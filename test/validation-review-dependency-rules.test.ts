/**
 * Review-state and dependency-list validation rule tests (#38, #39, #33)
 *
 * Contracts under test:
 * - valid-review-fields (#38): SM-2 numeric bounds read from raw
 *   frontmatter (pre-normalization) — ease >= 1.3, interval >= 1,
 *   counters >= 0, last_quality null or integer 0-5; missing fields
 *   are the adopt-default state and pass; adopt-written review
 *   blocks pass; strings that the loader would coerce are errors.
 * - valid-review-dates (#39): date-only YYYY-MM-DD contract for
 *   last_reviewed_at/due_at — null passes (newly adopted), full
 *   timestamps fail, impossible calendars fail, due < reviewed fails.
 * - valid-dependency-list (#33): depends_on shape — array of
 *   non-empty strings, no self-references (error), duplicates
 *   (warning), missing/null treated as the empty list.
 * - review-dates shared validator: strict date-only parsing and the
 *   real-calendar check are shared with the assessed_at policy.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validReviewFieldsRule } from '../src/validation/rules/valid-review-fields';
import { validReviewDatesRule } from '../src/validation/rules/valid-review-dates';
import { validDependencyListRule } from '../src/validation/rules/valid-dependency-list';
import { isValidReviewDate, parseDateOnly } from '../src/validation/rules/review-dates';
import type { ValidationContext } from '../src/validation/types';
import type { LoadedTopic } from '../src/storage/loader';
import type { ScannedNote } from '../src/types';

/** Minimal topic builder; frontmatter carries the RAW on-disk values. */
function makeTopic(overrides: Partial<LoadedTopic> = {}): LoadedTopic {
  return {
    palee_id: 'T-topic',
    id: 'T-topic',
    title: 'Topic',
    path: 'topic.md',
    filePath: '/vault/topic.md',
    content: '---\n---\n',
    frontmatter: {},
    difficulty: 'beginner',
    depends_on: [],
    topic_mastery: 0,
    status: 'not_started',
    ...overrides,
  };
}

/** Minimal context builder wiring topics to an empty note set. */
function makeContext(
  topics: LoadedTopic[],
  notes: ScannedNote[] = []
): ValidationContext {
  return {
    vaultPath: '/vault',
    files: notes.map((n) => n.absolutePath),
    topics,
    notes,
    readIncomplete: false,
  };
}

/** The exact review block `adopt` writes on a fresh topic. */
const ADOPT_REVIEW_STATE = {
  ease_factor: 2.5,
  interval_days: 1,
  repetition: 0,
  lapses: 0,
  last_quality: null,
  last_reviewed_at: null,
  due_at: null,
};

