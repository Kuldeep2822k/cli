import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileCache, UNSETTLED_HORIZON, MAX_CACHE_ENTRIES } from '../src/storage/cache';
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

  test('fingerprint fallback catches same-second edit outside horizon (#367)', () => {
    const original = '# Test';
    fs.writeFileSync(testFile, original, 'utf8');

    // Pin a whole-second mtime well outside the unsettled horizon. On a
    // whole-second mtime the sub-second component is absent, so mtime equality
    // alone cannot distinguish a same-second edit.
    const pinnedSec = Math.floor((Date.now() - 10000) / 1000);
    fs.utimesSync(testFile, pinnedSec, pinnedSec);

    cache.set(testFile, { title: 'Original' }, computeFingerprint(original));

    // Edit the file in place, same byte length, then force the identical
    // whole-second mtime back so the mtime check would report a false hit.
    const edited = '# Best';
    assert.strictEqual(edited.length, original.length);
    fs.writeFileSync(testFile, edited, 'utf8');
    fs.utimesSync(testFile, pinnedSec, pinnedSec);

    const cached = cache.get(testFile);
    assert.strictEqual(
      cached,
      null,
      'Fingerprint fallback should detect the changed content the mtime check misses',
    );
  });

  test('cache evicts past the cap, oldest lastVerified first (#368)', () => {
    const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-cache-cap-'));
    try {
      const cap = 3;
      const bounded = new FileCache<{ id: number }>(cap);
      const files: string[] = [];

      // Fill the cache exactly to its cap. Each set() stamps lastVerified, so
      // files[0] is the least-recently-verified entry.
      for (let i = 0; i < cap; i++) {
        const f = path.join(capDir, `note-${i}.md`);
        const body = `# Note ${i}`;
        fs.writeFileSync(f, body, 'utf8');
        bounded.set(f, { id: i }, computeFingerprint(body));
        files.push(f);
      }

      // All cap entries are present.
      for (let i = 0; i < cap; i++) {
        assert.deepStrictEqual(bounded.get(files[i]), { id: i });
      }

      // get() above refreshed lastVerified for files[0..cap-1] in order, so
      // files[0] is once again the oldest. Insert one more over the cap.
      const overflow = path.join(capDir, 'note-overflow.md');
      const overflowBody = '# Overflow';
      fs.writeFileSync(overflow, overflowBody, 'utf8');
      bounded.set(overflow, { id: 999 }, computeFingerprint(overflowBody));

      // The oldest-lastVerified entry (files[0]) must have been evicted.
      assert.strictEqual(
        bounded.get(files[0]),
        null,
        'Oldest-lastVerified entry should be evicted once the cap is exceeded',
      );
      // Newer entries and the overflow entry survive.
      assert.deepStrictEqual(bounded.get(files[1]), { id: 1 });
      assert.deepStrictEqual(bounded.get(files[cap - 1]), { id: cap - 1 });
      assert.deepStrictEqual(bounded.get(overflow), { id: 999 });
    } finally {
      fs.rmSync(capDir, { recursive: true, force: true });
    }
  });

  test('default cache cap is a bounded positive constant (#368)', () => {
    assert.ok(Number.isInteger(MAX_CACHE_ENTRIES) && MAX_CACHE_ENTRIES > 0);
  });
});
