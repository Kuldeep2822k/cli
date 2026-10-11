import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildReviewUpdate } from '../src/application/record-review';
import { formatLocalDateOnly } from '../src/engine/sm2';

const reviewedAt = new Date('2026-05-01T12:00:00.000Z');

describe('buildReviewUpdate', () => {
  test('a passing review advances the SM-2 state and stamps the dates', () => {
    const { updates, newState, dueDate } = buildReviewUpdate({}, 5, reviewedAt);
    assert.strictEqual(newState.repetition, 1);
    assert.ok((newState.interval_days ?? 0) >= 1);
    assert.strictEqual(updates.last_reviewed_at, formatLocalDateOnly(reviewedAt));
    assert.strictEqual(updates.due_at, formatLocalDateOnly(dueDate));
    assert.strictEqual(updates.repetition, newState.repetition);
  });

  test('a failing review (quality < 3) resets interval to 1 day', () => {
    const { newState } = buildReviewUpdate({ repetition: 4, interval_days: 30 }, 1, reviewedAt);
    assert.strictEqual(newState.interval_days, 1);
    assert.strictEqual(newState.repetition, 0);
  });

  test('empty frontmatter yields no pillar keys and zero mastery (#300)', () => {
    const { updates } = buildReviewUpdate({}, 4, reviewedAt);
    // A review records the SM-2 outcome, not an assessment the learner never
    // made: minting `conceptual: 0` & co. made the note look assessed-but-zero
    // while `assessed_at` stayed null, and pinned mastery against a computed 0.
    assert.ok(!('conceptual' in updates), 'absent conceptual must not be written');
    assert.ok(!('practical' in updates), 'absent practical must not be written');
    assert.ok(!('debug' in updates), 'absent debug must not be written');
    assert.ok(!('feynman' in updates), 'absent feynman must not be written');
    assert.strictEqual(updates.topic_mastery, 0);
  });

  test('present pillars pass through unchanged while absent ones stay omitted', () => {
    const { updates } = buildReviewUpdate({ conceptual: 0.5, feynman: 0.25 }, 4, reviewedAt);
    assert.strictEqual(updates.conceptual, 0.5);
    assert.strictEqual(updates.feynman, 0.25);
    assert.ok(!('practical' in updates), 'absent practical must not be written');
    assert.ok(!('debug' in updates), 'absent debug must not be written');
  });

  test('a pillar written explicitly as null is treated as absent, not zeroed (#300)', () => {
    const { updates } = buildReviewUpdate({ conceptual: null }, 4, reviewedAt);
    assert.ok(!('conceptual' in updates));
  });

  test('existing pillar scores are preserved into the update and drive mastery', () => {
    const { updates } = buildReviewUpdate(
      { conceptual: 0.8, practical: 0.8, debug: 0.8, feynman: 0.8 },
      4,
      reviewedAt,
    );
    assert.strictEqual(updates.conceptual, 0.8);
    assert.strictEqual(updates.feynman, 0.8);
    assert.ok(typeof updates.topic_mastery === 'number' && updates.topic_mastery > 0);
  });

  test('a literal repetition of 0 is treated as a real base, not a missing field', () => {
    const { newState } = buildReviewUpdate({ repetition: 0, interval_days: 1, ease_factor: 2.5 }, 5, reviewedAt);
    assert.strictEqual(newState.repetition, 1);
  });
});
