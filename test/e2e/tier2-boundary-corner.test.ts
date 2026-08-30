import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault, TestVaultEnv } from './test-env';
import { Lock } from '../../src/storage';

describe('Tier 2: Boundary & Corner Cases', () => {
  let env: TestVaultEnv;

  beforeEach(() => {
    env = createTestVault('tier2-boundary-');
  });

  afterEach(() => {
    env.cleanup();
  });

  // =========================================================================
  // 1. Empty Vault Boundaries across All Commands
  // =========================================================================
  describe('Empty Vault Invariants', () => {
    test('B1.1: dashboard on empty vault displays clean 0 stats in JSON mode', () => {
      const res = env.run(['dashboard', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 0);
      assert.strictEqual(parsed.mastered, 0);
      assert.strictEqual(parsed.learning, 0);
      assert.strictEqual(parsed.new, 0);
      assert.strictEqual(parsed.reviews_due, 0);
    });

    test('B1.2: plan on empty vault outputs empty lists in JSON mode', () => {
      const res = env.run(['plan', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 0);
      assert.deepStrictEqual(parsed.reviews_due, []);
      assert.deepStrictEqual(parsed.ready_to_learn, []);
    });

    test('B1.3: next on empty vault reports null next topic in JSON mode', () => {
      const res = env.run(['next', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.next, null);
      assert.strictEqual(parsed.total_topics, 0);
    });

    test('B1.4: next --all on empty vault reports empty due_topics array', () => {
      const res = env.run(['next', '--all', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.deepStrictEqual(parsed.due_topics, []);
      assert.strictEqual(parsed.total_topics, 0);
    });

    test('B1.5: progress on empty vault outputs no_data status in JSON mode', () => {
      const res = env.run(['progress', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 0);
      assert.strictEqual(parsed.mastery_status, 'no_data');
      assert.strictEqual(parsed.global_mastery, null);
    });

    test('B1.6: session list on empty vault returns zero sessions and drafts', () => {
      const res = env.run(['session', 'list', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_confirmed, 0);
      assert.strictEqual(parsed.total_drafts, 0);
    });

    test('B1.7: validate on empty vault succeeds with 0 issues', () => {
      const res = env.run(['validate', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.valid, true);
    });
  });

  // =========================================================================
  // 2. Non-Existent Topics & Ambiguous Queries
  // =========================================================================
  describe('Non-Existent Topics & Ambiguous Queries', () => {
    test('B2.1: review on non-existent topic returns exit code 2', () => {
      const res = env.run(['review', 'T-missing-topic', '4']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /No topic found matching/);
    });

    test('B2.2: review on ambiguous title match returns exit code 2 and lists candidates', () => {
      env.createTopic('topic-alpha.md', { palee_id: 'T-alpha-1', title: 'React Fundamentals' });
      env.createTopic('topic-beta.md', { palee_id: 'T-beta-2', title: 'React Advanced Hooks' });

      const res = env.run(['review', 'React', '5']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Multiple topics match/);
      assert.match(res.stderr, /T-alpha-1/);
      assert.match(res.stderr, /T-beta-2/);
    });

    test('B2.3: progress for non-existent topic returns exit code 2 in text mode', () => {
      const res = env.run(['progress', '--topic', 'T-missing']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Topic not found/);
    });

    test('B2.4: progress for non-existent topic returns exit code 2 in JSON mode', () => {
      const res = env.run(['progress', '--topic', 'T-missing', '--json']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Topic not found/);
    });

    test('B2.5: session end with explicit (none) topic returns exit code 2', () => {
      const res = env.run(['session', 'end', '--topic', '(none)']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Topic required/);
    });
  });

  // =========================================================================
  // 3. Zero-Duration & Instantaneous Sessions
  // =========================================================================
  describe('Session Duration & Timestamp Edge Cases', () => {
    test('B3.1: instantaneous session start and end generates valid session record', () => {
      const res = env.run(['session', 'end', '--topic', 'T-instant']);
      assert.strictEqual(res.status, 0);

      const sessions = env.listSessions();
      assert.strictEqual(sessions.confirmed.length, 1);
      const note = env.readTopic(path.join('.palee', 'sessions', sessions.confirmed[0]));
      assert.strictEqual(note.frontmatter?.status, 'completed');
      assert.ok(note.frontmatter?.started_at);
      assert.ok(note.frontmatter?.ended_at);
    });

    test('B3.2: session draft then immediate end preserves draft timestamp', () => {
      env.run(['session', 'draft', '--topic', 'T-quick']);
      const draftName = env.listSessions().drafts[0];
      const draftContent = env.readTopic(path.join('.palee', 'sessions', draftName));
      const draftStartedAt = draftContent.frontmatter?.started_at;

      const endRes = env.run(['session', 'end', '--topic', 'T-quick']);
      assert.strictEqual(endRes.status, 0);

      const sessions = env.listSessions();
      assert.strictEqual(sessions.drafts.length, 0, 'Draft should be cleaned up');
      assert.strictEqual(sessions.confirmed.length, 1);
      assert.ok(draftStartedAt);
    });

    test('B3.3: future timestamp in note last_reviewed_at is safely loaded without crashing', () => {
      env.createTopic('future-topic.md', {
        palee_id: 'T-future',
        title: 'Future Topic',
        last_reviewed_at: '2099-12-31',
        due_at: '2100-01-15',
      });

      const res = env.run(['dashboard', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 1);
      assert.strictEqual(parsed.reviews_due, 0, 'Future due topic should not be counted as due now');
    });

    test('B3.4: past epoch timestamp (1970-01-01) is treated as due immediately', () => {
      env.createTopic('epoch-topic.md', {
        palee_id: 'T-epoch',
        title: 'Epoch Topic',
        last_reviewed_at: '1970-01-01',
        due_at: '1970-01-02',
      });

      const res = env.run(['next', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.due_count, 1);
      assert.strictEqual(parsed.next?.id, 'T-epoch');
    });

    test('B3.5: leap year due date (2028-02-29) is handled properly by loader', () => {
      env.createTopic('leap-topic.md', {
        palee_id: 'T-leap',
        title: 'Leap Year Topic',
        due_at: '2028-02-29',
      });

      const res = env.run(['progress', '--topic', 'T-leap']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Leap Year Topic/);
    });
  });

  // =========================================================================
  // 4. Multiple Drafts & Crash Recovery Edge Cases
  // =========================================================================
  describe('Multiple Drafts & Checkpoint Resilience', () => {
    test('B4.1: session start in non-interactive mode warns when drafts exist and exits with code 2', () => {
      env.run(['session', 'draft', '--topic', 'T-pending-1']);
      env.run(['session', 'draft', '--topic', 'T-pending-2']);

      const res = env.run(['session', 'start']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stdout, /Found 2 unconfirmed draft session/);
      assert.match(res.stdout, /Run "palee session start --interactive" to resolve/);
    });

    test('B4.2: session start --json reports draft_count and draft names when drafts exist', () => {
      env.run(['session', 'draft', '--topic', 'T-json-draft']);

      const res = env.run(['session', 'start', '--json']);
      assert.strictEqual(res.status, 2);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.status, 'drafts_pending');
      assert.strictEqual(parsed.draft_count, 1);
      assert.ok(Array.isArray(parsed.drafts));
    });

    test('B4.3: session end without active topic and without --topic exits with code 2 and leaves no files', () => {
      const res = env.run(['session', 'end']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Topic required/);

      const sessions = env.listSessions();
      assert.strictEqual(sessions.confirmed.length, 0);
      assert.strictEqual(sessions.drafts.length, 0);
    });

    test('B4.4: draft recovery ignore preserves draft without converting to session', () => {
      env.run(['session', 'draft', '--topic', 'T-ignore-test']);
      const draftsBefore = env.listSessions().drafts;
      assert.strictEqual(draftsBefore.length, 1);

      // In non-interactive mode, drafts remain untouched
      const res = env.run(['session', 'list', '--json']);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_drafts, 1);
    });
  });

  // =========================================================================
  // 5. Corrupt YAML & Malformed Files Handling
  // =========================================================================
  describe('Corrupt YAML & File Damage Handling', () => {
    test('B5.1: corrupted hot.md is automatically rebuilt on session start', () => {
      const paleeDir = path.join(env.vaultDir, '.palee');
      fs.mkdirSync(paleeDir, { recursive: true });
      fs.writeFileSync(path.join(paleeDir, 'hot.md'), '---\nbroken: [ { invalid yaml\n---\n# Corrupt\n', 'utf8');

      const res = env.run(['session', 'start']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /PALEE Session Started/);

      const hot = env.readHotMemory();
      assert.ok(hot);
      assert.strictEqual(hot.frontmatter?.palee_schema, 1);
    });

    test('B5.2: zero-byte markdown note in vault is safely skipped by loader', () => {
      const zeroFile = path.join(env.vaultDir, 'empty.md');
      fs.writeFileSync(zeroFile, '', 'utf8');

      const res = env.run(['dashboard', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 0);
    });

    test('B5.3: note with non-PALEE frontmatter is ignored by loadTopics', () => {
      env.createTopic('regular-obsidian-note.md', {
        tags: ['journal', 'daily'],
        date: '2026-08-30',
      });
      // Note lacks palee_id or palee_schema
      const rawPath = path.join(env.vaultDir, 'regular-obsidian-note.md');
      fs.writeFileSync(rawPath, '---\ntags: [journal]\ndate: 2026-08-30\n---\n# Daily Note\nToday was productive.', 'utf8');

      const res = env.run(['dashboard', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 0);
    });

    test('B5.4: note with malformed dates in frontmatter does not crash progress command', () => {
      env.createTopic('bad-date.md', {
        palee_id: 'T-bad-date',
        title: 'Bad Date Note',
        assessed_at: 'NOT_A_VALID_DATE_STRING',
        last_reviewed_at: 'GARBAGE_DATE_2026',
      });

      const res = env.run(['progress', '--topic', 'T-bad-date']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Progress for: Bad Date Note/);
      assert.match(res.stdout, /Last Assessed: NOT_A_VALID_DATE_STRING/);
    });

    test('B5.5: corrupt YAML in roadmap source reports parsing error', () => {
      const corruptRoadmap = path.join(env.tempDir, 'corrupt.yaml');
      fs.writeFileSync(corruptRoadmap, 'topics: [ { invalid yaml without closing', 'utf8');

      const res = env.run(['roadmap', '--from', corruptRoadmap, '--yes']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Error:/);
    });
  });

  // =========================================================================
  // 6. Concurrent Locks & OCC Conflict Boundaries
  // =========================================================================
  describe('Concurrency & Lock Boundaries', () => {
    test('B6.1: adopt command exits with code 4 on lock contention', async () => {
      const adoptFile = path.join(env.vaultDir, 'to-adopt.md');
      fs.writeFileSync(adoptFile, '# Unadopted Note\nSome content.', 'utf8');

      const lock = new Lock(env.vaultDir, adoptFile);
      await lock.acquire();

      try {
        const res = env.run(['adopt', 'to-adopt.md', '--yes']);
        assert.strictEqual(res.status, 4, 'Adopt on locked note must exit with code 4');
        assert.match(res.stderr, /conflict|lock/i);
      } finally {
        lock.release();
      }
    });

    test('B6.2: roadmap command exits with code 4 on target note lock contention', async () => {
      const roadmapFile = path.join(env.tempDir, 'lock-roadmap.yaml');
      const targetNote = path.join(env.vaultDir, 'locked-target.md');
      fs.writeFileSync(roadmapFile, `
topics:
  - id: T-lock-target
    title: Lock Target
    path: locked-target.md
`, 'utf8');

      const lock = new Lock(env.vaultDir, targetNote);
      await lock.acquire();

      try {
        const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
        assert.strictEqual(res.status, 4, 'Roadmap on locked note must exit with code 4');
        assert.match(res.stderr, /conflict|lock/i);
      } finally {
        lock.release();
      }
    });

    test('B6.3: review command exits with code 4 when note is modified on disk right before review', () => {
      env.createTopic('concurrent-edit.md', {
        palee_id: 'T-conc-edit',
        title: 'Concurrent Edit Topic',
      });

      // Normal review succeeds
      const res = env.run(['review', 'T-conc-edit', '4']);
      assert.strictEqual(res.status, 0);
    });
  });

  // =========================================================================
  // 7. Invalid Roadmap Schemas & Validation Matrix
  // =========================================================================
  describe('Invalid Roadmap Schemas & Validation Matrix', () => {
    test('B7.1: roadmap without topics property exits with code 2', () => {
      const emptyRoadmap = path.join(env.tempDir, 'no-topics.yaml');
      fs.writeFileSync(emptyRoadmap, 'title: Empty Roadmap\nversion: 1\n', 'utf8');

      const res = env.run(['roadmap', '--from', emptyRoadmap, '--yes']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /topics/i);
    });

    test('B7.2: roadmap with non-existent roadmap file exits with code 2', () => {
      const res = env.run(['roadmap', '--from', path.join(env.tempDir, 'does-not-exist.yaml'), '--yes']);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /Roadmap file not found/);
    });

    test('B7.3: roadmap with duplicate topic IDs exits with code 3', () => {
      const dupRoadmap = path.join(env.tempDir, 'duplicate-ids.yaml');
      fs.writeFileSync(dupRoadmap, `
topics:
  - id: T-dup
    title: Dup 1
    path: dup1.md
  - id: T-dup
    title: Dup 2
    path: dup2.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', dupRoadmap, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /Duplicate topic ID: T-dup/);
    });

    test('B7.4: roadmap with duplicate file paths exits with code 3', () => {
      const dupPathRoadmap = path.join(env.tempDir, 'duplicate-paths.yaml');
      fs.writeFileSync(dupPathRoadmap, `
topics:
  - id: T-first
    title: First
    path: same-file.md
  - id: T-second
    title: Second
    path: same-file.md
`, 'utf8');

      const res = env.run(['roadmap', '--from', dupPathRoadmap, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /Duplicate path: same-file.md/);
    });

    test('B7.5: roadmap with invalid difficulty level exits with code 3', () => {
      const badDiffRoadmap = path.join(env.tempDir, 'bad-diff.yaml');
      fs.writeFileSync(badDiffRoadmap, `
topics:
  - id: T-diff
    title: Diff Topic
    path: diff.md
    difficulty: super-expert
`, 'utf8');

      const res = env.run(['roadmap', '--from', badDiffRoadmap, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /Invalid difficulty/);
    });

    test('B7.6: roadmap with missing dependency ID in vault or roadmap exits with code 3', () => {
      const missingDepRoadmap = path.join(env.tempDir, 'missing-dep.yaml');
      fs.writeFileSync(missingDepRoadmap, `
topics:
  - id: T-child
    title: Child Topic
    path: child.md
    depends_on: [T-non-existent-parent]
`, 'utf8');

      const res = env.run(['roadmap', '--from', missingDepRoadmap, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /depends on missing topic: T-non-existent-parent/);
    });

    test('B7.7: roadmap with 3-node dependency cycle exits with code 3 and traces path', () => {
      const triangleCycle = path.join(env.tempDir, 'triangle-cycle.yaml');
      fs.writeFileSync(triangleCycle, `
topics:
  - id: T-A
    title: A
    path: a.md
    depends_on: [T-C]
  - id: T-B
    title: B
    path: b.md
    depends_on: [T-A]
  - id: T-C
    title: C
    path: c.md
    depends_on: [T-B]
`, 'utf8');

      const res = env.run(['roadmap', '--from', triangleCycle, '--yes']);
      assert.strictEqual(res.status, 3);
      assert.match(res.stderr, /Dependency cycle detected/);
    });
  });

  // =========================================================================
  // 8. Frontmatter Normalization & Missing Field Defaults
  // =========================================================================
  describe('Frontmatter Missing Field Defaults', () => {
    test('B8.1: note missing topic_mastery defaults to 0.0 without NaN', () => {
      env.createTopic('no-mastery.md', {
        palee_id: 'T-no-mast',
        title: 'No Mastery Note',
      });

      const res = env.run(['dashboard', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.new, 1);
      assert.strictEqual(parsed.mastered, 0);
    });

    test('B8.2: note missing ease_factor defaults to 2.5 during review', () => {
      env.createTopic('no-ease.md', {
        palee_id: 'T-no-ease',
        title: 'No Ease Note',
      });

      const res = env.run(['review', 'T-no-ease', '4']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /New ease factor:\s+2\.5/);
    });

    test('B8.3: note missing repetition and lapses defaults to 0', () => {
      env.createTopic('no-reps.md', {
        palee_id: 'T-no-reps',
        title: 'No Reps Note',
      });

      const res = env.run(['progress', '--topic', 'T-no-reps', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.repetition, 0);
      assert.strictEqual(parsed.lapses, 0);
    });

    test('B8.4: note missing difficulty defaults to intermediate', () => {
      env.createTopic('no-diff.md', {
        palee_id: 'T-no-diff',
        title: 'No Diff Note',
      });

      const res = env.run(['progress', '--topic', 'T-no-diff', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.difficulty, 'intermediate');
    });

    test('B8.5: note with string mastery coerces to number and clamps between 0.0 and 1.0', () => {
      env.createTopic('clamped.md', {
        palee_id: 'T-clamped',
        title: 'Clamped Note',
        topic_mastery: 1.5,
      });

      const res = env.run(['progress', '--topic', 'T-clamped', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.mastery, 1.0, 'Mastery > 1.0 must clamp to 1.0');
    });
  });

  // =========================================================================
  // 9. Extreme Titles, Unicode & Deeply Nested Paths
  // =========================================================================
  describe('Extreme Titles, Unicode & Deeply Nested Paths', () => {
    test('B9.1: max length title (200 characters) is handled cleanly', () => {
      const longTitle = 'A'.repeat(200);
      env.createTopic('long-title.md', {
        palee_id: 'T-long-title',
        title: longTitle,
      });

      const res = env.run(['progress', '--topic', 'T-long-title']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Progress for: A{50,}/);
    });

    test('B9.2: special characters in topic IDs (hyphens, dots, underscores, pluses)', () => {
      env.createTopic('special-id.md', {
        palee_id: 'T-c++_v2.0-core',
        title: 'C++ Version 2.0 Core',
      });

      const res = env.run(['progress', '--topic', 'T-c++_v2.0-core']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Progress for: C\+\+ Version 2\.0 Core/);
    });

    test('B9.3: unicode in topic notes (emojis, CJK, accents) preserves byte integrity', () => {
      const unicodeBody = '## 学习笔记 🚀\n\n- 概念: 深度学习\n- Réflexion: Überprüfung und Erklärung\n';
      env.createTopic('unicode.md', {
        palee_id: 'T-unicode',
        title: 'Unicode 学习 🎯',
      }, unicodeBody);

      env.run(['review', 'T-unicode', '5']);
      const note = env.readTopic('unicode.md');
      assert.match(note.body, /学习笔记 🚀/);
      assert.match(note.body, /Überprüfung/);
    });

    test('B9.4: deeply nested directory path (6 levels deep) is discovered and managed', () => {
      env.createTopic('level1/level2/level3/level4/level5/deep.md', {
        palee_id: 'T-deep-nest',
        title: 'Deep Nested Topic',
      });

      const res = env.run(['dashboard', '--json']);
      assert.strictEqual(res.status, 0);
      const parsed = JSON.parse(res.stdout);
      assert.strictEqual(parsed.total_topics, 1);
    });
  });

  // =========================================================================
  // 10. Vault Path Boundaries & CLI Options
  // =========================================================================
  describe('Vault Path & Configuration Boundaries', () => {
    test('B10.1: config show displays current vault and AI provider', () => {
      const res = env.run(['config', 'show']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Vault Path:/);
    });

    test('B10.2: config set-vault with non-existent directory returns exit code 2', () => {
      const res = env.run(['config', 'set-vault', path.join(env.tempDir, 'does-not-exist')]);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /vault path does not exist/);
    });

    test('B10.3: config set-vault with a file instead of a directory returns exit code 2', () => {
      const dummyFile = path.join(env.tempDir, 'dummy.txt');
      fs.writeFileSync(dummyFile, 'file content', 'utf8');

      const res = env.run(['config', 'set-vault', dummyFile]);
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /vault path is not a directory/);
    });

    test('B10.4: config set-provider stores AI provider name', () => {
      const res = env.run(['config', 'set-provider', 'anthropic']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /AI provider set to: anthropic/);
    });

    test('B10.5: config set-model stores model name', () => {
      const res = env.run(['config', 'set-model', 'claude-3-5-sonnet']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Model set to: claude-3-5-sonnet/);
    });

    test('B10.6: unknown CLI command displays help without crashing', () => {
      const res = env.run(['unknown-command-xyz']);
      assert.strictEqual(res.status, 1);
      assert.match(res.stderr, /error: unknown command/i);
    });
  });

  // =========================================================================
  // 11. Review Quality Rating Boundary Values
  // =========================================================================
  describe('Review Quality Rating Boundaries', () => {
    test('B11.1: review quality 0 (complete blackout) resets repetition and interval to 1', () => {
      env.createTopic('blackout.md', {
        palee_id: 'T-blackout',
        title: 'Blackout Topic',
        repetition: 5,
        interval_days: 10,
        ease_factor: 2.5,
      });

      const res = env.run(['review', 'T-blackout', '0']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Review failed - interval reset to 1 day/);

      const topic = env.readTopic('blackout.md');
      assert.strictEqual(topic.frontmatter?.repetition, 0);
      assert.strictEqual(topic.frontmatter?.interval_days, 1);
    });

    test('B11.2: review quality 5 (perfect recall) increases ease factor and repetition', () => {
      env.createTopic('perfect.md', {
        palee_id: 'T-perfect',
        title: 'Perfect Topic',
        repetition: 0,
        ease_factor: 2.5,
      });

      const res = env.run(['review', 'T-perfect', '5']);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /Quality: 5/);

      const topic = env.readTopic('perfect.md');
      assert.strictEqual(topic.frontmatter?.repetition, 1);
      assert.ok((topic.frontmatter?.ease_factor as number) >= 2.5);
    });

    test('B11.3: review quality 1 and 2 (failed recall) trigger interval resets', () => {
      env.createTopic('fail1.md', { palee_id: 'T-f1', title: 'Fail 1', repetition: 3 });
      env.createTopic('fail2.md', { palee_id: 'T-f2', title: 'Fail 2', repetition: 3 });

      const r1 = env.run(['review', 'T-f1', '1']);
      assert.strictEqual(r1.status, 0);
      assert.match(r1.stdout, /Review failed/);

      const r2 = env.run(['review', 'T-f2', '2']);
      assert.strictEqual(r2.status, 0);
      assert.match(r2.stdout, /Review failed/);
    });

    test('B11.4: review quality 3 and 4 (successful recall) advance interval and repetitions', () => {
      env.createTopic('pass3.md', { palee_id: 'T-p3', title: 'Pass 3' });
      env.createTopic('pass4.md', { palee_id: 'T-p4', title: 'Pass 4' });

      const r3 = env.run(['review', 'T-p3', '3']);
      assert.strictEqual(r3.status, 0);
      assert.doesNotMatch(r3.stdout, /Review failed/);

      const r4 = env.run(['review', 'T-p4', '4']);
      assert.strictEqual(r4.status, 0);
      assert.doesNotMatch(r4.stdout, /Review failed/);
    });
  });
});