describe('valid-review-fields rule (#38)', () => {
  test('adopt-written review block on a new topic passes', () => {
    const topics = [makeTopic({ frontmatter: { ...ADOPT_REVIEW_STATE } })];
    assert.deepStrictEqual(validReviewFieldsRule.run(makeContext(topics)), []);
  });

  test('valid reviewed topic state passes', () => {
    const topics = [makeTopic({
      frontmatter: {
        ease_factor: 1.8,
        interval_days: 6,
        repetition: 2,
        lapses: 1,
        last_quality: 4,
        last_reviewed_at: '2026-09-01',
        due_at: '2026-09-07',
      },
    })];
    assert.deepStrictEqual(validReviewFieldsRule.run(makeContext(topics)), []);
  });

  test('new topic with no review keys at all passes (adopt-default policy)', () => {
    const topics = [makeTopic({ frontmatter: {} })];
    assert.deepStrictEqual(validReviewFieldsRule.run(makeContext(topics)), []);
  });

  test('ease_factor below 1.3 reports an error', () => {
    const topics = [makeTopic({
      palee_id: 'T-bad-ef',
      frontmatter: { ...ADOPT_REVIEW_STATE, ease_factor: 1.2 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-review-fields');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-bad-ef');
    assert.strictEqual(issues[0].field, 'ease_factor');
    assert.strictEqual(issues[0].details?.actual, 1.2);
  });

  test('negative interval_days reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, interval_days: -3 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'interval_days');
    assert.strictEqual(issues[0].details?.actual, -3);
  });

  test('negative repetition reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, repetition: -1 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'repetition');
  });

  test('negative lapses reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, lapses: -2 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'lapses');
  });

  test('non-integer interval_days reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, interval_days: 4.5 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'interval_days');
    assert.strictEqual(issues[0].details?.actual, 4.5);
  });

  test('non-integer last_quality reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, last_quality: 4.5 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'last_quality');
    assert.strictEqual(issues[0].details?.actual, 4.5);
  });

  test('last_quality outside 0-5 reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, last_quality: 6 },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'last_quality');
  });

  test('stringified numeric field reports an error (raw read, pre-coercion)', () => {
    // The loader's parseNumber('2.5') would coerce this to a valid 2.5 —
    // the raw read exists to expose it.
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, ease_factor: '2.5' },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'ease_factor');
    assert.strictEqual(issues[0].details?.actual, '2.5');
  });

  test('null numeric state fields report errors (never any PALEE writer output)', () => {
    // adopt writes 2.5/1/0/0; review always writes numbers. A null
    // ease_factor cannot have been produced by any command.
    const topics = [makeTopic({
      frontmatter: { ...ADOPT_REVIEW_STATE, ease_factor: null, repetition: null },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 2);
    assert.deepStrictEqual(issues.map((i) => i.field), ['ease_factor', 'repetition']);
  });

  test('multiple invalid fields report in declaration order', () => {
    const topics = [makeTopic({
      frontmatter: {
        ease_factor: 0.5,
        interval_days: 0,
        repetition: -1,
        lapses: -4,
        last_quality: 9,
      },
    })];
    const issues = validReviewFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 5);
    assert.deepStrictEqual(
      issues.map((i) => i.field),
      ['ease_factor', 'interval_days', 'repetition', 'lapses', 'last_quality']
    );
  });

  test('rule metadata: id, error severity, manual fixability', () => {
    assert.strictEqual(validReviewFieldsRule.id, 'valid-review-fields');
    assert.strictEqual(validReviewFieldsRule.severity, 'error');
    assert.strictEqual(validReviewFieldsRule.fixable, 'manual');
  });
});

