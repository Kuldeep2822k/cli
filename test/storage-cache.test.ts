import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileCache, UNSETTLED_HORIZON } from '../src/storage/cache';
import { computeFingerprint } from '../src/storage/frontmatter';

describe('File Cache', () => {
  let testDir: string;
  let testFile: string;
  let cache: FileCache;

  before(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-cache-test-'));
    testFile = path.join(testDir, 'test.md');
    cache = new FileCache();
  });

  after(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('unsettled horizon is 2 seconds', () => {
    assert.strictEqual(UNSETTLED_HORIZON, 2000);
  });

  test('cache miss returns null', () => {
    const result = cache.get('/nonexistent/file.md');
    assert.strictEqual(result, null);
  });

  test('cache hit returns data', () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    cache.set(testFile, { title: 'Test' }, fingerprint);
    const cached = cache.get(testFile);

    assert.deepStrictEqual(cached, { title: 'Test' });
  });

  test('cache invalidates on size mismatch', () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    cache.set(testFile, { title: 'Test' }, fingerprint);

    // Modify file
    fs.writeFileSync(testFile, '# Test\n\nMore content', 'utf8');

    const cached = cache.get(testFile);
    assert.strictEqual(cached, null, 'Cache should invalidate on size change');
  });

  test('cache recomputes fingerprint within unsettled horizon', () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    cache.set(testFile, { title: 'Test' }, fingerprint);

    // File is fresh - within 2 seconds
    // Modify content but keep same size
    const newContent = '# Best';
    assert.strictEqual(newContent.length, content.length);
    fs.writeFileSync(testFile, newContent, 'utf8');

    const cached = cache.get(testFile);
    assert.strictEqual(cached, null, 'Cache should invalidate when fingerprint changes within unsettled horizon');
  });

  test('cache hit outside unsettled horizon with mtime match', async () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    // Set file mtime to 3 seconds ago (outside unsettled horizon)
    const oldTime = (Date.now() - 3000) / 1000;
    fs.utimesSync(testFile, oldTime, oldTime);

    cache.set(testFile, { title: 'Test' }, fingerprint);

    const cached = cache.get(testFile);
    assert.deepStrictEqual(cached, { title: 'Test' }, 'Cache should hit outside unsettled horizon');
  });

  test('invalidate removes entry', () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    cache.set(testFile, { title: 'Test' }, fingerprint);
    cache.invalidate(testFile);

    const cached = cache.get(testFile);
    assert.strictEqual(cached, null);
  });

  test('clear removes all entries', () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    cache.set(testFile, { title: 'Test' }, fingerprint);
    cache.clear();

    const cached = cache.get(testFile);
    assert.strictEqual(cached, null);
  });

  test('cache handles file deletion gracefully', () => {
    const content = '# Test';
    fs.writeFileSync(testFile, content, 'utf8');
    const fingerprint = computeFingerprint(content);

    cache.set(testFile, { title: 'Test' }, fingerprint);
    fs.unlinkSync(testFile);

    const cached = cache.get(testFile);
    assert.strictEqual(cached, null, 'Cache should return null for deleted files');
  });
});
