/**
 * A reclaimed lock holder learns that it lost the lock (#334)
 *
 * `updateHeartbeat` caught everything and its comment claimed "If ENOENT, we lost the
 * lock. Stop updating." None of that happened: `ENOENT` on the holder's own record means
 * a stale takeover quarantined and deleted it, yet the interval kept firing, the dead
 * `lockData` stayed in place, and nothing was surfaced to the holder — so a process whose
 * lock had been reclaimed went on behaving as the exclusive owner, and its writes were
 * attributable to nobody.
 *
 * The heartbeat now answers `'lost'`, the instance stops its own timer, drops the dead
 * record (so `release()` cannot touch the takeover's directory) and exposes the loss as
 * `lock.lockLost`. That is detectability, not prevention: a holder suspended long enough
 * to be reclaimed can still be mid-`renameSync` when it resumes, and no JS-visible state
 * closes the gap between a check and that syscall — the TOCTOU note in
 * `src/storage/atomic-write.ts` says so and only narrows it.
 *
 * The 15-second interval is faked with `node:test` mock timers so a takeover is observed
 * on one tick instead of in real time. Only `setInterval` and `Date` are replaced, and the
 * clock is seeded with the real epoch, so every timestamp below — the record write, the
 * aging, the renewal — lands on one monotone clock and the staging is deterministic rather
 * than raced. Locks are released in a `finally` because a pending fake interval holds the
 * event loop open: mock timers ignore `unref`.
 */
import { test, describe, before, after, type TestContext } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT } from '../src/storage/lock';
import { atomicWrite } from '../src/storage/atomic-write';
import { computeFingerprint } from '../src/storage/frontmatter';
import { NodeError } from '../src/types';

