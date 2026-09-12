/**
 * Assessment-review independence regression (#40)
 *
 * Contracts under test (issue design: command-level mutation tests are the
 * enforcement mechanism, not a static vault rule):
 * - `palee review` updates ONLY the SM-2 review fields.
 * - Existing assessment data (four pillars + assessed_at) survives
 *   `palee review` untouched.
 * - Existing `topic_mastery` survives `palee review` untouched, including a
 *   non-zero value (the regression case the issue calls out).
 * - The reverse direction: a curriculum write path (`palee roadmap` import,
 *   which writes assessment fields through resolveTopicUpdates) preserves
 *   existing SM-2 review state — future assessment/test flows must not
 *   clobber review state unless an explicit confirmed review mutation is
 *   added.
 *
 * Assessment fields: conceptual, practical, debug, feynman, assessed_at,
 * topic_mastery. Review fields: last_quality, last_reviewed_at, due_at,
 * ease_factor, interval_days, repetition, lapses.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault } from './test-env';

describe('assessment-review independence (#40)', () => {
  let env: ReturnType<typeof createTestVault>;

  beforeEach(() => {
    env = createTestVault('palee-independence-');
  });

  afterEach(() => {
    env.cleanup();
  });

  /** Topic carrying pre-existing assessment + review state. */
  function writeAssessedTopic(): void {
    env.createTopic(
      'assessed.md',
      {
        palee_id: 'T-assessed',
        title: 'Assessed Topic',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: '2026-09-01',
        // Non-zero mastery — the regression case: review must not touch it.
        topic_mastery: 0.82,
      },
      'Pre-existing notes with assessment data.'
    );
  }

  /** The seven SM-2 review fields palee review is allowed to mutate. */
  const SM2_FIELDS =
    /^(last_quality|last_reviewed_at|due_at|ease_factor|interval_days|repetition|lapses):/;

  /**
   * Strips the seven SM-2 lines from a raw note so the remainder can be
   * compared byte-for-byte. Everything else — title, status, depends_on,
   * assessment fields, comments, frontmatter order, the body — must
   * survive a review mutation unchanged.
   */
  function withoutSm2(raw: string): string[] {
    return raw.split('\n').filter((line) => !SM2_FIELDS.test(line));
  }

  test('palee review preserves all assessment fields and topic_mastery', () => {
    // Noncanonical numeric forms on purpose (0.80, not 0.8): if the review
    // path renormalizes pillar values on write, this test catches the
    // rewrite, because the full-file comparison (minus SM-2 lines only)
    // includes these exact lines.
    const rawNote =
      '---\n' +
      'palee_schema: 1\n' +
      'palee_id: T-assessed\n' +
      'title: Assessed Topic\n' +
      'difficulty: intermediate\n' +
      'depends_on: []\n' +
      'status: learning\n' +
      'conceptual: 0.80\n' +
      'practical: 0.70\n' +
      'debug: 0.90\n' +
      'feynman: 0.85\n' +
      'assessed_at: "2026-09-01"\n' +
      'topic_mastery: 0.82\n' +
      '---\n' +
      '# Assessed Topic\n\n' +
      'Pre-existing notes with assessment data. #assessment #wip\n';
    fs.writeFileSync(path.join(env.vaultDir, 'assessed.md'), rawNote, 'utf8');

    const before = withoutSm2(fs.readFileSync(path.join(env.vaultDir, 'assessed.md'), 'utf8'));

    const res = env.run(['review', 'T-assessed', '4']);
    assert.strictEqual(res.status, 0);

    const after = withoutSm2(fs.readFileSync(path.join(env.vaultDir, 'assessed.md'), 'utf8'));

    // The entire file except the seven SM-2 lines is byte-identical:
    // frontmatter (order, comments, numeric spellings), body, everything.
    assert.deepStrictEqual(after, before);

    const topic = env.readTopic('assessed.md');
    const fm = topic.frontmatter as Record<string, unknown>;

    // Parsed-value assertions too (belt and braces).
    assert.strictEqual(fm.conceptual, 0.8);
    assert.strictEqual(fm.practical, 0.7);
    assert.strictEqual(fm.debug, 0.9);
    assert.strictEqual(fm.feynman, 0.85);
    assert.strictEqual(fm.assessed_at, '2026-09-01');

    // Non-zero mastery untouched.
    assert.strictEqual(fm.topic_mastery, 0.82);

    // Review fields DID update (SM-2 first successful review).
    assert.strictEqual(fm.repetition, 1);
    assert.strictEqual(fm.ease_factor, 2.5);
    assert.strictEqual(fm.interval_days, 1);
    assert.ok(typeof fm.last_reviewed_at === 'string' && fm.last_reviewed_at.length > 0);
    assert.ok(typeof fm.due_at === 'string' && fm.due_at.length > 0);
  });

  test('palee review preserves assessment state across repeated reviews', () => {
    writeAssessedTopic();

    const first = env.run(['review', 'T-assessed', '5']);
    assert.strictEqual(first.status, 0);
    const second = env.run(['review', 'T-assessed', '3']);
    assert.strictEqual(second.status, 0);

    const topic = env.readTopic('assessed.md');
    const fm = topic.frontmatter as Record<string, unknown>;

    // Assessment data still intact after two review mutations.
    assert.strictEqual(fm.conceptual, 0.8);
    assert.strictEqual(fm.practical, 0.7);
    assert.strictEqual(fm.debug, 0.9);
    assert.strictEqual(fm.feynman, 0.85);
    assert.strictEqual(fm.assessed_at, '2026-09-01');
    assert.strictEqual(fm.topic_mastery, 0.82);

    // SM-2 state advanced (second review: repetition 2).
    assert.strictEqual(fm.repetition, 2);
  });

  test('palee review on a topic with assessment but no review history starts SM-2 cleanly', () => {
    env.createTopic(
      'fresh.md',
      {
        palee_id: 'T-fresh-assessed',
        title: 'Fresh Assessed',
        conceptual: 0.6,
        practical: 0.6,
        debug: 0.6,
        feynman: 0.6,
        assessed_at: '2026-09-01',
        topic_mastery: 0.6,
      },
      'Notes.'
    );

    const res = env.run(['review', 'T-fresh-assessed', '4']);
    assert.strictEqual(res.status, 0);

    const fm = env.readTopic('fresh.md').frontmatter as Record<string, unknown>;
    // Assessment + mastery preserved; SM-2 initialized.
    assert.strictEqual(fm.conceptual, 0.6);
    assert.strictEqual(fm.topic_mastery, 0.6);
    assert.strictEqual(fm.repetition, 1);
  });
});

