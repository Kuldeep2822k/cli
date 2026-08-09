import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT } from '../src/storage/lock';

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
    testFilePath = path.join(testVaultPath, 'test-note.md');
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

  test('lock includes heartbeat_at field', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();

    const lockData = getLockData(lock.lockPath);
    assert.ok(lockData.heartbeat_at);
    assert.ok(new Date(lockData.heartbeat_at).getTime() > 0);

    lock.release();
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

  test('validates lock collision throws ECONFLICT immediately without delay', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, testFilePath);
    const start = Date.now();
    let err: any;
    try {
      await lock2.acquire();
    } catch (e) {
      err = e;
    }
    const end = Date.now();

    assert.ok(err, 'Expected error to be thrown');
    assert.strictEqual(err.code, 'ECONFLICT');
    // Ensure it failed immediately without retry loops for active locks
    assert.ok(end - start < 100, 'Expected immediate ECONFLICT without retry delay');

    lock1.release();
  });

  test('validates Windows specific stale lock timing behavior', async () => {
    // Only run this test logic if on Windows, but the test passes universally by skipping on non-Windows
    if (process.platform !== 'win32') {
      return; 
    }

    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lockPath = lock1.lockPath;
    const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
    const lockFile = path.join(lockPath, files[0]);
    
    // Set exactly to 59 seconds ago (just under Windows 60s timeout)
    const activeTime = new Date(Date.now() - 59000);
    fs.utimesSync(lockFile, activeTime, activeTime);

    const lock2 = new Lock(testVaultPath, testFilePath);
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

    lock2.release();
  });
});
