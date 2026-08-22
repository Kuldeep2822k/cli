import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, isConflictError } from '../src/storage/atomic-write';
import { computeFingerprint } from '../src/storage/frontmatter';

describe('Atomic Write', () => {
  let testVaultPath: string;
  let testFilePath: string;

  before(() => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-write-test-'));
    fs.mkdirSync(path.join(testVaultPath, '.palee', 'locks'), { recursive: true });
    testFilePath = path.join(testVaultPath, 'test-note.md');
  });

  after(() => {
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  });

  test('writes new file successfully', async () => {
    const content = '# Test Note\n\nContent here.';
    await atomicWrite(testVaultPath, testFilePath, content);

    assert.ok(fs.existsSync(testFilePath));
    const written = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(written, content);
  });

  test('OCC detects concurrent modification', async () => {
    const originalContent = '# Original';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const fingerprint = computeFingerprint(originalContent);

    // Modify file externally
    fs.writeFileSync(testFilePath, '# Modified Externally', 'utf8');

    // Attempt write with stale fingerprint
    await assert.rejects(
      async () => await atomicWrite(testVaultPath, testFilePath, '# My Update', fingerprint),
      { message: /OCC conflict/ }
    );

    // Original external modification should be preserved
    const current = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(current, '# Modified Externally');
  });

  test('OCC allows write when fingerprint matches', async () => {
    const originalContent = '# Original Content';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const fingerprint = computeFingerprint(originalContent);

    const newContent = '# Updated Content';
    await atomicWrite(testVaultPath, testFilePath, newContent, fingerprint);

    const written = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(written, newContent);
  });

  test('write leaves target untouched on failure', async () => {
    const originalContent = '# Original';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const wrongFingerprint = 'invalid-fingerprint';

    try {
      await atomicWrite(testVaultPath, testFilePath, '# New', wrongFingerprint);
    } catch {
      // Expected to fail
    }

    const current = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(current, originalContent, 'Target should be unchanged after failed write');
  });

  test('no temp file remains after successful write', async () => {
    await atomicWrite(testVaultPath, testFilePath, '# Clean Write');

    const files = fs.readdirSync(testVaultPath);
    const hasTempFile = files.some(f => f.includes('.tmp.'));
    assert.strictEqual(hasTempFile, false);
  });

  test('no temp file remains after failed write', async () => {
    const originalContent = '# Original';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');

    try {
      await atomicWrite(testVaultPath, testFilePath, '# New', 'wrong-fp');
    } catch {
      // Expected
    }

    const files = fs.readdirSync(testVaultPath);
    const hasTempFile = files.some(f => f.includes('.tmp.'));
    assert.strictEqual(hasTempFile, false);
  });

  test('concurrent write attempts serialize via locks', async () => {
    const content1 = '# Writer 1';
    const content2 = '# Writer 2';

    // Start two writes concurrently
    const write1 = atomicWrite(testVaultPath, testFilePath, content1);
    const write2 = atomicWrite(testVaultPath, testFilePath, content2);

    // One should succeed, other should fail with lock conflict
    const results = await Promise.allSettled([write1, write2]);

    const succeeded = results.filter(r => r.status === 'fulfilled');

    // At least one should succeed (lock serialization)
    assert.ok(succeeded.length >= 1);

    // File should contain one of the writes
    const final = fs.readFileSync(testFilePath, 'utf8');
    assert.ok(final === content1 || final === content2);
  });

  test('OCC conflict sets ECONFLICT error code', async () => {
    const originalContent = '# OCC Code Check';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const fingerprint = computeFingerprint(originalContent);

    // Modify file externally
    fs.writeFileSync(testFilePath, '# OCC Modified Externally', 'utf8');

    try {
      await atomicWrite(testVaultPath, testFilePath, '# My Update', fingerprint);
      assert.fail('Expected atomicWrite to throw on OCC conflict');
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      assert.strictEqual(err.code, 'ECONFLICT');
      assert.match(err.message || '', /OCC conflict/);
      assert.strictEqual(isConflictError(e), true);
    }
  });

  test('isConflictError helper correctly classifies error objects', () => {
    assert.strictEqual(isConflictError({ code: 'ECONFLICT' }), true);
    assert.strictEqual(isConflictError(new Error('OCC conflict: target modified')), true);
    assert.strictEqual(isConflictError(new Error('Lock conflict: target locked by PID 123')), true);
    assert.strictEqual(isConflictError(new Error('Generic file read failure')), false);
    assert.strictEqual(isConflictError(null), false);
    assert.strictEqual(isConflictError(undefined), false);
    assert.strictEqual(isConflictError('some string error'), false);
    assert.strictEqual(isConflictError(123), false);
  });
});
