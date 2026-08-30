import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault, TestVaultEnv } from './test-env';
import {
  walkVault,
  loadTopics,
  matchesPattern,
  matchesTags,
  extractTags,
  validatePattern,
  parseRoadmapContent,
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  Lock,
  atomicWrite,
  isConflictError,
  FileCache,
  UNSETTLED_HORIZON,
  generateSessionId,
  generateDraftId,
  writeSessionNote,
  updateHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  recoverDraft,
} from '../../src/storage';

describe('Tier 1: Feature Coverage (11 Features)', () => {
  let env: TestVaultEnv;

  beforeEach(() => {
    env = createTestVault('tier1-coverage-');
  });

  afterEach(() => {
    env.cleanup();
  });

  // =========================================================================
  // Feature 1: Storage Isolation Helpers (#86)
  // =========================================================================
  describe('F1: Storage Isolation Helpers', () => {
    test('F1.1: writeSessionNote saves canonical session note to .palee/sessions/S-*.md', async () => {
      const sessionId = generateSessionId();
      const filePath = await writeSessionNote(env.vaultDir, {
        session_id: sessionId,
        topic_id: 'T-storage-1',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      }, 'Session study note content');

      assert.ok(fs.existsSync(filePath), 'Session file should exist on disk');
      assert.match(filePath, /[\\/]\.palee[\\/]sessions[\\/]S-.*\.md$/);
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      assert.strictEqual(frontmatter?.session_id, sessionId);
      assert.strictEqual(frontmatter?.topic_id, 'T-storage-1');
      assert.strictEqual(frontmatter?.status, 'completed');
      assert.match(body, /Session study note content/);
    });

    test('F1.2: writeDraftCheckpoint isolates draft files under .palee/sessions/DRAFT-S-*.md', async () => {
      const draftId = generateDraftId();
      const draftPath = await writeDraftCheckpoint(env.vaultDir, draftId, {
        topic_id: 'T-storage-draft',
        started_at: new Date().toISOString(),
      }, 'Draft in progress');

      assert.ok(fs.existsSync(draftPath));
      assert.match(draftPath, /[\\/]\.palee[\\/]sessions[\\/]DRAFT-S-.*\.md$/);
      const drafts = getDrafts(env.vaultDir);
      assert.ok(drafts.includes(draftPath));
    });

    test('F1.3: Draft recovery with discard cleanly unlinks draft file without touching others', async () => {
      const d1 = await writeDraftCheckpoint(env.vaultDir, generateDraftId(), {
        topic_id: 'T-1',
        started_at: new Date().toISOString(),
      }, 'Draft 1');
      const d2 = await writeDraftCheckpoint(env.vaultDir, generateDraftId(), {
        topic_id: 'T-2',
        started_at: new Date().toISOString(),
      }, 'Draft 2');

      assert.strictEqual(getDrafts(env.vaultDir).length, 2);
      await recoverDraft(env.vaultDir, d1, 'discard');

      assert.strictEqual(fs.existsSync(d1), false, 'Discarded draft should be removed');
      assert.strictEqual(fs.existsSync(d2), true, 'Remaining draft should stay intact');
      assert.strictEqual(getDrafts(env.vaultDir).length, 1);
    });

    test('F1.4: updateHotMemory preserves hot.md structure and caps at MAX_HOT_WORDS', async () => {
      const longBody = Array(300).fill('studyword').join(' ');
      const hotPath = await updateHotMemory(env.vaultDir, 'S-test-100', 'T-active-topic', longBody);

      assert.ok(fs.existsSync(hotPath));
      const hot = env.readHotMemory();
      assert.ok(hot);
      assert.strictEqual(hot.frontmatter?.last_session, 'S-test-100');
      assert.strictEqual(hot.frontmatter?.active_topic, 'T-active-topic');
      const words = hot.body.split(/\s+/);
      assert.ok(words.length <= 251, `Body should be capped at 250 words (+ ellipsis), got ${words.length}`);
    });

    test('F1.5: regenerateIndex lists only confirmed sessions in reverse chronological order', async () => {
      await writeSessionNote(env.vaultDir, {
        session_id: 'S-20260101T100000-0001',
        topic_id: 'T-old',
        started_at: '2026-01-01T10:00:00.000Z',
        ended_at: '2026-01-01T10:30:00.000Z',
      }, 'Old note');

      await writeSessionNote(env.vaultDir, {
        session_id: 'S-20260102T100000-0002',
        topic_id: 'T-new',
        started_at: '2026-01-02T10:00:00.000Z',
        ended_at: '2026-01-02T10:30:00.000Z',
      }, 'New note');

      // Also create a draft, which should NOT be in the index count
      await writeDraftCheckpoint(env.vaultDir, generateDraftId(), {
        topic_id: 'T-draft',
        started_at: '2026-01-03T10:00:00.000Z',
      }, 'Draft note');

      const indexPath = await regenerateIndex(env.vaultDir);
      assert.ok(fs.existsSync(indexPath));
      const idx = env.readSessionIndex();
      assert.ok(idx);
      assert.match(idx.body, /Total Sessions: 2/);
      assert.match(idx.body, /\[\[S-20260102T100000-0002\]\]/);
      assert.match(idx.body, /\[\[S-20260101T100000-0001\]\]/);
    });

    test('F1.6: rebuildHotAndIndex reconstructs hot.md and index.md from on-disk sessions', async () => {
      await writeSessionNote(env.vaultDir, {
        session_id: 'S-20260815T120000-aaaa',
        topic_id: 'T-recovered',
        started_at: '2026-08-15T12:00:00.000Z',
        ended_at: '2026-08-15T12:45:00.000Z',
      }, 'Recovered study notes content');

      // Delete hot.md and index.md
      const hotPath = path.join(env.vaultDir, '.palee', 'hot.md');
      const indexPath = path.join(env.vaultDir, '.palee', 'index.md');
      if (fs.existsSync(hotPath)) fs.unlinkSync(hotPath);
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);

      await rebuildHotAndIndex(env.vaultDir);

      assert.ok(fs.existsSync(hotPath), 'hot.md should be recreated');
      assert.ok(fs.existsSync(indexPath), 'index.md should be recreated');
      const hot = env.readHotMemory();
      assert.strictEqual(hot?.frontmatter?.last_session, 'S-20260815T120000-aaaa');
      assert.strictEqual(hot?.frontmatter?.active_topic, 'T-recovered');
    });
  });

  // =========================================================================
  // Feature 2: Storage Barrel Re-exports (#90)
  // =========================================================================
  describe('F2: Storage Barrel Re-exports', () => {
    test('F2.1: Storage barrel exports vault traversal and topic loader', () => {
      assert.strictEqual(typeof walkVault, 'function');
      assert.strictEqual(typeof loadTopics, 'function');
    });

    test('F2.2: Storage barrel exports pattern and tag matching utilities', () => {
      assert.strictEqual(typeof matchesPattern, 'function');
      assert.strictEqual(typeof matchesTags, 'function');
      assert.strictEqual(typeof extractTags, 'function');
      assert.strictEqual(typeof validatePattern, 'function');
    });

    test('F2.3: Storage barrel exports frontmatter parser, updater, and fingerprinting', () => {
      assert.strictEqual(typeof parseFrontmatter, 'function');
      assert.strictEqual(typeof updateFrontmatter, 'function');
      assert.strictEqual(typeof computeFingerprint, 'function');
    });

    test('F2.4: Storage barrel exports concurrency primitives and cache', () => {
      assert.strictEqual(typeof Lock, 'function');
      assert.strictEqual(typeof atomicWrite, 'function');
      assert.strictEqual(typeof isConflictError, 'function');
      assert.strictEqual(typeof FileCache, 'function');
      assert.strictEqual(typeof UNSETTLED_HORIZON, 'number');
    });

    test('F2.5: Storage barrel exports memory, draft, and roadmap parsing utilities', () => {
      assert.strictEqual(typeof parseRoadmapContent, 'function');
      assert.strictEqual(typeof writeSessionNote, 'function');
      assert.strictEqual(typeof updateHotMemory, 'function');
      assert.strictEqual(typeof regenerateIndex, 'function');
      assert.strictEqual(typeof rebuildHotAndIndex, 'function');
      assert.strictEqual(typeof writeDraftCheckpoint, 'function');
      assert.strictEqual(typeof getDrafts, 'function');
      assert.strictEqual(typeof recoverDraft, 'function');
    });
  });

  // =========================================================================
  // Feature 3: Cache Determinism (#90)
  // =========================================================================
  describe('F3: Cache Determinism', () => {
    test('F3.1: FileCache returns stored data on cache hit', () => {
      const cache = new FileCache<{ title: string }>();
      const testFile = path.join(env.vaultDir, 'cache-test.md');
      fs.writeFileSync(testFile, '# Cache Test\n', 'utf8');
      const fp = computeFingerprint(fs.readFileSync(testFile, 'utf8'));

      cache.set(testFile, { title: 'Cached Note' }, fp);
      const hit = cache.get(testFile);
      assert.deepStrictEqual(hit, { title: 'Cached Note' });
    });

    test('F3.2: FileCache evicts entry on file size change', () => {
      const cache = new FileCache<{ title: string }>();
      const testFile = path.join(env.vaultDir, 'size-change.md');
      fs.writeFileSync(testFile, 'short', 'utf8');
      const fp = computeFingerprint('short');

      cache.set(testFile, { title: 'Short' }, fp);
      // Change file size
      fs.writeFileSync(testFile, 'much longer content that changes size', 'utf8');

      const miss = cache.get(testFile);
      assert.strictEqual(miss, null, 'Cache must miss and evict on size change');
    });

    test('F3.3: FileCache detects content modifications within unsettled horizon', () => {
      const cache = new FileCache<{ count: number }>();
      const testFile = path.join(env.vaultDir, 'horizon-test.md');
      fs.writeFileSync(testFile, 'data_a', 'utf8');
      const fpA = computeFingerprint('data_a');

      cache.set(testFile, { count: 1 }, fpA);
      // Overwrite same size, different content within unsettled horizon
      fs.writeFileSync(testFile, 'data_b', 'utf8');

      const result = cache.get(testFile);
      assert.strictEqual(result, null, 'Cache must invalidate on fingerprint mismatch');
    });

    test('F3.4: FileCache invalidate removes specific entry', () => {
      const cache = new FileCache<{ val: number }>();
      const f1 = path.join(env.vaultDir, 'f1.md');
      const f2 = path.join(env.vaultDir, 'f2.md');
      fs.writeFileSync(f1, 'content 1', 'utf8');
      fs.writeFileSync(f2, 'content 2', 'utf8');

      cache.set(f1, { val: 1 }, computeFingerprint('content 1'));
      cache.set(f2, { val: 2 }, computeFingerprint('content 2'));

      cache.invalidate(f1);
      assert.strictEqual(cache.get(f1), null);
      assert.deepStrictEqual(cache.get(f2), { val: 2 });
    });

    test('F3.5: FileCache clear purges all entries and handles missing files gracefully', () => {
      const cache = new FileCache<string>();
      const f = path.join(env.vaultDir, 'temp.md');
      fs.writeFileSync(f, 'temp', 'utf8');
      cache.set(f, 'cached', computeFingerprint('temp'));

      cache.clear();
      assert.strictEqual(cache.get(f), null);

      // File deletion handling
      cache.set(f, 'cached2', computeFingerprint('temp'));
      fs.unlinkSync(f);
      assert.strictEqual(cache.get(f), null, 'Cache should safely return null for deleted file');
    });
  });

  // =========================================================================
  // Feature 4: Session Start & Draft Timestamping (#88)
  // =========================================================================
  describe('F4: Session Start & Draft Timestamping', () => {
    test('F4.1: session start initializes hot.md working memory', () => {
      const res = env.run(['session', 'start']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /PALEE Session Started/);
      assert.match(res.stdout, /Working Memory/);

      const hot = env.readHotMemory();
      assert.ok(hot, 'hot.md must be created');
      assert.strictEqual(hot.frontmatter?.palee_schema, 1);
      assert.strictEqual(hot.frontmatter?.memory_id, 'H-active');
    });

    test('F4.2: session draft requires a valid topic', () => {
      const res = env.run(['session', 'draft']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Topic required/);
    });

    test('F4.3: session draft --topic creates checkpoint with started_at ISO timestamp', () => {
      const res = env.run(['session', 'draft', '--topic', 'T-typescript-basics']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Draft checkpoint created/);

      const sessions = env.listSessions();
      assert.strictEqual(sessions.drafts.length, 1);

      const draftPath = path.join(env.vaultDir, '.palee', 'sessions', sessions.drafts[0]);
      const content = fs.readFileSync(draftPath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      assert.strictEqual(frontmatter?.topic_id, 'T-typescript-basics');
      assert.strictEqual(frontmatter?.status, 'draft');
      assert.ok(frontmatter?.started_at, 'started_at timestamp must exist');
      // Validate ISO timestamp format
      const parsedDate = new Date(frontmatter?.started_at as string);
      assert.ok(!Number.isNaN(parsedDate.getTime()), 'started_at must be a valid ISO date');
    });

    test('F4.4: multiple sequential drafts capture distinct draft IDs and timestamps', () => {
      env.run(['session', 'draft', '--topic', 'T-topic-a']);
      env.run(['session', 'draft', '--topic', 'T-topic-b']);

      const sessions = env.listSessions();
      assert.strictEqual(sessions.drafts.length, 2);
      assert.notStrictEqual(sessions.drafts[0], sessions.drafts[1]);
    });

    test('F4.5: session list --json reports active drafts and confirmed counts', () => {
      env.run(['session', 'draft', '--topic', 'T-topic-json']);
      const res = env.run(['session', 'list', '--json']);
      assert.strictEqual(res.status, 0);

      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_drafts, 1);
      assert.strictEqual(parsed.total_confirmed, 0);
      assert.ok(Array.isArray(parsed.drafts));
      assert.strictEqual(parsed.drafts.length, 1);
    });
  });

  // =========================================================================
  // Feature 5: Session End Duration Recovery (#88)
  // =========================================================================
  describe('F5: Session End Duration Recovery', () => {
    test('F5.1: session end creates S-*.md with completed status and valid timestamps', () => {
      const res = env.run(['session', 'end', '--topic', 'T-algo']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Session recorded/);

      const sessions = env.listSessions();
      assert.strictEqual(sessions.confirmed.length, 1);

      const sessionFile = path.join(env.vaultDir, '.palee', 'sessions', sessions.confirmed[0]);
      const content = fs.readFileSync(sessionFile, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      assert.strictEqual(frontmatter?.status, 'completed');
      assert.strictEqual(frontmatter?.topic_id, 'T-algo');
      assert.ok(frontmatter?.started_at);
      assert.ok(frontmatter?.ended_at);

      const startDate = new Date(frontmatter?.started_at as string);
      const endDate = new Date(frontmatter?.ended_at as string);
      assert.ok(!Number.isNaN(startDate.getTime()));
      assert.ok(!Number.isNaN(endDate.getTime()));
      assert.ok(startDate.getTime() <= endDate.getTime());
    });

    test('F5.2: session end clears draft checkpoints for the completed topic', () => {
      // Create draft for T-algo and draft for T-other
      env.run(['session', 'draft', '--topic', 'T-algo']);
      env.run(['session', 'draft', '--topic', 'T-other']);

      let sessions = env.listSessions();
      assert.strictEqual(sessions.drafts.length, 2);

      // End session for T-algo
      const endRes = env.run(['session', 'end', '--topic', 'T-algo']);
      assert.strictEqual(endRes.status, 0);

      sessions = env.listSessions();
      assert.strictEqual(sessions.confirmed.length, 1);
      assert.strictEqual(sessions.drafts.length, 1, 'Draft for T-other should remain');

      const remainingDraftPath = path.join(env.vaultDir, '.palee', 'sessions', sessions.drafts[0]);
      const remainingContent = fs.readFileSync(remainingDraftPath, 'utf8');
      const parsed = parseFrontmatter(remainingContent);
      assert.strictEqual(parsed.frontmatter?.topic_id, 'T-other');
    });

    test('F5.3: session end updates hot.md with last_session reference', () => {
      env.run(['session', 'end', '--topic', 'T-hot-update']);
      const sessions = env.listSessions();
      const completedId = sessions.confirmed[0].replace('.md', '');

      const hot = env.readHotMemory();
      assert.ok(hot);
      assert.strictEqual(hot.frontmatter?.last_session, completedId);
    });

    test('F5.4: session end updates index.md catalog', () => {
      env.run(['session', 'end', '--topic', 'T-index-update']);
      const idx = env.readSessionIndex();
      assert.ok(idx);
      assert.match(idx.body, /Total Sessions: 1/);
      assert.match(idx.body, /Topic: T-index-update/);
    });

    test('F5.5: session list shows confirmed sessions in descending order', () => {
      env.run(['session', 'end', '--topic', 'T-first']);
      env.run(['session', 'end', '--topic', 'T-second']);

      const res = env.run(['session', 'list']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Confirmed Sessions: 2/);
    });
  });

  // =========================================================================
  // Feature 6: Review OCC TOCTOU Elimination (#87)
  // =========================================================================
  describe('F6: Review OCC TOCTOU Elimination', () => {
    test('F6.1: review command records quality rating and updates SM-2 state', () => {
      env.createTopic('topic1.md', {
        palee_id: 'T-review-1',
        title: 'Review Topic 1',
      });

      const res = env.run(['review', 'T-review-1', '4']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Review recorded for Review Topic 1/);
      assert.match(res.stdout, /Quality: 4/);

      const topic = env.readTopic('topic1.md');
      assert.strictEqual(topic.frontmatter?.repetition, 1);
      assert.ok(topic.frontmatter?.last_reviewed_at);
      assert.ok(topic.frontmatter?.due_at);
    });

    test('F6.2: review command preserves body content byte-for-byte', () => {
      const customBody = '## In-depth Notes\n\n- Point 1\n- Point 2\n\n```ts\nconst x = 42;\n```\n';
      env.createTopic('body-preserve.md', {
        palee_id: 'T-body-preserve',
        title: 'Body Preserve',
      }, customBody);

      env.run(['review', 'T-body-preserve', '5']);
      const topic = env.readTopic('body-preserve.md');
      assert.match(topic.body, /const x = 42;/);
      assert.match(topic.body, /## In-depth Notes/);
    });

    test('F6.3: review command rejects invalid quality rating with exit code 2', () => {
      env.createTopic('rating-test.md', {
        palee_id: 'T-rating',
        title: 'Rating Test',
      });

      const resInvalid1 = env.run(['review', 'T-rating', '6']);
      assert.strictEqual(resInvalid1.status, 2);
      assert.match(resInvalid1.stderr, /Quality must be an integer from 0 to 5/);

      const resInvalid2 = env.run(['review', 'T-rating', '-1']);
      assert.strictEqual(resInvalid2.status, 2);

      const resInvalid3 = env.run(['review', 'T-rating', 'abc']);
      assert.strictEqual(resInvalid3.status, 2);
    });

    test('F6.4: review command rejects non-existent topic with exit code 2', () => {
      const res = env.run(['review', 'T-non-existent-topic', '4']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /No topic found matching/);
    });

    test('F6.5: review command exits with code 4 when concurrent file lock is held', async () => {
      const topicPath = env.createTopic('lock-target.md', {
        palee_id: 'T-lock-occ',
        title: 'Lock OCC Topic',
      });

      const lock = new Lock(env.vaultDir, topicPath);
      await lock.acquire();

      try {
        const res = env.run(['review', 'T-lock-occ', '5']);
        assert.strictEqual(res.status, 4, 'Review under concurrent lock must exit with code 4');
        assert.match(res.stderr, /conflict|lock/i);
      } finally {
        lock.release();
      }
    });

    test('F6.6: review command recomputes topic_mastery when pillar assessment scores exist', () => {
      env.createTopic('pillars.md', {
        palee_id: 'T-pillars',
        title: 'Pillars Topic',
        conceptual: 0.9,
        practical: 0.9,
        debug: 0.9,
        feynman: 0.9,
        topic_mastery: 0.0,
      });

      const res = env.run(['review', 'T-pillars', '5']);
      assert.strictEqual(res.status, 0);

      const topic = env.readTopic('pillars.md');
      assert.strictEqual(topic.frontmatter?.topic_mastery, 0.9);
    });
  });

  // =========================================================================
  // Feature 7: Roadmap Batch Try/Catch Isolation (#89)
  // =========================================================================
  describe('F7: Roadmap Batch Try/Catch Isolation', () => {
    test('F7.1: roadmap import with valid topics succeeds and exits with code 0', () => {
      const roadmapFile = path.join(env.tempDir, 'valid-roadmap.yaml');
      fs.writeFileSync(roadmapFile, `
topics:
  - id: T-batch-1
    title: Batch Topic 1
    path: batch1.md
  - id: T-batch-2
    title: Batch Topic 2
    path: batch2.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Roadmap imported successfully/);
      assert.match(res.stdout, /Created: 2 notes/);

      assert.ok(fs.existsSync(path.join(env.vaultDir, 'batch1.md')));
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'batch2.md')));
    });

    test('F7.2: roadmap import with corrupt note reports failure, imports others, and exits with code 1', () => {
      const roadmapFile = path.join(env.tempDir, 'partial-fail-roadmap.yaml');

      // Create a corrupt note on disk that will fail during import (malformed YAML frontmatter)
      const corruptNotePath = path.join(env.vaultDir, 'corrupt-partial.md');
      fs.writeFileSync(corruptNotePath, '---\npalee_id: [unclosed bracket\n---\n# Corrupt\n', 'utf8');

      fs.writeFileSync(roadmapFile, `
topics:
  - id: T-valid-1
    title: Valid Topic 1
    path: valid1.md
  - id: T-corrupt
    title: Corrupt Note Topic
    path: corrupt-partial.md
  - id: T-valid-2
    title: Valid Topic 2
    path: valid2.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
      assert.strictEqual(res.status, 1, 'Should exit with code 1 on partial batch failure');
      assert.match(res.stderr, /Failed to import 1 topics/);

      // Valid topics should still be created
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'valid1.md')));
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'valid2.md')));
    });

    test('F7.3: roadmap import detects schema validation errors and exits with code 3', () => {
      const invalidRoadmap = path.join(env.tempDir, 'invalid-schema.yaml');
      fs.writeFileSync(invalidRoadmap, `
topics:
  - id: T-bad
    title: Missing Path
`, 'utf8');

      const res = env.run(['roadmap', '--from', invalidRoadmap, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /Validation errors/);
      assert.match(res.stderr, /Topic missing "path" field/);
    });

    test('F7.4: roadmap import detects dependency cycle and exits with code 3', () => {
      const cyclicRoadmap = path.join(env.tempDir, 'cycle.yaml');
      fs.writeFileSync(cyclicRoadmap, `
topics:
  - id: T-cycle-a
    title: Cycle A
    path: cycle-a.md
    depends_on: [T-cycle-b]
  - id: T-cycle-b
    title: Cycle B
    path: cycle-b.md
    depends_on: [T-cycle-a]
`, 'utf8');

      const res = env.run(['roadmap', '--from', cyclicRoadmap, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /Dependency cycle detected/);
    });

    test('F7.5: roadmap import without --yes in non-interactive environment exits with code 2', () => {
      const sampleRoadmap = path.join(env.tempDir, 'sample.yaml');
      fs.writeFileSync(sampleRoadmap, `
topics:
  - id: T-sample
    title: Sample
    path: sample.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', sampleRoadmap]);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Use --yes to confirm import/);
    });
  });

  // =========================================================================
  // Feature 8: Roadmap Linear Control Flow (#89)
  // =========================================================================
  describe('F8: Roadmap Linear Control Flow', () => {
    test('F8.1: roadmap import generates clean markdown note with initial frontmatter', () => {
      const roadmapFile = path.join(env.tempDir, 'flow-test.yaml');
      fs.writeFileSync(roadmapFile, `
topics:
  - id: T-flow-1
    title: Linear Flow Note
    path: flow1.md
    difficulty: advanced
`, 'utf8');

      env.run(['roadmap', '--from', roadmapFile, '--yes']);
      const note = env.readTopic('flow1.md');
      assert.strictEqual(note.frontmatter?.palee_id, 'T-flow-1');
      assert.strictEqual(note.frontmatter?.difficulty, 'advanced');
      assert.strictEqual(note.frontmatter?.topic_mastery, 0.0);
      assert.match(note.body, /Linear Flow Note/);
    });

    test('F8.2: roadmap import preserves study state on existing notes', () => {
      env.createTopic('existing.md', {
        palee_id: 'T-existing',
        title: 'Original Title',
        topic_mastery: 0.85,
        repetition: 4,
        ease_factor: 2.6,
      });

      const roadmapFile = path.join(env.tempDir, 'update-roadmap.yaml');
      fs.writeFileSync(roadmapFile, `
topics:
  - id: T-existing
    title: Updated Title
    path: existing.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
      assert.strictEqual(res.status, 0);

      const note = env.readTopic('existing.md');
      assert.strictEqual(note.frontmatter?.title, 'Updated Title');
      assert.strictEqual(note.frontmatter?.topic_mastery, 0.85, 'Mastery must be preserved');
      assert.strictEqual(note.frontmatter?.repetition, 4, 'Repetition must be preserved');
      assert.strictEqual(note.frontmatter?.ease_factor, 2.6, 'Ease factor must be preserved');
    });

    test('F8.3: roadmap import parses embedded YAML code block in Markdown files', () => {
      const mdRoadmap = path.join(env.tempDir, 'embedded-roadmap.md');
      fs.writeFileSync(mdRoadmap, `
# Engineering Roadmap

\`\`\`yaml
topics:
  - id: T-embed-1
    title: Embedded Topic
    path: embedded.md
\`\`\`
`, 'utf8');

      const res = env.run(['roadmap', '--from', mdRoadmap, '--yes']);
      assert.strictEqual(res.status, 0);
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'embedded.md')));
    });

    test('F8.4: roadmap import parses YAML frontmatter in Markdown files', () => {
      const fmRoadmap = path.join(env.tempDir, 'fm-roadmap.md');
      fs.writeFileSync(fmRoadmap, `---
topics:
  - id: T-fm-1
    title: Frontmatter Topic
    path: fm.md
---

# Title
`, 'utf8');

      const res = env.run(['roadmap', '--from', fmRoadmap, '--yes']);
      assert.strictEqual(res.status, 0);
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'fm.md')));
    });

    test('F8.5: roadmap import auto-creates nested subdirectory structures', () => {
      const nestedRoadmap = path.join(env.tempDir, 'nested-roadmap.yaml');
      fs.writeFileSync(nestedRoadmap, `
topics:
  - id: T-nested-1
    title: Deeply Nested
    path: deep/nested/dir/topic.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', nestedRoadmap, '--yes']);
      assert.strictEqual(res.status, 0);
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'deep', 'nested', 'dir', 'topic.md')));
    });
  });

  // =========================================================================
  // Feature 9: Mastery Formatting Standardization (#90, #91)
  // =========================================================================
  describe('F9: Mastery Formatting Standardization', () => {
    test('F9.1: progress command outputs mastery in XX.X% format for single topic', () => {
      env.createTopic('prog-mast.md', {
        palee_id: 'T-prog-mast',
        title: 'Mastery Formatting Topic',
        topic_mastery: 0.75,
      });

      const res = env.run(['progress', '--topic', 'T-prog-mast']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Mastery:\s+75\.0%/);
    });

    test('F9.2: progress command outputs global average mastery in XX.X% format', () => {
      env.createTopic('t1.md', { palee_id: 'T-1', title: 'T1', topic_mastery: 0.6 });
      env.createTopic('t2.md', { palee_id: 'T-2', title: 'T2', topic_mastery: 0.8 });

      const res = env.run(['progress']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Average Mastery:\s+70\.0%/);
      assert.match(res.stdout, /Mastered \(≥70%\):\s+1 \(50\.0%\)/);
      assert.match(res.stdout, /Learning:\s+1 \(50\.0%\)/);
    });

    test('F9.3: dashboard command outputs mastered percentage in XX.X% format', () => {
      env.createTopic('dash1.md', { palee_id: 'T-d1', title: 'D1', topic_mastery: 0.85 });
      env.createTopic('dash2.md', { palee_id: 'T-d2', title: 'D2', topic_mastery: 0.3 });

      const res = env.run(['dashboard']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Mastered \(≥70%\):\s+1 \(50\.0%\)/);
      assert.match(res.stdout, /Learning:\s+1 \(50\.0%\)/);
      assert.match(res.stdout, /New:\s+0 \(0\.0%\)/);
    });

    test('F9.4: plan command displays counts and ready topics cleanly', () => {
      env.createTopic('p1.md', { palee_id: 'T-p1', title: 'Plan Topic 1', topic_mastery: 0.5 });
      const res = env.run(['plan']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Today's Learning Plan/);
      assert.match(res.stdout, /Total Topics:\s+1/);
    });

    test('F9.5: next command displays next topic due for review with mastery score in XX.X% format', () => {
      env.createTopic('next1.md', {
        palee_id: 'T-next-1',
        title: 'Next Topic',
        topic_mastery: 0.55,
      });

      const res = env.run(['next']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Next topic due for review/);
      assert.match(res.stdout, /Mastery:\s+55\.0%/);

      const resAll = env.run(['next', '--all']);
      assert.strictEqual(resAll.status, 0);
      assert.match(resAll.stdout, /Mastery:\s+55\.0%/);
    });
  });

  // =========================================================================
  // Feature 10: Dashboard Box Width Alignment (#91)
  // =========================================================================
  describe('F10: Dashboard Box Width Alignment', () => {
    test('F10.1: Dashboard header top border is exactly 62 characters wide', () => {
      env.createTopic('t.md', { palee_id: 'T-1', title: 'Topic 1' });
      const res = env.run(['dashboard']);
      assert.strictEqual(res.status, 0);

      const lines = res.stdout.split('\n');
      const topBorder = lines.find(l => l.includes('╔════'));
      assert.ok(topBorder, 'Top border line must exist');
      assert.strictEqual(topBorder.trim().length, 62, 'Top border should be 62 chars');
    });

    test('F10.2: Dashboard header title line is framed with box border and exactly 62 characters wide', () => {
      env.createTopic('t.md', { palee_id: 'T-1', title: 'Topic 1' });
      const res = env.run(['dashboard']);
      const lines = res.stdout.split('\n');
      const titleLine = lines.find(l => l.includes('PALEE Learning Dashboard'));
      assert.ok(titleLine, 'Title line must exist');
      assert.ok(titleLine.trim().startsWith('║') && titleLine.trim().endsWith('║'), 'Title line must be framed by vertical box borders');
      assert.strictEqual(titleLine.trim().length, 62, `Header title line should be 62 chars, got ${titleLine.trim().length}`);
    });

    test('F10.3: Dashboard header bottom border is exactly 62 characters wide', () => {
      env.createTopic('t.md', { palee_id: 'T-1', title: 'Topic 1' });
      const res = env.run(['dashboard']);
      const lines = res.stdout.split('\n');
      const bottomBorder = lines.find(l => l.includes('╚════'));
      assert.ok(bottomBorder, 'Bottom border line must exist');
      assert.strictEqual(bottomBorder.trim().length, 62, 'Bottom border should be 62 chars');
    });

    test('F10.4: Empty vault dashboard displays 62-character box with onboarding guidance', () => {
      const res = env.run(['dashboard']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /No topics found in vault/);
      assert.match(res.stdout, /palee adopt/);
      assert.match(res.stdout, /palee roadmap --from/);

      const lines = res.stdout.split('\n');
      const topBorder = lines.find(l => l.includes('╔════'));
      assert.ok(topBorder);
      assert.strictEqual(topBorder.trim().length, 62);
    });

    test('F10.5: Dashboard populated stats do not contain NaN', () => {
      env.createTopic('t1.md', { palee_id: 'T-1', title: 'Topic 1', topic_mastery: 0.9 });
      env.createTopic('t2.md', { palee_id: 'T-2', title: 'Topic 2', topic_mastery: 0.2 });

      const res = env.run(['dashboard']);
      assert.strictEqual(res.status, 0);
      assert.doesNotMatch(res.stdout, /NaN/);
      assert.match(res.stdout, /Total Topics:\s+2/);
    });

    test('F10.6: Dashboard divider line is exactly 62 characters wide', () => {
      env.createTopic('t1.md', { palee_id: 'T-1', title: 'Topic 1', topic_mastery: 0.9 });
      const res = env.run(['dashboard']);
      assert.strictEqual(res.status, 0);
      const lines = res.stdout.split('\n');
      const divider = lines.find(l => l.includes('───'));
      assert.ok(divider, 'Divider line must exist');
      assert.strictEqual(divider.trim().length, 62, 'Divider line must be exactly 62 chars');
    });
  });

  // =========================================================================
  // Feature 11: Documentation & Site Sync (Follow-up)
  // =========================================================================
  describe('F11: Documentation & Site Sync', () => {
    const docsDir = path.resolve(__dirname, '../../docs');

    test('F11.1: Core docs directories and files exist', () => {
      assert.ok(fs.existsSync(docsDir), 'docs directory must exist');
      assert.ok(fs.existsSync(path.join(docsDir, 'index.md')), 'docs/index.md must exist');
    });

    test('F11.2: CLI reference documentation covers Phase 1 commands', () => {
      const cliDocsPath = path.join(docsDir, '02-0-cli-commands.md');
      assert.ok(fs.existsSync(cliDocsPath), 'CLI documentation must exist');
      const content = fs.readFileSync(cliDocsPath, 'utf8');
      assert.match(content, /palee\s+adopt/i);
      assert.match(content, /palee\s+review/i);
      assert.match(content, /palee\s+roadmap/i);
      assert.match(content, /palee\s+session/i);
    });

    test('F11.3: Storage architecture documentation exists', () => {
      const storageDoc = path.join(docsDir, '04-0-storage-layer.md');
      assert.ok(fs.existsSync(storageDoc), 'Storage layer doc must exist');
      const content = fs.readFileSync(storageDoc, 'utf8');
      assert.match(content, /atomic|concurrency|lock/i);
    });

    test('F11.4: Architecture Decision Records (ADRs) exist', () => {
      const adrDir = path.join(docsDir, 'adr');
      assert.ok(fs.existsSync(adrDir), 'ADR directory must exist');
      const adrFiles = fs.readdirSync(adrDir);
      assert.ok(adrFiles.length >= 1, 'At least 1 ADR must be present');
    });

    test('F11.5: VitePress configuration exists and contains valid structure', () => {
      const vpConfigPath = path.join(docsDir, '.vitepress', 'config.mts');
      assert.ok(fs.existsSync(vpConfigPath), 'VitePress config must exist');
      const content = fs.readFileSync(vpConfigPath, 'utf8');
      assert.match(content, /withMermaid|defineConfig/);
      assert.match(content, /sidebar/i);
    });
  });
});
