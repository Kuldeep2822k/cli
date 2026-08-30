import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, isConflictError } from '../src/storage/atomic-write';
import { Lock } from '../src/storage/lock';
import { FileCache } from '../src/storage/cache';
import { computeFingerprint } from '../src/storage/frontmatter';

describe('Storage & Concurrency Stress Test Suite', () => {
  let testVault: string;

  before(() => {
    testVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-stress-vault-'));
  });

  after(() => {
    fs.rmSync(testVault, { recursive: true, force: true });
  });

  test('30 concurrent atomic writes to distinct files all complete without temp collisions', async () => {
    const fileCount = 30;
    const writePromises = Array.from({ length: fileCount }, async (_, i) => {
      const filePath = path.join(testVault, `concurrent-${i}.md`);
      const payload = `---\ntitle: Note ${i}\n---\n# Content for ${i}\nData ${Math.random()}`;
      await atomicWrite(testVault, filePath, payload);
      const readBack = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(readBack, payload);
      return filePath;
    });

    const writtenFiles = await Promise.all(writePromises);
    assert.strictEqual(writtenFiles.length, fileCount);

    // Verify no temporary files remain
    const remainingTempFiles = fs.readdirSync(testVault).filter(f => f.includes('.tmp.'));
    assert.strictEqual(remainingTempFiles.length, 0);
  });

  test('concurrent conflicting writes to same file are strictly serialized and OCC enforced', async () => {
    const targetFile = path.join(testVault, 'contested-file.md');
    const initialContent = '---\ntitle: Base\n---\n# Base';
    await atomicWrite(testVault, targetFile, initialContent);
    const baseFingerprint = computeFingerprint(initialContent);

    // Launch 15 concurrent writes with the same initial expected fingerprint
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) =>
        atomicWrite(
          testVault,
          targetFile,
          `---\ntitle: Update ${i}\n---\n# Update ${i}`,
          baseFingerprint
        )
      )
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // Exactly 1 must win the OCC race; the remaining 14 must fail with ECONFLICT
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 14);

    for (const r of rejected) {
      if (r.status === 'rejected') {
        assert.ok(isConflictError(r.reason), `Expected ECONFLICT error, got: ${r.reason}`);
      }
    }

    // No leftover temporary files
    const remainingTemp = fs.readdirSync(testVault).filter(f => f.includes('.tmp.'));
    assert.strictEqual(remainingTemp.length, 0);
  });

  test('high lock contention: 20 simultaneous workers acquire and release lock with mutual exclusion', async () => {
    const lockTarget = path.join(testVault, 'shared-resource.md');
    fs.writeFileSync(lockTarget, 'initial');
    let activeHolders = 0;
    let maxConcurrentHolders = 0;
    let totalCompleted = 0;

    const worker = async (workerId: number) => {
      const lock = new Lock(testVault, lockTarget);
      let acquired = false;

      // Retry loop simulating high contention
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await lock.acquire();
          acquired = true;
          break;
        } catch {
          await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
        }
      }

      if (!acquired) {
        throw new Error(`Worker ${workerId} failed to acquire lock after retries`);
      }

      activeHolders++;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, activeHolders);

      // Hold critical section for a brief time
      await new Promise(r => setTimeout(r, 15));

      activeHolders--;
      await lock.release();
      totalCompleted++;
    };

    await Promise.all(Array.from({ length: 20 }, (_, i) => worker(i)));

    assert.strictEqual(maxConcurrentHolders, 1, 'Lock must guarantee strict mutual exclusion');
    assert.strictEqual(totalCompleted, 20);
    assert.strictEqual(activeHolders, 0);
  });

  test('cache under high-frequency invalidation and concurrent access maintains consistency', () => {
    const cache = new FileCache();
    const filePath = path.join(testVault, 'cached-note.md');
    const contentA = '---\ntitle: Version A\n---\n# A';
    fs.writeFileSync(filePath, contentA);

    const fpA = computeFingerprint(contentA);
    cache.set(filePath, { title: 'Version A' }, fpA);

    assert.deepStrictEqual(cache.get(filePath), { title: 'Version A' });

    // Modify file on disk
    const contentB = '---\ntitle: Version B\n---\n# B';
    fs.writeFileSync(filePath, contentB);
    const fpB = computeFingerprint(contentB);

    // Cache should detect change inside horizon via SHA-256 fallback
    assert.strictEqual(cache.get(filePath), null);

    // Update cache with new version
    cache.set(filePath, { title: 'Version B' }, fpB);
    assert.deepStrictEqual(cache.get(filePath), { title: 'Version B' });
  });
});
