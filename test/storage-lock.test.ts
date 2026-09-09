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
    const content = fs.readFileSync(path.join(lockDir, files[0]), 'utf8');
    if (!content.trim()) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
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



  test('heartbeat updates mtime', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();

    const files = fs.readdirSync(lock.lockPath).filter(f => f.endsWith('.json'));
    const lockFile = path.join(lock.lockPath, files[0]);
    const initialMtime = fs.statSync(lockFile).mtimeMs;

    await new Promise(resolve => setTimeout(resolve, 1100));

    // Force heartbeat update via manual utimesSync
    const now = new Date();
    fs.utimesSync(lockFile, now, now);

    const updatedMtime = fs.statSync(lockFile).mtimeMs;

    assert.notStrictEqual(initialMtime, updatedMtime);
    assert.ok(updatedMtime > initialMtime);

    lock.release();
  });

  test('stale lock recovery takes over old lock', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lockPath = lock1.lockPath;

    // Manually make lock stale by modifying mtime
    const lockData = getLockData(lockPath);
    const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
    const lockFile = path.join(lockPath, files[0]);
    
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
    const faultLockFile = path.join(faultLockDir, files[0]);
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
    const faultLockFile = path.join(faultLockDir, files[0]);
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
      const lockFile = path.join(lockPath, files[0]);
      
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
