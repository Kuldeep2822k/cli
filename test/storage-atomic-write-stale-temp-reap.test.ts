/**
 * Reclaiming the temporary files a killed writer abandoned (#481)
 *
 * A process SIGKILLed between the temp write and the rename leaves
 * `<target>.tmp.<pid>.<entropy>` in the note's own directory forever. `atomicWrite`
 * unlinks only from the `catch` of a *handled* error, and a signal reaches neither
 * that nor any `finally`; the residue ends in neither `.md` nor a lock name, so no
 * enumerator ever sees it and nothing ever removes it. It surfaces in Obsidian's
 * file picker and in every vault git diff.
 *
 * The sweep is deliberately narrower than "delete the litter in this directory".
 * Deletion requires all of: the entry is a regular file, its name starts with this
 * target's own basename, the remainder matches exactly the spelling this primitive
 * writes, the pid it carries is a safe positive integer, the file is older than the
 * staleness floor, and that pid is gone from this host's process table. Each guard
 * spares a different thing a user could plausibly lose, so each gets its own test
 * below, and every "survives" assertion sits next to a stray of the same shape that
 * *is* reclaimed — otherwise a sweep that silently never ran would look identical to
 * a sweep that correctly declined.
 *
 * Placement is part of the contract, not an implementation detail, and is tested as
 * its own behaviour: the sweep runs after `lock.acquire()` (INV-04) and after the OCC
 * check (INV-03), so a write that refuses mutates nothing either way. The tests pin
 * that by refusing a write, showing the stray is still there, and then showing the
 * same stray goes as soon as a write is allowed to proceed — which excludes "the
 * fixture was never a candidate" as the reason it survived.
 *
 * What this file deliberately does NOT claim, because no test through the public
 * interface can fail on it:
 * - the `stalePath === selfTempPath` skip. The sweep runs before `openSync` creates
 *   this call's temp, so the listing can never contain it; the arm is insurance
 *   against a future reordering, not a reachable branch.
 * - `lstatSync` rather than `statSync` for the age. Only regular files reach that
 *   line (`isFile()` is checked first), and for those the two calls report the same
 *   mtime. The symlink test below pins `isFile()`, which is what actually keeps a
 *   link from being followed out of the directory; swapping `lstatSync` to
 *   `statSync` changes nothing observable.
 * - `pid > 0` on its own. `process.kill(0, 0)` succeeds (signal 0 to the caller's own
 *   process group), so a `0` pid is also spared by the liveness probe. It is planted
 *   next to the oversized-pid case so the outcome is recorded, but the oversized case
 *   is the one that moves under mutation.
 * - a *directory* wearing the spelling: with `isFile()` removed the sweep would try to
 *   unlink it, and the unlink swallow would eat the `EPERM`/`EISDIR`, so it survives
 *   either way. The symlink case is the one that can actually fail.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, isConflictError } from '../src/storage/atomic-write';
import { Lock } from '../src/storage/lock';
import { computeFingerprint } from '../src/storage/frontmatter';
import { walkVault } from '../src/storage/vault-walker';

/**
 * `INT32_MAX`: absent from the process table on Windows and Linux alike, so
 * `process.kill(pid, 0)` answers `ESRCH` and the owner reads as gone.
 */
const DEAD_PID = 2147483647;

/** Well past the primitive's 30 s floor, and nowhere near a lock staleness window. */
const STALE_AGE_MS = 120_000;

/**
 * A pid this host will not have. Its liveness answer is forced through the
 * `process.kill` seam rather than hunted for in the real table, so the test is the
 * same on a container where pid 4 does not exist as it is on a desktop where it does.
 */
const FOREIGN_PID = 987_654;

/** The exact spelling `atomicWrite` gives its temp file, so a fixture is indistinguishable from one. */
function strayName(basename: string, pid: number, entropy: string): string {
  return `${basename}.tmp.${pid}.${entropy}`;
}

