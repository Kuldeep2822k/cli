import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as storage from '../src/storage';
import * as index from '../src/index';

describe('Storage Barrel Census & Public Surface (Issue #131)', () => {
  describe('Public Exports Presence', () => {
    it('exports all expected production and contract functions', () => {
      // Vault operations
      assert.strictEqual(typeof storage.walkVault, 'function');
      assert.strictEqual(typeof storage.ensureVaultDirectory, 'function');
      assert.strictEqual(typeof storage.loadTopics, 'function');

      // Pattern & tag operations
      assert.strictEqual(typeof storage.matchesPattern, 'function');
      assert.strictEqual(typeof storage.matchesTags, 'function');
      assert.strictEqual(typeof storage.extractTags, 'function');
      assert.strictEqual(typeof storage.validatePattern, 'function');

      // Roadmap operations
      assert.strictEqual(typeof storage.parseRoadmapContent, 'function');

      // Frontmatter operations
      assert.strictEqual(typeof storage.parseFrontmatter, 'function');
      assert.strictEqual(typeof storage.updateFrontmatter, 'function');
      assert.strictEqual(typeof storage.computeFingerprint, 'function');

      // Locking & OCC
      assert.strictEqual(typeof storage.Lock, 'function');
      assert.strictEqual(typeof storage.atomicWrite, 'function');
      assert.strictEqual(typeof storage.isConflictError, 'function');

      // Caching
      assert.strictEqual(typeof storage.FileCache, 'function');
      assert.strictEqual(typeof storage.UNSETTLED_HORIZON, 'number');

      // Memory & session
      assert.strictEqual(typeof storage.generateSessionId, 'function');
      assert.strictEqual(typeof storage.generateDraftId, 'function');
      assert.strictEqual(typeof storage.formatDateOnly, 'function');
      assert.strictEqual(typeof storage.writeSessionNote, 'function');
      assert.strictEqual(typeof storage.updateHotMemory, 'function');
      assert.strictEqual(typeof storage.resetHotMemory, 'function');
      assert.strictEqual(typeof storage.regenerateIndex, 'function');
      assert.strictEqual(typeof storage.rebuildHotAndIndex, 'function');
      assert.strictEqual(typeof storage.writeDraftCheckpoint, 'function');
      assert.strictEqual(typeof storage.getDrafts, 'function');
      assert.strictEqual(typeof storage.getTopicDrafts, 'function');
      assert.strictEqual(typeof storage.deleteTopicDrafts, 'function');
      assert.strictEqual(typeof storage.deleteSessionNote, 'function');
      assert.strictEqual(typeof storage.recoverDraft, 'function');
    });

    it('exports all reserved symbols with correct types and behavior', () => {
      // getTopicCache (reserved for #129)
      assert.strictEqual(typeof storage.getTopicCache, 'function');
      const cache = storage.getTopicCache();
      assert.ok(cache instanceof storage.FileCache);

      // countWords (reserved for #43)
      assert.strictEqual(typeof storage.countWords, 'function');
      assert.strictEqual(storage.countWords(''), 0);
      assert.strictEqual(storage.countWords('  hello   world  '), 2);

      // truncateWords (reserved for #43)
      assert.strictEqual(typeof storage.truncateWords, 'function');
      assert.strictEqual(storage.truncateWords('one two three', 2), 'one two...');
      assert.strictEqual(storage.truncateWords('one two', 5), 'one two');

      // MAX_HOT_WORDS (reserved for #43)
      assert.strictEqual(typeof storage.MAX_HOT_WORDS, 'number');
      assert.strictEqual(storage.MAX_HOT_WORDS, 250);

      // UNSETTLED_HORIZON (reserved for #131 / #129)
      assert.strictEqual(storage.UNSETTLED_HORIZON, 2000);
    });

    it('removed remove-candidate symbols from the barrel while lock.ts module exports remain', async () => {
      // Census verdict "removed" (#131): zero runtime consumers and no reservation
      // → pruned from the public barrel and root re-export chain. The constants
      // remain module-private exports in src/storage/lock.ts for internal/test use.
      // (Cast: the whole point is the property no longer exists on the namespace.)
      const barrel = storage as unknown as Record<string, unknown>;
      const root = index as unknown as Record<string, unknown>;
      assert.strictEqual(barrel.HEARTBEAT_INTERVAL, undefined);
      assert.strictEqual(barrel.STALE_TIMEOUT, undefined);
      assert.strictEqual(root.HEARTBEAT_INTERVAL, undefined);
      assert.strictEqual(root.STALE_TIMEOUT, undefined);

      // The owning module still exports them for internal consumers (tests import
      // via '../src/storage/lock'); pin the values and the platform mapping.
      const lock = await import('../src/storage/lock');
      assert.strictEqual(lock.HEARTBEAT_INTERVAL, 15000);
      assert.strictEqual(
        lock.STALE_TIMEOUT,
        process.platform === 'win32' ? 60000 : 120000
      );
    });
  });

  describe('Root Re-export Chain', () => {
    it('re-exports storage symbols via the root package index', () => {
      assert.strictEqual(index.loadTopics, storage.loadTopics);
      assert.strictEqual(index.getTopicCache, storage.getTopicCache);
      assert.strictEqual(index.parseFrontmatter, storage.parseFrontmatter);
      assert.strictEqual(index.Lock, storage.Lock);
      assert.strictEqual(index.atomicWrite, storage.atomicWrite);
      assert.strictEqual(index.MAX_HOT_WORDS, storage.MAX_HOT_WORDS);
    });
  });
});