describe('assessment-review independence, reverse direction (#40)', () => {
  let env: ReturnType<typeof createTestVault>;

  beforeEach(() => {
    env = createTestVault('palee-independence-rev-');
  });

  afterEach(() => {
    env.cleanup();
  });

  /** The seven SM-2 review fields a curriculum write must never touch. */
  const SM2_FIELDS =
    /^(last_quality|last_reviewed_at|due_at|ease_factor|interval_days|repetition|lapses):/;

  /**
   * Extracts the seven SM-2 lines from a raw note, in order, for
   * byte-level comparison across an assessment-path mutation. The
   * curriculum import legitimately rewrites metadata lines (title,
   * difficulty, depends_on, palee_id), so only these seven lines are
   * comparable byte-for-byte.
   */
  function sm2Lines(raw: string): string[] {
    return raw.split('\n').filter((line) => SM2_FIELDS.test(line));
  }

  test('roadmap import preserves all seven SM-2 review fields on a reviewed topic', () => {
    // A topic that has been through real reviews: its SM-2 state is
    // non-default on every field (two reviews of quality 5, then 3).
    env.createTopic(
      'reviewed.md',
      {
        palee_id: 'T-reviewed',
        title: 'Reviewed Topic',
        difficulty: 'beginner',
      },
      'Notes before import.'
    );
    const r1 = env.run(['review', 'T-reviewed', '5']);
    assert.strictEqual(r1.status, 0);
    const r2 = env.run(['review', 'T-reviewed', '3']);
    assert.strictEqual(r2.status, 0);

    const reviewedRaw = fs.readFileSync(path.join(env.vaultDir, 'reviewed.md'), 'utf8');
    const reviewedFm = env.readTopic('reviewed.md').frontmatter as Record<string, unknown>;
    // Real, non-default SM-2 state on disk before the import.
    assert.ok(reviewedFm.last_quality !== undefined && reviewedFm.last_quality !== null);
    assert.ok(typeof reviewedFm.last_reviewed_at === 'string');
    assert.ok(typeof reviewedFm.due_at === 'string');
    assert.ok(typeof reviewedFm.ease_factor === 'number');
    assert.ok(typeof reviewedFm.interval_days === 'number');
    assert.strictEqual(reviewedFm.repetition, 2);
    assert.strictEqual(reviewedFm.lapses, 0);

    // The curriculum write path: a roadmap import targets the same note
    // (by palee_id + path) and rewrites metadata including assessment
    // fields through resolveTopicUpdates.
    const roadmapFile = path.join(env.tempDir, 'update-roadmap.yaml');
    fs.writeFileSync(
      roadmapFile,
      'topics:\n' +
      '  - id: T-reviewed\n' +
      '    title: Reviewed Topic (Curriculum Update)\n' +
      '    path: reviewed.md\n',
      'utf8'
    );
    const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
    assert.strictEqual(res.status, 0, `roadmap import failed: ${res.stderr}`);

    const importedRaw = fs.readFileSync(path.join(env.vaultDir, 'reviewed.md'), 'utf8');
    const importedFm = env.readTopic('reviewed.md').frontmatter as Record<string, unknown>;

    // The seven SM-2 fields survive with their exact values.
    assert.strictEqual(importedFm.last_quality, reviewedFm.last_quality);
    assert.strictEqual(importedFm.last_reviewed_at, reviewedFm.last_reviewed_at);
    assert.strictEqual(importedFm.due_at, reviewedFm.due_at);
    assert.strictEqual(importedFm.ease_factor, reviewedFm.ease_factor);
    assert.strictEqual(importedFm.interval_days, reviewedFm.interval_days);
    assert.strictEqual(importedFm.repetition, reviewedFm.repetition);
    assert.strictEqual(importedFm.lapses, reviewedFm.lapses);

    // And byte-for-byte: the seven SM-2 lines are identical in content,
    // order, and spelling (the import rewrites metadata lines like title,
    // so only the SM-2 block is byte-comparable).
    assert.deepStrictEqual(sm2Lines(importedRaw), sm2Lines(reviewedRaw));

    // The import DID rewrite curriculum metadata (proof the mutation ran).
    assert.strictEqual(importedFm.title, 'Reviewed Topic (Curriculum Update)');
  });

  test('roadmap import preserves SM-2 state even on topics with failed-recall lapses', () => {
    // The lapse path is the richest SM-2 state (interval reset to 1,
    // lapses incremented) — the strongest preservation assertion.
    env.createTopic(
      'lapsed.md',
      {
        palee_id: 'T-lapsed',
        title: 'Lapsed Topic',
      },
      'Notes.'
    );
    const ok = env.run(['review', 'T-lapsed', '5']);
    assert.strictEqual(ok.status, 0);
    const fail = env.run(['review', 'T-lapsed', '1']);
    assert.strictEqual(fail.status, 0);

    const beforeFm = env.readTopic('lapsed.md').frontmatter as Record<string, unknown>;
    assert.strictEqual(beforeFm.lapses, 1);

    const roadmapFile = path.join(env.tempDir, 'lapse-roadmap.yaml');
    fs.writeFileSync(
      roadmapFile,
      'topics:\n' +
      '  - id: T-lapsed\n' +
      '    title: Lapsed Topic (Curriculum Update)\n' +
      '    path: lapsed.md\n',
      'utf8'
    );
    const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
    assert.strictEqual(res.status, 0, `roadmap import failed: ${res.stderr}`);

    const afterFm = env.readTopic('lapsed.md').frontmatter as Record<string, unknown>;
    // Failed-recall state survives a curriculum write untouched.
    assert.strictEqual(afterFm.lapses, 1);
    assert.strictEqual(afterFm.repetition, beforeFm.repetition);
    assert.strictEqual(afterFm.ease_factor, beforeFm.ease_factor);
    assert.strictEqual(afterFm.interval_days, 1);
    assert.strictEqual(afterFm.last_quality, beforeFm.last_quality);
    assert.strictEqual(afterFm.last_reviewed_at, beforeFm.last_reviewed_at);
    assert.strictEqual(afterFm.due_at, beforeFm.due_at);
  });
});
