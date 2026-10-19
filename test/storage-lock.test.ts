import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT } from '../src/storage/lock';
import { NodeError } from '../src/types';

function getLockData(lockDir: string) {
  if (!fs.existsSync(lockDir)) return null;
  try {
    const files = fs.readdirSync(lockDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    const [recordFile] = files;
    if (recordFile === undefined) return null;
    const content = fs.readFileSync(path.join(lockDir, recordFile), 'utf8');
    if (!content.trim()) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** One recorded `fs.utimesSync` call: the path it was given and both stamps. */
interface UtimesCall {
  file: string;
  atime: Parameters<typeof fs.utimesSync>[1];
  mtime: Parameters<typeof fs.utimesSync>[2];
}

/**
 * Records every `fs.utimesSync` call while still performing the real touch.
 *
 * @remarks
 * `src/storage/lock.ts` imports the same `fs` namespace object this file does, so
 * replacing the method here is what makes the heartbeat's own touch observable —
 * the same seam the `fs.rmdirSync` patch below uses, for the same reason. The
 * heartbeat is the ONLY production path that calls `utimesSync` (the whole of
 * `lock.ts` has one call site), so an empty record list proves nobody stamped
 * the lock file.
 *
 * @returns The live record list plus the function that puts `fs` back.
 */
function spyUtimesSync(): { calls: UtimesCall[]; restore: () => void } {
  const calls: UtimesCall[] = [];
  const originalUtimesSync = fs.utimesSync;
  (fs as unknown as { utimesSync: typeof fs.utimesSync }).utimesSync = function recordingUtimesSync(
    this: unknown,
    p: fs.PathLike,
    atime: Parameters<typeof fs.utimesSync>[1],
    mtime: Parameters<typeof fs.utimesSync>[2]
  ): void {
    if (typeof p === 'string') calls.push({ file: p, atime, mtime });
    return (originalUtimesSync as unknown as (...a: unknown[]) => void).call(this, p, atime, mtime);
  };
  return {
    calls,
    restore: () => {
      (fs as unknown as { utimesSync: typeof fs.utimesSync }).utimesSync = originalUtimesSync;
    },
  };
}

/** Path of the holder's session file, asserting the lock dir holds exactly one. */
function singleSessionFile(lockDir: string): string {
  const files = fs.readdirSync(lockDir).filter(f => f.endsWith('.json'));
  assert.strictEqual(files.length, 1, `precondition: one lock session file expected, found ${files.length}`);
  const sessionFile = files[0];
  assert.strictEqual(
    sessionFile,
    `${getLockData(lockDir).lock_id}.json`,
    `precondition: session file must be named after the lock id inside it, found ${sessionFile}`
  );
  return path.join(lockDir, sessionFile);
}

describe('File Locking', () => {
  let testVaultPath: string;
  let testFilePath: string;

  before(() => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-test-'));
  });

  beforeEach(() => {
    const locksDir = path.join(testVaultPath, '.palee', 'locks');
    fs.rmSync(locksDir, { recursive: true, force: true });
    testFilePath = path.join(testVaultPath, 'test-note-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(testFilePath, '# Test Note', 'utf8');
  });

  after(() => {
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  });

  test('acquires lock successfully', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();

    const lockPath = lock.lockPath;
    assert.ok(fs.existsSync(lockPath));

    const lockData = getLockData(lockPath);
    assert.ok(lockData);
    assert.ok(lockData.lock_id.startsWith('L-'));
    // #356: the id must carry the full 4 bytes (8 hex chars) of entropy, not a
    // narrower suffix — two locks minted in the same second are separated by this
    // alone, exactly as the session id is.
    assert.match(
      lockData.lock_id,
      /^L-\d{8}T\d{6}-[0-9a-f]{8}$/,
      `lock id must be L-<timestamp>-<8 hex>: ${lockData.lock_id}`
    );
    assert.strictEqual(lockData.pid, process.pid);
    assert.strictEqual(lockData.target, testFilePath);

    lock.release();
    assert.ok(getLockData(lockPath) === null);
  });

  test('second lock acquisition fails with conflict', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, testFilePath);
    await assert.rejects(
      async () => await lock2.acquire(),
      { message: /Lock conflict/ }
    );

    lock1.release();
  });

  test('lock release occurs after success', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();
    lock.release();
    assert.ok(getLockData(lock.lockPath) === null);
  });



  test('heartbeat timer stamps the held session file once per HEARTBEAT_INTERVAL (INV-05)', async (t) => {
    // INV-05: a held lock advertises its own liveness. The previous version of
    // this test slept 1100ms, called `fs.utimesSync` on the lock file ITSELF and
    // then asserted the mtime had moved — it manufactured the effect it credited
    // to production, so deleting `startHeartbeat()` from `acquire()` kept it
    // green. Here the only thing allowed to touch the file is the closure
    // production handed to `setInterval`, and the clock is a mock: the 15s
    // cadence is pinned by simulated elapsed time, with no sleep, no 1100ms
    // gamble, and no dependence on Windows mtime granularity.
    t.mock.timers.enable({ apis: ['setInterval'] });
    const spy = spyUtimesSync();

    const lock = new Lock(testVaultPath, testFilePath);
    try {
      await lock.acquire();
      const lockFile = singleSessionFile(lock.lockPath);

      // Armed, but nothing has elapsed. Neither this test nor production may have
      // stamped anything yet — this is the assertion the old test faked.
      assert.deepStrictEqual(
        spy.calls.map(c => c.file),
        [] as string[],
        'acquire() must not stamp the lock file; only the interval may'
      );

      // One millisecond short of the interval: still silent. A heartbeat armed on
      // a shorter delay fires inside this window and shows up as extra calls.
      t.mock.timers.tick(HEARTBEAT_INTERVAL - 1);
      assert.deepStrictEqual(
        spy.calls.map(c => c.file),
        [] as string[],
        `heartbeat must stay silent until ${HEARTBEAT_INTERVAL}ms has elapsed`
      );

      const startedAt = Date.now();
      t.mock.timers.tick(1);
      const endedAt = Date.now();

      assert.strictEqual(
        spy.calls.length,
        1,
        `expected exactly one heartbeat stamp at ${HEARTBEAT_INTERVAL}ms, got ${spy.calls.length}`
      );
      const [firstStamp] = spy.calls;
      assert.ok(firstStamp !== undefined);
      assert.strictEqual(
        firstStamp.file,
        lockFile,
        'heartbeat must stamp the session file this holder owns'
      );

      // The stamp has to be a live timestamp: `utimesSync` on `new Date(0)` would
      // arm the timer but make the lock look abandoned to every other process.
      const { atime, mtime } = firstStamp;
      assert.ok(
        atime instanceof Date && mtime instanceof Date,
        `heartbeat must pass Date stamps to utimesSync, got ${String(atime)} / ${String(mtime)}`
      );
      assert.ok(
        atime.getTime() >= startedAt && atime.getTime() <= endedAt,
        `heartbeat stamp must be the current clock, got ${atime.toISOString()} outside ${new Date(startedAt).toISOString()}..${new Date(endedAt).toISOString()}`
      );

      // `setInterval`, not a one-shot: a second period must stamp a second time.
      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(
        spy.calls.length,
        2,
        `heartbeat must repeat every ${HEARTBEAT_INTERVAL}ms, saw ${spy.calls.length} stamps after a second period`
      );
      const [, secondStamp] = spy.calls;
      assert.ok(secondStamp !== undefined);
      assert.strictEqual(secondStamp.file, lockFile, 'repeated heartbeat must re-stamp the same session file');
    } finally {
      spy.restore();
      lock.release();
    }
  });

  test('release clears the heartbeat interval so a dead holder stops claiming liveness (INV-05)', async (t) => {
    // The other half of the liveness contract: stop advertising once released.
    // Nothing else in the suite can see a leaked interval — `release()` unlinks the
    // session file either way, and a tick after that reads ENOENT and self-clears
    // (`updateHeartbeat` returns 'lost'). The recorder sees the attempt regardless
    // of the outcome, so an interval left running after release still shows up here.
    t.mock.timers.enable({ apis: ['setInterval'] });
    const spy = spyUtimesSync();

    const lock = new Lock(testVaultPath, testFilePath);
    try {
      await lock.acquire();
      const lockFile = singleSessionFile(lock.lockPath);

      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(spy.calls.length, 1, 'precondition: the heartbeat stamps once per interval');
      const [heldStamp] = spy.calls;
      assert.ok(heldStamp !== undefined);
      assert.strictEqual(heldStamp.file, lockFile, 'precondition: that stamp is this session file');

      lock.release();
      spy.calls.length = 0;

      // Three full periods with nobody holding the lock. If the interval survived
      // `release()` the touch still happens (its ENOENT is caught by
      // `updateHeartbeat`), so a leaked timer is recorded here rather than thrown.
      t.mock.timers.tick(HEARTBEAT_INTERVAL * 3);
      assert.deepStrictEqual(
        spy.calls.map(c => c.file),
        [] as string[],
        'release() must clear the heartbeat interval'
      );
    } finally {
      spy.restore();
      lock.release();
    }
  });

  test('stale lock recovery takes over old lock', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lockPath = lock1.lockPath;

    // Manually make lock stale by modifying mtime
    const lockData = getLockData(lockPath);
    const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
    const [lockFileName] = files;
    assert.ok(lockFileName !== undefined);
    const lockFile = path.join(lockPath, lockFileName);
    
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 1000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    // Don't release lock1 - leave it in stale state
    const lock2 = new Lock(testVaultPath, testFilePath);

    // Should succeed after detecting stale lock and taking it over
    await lock2.acquire();

    const newLockData = getLockData(lockPath);
    assert.notStrictEqual(newLockData.lock_id, lockData.lock_id);
    assert.strictEqual(newLockData.pid, process.pid);

    lock2.release();
  });

  test('dead-process lock on this host is reclaimed before STALE_TIMEOUT', async () => {
    // Simulate a holder that crashed without releasing: a lock file recorded on
    // THIS host whose PID no longer exists. The same-host liveness probe should
    // treat it as stale immediately, without waiting out STALE_TIMEOUT.
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();
    const lockPath = lock1.lockPath;

    const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
    const [lockFileName] = files;
    assert.ok(lockFileName !== undefined);
    const lockFile = path.join(lockPath, lockFileName);
    const original = JSON.parse(fs.readFileSync(lockFile, 'utf8'));

    // Find a PID that is not running, using the same signal-0 check the
    // implementation relies on.
    let deadPid = 999999;
    for (let candidate = 999999; candidate > 1; candidate--) {
      try {
        process.kill(candidate, 0);
      } catch (e) {
        if ((e as NodeError).code === 'ESRCH') { deadPid = candidate; break; }
      }
    }

    // Rewrite the lock file: current hostname, a dead PID, and a FRESH mtime so
    // only the liveness probe — not the timeout — can mark it stale.
    const stale = { ...original, pid: deadPid, hostname: os.hostname() };
    fs.writeFileSync(lockFile, JSON.stringify(stale, null, 2), 'utf8');
    const now = new Date();
    fs.utimesSync(lockFile, now, now);

    // A second acquisition must take over the dead holder's lock immediately.
    const lock2 = new Lock(testVaultPath, testFilePath);
    await lock2.acquire();

    const newLockData = getLockData(lockPath);
    assert.strictEqual(newLockData.pid, process.pid);
    assert.notStrictEqual(newLockData.lock_id, stale.lock_id);

    lock2.release();
  });

  test('stale timeout is platform-specific', () => {
    if (process.platform === 'win32') {
      assert.strictEqual(STALE_TIMEOUT, 60000); // 60s on Windows
    } else {
      assert.strictEqual(STALE_TIMEOUT, 120000); // 120s elsewhere
    }
  });

  test('heartbeat interval is 15 seconds', () => {
    assert.strictEqual(HEARTBEAT_INTERVAL, 15000);
  });

  test('lock release handles already-released lock', () => {
    const lock = new Lock(testVaultPath, testFilePath);
    assert.doesNotThrow(() => lock.release());
  });

  test('validates lock collision throws ECONFLICT', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, testFilePath);
    try {
      let err: any;
      try {
        await lock2.acquire();
      } catch (e) {
        err = e;
      }

      assert.ok(err, 'Expected error to be thrown');
      assert.strictEqual(err.code, 'ECONFLICT');
    } finally {
      lock1.release();
      lock2.release();
    }
  });

  test('lock identity is consistent across symlinks', async () => {
    const symlinkPath = path.join(testVaultPath, 'symlink-note.md');
    try {
      fs.symlinkSync(path.basename(testFilePath), symlinkPath);
    } catch (e: any) {
      if (e.code === 'EPERM' || e.code === 'ENOTSUP') return; // Skip if symlinks require admin
      throw e;
    }

    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, symlinkPath);
    try {
      let err: any;
      try {
        await lock2.acquire();
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'Expected error to be thrown');
      assert.strictEqual(err.code, 'ECONFLICT');
    } finally {
      lock1.release();
      lock2.release();
    }
  });

  test('stale-lock recovery retries EPERM/EBUSY up to the budget and rethrows', { timeout: 10000 }, async () => {
    // Pin the bounded-retry contract from `createLock`'s stale-recovery path.
    // Without this, a future refactor that drops the budget (e.g. back to a
    // bare `continue` inside `while (true)`) would re-introduce the
    // unbounded-busy-spin hang this PR was meant to remove, and CI would not
    // catch it because the existing 11 tests only exercise the happy path.
    //
    // We monkey-patch the global `fs.rmdirSync` so that every rmdirSync
    // `createLock` issues on the lock directory (after quarantining all stale
    // session files) throws a synthetic `EPERM`. On Windows the bounded retry
    // loop will spin through its 5-attempt budget and then rethrow the
    // original error. On non-Windows the platform gate in
    // `src/storage/lock.ts` skips the retry and rethrows immediately. Either
    // way the call must surface a thrown error. The setTimeout watchdog below
    // only detects hangs on the ASYNCHRONOUS path (acquire() is async, so a
    // hang before the synchronous createLock section can still tick timers);
    // a regression to an unbounded SYNCHRONOUS spin would freeze the event
    // loop and bypass the watchdog — the per-test `timeout` above is what
    // bounds that case, since the test runner supervises each child process
    // from outside.
    const isWindows = process.platform === 'win32';

    // Set up a vault + a target file the same way the other stale tests do.
    const faultVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-fault-'));
    const faultFile = path.join(faultVault, 'fault-target-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(faultFile, '# Fault Target', 'utf8');

    // Acquire a lock, then age it past the stale threshold so the next
    // acquisition enters stale-recovery and reaches the rmdirSync call.
    const seedLock = new Lock(faultVault, faultFile);
    await seedLock.acquire();
    const faultLockDir = seedLock.lockPath;

    const files = fs.readdirSync(faultLockDir).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0, 'precondition: seed lock should have a session file');
    const [faultLockFileName] = files;
    assert.ok(faultLockFileName !== undefined);
    const faultLockFile = path.join(faultLockDir, faultLockFileName);
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 5000);
    fs.utimesSync(faultLockFile, staleTime, staleTime);
    // Stop the heartbeat so it cannot refresh the lock mid-test.
    const seedTimer = (seedLock as unknown as { heartbeatTimer: ReturnType<typeof setInterval> | null }).heartbeatTimer;
    if (seedTimer) clearInterval(seedTimer);

    // Monkey-patch fs.rmdirSync. The same `fs` module instance is shared by
    // lock.ts because both files import `fs from 'fs'`, so this intercepts
    // the rmdirSync call inside `createLock`'s stale-recovery path.
    const originalRmdirSync = fs.rmdirSync;
    let rmdirCalls = 0;
    (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = function patchedRmdirSync(
      this: unknown,
      p: fs.PathLike,
      ...rest: unknown[]
    ): void {
      if (typeof p === 'string' && p === faultLockDir) {
        rmdirCalls += 1;
        const e = new Error('simulated EPERM for stale-recovery budget test') as NodeError;
        e.code = 'EPERM';
        throw e;
      }
      return (originalRmdirSync as unknown as (...a: unknown[]) => void).call(
        this,
        p as fs.PathLike,
        ...rest
      );
    };

    // Wall-clock watchdog. If `acquire` does not throw within `WATCHDOG_MS`,
    // the bounded-retry contract has regressed to an unbounded busy-spin
    // and the test must fail loudly. The contract guarantees completion well
    // under 2s on either platform (5 attempts × max 300ms each on Windows;
    // immediate rethrow on non-Windows), so 5s is a generous safety margin.
    const WATCHDOG_MS = 5000;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          `stale-recovery hung past ${WATCHDOG_MS}ms watchdog — retry is unbounded`
        ));
      }, WATCHDOG_MS);
    });

    try {
      const acquirer = new Lock(faultVault, faultFile);
      const acquirePromise = acquirer.acquire();
      await assert.rejects(
        Promise.race([acquirePromise, watchdog]),
        (err: Error & { code?: string }) => {
          // Watchdog rejection (no code) signals an unbounded regression.
          if (!err.code) return false;
          return err.code === 'EPERM';
        },
        'expected stale-recovery to surface EPERM after the retry budget'
      );
    } finally {
      if (timer) clearTimeout(timer);
      (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = originalRmdirSync;
      seedLock.release();
      try { fs.rmSync(faultVault, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    // Sanity: the patched rmdirSync must have been entered at least once.
    // (On non-Windows, rmdirSync is called once before the platform gate
    // rejects the retry path; on Windows, the bounded retry calls it at
    // least once and the loop's first attempt may also consume it.)
    assert.ok(
      rmdirCalls >= 1,
      `expected at least one intercepted rmdirSync call on lockDir (got ${rmdirCalls})`
    );
    // Cross-platform note (informational; not an assertion):
    // isWindows === true  -> bounded retry runs; with an always-throwing
    //   mock the intercepted calls are WINDOWS_RETRY_ATTEMPTS (5) retry
    //   attempts plus the initial rmdirSync before the retry loop — 6 total.
    // isWindows === false -> platform gate skips the retry loop, so exactly
    //   1 rmdirSync call is intercepted.
    void isWindows;
  });

  test('stale-lock recovery succeeds when the final retry attempt clears the handle', { timeout: 10000 }, async () => {
    // Regression pin for the off-by-one Greptile/Kilo flagged on the first
    // cut of the retry budget: when the last permitted attempt's rmdirSync
    // succeeds, the loop must fall through to re-acquisition — deriving the
    // outcome from the attempt count alone made the 5th attempt's success
    // rethrow the original EPERM anyway. Windows-only: the retry budget is
    // gated on process.platform.
    if (process.platform !== 'win32') return;

    const RETRY_BUDGET = 5; // mirrors WINDOWS_RETRY_ATTEMPTS in src/storage/lock.ts

    const faultVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-last-'));
    const faultFile = path.join(faultVault, 'fault-target-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(faultFile, '# Fault Target', 'utf8');

    const seedLock = new Lock(faultVault, faultFile);
    await seedLock.acquire();
    const faultLockDir = seedLock.lockPath;
    const seedLockData = getLockData(faultLockDir);
    assert.ok(seedLockData, 'precondition: seed lock should parse');

    const files = fs.readdirSync(faultLockDir).filter(f => f.endsWith('.json'));
    const [faultLockFileName] = files;
    assert.ok(faultLockFileName !== undefined);
    const faultLockFile = path.join(faultLockDir, faultLockFileName);
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 5000);
    fs.utimesSync(faultLockFile, staleTime, staleTime);
    const seedTimer = (seedLock as unknown as { heartbeatTimer: ReturnType<typeof setInterval> | null }).heartbeatTimer;
    if (seedTimer) clearInterval(seedTimer);

    // Throw EPERM for the initial rmdirSync plus the first four retry
    // attempts; the next call — the final permitted attempt — lets the real
    // rmdirSync run and succeed on the now-empty directory.
    const originalRmdirSync = fs.rmdirSync;
    let rmdirCalls = 0;
    (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = function patchedRmdirSync(
      this: unknown,
      p: fs.PathLike,
      ...rest: unknown[]
    ): void {
      if (typeof p === 'string' && p === faultLockDir) {
        rmdirCalls += 1;
        if (rmdirCalls <= RETRY_BUDGET) {
          const e = new Error('simulated EPERM for final-attempt recovery test') as NodeError;
          e.code = 'EPERM';
          throw e;
        }
      }
      return (originalRmdirSync as unknown as (...a: unknown[]) => void).call(
        this,
        p as fs.PathLike,
        ...rest
      );
    };

    try {
      const acquirer = new Lock(faultVault, faultFile);
      await acquirer.acquire();
      assert.strictEqual(rmdirCalls, RETRY_BUDGET + 1);
      const newLockData = getLockData(faultLockDir);
      assert.ok(newLockData, 'expected a live lock after recovery');
      assert.notStrictEqual(newLockData.lock_id, seedLockData.lock_id);
      acquirer.release();
    } finally {
      (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = originalRmdirSync;
      seedLock.release();
      try { fs.rmSync(faultVault, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('validates Windows specific stale lock timing behavior', async () => {
    // Only run this test logic if on Windows, but the test passes universally by skipping on non-Windows
    if (process.platform !== 'win32') {
      return; 
    }

    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();
    const lock2 = new Lock(testVaultPath, testFilePath);

    try {
      const lockPath = lock1.lockPath;
      const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
      const [lockFileName] = files;
      assert.ok(lockFileName !== undefined);
      const lockFile = path.join(lockPath, lockFileName);
      
      // Stop the heartbeat so it doesn't refresh concurrently with our manual aging
      clearInterval((lock1 as any).heartbeatTimer);

      // Set exactly to 59 seconds ago (just under Windows 60s timeout)
      const activeTime = new Date(Date.now() - 59000);
      fs.utimesSync(lockFile, activeTime, activeTime);

      // Should still fail with ECONFLICT because it hasn't reached 60s
      await assert.rejects(
        async () => await lock2.acquire(),
        { code: 'ECONFLICT' }
      );

      // Now set exactly to 61 seconds ago (just over Windows 60s timeout)
      const staleTime = new Date(Date.now() - 61000);
      fs.utimesSync(lockFile, staleTime, staleTime);

      // Should succeed because it exceeded 60s
      await assert.doesNotReject(
        async () => await lock2.acquire()
      );
    } finally {
      lock1.release();
      lock2.release();
    }
  });
});
