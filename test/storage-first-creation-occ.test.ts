/**
 * First-creation writes carry an explicit existence expectation (#327)
 *
 * When `.palee/hot.md` or `.palee/index.md` did not exist yet, the memory layer read
 * `ENOENT` and recorded that as `expectedFingerprint = null`. The OCC guard in
 * `atomicWrite` was `if (expectedFingerprint !== null)`, so the null skipped the whole
 * block — including the existence check. The lock still serialised the two writers, which
 * is exactly what made the loss silent: process B acquired the lock *after* A had created
 * and released it, saw no reason to object, and renamed its own bytes over A's fresh file.
 * One invocation's hot memory or session index simply vanished, with no `ECONFLICT` and no
 * trace (only the next clean `rebuildHotAndIndex` healed it).
 *
 * Absence is now a claim the caller states — `{ expectExists: false }` — and the guard
 * re-tests it from inside the lock. These tests pin both halves: the race that used to be
 * silent now fails, and a first creation nobody raced still succeeds.
 *
 * #334 is pinned from the other side here: a caller that states the destination *exists*
 * must also state what it read, or its overwrite cannot be attributed to anyone.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, isConflictError } from '../src/storage/atomic-write';
import { computeFingerprint, parseFrontmatter } from '../src/storage/frontmatter';
import { updateHotMemory, regenerateIndex, writeSessionNote } from '../src/storage';

/** Reads a file the way the pre-#327 caller did, so the test can name the loser's bytes. */
function readOrAbsent(target: string): string {
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '<absent>';
}

