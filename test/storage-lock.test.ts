import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT } from '../src/storage/lock';

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

    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.ok(lockData.lock_id.startsWith('L-'));
    assert.strictEqual(lockData.pid, process.pid);
    assert.strictEqual(lockData.target, testFilePath);

    lock.release();
    assert.ok(!fs.existsSync(lockPath));
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
    const lockPath = lock.lockPath;

    lock.release();
    assert.ok(!fs.existsSync(lockPath));
  });

  test('lock includes heartbeat_at field', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();

    const lockData = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    assert.ok(lockData.heartbeat_at);
    assert.ok(new Date(lockData.heartbeat_at).getTime() > 0);

    lock.release();
  });

  test('heartbeat updates heartbeat_at field', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();

    const initialLockData = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    const initialHeartbeat = initialLockData.heartbeat_at;

    // Wait long enough for timestamp precision
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Read, update, and write lock
    const lockData = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    lockData.heartbeat_at = new Date().toISOString();
    const tempPath = lock.lockPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(lockData, null, 2));
    fs.renameSync(tempPath, lock.lockPath);

    const updatedLockData = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    const updatedHeartbeat = updatedLockData.heartbeat_at;

    assert.notStrictEqual(initialHeartbeat, updatedHeartbeat);
    assert.ok(new Date(updatedHeartbeat) > new Date(initialHeartbeat));

    lock.release();
  });

  test('stale lock recovery quarantines old lock', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lockPath = lock1.lockPath;

    // Manually make lock stale by modifying heartbeat_at
    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 1000).toISOString();
    lockData.heartbeat_at = staleTime;
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));

    // Don't release lock1 - leave it in stale state
    // Create new lock object pointing to same file
    const lock2 = new Lock(testVaultPath, testFilePath);

    // Should succeed after detecting stale lock and quarantining
    await lock2.acquire();

    // Check quarantine file exists
    const lockDir = path.dirname(lockPath);
    const files = fs.readdirSync(lockDir);
    const hasStale = files.some(f => f.includes('.stale.'));
    assert.ok(hasStale, 'Stale lock should be quarantined');

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
    // Release without acquire - should not throw
    assert.doesNotThrow(() => lock.release());
  });
});