describe('atomicWrite reclaims abandoned temp files of its own target (#481)', () => {
  let vault: string;

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-stale-temp-'));
    fs.mkdirSync(path.join(vault, '.palee', 'locks'), { recursive: true });
  });

  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /** A directory holding one note and whatever the test plants, so a listing is an exact set. */
  function caseDir(name: string): string {
    const dir = path.join(vault, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Affects only the planted age, never the note a test is about to write. */
  function age(created: string): void {
    const when = new Date(Date.now() - STALE_AGE_MS);
    fs.utimesSync(created, when, when);
  }

  /** Creates a file a killed writer could have abandoned and, when `aged`, backdates it past the floor. */
  function plantStray(dir: string, name: string, aged: boolean): string {
    const created = path.join(dir, name);
    fs.writeFileSync(created, 'bytes abandoned by a killed writer\n', 'utf8');
    if (aged) {
      age(created);
    }
    return created;
  }

  /** Lists a directory's entries sorted, so a test asserts the exact set that survives. */
  function names(dir: string): string[] {
    return fs.readdirSync(dir).sort();
  }

  /**
   * Wraps `fs.unlinkSync`, refusing exactly the named path and delegating everything
   * else — including the lock record the release unlinks — so one errno is injected
   * at one syscall rather than switching the primitive off. Reports both the error
   * the write raised and the paths the sweep actually tried, so a run where the
   * injection never fired cannot be mistaken for a passing one.
   */
  async function writeWithRefusedUnlink(
    refuseBasename: string,
    run: () => Promise<void>
  ): Promise<{ caught: unknown; attempted: string[] }> {
    const attempted: string[] = [];
    const originalUnlink = fs.unlinkSync;
    Object.defineProperty(fs, 'unlinkSync', {
      configurable: true,
      writable: true,
      value: (target: fs.PathLike): void => {
        const name = path.basename(String(target));
        attempted.push(name);
        if (name === refuseBasename) {
          const err = new Error('simulated: another process still holds this stray open') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        originalUnlink(String(target));
      },
    });
    let caught: unknown = null;
    try {
      await run();
    } catch (e: unknown) {
      caught = e;
    } finally {
      Object.defineProperty(fs, 'unlinkSync', { configurable: true, writable: true, value: originalUnlink });
    }
    return { caught, attempted };
  }

  test('reclaims a stray this target abandoned in an earlier run (#481)', async () => {
    const dir = caseDir('reap-baseline');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const stray = strayName('note.md', DEAD_PID, '11111111');
    plantStray(dir, stray, true);
    assert.deepStrictEqual(names(dir), ['note.md', stray], 'the stray must be on disk before the write, or the run proves nothing');

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Rewritten\n');
    assert.deepStrictEqual(names(dir), ['note.md'], 'a temp file this target owns, whose owner is gone, must be reclaimed');
  });

  test('leaves a stray younger than the staleness floor (#481)', async () => {
    const dir = caseDir('reap-age-floor');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const aged = strayName('note.md', DEAD_PID, '22222222');
    const inFlight = strayName('note.md', DEAD_PID, '33333333');
    plantStray(dir, aged, true);
    // Same spelling and a dead owner, so the only thing that spares it is its age:
    // this is a live writer on a second host sharing the vault, where the process
    // table says nothing about anybody.
    plantStray(dir, inFlight, false);

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.deepStrictEqual(
      names(dir),
      ['note.md', inFlight],
      'a recent temp may be somebody else s in flight; only the aged one is provably abandoned'
    );
  });

  test('leaves a stray whose owner is still running (#481)', async () => {
    const dir = caseDir('reap-live-pid');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    // Aged, so the survival is attributable to the liveness probe alone.
    const live = strayName('note.md', process.pid, '44444444');
    const dead = strayName('note.md', DEAD_PID, '55555555');
    plantStray(dir, live, true);
    plantStray(dir, dead, true);

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.deepStrictEqual(names(dir), ['note.md', live], 'the probe, not the age, must be what spares a running owner');
  });

  test('treats an owner it may not signal as alive and spares the stray (#481)', async () => {
    const dir = caseDir('reap-eperm-alive');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const foreign = strayName('note.md', FOREIGN_PID, '66666666');
    const dead = strayName('note.md', DEAD_PID, '77777777');
    plantStray(dir, foreign, true);
    plantStray(dir, dead, true);

    const probed: number[] = [];
    const originalKill = process.kill;
    Object.defineProperty(process, 'kill', {
      configurable: true,
      writable: true,
      value: (pid: number, signal?: string | number): true => {
        probed.push(pid);
        if (pid === FOREIGN_PID) {
          const err = new Error('simulated: EPERM, the process is not ours') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return originalKill(pid, signal);
      },
    });
    try {
      await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

      assert.ok(probed.includes(FOREIGN_PID), 'the liveness probe never ran on the planted pid, so a green run would say nothing');
      assert.deepStrictEqual(
        names(dir),
        ['note.md', foreign],
        'a process this user cannot signal still exists; a recycled pid may spare a stray but must never condemn a live write'
      );
    } finally {
      Object.defineProperty(process, 'kill', { configurable: true, writable: true, value: originalKill });
    }
  });

  test('never reclaims a symlink wearing the temp spelling (#481)', async (t) => {
    const dir = caseDir('reap-symlink');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const canaryName = 'keep-me.md';
    const canary = path.join(dir, canaryName);
    fs.writeFileSync(canary, '# Keep\n', 'utf8');
    const linkName = strayName('note.md', DEAD_PID, '88888888');
    const link = path.join(dir, linkName);
    const dead = strayName('note.md', DEAD_PID, '99999999');
    plantStray(dir, dead, true);

    let linked = true;
    try {
      fs.symlinkSync(canary, link, 'file');
      // `lutimesSync`, not `utimesSync`: the link itself has to be past the floor,
      // or the age guard would spare it before `isFile()` ever gets to say no.
      const when = new Date(Date.now() - STALE_AGE_MS);
      fs.lutimesSync(link, when, when);
    } catch {
      linked = false;
    }
    if (!linked) {
      if (fs.existsSync(link)) {
        fs.unlinkSync(link);
      }
      t.skip('an aged file symlink cannot be created on this platform');
      return;
    }
    assert.ok(
      Date.now() - fs.lstatSync(link).mtimeMs >= STALE_AGE_MS - 5_000,
      'the link itself, not the note behind it, must be past the staleness floor'
    );

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.deepStrictEqual(
      names(dir),
      ['keep-me.md', 'note.md', linkName],
      'a link is not a temp file this primitive wrote, however it is named: only the regular stray goes'
    );
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the surviving entry must still be the link, not a file that replaced it');
    assert.strictEqual(fs.readFileSync(canary, 'utf8'), '# Keep\n', 'the note the link names must not be touched');
    fs.unlinkSync(link);
  });

  test('reclaims only this target s strays, never a sibling note s (#481)', async () => {
    const dir = caseDir('reap-sibling');
    const target = path.join(dir, 'note-a.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    // Equal-length basenames, so the sibling's stray is a candidate for a sweep that
    // forgets the prefix test: `note-b.md`.slice(9) hands it `.tmp.<pid>.<entropy>`.
    const sibling = strayName('note-b.md', DEAD_PID, 'aaaaaaaa');
    const own = strayName('note-a.md', DEAD_PID, 'bbbbbbbb');
    fs.writeFileSync(path.join(dir, 'note-b.md'), '# Sibling\n', 'utf8');
    plantStray(dir, sibling, true);
    plantStray(dir, own, true);

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.deepStrictEqual(
      names(dir),
      ['note-a.md', 'note-b.md', sibling],
      'another note s abandoned temp belongs to that note s next write, not to this one'
    );
  });

  test('reclaims only the exact spelling this primitive writes (#481)', async () => {
    const dir = caseDir('reap-exact-spelling');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    // Anchored at end-of-name, so this one is a real note: `walkVault` enumerates
    // anything ending in `.md`, and deleting it is deleting a user's file.
    const stillANote = 'note.md.tmp.2147483647.abcd1234.md';
    // Seven hex digits: not the eight the primitive writes, so its owner is unknowable.
    const shortEntropy = 'note.md.tmp.2147483647.abc1234';
    // Unanchored, the `.tmp.` inside this name would match; anchored, it does not.
    const otherNotePrefix = 'note.md-note.md.tmp.2147483647.abcd1234';
    // Eight characters is not enough: they also have to be the hex this writes.
    const notHex = 'note.md.tmp.2147483647.zzzzzzzz';
    const own = strayName('note.md', DEAD_PID, '00000000');
    for (const name of [stillANote, shortEntropy, otherNotePrefix, notHex]) {
      fs.writeFileSync(path.join(dir, name), 'a file this primitive did not write\n', 'utf8');
      age(path.join(dir, name));
    }
    plantStray(dir, own, true);
    assert.ok(
      walkVault(dir).some((found) => path.basename(found) === stillANote),
      'the anchored name has to be a note the walker itself counts, or the anchor guards nothing'
    );

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.deepStrictEqual(
      names(dir),
      [
        'note.md',
        'note.md-note.md.tmp.2147483647.abcd1234',
        'note.md.tmp.2147483647.abc1234',
        'note.md.tmp.2147483647.abcd1234.md',
        'note.md.tmp.2147483647.zzzzzzzz',
      ],
      'a sweep that deletes what it cannot prove it wrote is a data-loss bug with tidier directories'
    );
  });

  test('skips a stray whose pid is not one it can ask about (#481)', async () => {
    const dir = caseDir('reap-pid-integer');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    // 21 digits: `\d+` matches it, `Number()` is 1e21, and no probe can answer for it.
    const oversized = 'note.md.tmp.999999999999999999999.abcdef12';
    // Also spared, but not by this guard alone — see the header: signal 0 to pid 0
    // succeeds, so the liveness probe reaches the same answer.
    const zero = 'note.md.tmp.0.abcdef12';
    const dead = strayName('note.md', DEAD_PID, 'cccccccc');
    for (const name of [oversized, zero]) {
      plantStray(dir, name, true);
    }
    plantStray(dir, dead, true);

    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));

    assert.deepStrictEqual(
      names(dir),
      ['note.md', 'note.md.tmp.0.abcdef12', 'note.md.tmp.999999999999999999999.abcdef12'],
      'a pid the probe cannot be asked about is not evidence of a dead writer'
    );
  });

  test('reclaims nothing when the fingerprint check refuses the write (#481, INV-03)', async () => {
    const dir = caseDir('reap-after-occ');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const stray = strayName('note.md', DEAD_PID, 'dddddddd');
    plantStray(dir, stray, true);

    await assert.rejects(
      () => atomicWrite(vault, target, '# Refused\n', 'not-the-disk-fingerprint'),
      (err: unknown) => {
        assert.strictEqual((err as { code?: string }).code, 'ECONFLICT', 'a stale fingerprint is a retryable conflict');
        return true;
      }
    );

    assert.deepStrictEqual(
      names(dir),
      ['note.md', stray],
      'a write that goes on to refuse must not have reclaimed anything on the way out'
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Original\n', 'the target stays as the caller left it');

    // Same fixture, same stray, one legitimate write: without this the survival above
    // could be read as the sweep never reaching this directory at all.
    await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));
    assert.deepStrictEqual(names(dir), ['note.md'], 'the reclaimed stray was a candidate all along');
  });

  test('reclaims nothing when the lock is held by another writer (#481, INV-04)', async () => {
    const dir = caseDir('reap-after-acquire');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const stray = strayName('note.md', DEAD_PID, 'eeeeeeee');
    plantStray(dir, stray, true);

    // A holder in this process's own name: `createLock` finds the record fresh and
    // alive, so the second writer is refused at acquisition — the point is what it
    // must not have touched by then, not the exclusion itself.
    const holder = new Lock(vault, target);
    await holder.acquire();
    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# Rewritten\n'),
        (err: unknown) => {
          assert.strictEqual(isConflictError(err), true, 'a held lock is the retryable conflict the caller expects');
          return true;
        }
      );

      assert.deepStrictEqual(
        names(dir),
        ['note.md', stray],
        'a sweep that runs before acquisition reclaims strays from behind a lock it does not hold'
      );
    } finally {
      holder.release();
    }

    await atomicWrite(vault, target, '# Rewritten\n');
    assert.deepStrictEqual(names(dir), ['note.md'], 'once the lock is this writer s, the same stray goes');
  });

  test('skips a stray it cannot unlink instead of failing the write (#481, INV-08)', async () => {
    const dir = caseDir('reap-unlink-refused');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const stuck = strayName('note.md', DEAD_PID, 'ff00ff00');
    const reclaimable = strayName('note.md', DEAD_PID, 'ff00ff01');
    plantStray(dir, stuck, true);
    plantStray(dir, reclaimable, true);

    const { caught, attempted } = await writeWithRefusedUnlink(stuck, () =>
      atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'))
    );

    assert.ok(attempted.includes(stuck), 'the sweep never tried the stuck stray, so a green run would be the wrong kind of silence');
    assert.strictEqual(caught, null, `litter in the vault must never cost the user their write: ${String(caught)}`);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Rewritten\n');
    assert.deepStrictEqual(
      names(dir),
      ['note.md', stuck],
      'the unreadable stray stays and the write itself still leaves nothing behind'
    );
  });

  test('survives a directory it cannot enumerate instead of failing the write (#481, INV-08)', async () => {
    const dir = caseDir('reap-readdir-refused');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    const stray = strayName('note.md', DEAD_PID, 'ff11ff11');
    plantStray(dir, stray, true);

    const readableDir = fs.realpathSync(dir);
    const seen: string[] = [];
    const originalReaddir = fs.readdirSync;
    Object.defineProperty(fs, 'readdirSync', {
      configurable: true,
      writable: true,
      value: (entryPath: fs.PathLike, options?: unknown): unknown => {
        const asString = String(entryPath);
        seen.push(asString);
        if (asString === readableDir) {
          const err = new Error('simulated: the note directory is not enumerable') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return (originalReaddir as (p: fs.PathLike, o?: unknown) => unknown).call(fs, entryPath, options);
      },
    });

    let failure: unknown = null;
    try {
      await atomicWrite(vault, target, '# Rewritten\n', computeFingerprint('# Original\n'));
    } catch (e: unknown) {
      failure = e;
    } finally {
      Object.defineProperty(fs, 'readdirSync', { configurable: true, writable: true, value: originalReaddir });
    }

    assert.ok(seen.includes(readableDir), 'the injection never reached the sweep s own readdir, so the run proves nothing');
    assert.strictEqual(failure, null, `a directory the sweep cannot read must not fail the write: ${String(failure)}`);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Rewritten\n');
    assert.deepStrictEqual(names(dir), ['note.md', stray], 'an unreadable directory means no deletions, not a lost write');
  });

  // Kept deliberately apart from every sweep test above: #484 asks that a failed write
  // leave no `*.tmp.*` behind (INV-08), and a pre-write sweep could satisfy that
  // assertion for the wrong reason. This fixture plants no stray at all, records the
  // order of the two calls, and demands that the unlink of the temp follow the refusal
  // of its rename — which is the failure path cleaning up, not the reaper.
  test('a failed write unlinks its own temp, with no reaper to credit (#484, INV-08)', async () => {
    const dir = caseDir('failure-own-temp');
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, '# Original\n', 'utf8');
    assert.deepStrictEqual(names(dir), ['note.md'], 'no stray may exist, or the cleanup could be blamed on the sweep');

    const tempPrefix = 'note.md.tmp.';
    const refusedRenames: string[] = [];
    const unlinkedTemps: string[] = [];
    const ordered: string[] = [];
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      writable: true,
      value: (from: fs.PathLike, to: fs.PathLike): void => {
        const name = path.basename(String(from));
        if (name.startsWith(tempPrefix)) {
          refusedRenames.push(name);
          ordered.push(`rename:${name}`);
          const err = new Error('simulated: the rename failed') as NodeJS.ErrnoException;
          // Not `EPERM`/`EBUSY`: those are the retryable Windows handle cases, and a
          // retry loop would hide whether the cleanup ran at all.
          err.code = 'ENOSPC';
          throw err;
        }
        originalRename(String(from), String(to));
      },
    });
    Object.defineProperty(fs, 'unlinkSync', {
      configurable: true,
      writable: true,
      value: (entryPath: fs.PathLike): void => {
        const name = path.basename(String(entryPath));
        if (name.startsWith(tempPrefix)) {
          unlinkedTemps.push(name);
          ordered.push(`unlink:${name}`);
        }
        originalUnlink(String(entryPath));
      },
    });

    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# Refused\n'),
        (err: unknown) => {
          assert.strictEqual((err as { code?: string }).code, 'ENOSPC', 'the injected errno must surface unchanged');
          return true;
        }
      );
    } finally {
      Object.defineProperty(fs, 'renameSync', { configurable: true, writable: true, value: originalRename });
      Object.defineProperty(fs, 'unlinkSync', { configurable: true, writable: true, value: originalUnlink });
    }

    assert.strictEqual(refusedRenames.length, 1, 'the injection never refused this write s rename');
    assert.deepStrictEqual(unlinkedTemps, refusedRenames, 'the failed write must unlink exactly the temp whose rename failed');
    assert.deepStrictEqual(
      ordered,
      [`rename:${refusedRenames[0]}`, `unlink:${refusedRenames[0]}`],
      'the unlink must follow the refusal: before it, it could only have been the pre-write sweep'
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Original\n', 'a failed rename must not truncate the target');
    assert.deepStrictEqual(names(dir), ['note.md'], 'no temp file may survive a failed write');
  });
});