describe('first-creation writes keep OCC enabled (#327)', () => {
  let vault: string;

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-first-create-'));
  });

  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('a creation claim against a destination that already exists is a conflict, not an overwrite', async () => {
    const target = path.join(vault, 'created-first.md');
    const winnerContent = '# Writer A won the creation race\n';
    fs.writeFileSync(target, winnerContent, 'utf8');

    // What the loser used to pass for "the file was absent when I looked": a null
    // fingerprint. That is now an explicit statement, and it is false here.
    await assert.rejects(
      () => atomicWrite(vault, target, '# Writer B\n', null, { expectExists: false }),
      (err: unknown) => {
        const e = err as Error & { code?: string };
        assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}: ${e.message}`);
        assert.match(e.message, /created by another process/);
        assert.strictEqual(isConflictError(err), true, 'a lost creation race is retryable');
        return true;
      }
    );

    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      winnerContent,
      'the winner’s bytes must survive the loser’s write'
    );
  });

  test('an uncontested first creation still succeeds', async () => {
    const target = path.join(vault, 'brand-new.md');
    const content = '# Nobody raced me\n';

    await atomicWrite(vault, target, content, null, { expectExists: false });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), content);
  });

  test('two concurrent first creations of hot.md: one wins, the other conflicts', async () => {
    // Deterministic by construction, not by luck: `updateHotMemory` runs synchronously
    // from entry to its first `await` (the `atomicWrite`), and the pre-read of `hot.md`
    // is above that await. Both invocations therefore see "absent" before either one
    // takes the lock — the exact pair of concurrent `session start` processes the issue
    // describes.
    const hotVault = path.join(vault, 'concurrent-hot-vault');
    fs.mkdirSync(hotVault, { recursive: true });
    const hotPath = path.join(hotVault, '.palee', 'hot.md');
    assert.strictEqual(fs.existsSync(hotPath), false, 'precondition: hot.md must not exist');

    const results = await Promise.allSettled([
      updateHotMemory(hotVault, 'S-writer-a', 'T-a', 'Writer A summary'),
      updateHotMemory(hotVault, 'S-writer-b', 'T-b', 'Writer B summary'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, `exactly one creator may win, got ${fulfilled.length} successes`);
    assert.strictEqual(rejected.length, 1, `the other must be refused, got ${rejected.length} failures`);

    const loser = rejected[0];
    if (loser.status === 'rejected') {
      const err = loser.reason as Error & { code?: string };
      assert.strictEqual(
        isConflictError(err),
        true,
        `the losing creator must fail with a conflict, not silently — got ${err?.code}: ${err?.message}`
      );
    }

    // And the survivor is the writer that reported success, not an arbitrary one.
    const content = fs.readFileSync(hotPath, 'utf8');
    const winner = fulfilled[0];
    assert.strictEqual(
      winner.status === 'fulfilled' ? winner.value : null,
      hotPath,
      'the winner returns the hot.md it wrote'
    );
    assert.ok(
      content.includes('Writer A summary') || content.includes('Writer B summary'),
      `hot.md must hold one writer's body, got: ${readOrAbsent(hotPath)}`
    );
    const parsed = parseFrontmatter(content);
    assert.ok(parsed.frontmatter, 'the surviving hot.md must still parse');
    assert.strictEqual(
      parsed.frontmatter?.last_session,
      content.includes('Writer A summary') ? 'S-writer-a' : 'S-writer-b',
      'the surviving frontmatter must name the writer whose body survived'
    );
  });

  test('a creator that is beaten between its read and its write reports the conflict', async () => {
    // The tighter window: the caller's own pre-read says ENOENT, and the competing
    // creator commits *after* that read but before the guard runs. Injected rather than
    // raced, so the interleaving is not a coincidence of scheduling.
    const hotVault = path.join(vault, 'injected-hot-vault');
    fs.mkdirSync(hotVault, { recursive: true });
    const hotPath = path.join(hotVault, '.palee', 'hot.md');
    const winnerContent = '# Writer A committed first\n';

    const originalReadFileSync = fs.readFileSync;
    let injected = false;
    try {
      (fs as unknown as {
        readFileSync: typeof fs.readFileSync;
      }).readFileSync = ((arg: unknown, encoding?: unknown) => {
        if (!injected && arg === hotPath) {
          injected = true;
          // Writer A creates the file out-of-band, in this exact gap.
          fs.mkdirSync(path.dirname(hotPath), { recursive: true });
          fs.writeFileSync(hotPath, winnerContent, 'utf8');
          const enoent = new Error(`ENOENT: no such file or directory, open '${hotPath}'`) as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
        return (originalReadFileSync as (...a: unknown[]) => unknown)(arg, encoding);
      }) as typeof fs.readFileSync;

      await assert.rejects(
        () => updateHotMemory(hotVault, 'S-writer-b', 'T-b', 'Writer B summary'),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected the creation race to surface, got ${e.code}: ${e.message}`);
          assert.strictEqual(isConflictError(err), true);
          return true;
        },
        'updateHotMemory must not overwrite a hot.md created under it'
      );
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }

    assert.strictEqual(injected, true, 'the injection must have met the pre-read it models');
    assert.strictEqual(
      fs.readFileSync(hotPath, 'utf8'),
      winnerContent,
      'writer A’s hot.md must be byte-identical after writer B is refused'
    );
  });

  test('index.md gets the same protection when two rebuilds create it at once', async () => {
    const indexVault = path.join(vault, 'injected-index-vault');
    fs.mkdirSync(path.join(indexVault, '.palee', 'sessions'), { recursive: true });
    const indexPath = path.join(indexVault, '.palee', 'index.md');
    const winnerContent = '# Writer A built the index first\n';

    const originalReadFileSync = fs.readFileSync;
    let injected = false;
    try {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
        arg: unknown,
        encoding?: unknown
      ) => {
        if (!injected && arg === indexPath) {
          injected = true;
          fs.writeFileSync(indexPath, winnerContent, 'utf8');
          const enoent = new Error(`ENOENT: no such file or directory, open '${indexPath}'`) as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
        return (originalReadFileSync as (...a: unknown[]) => unknown)(arg, encoding);
      }) as typeof fs.readFileSync;

      await assert.rejects(
        () => regenerateIndex(indexVault),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}: ${e.message}`);
          return true;
        }
      );
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }

    assert.strictEqual(injected, true, 'the injection must have met the pre-read it models');
    assert.strictEqual(fs.readFileSync(indexPath, 'utf8'), winnerContent);
  });

  test('a session note created under a concurrent session end is not replaced', async () => {
    const sessionVault = path.join(vault, 'injected-session-vault');
    fs.mkdirSync(path.join(sessionVault, '.palee', 'sessions'), { recursive: true });
    const notePath = path.join(sessionVault, '.palee', 'sessions', 'S-20261010T000000-abcd.md');
    const winnerContent = '# Session written by the other process\n';

    const originalReadFileSync = fs.readFileSync;
    let injected = false;
    try {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
        arg: unknown,
        encoding?: unknown
      ) => {
        if (!injected && arg === notePath) {
          injected = true;
          fs.writeFileSync(notePath, winnerContent, 'utf8');
          const enoent = new Error(`ENOENT: no such file or directory, open '${notePath}'`) as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
        return (originalReadFileSync as (...a: unknown[]) => unknown)(arg, encoding);
      }) as typeof fs.readFileSync;

      await assert.rejects(
        () =>
          writeSessionNote(
            sessionVault,
            {
              session_id: 'S-20261010T000000-abcd',
              topic_id: 'T-1',
              started_at: '2026-10-10T00:00:00.000Z',
              ended_at: '2026-10-10T00:30:00.000Z',
            },
            'Body from the losing writer'
          ),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}: ${e.message}`);
          return true;
        }
      );
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }

    assert.strictEqual(injected, true, 'the injection must have met the pre-read it models');
    assert.strictEqual(fs.readFileSync(notePath, 'utf8'), winnerContent);
  });

  test('a creation claim that also carries a fingerprint is refused as a caller bug', async () => {
    const target = path.join(vault, 'contradictory.md');
    await assert.rejects(
      () => atomicWrite(vault, target, '# Content\n', computeFingerprint('# Content\n'), { expectExists: false }),
      (err: unknown) => {
        const e = err as Error & { code?: string };
        assert.strictEqual(e.code, 'ECONFLICT');
        assert.match(e.message, /cannot both be absent and carry a fingerprint/);
        return true;
      }
    );
    assert.strictEqual(fs.existsSync(target), false, 'a refused write moves no bytes');
  });
});

describe('an overwrite that states existence must state what it read (#334)', () => {
  let vault: string;

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-overwrite-guard-'));
  });

  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('expectExists true with no fingerprint is refused and leaves the note alone', async () => {
    const target = path.join(vault, 'adopted.md');
    const onDisk = '# Adopted content another process may have replaced\n';
    fs.writeFileSync(target, onDisk, 'utf8');

    await assert.rejects(
      () => atomicWrite(vault, target, '# Reverted content\n', null, { expectExists: true }),
      (err: unknown) => {
        const e = err as Error & { code?: string };
        assert.strictEqual(e.code, 'ECONFLICT', `expected ECONFLICT, got ${e.code}: ${e.message}`);
        assert.match(e.message, /overwrite carries no expectedFingerprint/);
        assert.strictEqual(isConflictError(err), true, 'the remedy is to re-read and retry, so it is a conflict');
        return true;
      }
    );

    assert.strictEqual(fs.readFileSync(target, 'utf8'), onDisk);
  });

  test('expectExists true with the fingerprint of what is on disk overwrites', async () => {
    const target = path.join(vault, 'revert.md');
    const adopted = '# Adopted by this process\n';
    fs.writeFileSync(target, adopted, 'utf8');

    // The shape `adopt.ts`’ rollback now uses: the note exists, and the caller knows
    // exactly what it wrote there.
    await atomicWrite(vault, target, '# Original\n', computeFingerprint(adopted), { expectExists: true });

    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Original\n');
  });

  test('expectExists true with a stale fingerprint still conflicts, with the same message as before', async () => {
    const target = path.join(vault, 'stale.md');
    fs.writeFileSync(target, '# Current\n', 'utf8');

    await assert.rejects(
      () => atomicWrite(vault, target, '# Ours\n', computeFingerprint('# What we read\n'), { expectExists: true }),
      (err: unknown) => {
        const e = err as Error & { code?: string };
        assert.strictEqual(e.code, 'ECONFLICT');
        assert.match(e.message, /was modified by another process/);
        return true;
      }
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Current\n');
  });
});