describe('valid-review-dates rule (#39)', () => {
  test('null dates on a newly adopted topic pass', () => {
    const topics = [makeTopic({ frontmatter: { ...ADOPT_REVIEW_STATE } })];
    assert.deepStrictEqual(validReviewDatesRule.run(makeContext(topics)), []);
  });

  test('valid date-only values pass', () => {
    const topics = [makeTopic({
      frontmatter: {
        last_reviewed_at: '2026-09-01',
        due_at: '2026-09-07',
      },
    })];
    assert.deepStrictEqual(validReviewDatesRule.run(makeContext(topics)), []);
  });

  test('due_at equal to last_reviewed_at passes', () => {
    const topics = [makeTopic({
      frontmatter: { last_reviewed_at: '2026-09-01', due_at: '2026-09-01' },
    })];
    assert.deepStrictEqual(validReviewDatesRule.run(makeContext(topics)), []);
  });

  test('full ISO timestamp fails the date-only contract', () => {
    const topics = [makeTopic({
      palee_id: 'T-ts',
      frontmatter: { due_at: '2026-09-01T12:00:00Z' },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-review-dates');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].field, 'due_at');
    assert.strictEqual(issues[0].details?.actual, '2026-09-01T12:00:00Z');
  });

  test('impossible calendar date fails (2026-02-31 is not normalized)', () => {
    const topics = [makeTopic({
      frontmatter: { last_reviewed_at: '2026-02-31' },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'last_reviewed_at');
  });

  test('single-digit date spelling fails strict zero-padded form', () => {
    const topics = [makeTopic({
      frontmatter: { due_at: '2026-9-1' },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'due_at');
  });

  test('due_at earlier than last_reviewed_at reports the inversion', () => {
    const topics = [makeTopic({
      palee_id: 'T-inverted',
      frontmatter: { last_reviewed_at: '2026-09-10', due_at: '2026-09-01' },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-review-dates');
    assert.strictEqual(issues[0].topicId, 'T-inverted');
    assert.strictEqual(issues[0].field, 'due_at');
    assert.strictEqual(issues[0].details?.due_at, '2026-09-01');
    assert.strictEqual(issues[0].details?.last_reviewed_at, '2026-09-10');
  });

  test('inversion is not double-reported when a field is also invalid', () => {
    // due_at is a timestamp (invalid) and also earlier — one shape
    // error only, no speculative inversion finding on garbage input.
    const topics = [makeTopic({
      frontmatter: { last_reviewed_at: '2026-09-10', due_at: '2020-01-01T00:00:00Z' },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'due_at');
    assert.match(issues[0].message, /YYYY-MM-DD/);
  });

  test('non-string date values fail (numbers, booleans)', () => {
    const topics = [makeTopic({
      frontmatter: { due_at: 20260901 },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'due_at');
    assert.strictEqual(issues[0].details?.actual, 20260901);
  });

  test('both fields invalid report two errors in read order', () => {
    const topics = [makeTopic({
      frontmatter: { last_reviewed_at: 'yesterday', due_at: 'tomorrow' },
    })];
    const issues = validReviewDatesRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 2);
    assert.deepStrictEqual(
      issues.map((i) => i.field),
      ['last_reviewed_at', 'due_at']
    );
  });

  test('rule metadata: id, error severity, manual fixability', () => {
    assert.strictEqual(validReviewDatesRule.id, 'valid-review-dates');
    assert.strictEqual(validReviewDatesRule.severity, 'error');
    assert.strictEqual(validReviewDatesRule.fixable, 'manual');
  });
});

describe('review-dates shared validator (#39)', () => {
  test('parseDateOnly extracts components from strict spellings only', () => {
    assert.deepStrictEqual(parseDateOnly('2026-09-07'), { year: 2026, month: 9, day: 7 });
    assert.strictEqual(parseDateOnly('2026-09-07T12:00:00Z'), null);
    assert.strictEqual(parseDateOnly('2026-9-7'), null);
    assert.strictEqual(parseDateOnly(20260907), null);
    assert.strictEqual(parseDateOnly(null), null);
  });

  test('isValidReviewDate accepts null/absent and real calendar dates', () => {
    assert.strictEqual(isValidReviewDate(null), true);
    assert.strictEqual(isValidReviewDate(undefined), true);
    assert.strictEqual(isValidReviewDate('2026-09-07'), true);
    assert.strictEqual(isValidReviewDate('2024-02-29'), true); // leap year
  });

  test('isValidReviewDate rejects impossible dates and timestamps', () => {
    assert.strictEqual(isValidReviewDate('2026-02-31'), false);
    assert.strictEqual(isValidReviewDate('2027-02-29'), false); // non-leap
    assert.strictEqual(isValidReviewDate('2026-09-01T00:00:00Z'), false);
    assert.strictEqual(isValidReviewDate('not-a-date'), false);
    assert.strictEqual(isValidReviewDate(12345), false);
  });

  test('leap-day policy matches the assessed_at calendar round-trip', () => {
    // Same engine: both date policies must agree on 2024-02-29.
    assert.strictEqual(isValidReviewDate('2024-02-29'), true);
    assert.strictEqual(isValidReviewDate('2023-02-29'), false);
  });
});

describe('valid-dependency-list rule (#33)', () => {
  test('missing depends_on is the adopt-default empty list and passes', () => {
    const topics = [makeTopic({ frontmatter: {} })];
    assert.deepStrictEqual(validDependencyListRule.run(makeContext(topics)), []);
  });

  test('explicit null depends_on passes (empty-list policy)', () => {
    const topics = [makeTopic({ frontmatter: { depends_on: null } })];
    assert.deepStrictEqual(validDependencyListRule.run(makeContext(topics)), []);
  });

  test('empty dependency list passes', () => {
    const topics = [makeTopic({ frontmatter: { depends_on: [] } })];
    assert.deepStrictEqual(validDependencyListRule.run(makeContext(topics)), []);
  });

  test('clean list of string IDs passes', () => {
    const topics = [makeTopic({
      palee_id: 'T-c',
      frontmatter: { depends_on: ['T-a', 'T-b'] },
    })];
    assert.deepStrictEqual(validDependencyListRule.run(makeContext(topics)), []);
  });

  test('string instead of array reports an error', () => {
    const topics = [makeTopic({
      palee_id: 'T-str',
      frontmatter: { depends_on: 'T-a, T-b' },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-dependency-list');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-str');
    assert.strictEqual(issues[0].field, 'depends_on');
    assert.strictEqual(issues[0].details?.actual, 'T-a, T-b');
  });

  test('non-string array items report errors (no String() coercion)', () => {
    const topics = [makeTopic({
      palee_id: 'T-mixed',
      frontmatter: { depends_on: ['T-a', 42, null, true] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    // 42, null, true are each reported; T-a is fine.
    assert.strictEqual(issues.length, 3);
    assert.deepStrictEqual(
      issues.map((i) => i.details?.actual),
      [42, null, true]
    );
  });

  test('empty-string entry reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { depends_on: ['T-a', ''] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].details?.actual, '');
  });

  test('self-dependency reports an error', () => {
    const topics = [makeTopic({
      palee_id: 'T-self',
      frontmatter: { depends_on: ['T-self'] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-dependency-list');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-self');
    assert.match(issues[0].message, /itself/);
  });

  test('duplicate dependency entries report a warning per duplicated ID', () => {
    const topics = [makeTopic({
      palee_id: 'T-dup',
      frontmatter: { depends_on: ['T-a', 'T-b', 'T-a', 'T-a', 'T-b'] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 2);
    assert.deepStrictEqual(
      issues.map((i) => i.severity),
      ['warning', 'warning']
    );
    // Duplicated IDs report in first-duplicate-seen order: T-a then T-b.
    assert.deepStrictEqual(
      issues.map((i) => i.details?.actual),
      ['T-a', 'T-b']
    );
  });

  test('shape errors, self-reference, and duplicates all report independently', () => {
    const topics = [makeTopic({
      palee_id: 'T-messy',
      frontmatter: { depends_on: ['T-messy', 'T-a', 5, 'T-a'] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    // 5 (non-string, error), self-reference (error), T-a dupe (warning)
    assert.strictEqual(issues.length, 3);
    assert.deepStrictEqual(
      issues.map((i) => i.severity),
      ['error', 'error', 'warning']
    );
  });

  test('duplicates that differ only by surrounding whitespace dedupe to one warning', () => {
    const topics = [makeTopic({
      frontmatter: { depends_on: ['T-a', ' T-a '] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].details?.actual, 'T-a');
  });

  test('padded self-dependency reports an error (loader-trim semantics)', () => {
    // Greptile P2: `' T-self '` trims to a real self-reference during
    // loader normalization — strict Array.includes would miss it.
    const topics = [makeTopic({
      palee_id: 'T-self',
      frontmatter: { depends_on: [' T-self '] },
    })];
    const issues = validDependencyListRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-dependency-list');
    assert.strictEqual(issues[0].severity, 'error');
    assert.match(issues[0].message, /itself/);
  });

  test('rule metadata: id, error severity (mixed rule), manual fixability', () => {
    assert.strictEqual(validDependencyListRule.id, 'valid-dependency-list');
    assert.strictEqual(validDependencyListRule.severity, 'error');
    // Manual, not safe: only duplicate findings are safely dedupable;
    // shape errors and self-references need human judgment (Greptile).
    assert.strictEqual(validDependencyListRule.fixable, 'manual');
  });
});
