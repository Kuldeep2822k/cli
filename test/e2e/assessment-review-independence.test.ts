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