/** The single `*.json` record a lock directory holds, or null when it holds none. */
function readRecord(lockDir: string): { lock_id: string; pid: number } | null {
  if (!fs.existsSync(lockDir)) return null;
  const files = fs.readdirSync(lockDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  const [recordFile] = files;
  assert.ok(recordFile !== undefined);
  return JSON.parse(fs.readFileSync(path.join(lockDir, recordFile), 'utf8')) as {
    lock_id: string;
    pid: number;
  };
}

/** The internals a holder is expected to clean up when it learns it lost the lock. */
interface LockInternals {
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lockData: { lock_id: string } | null;
}

/** Casts a Lock to its internal shape, exposing private fields for test assertions. */
function internals(lock: Lock): LockInternals {
  return lock as unknown as LockInternals;
}

/** Deletes every `.json` record in a lock dir, simulating a takeover's quarantine+delete. */
function wipeLockRecords(lockDir: string): void {
  if (!fs.existsSync(lockDir)) return;
  for (const f of fs.readdirSync(lockDir)) {
    if (f.endsWith('.json')) {
      const lf = path.join(lockDir, f);
      fs.renameSync(lf, lf + '.quarantine');
      fs.unlinkSync(lf + '.quarantine');
    }
  }
}

/** Returns the first `.lockdir` inside a vault's locks directory, or null. */
function findLockDir(vault: string): string | null {
  const locksDir = path.join(vault, '.palee', 'locks');
  if (!fs.existsSync(locksDir)) return null;
  const lockDirs = fs.readdirSync(locksDir).filter((f) => f.endsWith('.lockdir'));
  if (lockDirs.length === 0) return null;
  return path.join(locksDir, lockDirs[0]!);
}

describe('lock takeover is visible to the holder (#334)', () => {
  let vault: string;

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-loss-'));
    fs.mkdirSync(path.join(vault, '.palee', 'locks'), { recursive: true });
  });

  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /** Creates a note to lock, unique per call. */
  function newTarget(name: string): string {
    const target = path.join(vault, `${name}.md`);
    fs.writeFileSync(target, `# ${name}\n`, 'utf8');
    return target;
  }

  /**
   * Ages a holder's own record past the stale threshold — what a process suspended
   * longer than `STALE_TIMEOUT` looks like to everyone else: the record is still there,
   * but nobody is renewing it.
   */
  function makeStale(lockDir: string, lockId: string): void {
    const lockFile = path.join(lockDir, `${lockId}.json`);
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 1000);
    fs.utimesSync(lockFile, staleTime, staleTime);
  }

  /** Puts the test on a controllable clock seeded at the real epoch. */
  function startClock(t: TestContext): void {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  }

  test('a takeover, one heartbeat tick, and the stale holder reports the loss', async (t) => {
    startClock(t);
    const target = newTarget('takeover');
    const holder = new Lock(vault, target);
    const taker = new Lock(vault, target);

    try {
      await holder.acquire();
      const ours = readRecord(holder.lockPath);
      assert.ok(ours, 'precondition: the holder wrote its record');

      // Another process finds the aged record and takes it over through the real
      // stale-recovery path (quarantine by rename, never a blind delete). Nothing ticks
      // between the aging and the takeover, so the holder cannot refresh itself first.
      makeStale(holder.lockPath, ours.lock_id);
      await taker.acquire();
      const theirs = readRecord(taker.lockPath);
      assert.ok(theirs, 'precondition: the takeover wrote its own record');
      assert.notStrictEqual(theirs.lock_id, ours.lock_id, 'precondition: the takeover holds a new id');

      assert.strictEqual(holder.lockLost, false, 'loss is reported only once a heartbeat has run');

      t.mock.timers.tick(HEARTBEAT_INTERVAL);

      assert.strictEqual(holder.lockLost, true, 'the reclaimed holder must report the loss');
      assert.strictEqual(internals(holder).heartbeatTimer, null, 'the holder must stop its own timer');
      assert.strictEqual(internals(holder).lockData, null, 'the holder must drop the dead record');

      // A stale holder that releases after losing must not damage the new holder's lock:
      // dropping the record is what turns `releaseLock` into a no-op.
      holder.release();
      const survivor = readRecord(taker.lockPath);
      assert.ok(survivor, 'the takeover’s record must still exist after the stale holder released');
      assert.strictEqual(survivor.lock_id, theirs.lock_id, 'and it must still be the takeover’s own');
    } finally {
      holder.release();
      taker.release();
    }
  });

  test('a legitimate holder keeps renewing and is never told it lost the lock', async (t) => {
    startClock(t);
    const target = newTarget('healthy-holder');
    const holder = new Lock(vault, target);

    try {
      await holder.acquire();
      const ours = readRecord(holder.lockPath);
      assert.ok(ours);
      const lockFile = path.join(holder.lockPath, `${ours.lock_id}.json`);
      const written = fs.statSync(lockFile).mtimeMs;

      t.mock.timers.tick(HEARTBEAT_INTERVAL);

      assert.strictEqual(holder.lockLost, false, 'a healthy hold is not a loss');
      assert.ok(
        fs.statSync(lockFile).mtimeMs > written,
        'the heartbeat must still refresh the record it owns'
      );
      assert.notStrictEqual(internals(holder).heartbeatTimer, null, 'and it must stay armed');

      const renewed = fs.statSync(lockFile).mtimeMs;
      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(holder.lockLost, false, 'two renewals in a row are still not a loss');
      assert.ok(fs.statSync(lockFile).mtimeMs > renewed, 'the second tick must renew again');
      assert.strictEqual(readRecord(holder.lockPath)?.lock_id, ours.lock_id, 'and it still owns the record');
    } finally {
      holder.release();
    }
  });

  test('a transient heartbeat failure is not reported as a lost lock', async (t) => {
    // One failed `utimes` says nothing about ownership. Reading it as a loss would
    // abdicate a live holder on a brief antivirus handle and hand the target away.
    startClock(t);
    const target = newTarget('transient');
    const holder = new Lock(vault, target);

    await holder.acquire();
    const ours = readRecord(holder.lockPath);
    assert.ok(ours);
    const lockFile = path.join(holder.lockPath, `${ours.lock_id}.json`);

    const originalUtimesSync = fs.utimesSync;
    let failures = 0;
    (fs as unknown as { utimesSync: typeof fs.utimesSync }).utimesSync = ((
      arg: unknown,
      ...rest: unknown[]
    ) => {
      if (arg === lockFile && failures < 2) {
        failures += 1;
        const err = new Error('simulated EPERM on the lock record') as NodeError;
        err.code = 'EPERM';
        throw err;
      }
      return (originalUtimesSync as (...a: unknown[]) => void)(arg, ...rest);
    }) as typeof fs.utimesSync;

    try {
      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(holder.lockLost, false, 'EPERM must not be read as a takeover');
      assert.notStrictEqual(internals(holder).heartbeatTimer, null, 'and the heartbeat must keep running');

      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(holder.lockLost, false, 'still not a takeover after the second failure');

      // With the handle gone the same holder renews normally and is still the owner.
      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(holder.lockLost, false, 'a cleared handle is not a loss either');
      assert.strictEqual(readRecord(holder.lockPath)?.lock_id, ours.lock_id, 'and it still owns its record');
      assert.strictEqual(failures, 2, 'both failing ticks must have met the simulated EPERM');
    } finally {
      (fs as unknown as { utimesSync: typeof fs.utimesSync }).utimesSync = originalUtimesSync;
      holder.release();
    }
  });

  test('a fresh acquisition clears the loss the previous hold reported', async (t) => {
    startClock(t);
    const target = newTarget('reacquire');
    const holder = new Lock(vault, target);
    const taker = new Lock(vault, target);

    try {
      await holder.acquire();
      const ours = readRecord(holder.lockPath);
      assert.ok(ours);
      makeStale(holder.lockPath, ours.lock_id);
      await taker.acquire();

      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(holder.lockLost, true, 'precondition: the takeover was observed');

      // The takeover ends; the same instance may claim the target again.
      taker.release();
      await holder.acquire();

      assert.strictEqual(holder.lockLost, false, 'a new acquisition is a new claim, not a stale loss');
      const reacquired = internals(holder).lockData?.lock_id;
      assert.ok(reacquired, 'and it holds a fresh record');
      assert.notStrictEqual(reacquired, ours.lock_id, 'the new id differs from the reclaimed one');
      assert.strictEqual(readRecord(holder.lockPath)?.lock_id, reacquired, 'and that record is on disk');
      assert.notStrictEqual(internals(holder).heartbeatTimer, null, 'with the heartbeat armed again');
    } finally {
      holder.release();
      taker.release();
    }
  });

  test('the takeover still refuses the stale holder’s next write', async (t) => {
    // What the flag is for: once it is set the holder knows it must not assume
    // exclusivity — and the lock it can no longer claim is what refuses its write.
    startClock(t);
    const target = newTarget('refuse-after-loss');
    const holder = new Lock(vault, target);
    const taker = new Lock(vault, target);

    try {
      await holder.acquire();
      const ours = readRecord(holder.lockPath);
      assert.ok(ours);
      makeStale(holder.lockPath, ours.lock_id);
      await taker.acquire();

      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(holder.lockLost, true, 'precondition: the loss is visible');

      await assert.rejects(
        () => atomicWrite(vault, target, '# From the stale holder\n'),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected a lock conflict, got ${e.code}: ${e.message}`);
          assert.match(e.message, /Lock conflict/);
          return true;
        }
      );
      assert.strictEqual(fs.readFileSync(target, 'utf8'), '# refuse-after-loss\n', 'the target is untouched');
    } finally {
      holder.release();
      taker.release();
    }
  });

  test('#479 mid-write loss is caught before the rename commits over a takeover', { skip: process.platform !== 'win32' }, async (t) => {
    // Scenario: atomicWrite acquires its internal Lock and starts the heartbeat,
    // then a taker takes over while atomicWrite is suspended in the Windows
    // retry loop. The heartbeat ticks, sets lockLost=true, and the guard before
    // renameSync aborts with ECONFLICT instead of committing over the takeover.
    //
    // This test exercises the Windows-specific retry path: only on win32 does
    // a transient EPERM from openSync enter the `await sleep` retry loop, giving
    // the heartbeat a tick window to set lockLost before the guard re-checks
    // on the next iteration. On POSIX there is no await between the guard and
    // renameSync, so mid-write loss cannot occur and the guard cannot be tested
    // this way.
    //
    // We simulate the mid-write takeover by stubbing fs.openSync: on the first
    // temp-file open we wipe atomicWrite's lock record and tick the heartbeat
    // (setting lockLost), then throw a transient EPERM to force the retry loop
    // where the guard re-checks lockLost and must catch it.
    startClock(t);
    const target = newTarget('mid-write-loss');
    let takeoverStaged = false;

    try {
      fs.writeFileSync(target, '# mid-write-loss\n', 'utf8');
      const priorContent = fs.readFileSync(target, 'utf8');
      const priorFingerprint = computeFingerprint(priorContent);

      const originalOpen = fs.openSync;
      (fs as { openSync: typeof fs.openSync }).openSync = (file: fs.PathLike | number, ...rest: unknown[]) => {
        if (!takeoverStaged && typeof file === 'string' && file.includes('.tmp.')) {
          takeoverStaged = true;
          // Wipe atomicWrite's internal lock record so the heartbeat detects loss.
          const lockDir = findLockDir(vault);
          if (lockDir) {
            wipeLockRecords(lockDir);
          }
          // Tick the heartbeat: atomicWrite's internal Lock heartbeat fires,
          // finds its own record gone, sets lockLost=true.
          t.mock.timers.tick(HEARTBEAT_INTERVAL);
          // Throw EPERM to enter the Windows retry loop, where the guard
          // at line 460 re-checks lockLost and must catch it.
          const e = new Error('simulated EPERM on temp file (transient)') as NodeError;
          e.code = 'EPERM';
          throw e;
        }
        return (originalOpen as (...a: unknown[]) => number)(file, ...rest);
      };

      try {
        await assert.rejects(
          () => atomicWrite(vault, target, '# Stale holder writes\n', priorFingerprint),
          (err: unknown) => {
            const e = err as Error & { code?: string };
            assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}: ${e.message}`);
            assert.match(e.message, /lock was taken over mid-write/, `got: ${e.message}`);
            return true;
          }
        );
        assert.strictEqual(takeoverStaged, true, 'the takeover must have been staged');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), priorContent, 'the target must be untouched');
      } finally {
        (fs as { openSync: typeof fs.openSync }).openSync = originalOpen;
      }
    } finally {
      // Clean up lock dir for this target.
      const lockDir = findLockDir(vault);
      if (lockDir) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  test('#479 follow-up: post-write fingerprint check catches a synchronous takeover', async () => {
    // Scenario: a taker overwrites the target after the OCC read but during the
    // synchronous write/fsync block. The heartbeat cannot fire during synchronous
    // syscalls, so lockLost stays false — but the final fingerprint check before
    // renameSync catches the content change and aborts with ECONFLICT.
    const target = newTarget('post-write-takeover');
    fs.writeFileSync(target, '# post-write-takeover\n', 'utf8');
    const priorContent = fs.readFileSync(target, 'utf8');
    const priorFingerprint = computeFingerprint(priorContent);

    let readCount = 0;
    const originalReadFileSync = fs.readFileSync;
    const targetBasename = path.basename(target);

    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
      file: fs.PathLike | number,
      ...rest: unknown[]
    ) => {
      if (typeof file === 'string' && file.endsWith(targetBasename)) {
        readCount += 1;
        // Second read of the target (post-write check): return modified content
        // to simulate a taker overwriting during the synchronous write/fsync block.
        if (readCount === 2) {
          return "# post-write-takeover\n## Modified by the taker\n";
        }
      }
      return (originalReadFileSync as (...a: unknown[]) => string)(file as fs.PathLike, ...rest);
    }) as typeof fs.readFileSync;

    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# Stale holder writes\n', priorFingerprint),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}: ${e.message}`);
          assert.match(e.message, /concurrent takeover during the write/, `got: ${e.message}`);
          return true;
        }
      );
      assert.strictEqual(readCount >= 2, true, 'the post-write check must have read the target');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), '# post-write-takeover\n', 'the target must be untouched');
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }
  });

  test('#479 follow-up: post-write read catches ENOENT from a racing deletion', async () => {
    // Scenario: between the post-write existsSync (which sees the target as present)
    // and the post-write readFileSync, a concurrent takeover deletes the target.
    // The ENOENT from readFileSync must be converted to ECONFLICT, not propagated.
    const target = newTarget('post-write-enoent-race');
    const priorContent = fs.readFileSync(target, 'utf8');
    const expectedFingerprint = computeFingerprint(priorContent);

    let readCount = 0;
    const originalReadFileSync = fs.readFileSync;
    const targetBasename = path.basename(target);

    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
      file: fs.PathLike | number,
      ...rest: unknown[]
    ) => {
      if (typeof file === 'string' && file.endsWith(targetBasename)) {
        readCount += 1;
        // Second read of the target (post-write check): throw ENOENT to simulate
        // the target being deleted between existsSync and readFileSync.
        if (readCount === 2) {
          const enoent = new Error(`ENOENT: no such file or directory, open '${target}'`) as NodeError;
          enoent.code = 'ENOENT';
          throw enoent;
        }
      }
      return (originalReadFileSync as (...a: unknown[]) => string)(file as fs.PathLike, ...rest);
    }) as typeof fs.readFileSync;

    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# Stale holder writes\n', expectedFingerprint),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}`);
          assert.match(e.message, /was deleted by a concurrent write/, `got: ${e.message}`);
          return true;
        }
      );
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }
  });

  test('#479 follow-up: post-write read propagates non-ENOENT errors unchanged', async () => {
    // Scenario: the post-write readFileSync throws a non-ENOENT error (e.g. EIO).
    // That error must be propagated unchanged, not converted to ECONFLICT.
    const target = newTarget('post-write-non-enoent-error');
    const priorContent = fs.readFileSync(target, 'utf8');
    const expectedFingerprint = computeFingerprint(priorContent);

    let readCount = 0;
    const originalReadFileSync = fs.readFileSync;
    const targetBasename = path.basename(target);

    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
      file: fs.PathLike | number,
      ...rest: unknown[]
    ) => {
      if (typeof file === 'string' && file.endsWith(targetBasename)) {
        readCount += 1;
        // Second read of the target (post-write check): throw EIO
        // (not EPERM/EBUSY, which win32 retries)
        if (readCount === 2) {
          const eio = new Error(`EIO: i/o error, read '${target}'`) as NodeError;
          eio.code = 'EIO';
          throw eio;
        }
      }
      return (originalReadFileSync as (...a: unknown[]) => string)(file as fs.PathLike, ...rest);
    }) as typeof fs.readFileSync;

    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# Stale holder writes\n', expectedFingerprint),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'EIO', `expected EIO, got ${e.code}`);
          return true;
        }
      );
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }
  });

  test('#479 follow-up: post-write check catches a deletion during the synchronous write', async () => {
    const target = newTarget('post-write-deletion-test');
    const priorContent = fs.readFileSync(target, 'utf8');
    const expectedFingerprint = computeFingerprint(priorContent);

    // Stub the two presence probes the writer makes about its target: the OCC check and
    // the post-write check, both `lstatSync` since #565 P1-08 review. The first sees the
    // note; the second reports it gone, which simulates a taker deleting it during the
    // synchronous write/fsync block.
    const originalLstatSync = fs.lstatSync;
    let targetProbes = 0;
    const targetBasename = path.basename(target);

    (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith(targetBasename)) {
        targetProbes += 1;
        if (targetProbes === 2) {
          const enoent = new Error(`ENOENT: no such file or directory, lstat '${p}'`) as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
      }
      return (originalLstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.lstatSync;

    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# Stale holder writes\n', expectedFingerprint),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}`);
          assert.match(e.message, /was deleted by a concurrent write/, `got: ${e.message}`);
          return true;
        }
      );
      assert.strictEqual(targetProbes, 2, 'the OCC check and the post-write check both probed the target');
      // The target must still exist on disk (unchanged, no rename happened)
      assert.strictEqual(fs.readFileSync(target, 'utf8'), priorContent, 'the target must be untouched');
    } finally {
      (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstatSync;
    }
  });

  test('#479 follow-up: post-write check catches a creation during the synchronous write', async () => {
    // Target does not exist initially — caller expects absence
    const target = path.join(vault, '.palee', 'post-write-creation-test.md');
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // Stub the two presence probes about the target. The OCC check must see it absent (it
    // is a first creation), and the post-write check must see it present — which it is,
    // because the write just renamed it into place. That second probe is what catches a
    // taker who created the same path during the synchronous write.
    const originalLstatSync = fs.lstatSync;
    let targetProbes = 0;
    const targetBasename = path.basename(target);

    (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith(targetBasename)) {
        targetProbes += 1;
        if (targetProbes === 1) {
          // The OCC check: nothing there yet, so the creation claim holds.
          const enoent = new Error(`ENOENT: no such file or directory, lstat '${p}'`) as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
        if (targetProbes === 2) {
          // The post-write check: a taker's entry is there. `entryExists` only asks
          // whether the probe throws, so a stand-in entry is enough to model it.
          return originalLstatSync(vault) as fs.Stats;
        }
      }
      return (originalLstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.lstatSync;

    try {
      await assert.rejects(
        () => atomicWrite(vault, target, '# First creator writes\n', null, { expectExists: false }),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}`);
          assert.match(e.message, /was created by a concurrent write/, `got: ${e.message}`);
          return true;
        }
      );
      assert.strictEqual(targetProbes, 2, 'the OCC check and the post-write check both probed the target');
    } finally {
      (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstatSync;
    }
  });
});
