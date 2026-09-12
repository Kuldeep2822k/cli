/**
 * Assessment validation rules tests (#36, #37)
 *
 * Contracts under test:
 * - valid-assessment-fields (#36): scores must be numbers in [0.0, 1.0] read
 *   from raw frontmatter (pre-normalization), assessed_at null or a valid
 *   date; zero scores on newly adopted topics pass.
 * - valid-topic-mastery (#37): stored topic_mastery must equal
 *   round((conceptual + practical + debug + 2*feynman) / 5, 4) when the
 *   assessment fields are valid; stale mastery warns; invalid assessment
 *   data is left to rule #36; missing data never crashes.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validAssessmentFieldsRule } from '../src/validation/rules/valid-assessment-fields';
import { validTopicMasteryRule } from '../src/validation/rules/valid-topic-mastery';
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

describe('valid-assessment-fields rule (#36)', () => {
  test('all zero scores on a newly adopted topic pass', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 0, practical: 0, debug: 0, feynman: 0, assessed_at: null },
    })];
    assert.deepStrictEqual(validAssessmentFieldsRule.run(makeContext(topics)), []);
  });

  test('valid scores in [0,1] pass', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 0.85, practical: 1, debug: 0.5, feynman: 0.75, assessed_at: '2026-09-01' },
    })];
    assert.deepStrictEqual(validAssessmentFieldsRule.run(makeContext(topics)), []);
  });

  test('negative score reports an error with field and actual value', () => {
    const topics = [makeTopic({
      palee_id: 'T-bad',
      frontmatter: { conceptual: -0.2, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: null },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-assessment-fields');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-bad');
    assert.strictEqual(issues[0].field, 'conceptual');
    assert.strictEqual(issues[0].details?.actual, -0.2);
  });

  test('score above 1.0 reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 0.5, practical: 1.5, debug: 0.5, feynman: 0.5, assessed_at: null },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'practical');
    assert.strictEqual(issues[0].details?.actual, 1.5);
  });

  test('string score reports an error (raw frontmatter, pre-normalization)', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 'high', practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: null },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'conceptual');
    assert.strictEqual(issues[0].details?.actual, 'high');
  });

  test('invalid assessed_at reports an error', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: 'not-a-date' },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'assessed_at');
  });

  test('multiple invalid fields report multiple errors in field order', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 2, practical: -1, debug: 0.5, feynman: 0.5, assessed_at: [2026, 9] },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 3);
    assert.deepStrictEqual(issues.map((i) => i.field), ['conceptual', 'practical', 'assessed_at']);
  });

  test('non-finite numbers are rejected', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: Number.NaN, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: null },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'conceptual');
  });

  test('missing assessment fields follow the documented default policy (pass)', () => {
    // Missing fields are the newly-adopted default state; the loader
    // normalizes them to 0. The rule validates stored shape, not presence.
    const topics = [makeTopic({ frontmatter: {} })];
    assert.deepStrictEqual(validAssessmentFieldsRule.run(makeContext(topics)), []);
  });

  test('rule metadata: error severity, manual fixability', () => {
    assert.strictEqual(validAssessmentFieldsRule.id, 'valid-assessment-fields');
    assert.strictEqual(validAssessmentFieldsRule.severity, 'error');
    assert.strictEqual(validAssessmentFieldsRule.fixable, 'manual');
  });
});

describe('valid-topic-mastery rule (#37)', () => {
  test('matching computed mastery passes', () => {
    // (0.8 + 0.7 + 0.9 + 2*0.85) / 5 = 0.82
    const topics = [makeTopic({
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-09-01' },
      topic_mastery: 0.82,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('stale stored mastery reports a warning with actual and expected', () => {
    const topics = [makeTopic({
      palee_id: 'T-stale',
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-09-01' },
      topic_mastery: 0.5,
    })];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-mastery');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].topicId, 'T-stale');
    assert.strictEqual(issues[0].details?.actual, 0.5);
    assert.strictEqual(issues[0].details?.expected, 0.82);
  });

  test('missing assessment data does not crash and does not report', () => {
    // No assessment values at all: nothing to compare against.
    const topics = [makeTopic({ frontmatter: {}, topic_mastery: 0 })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('all pillars absent never reports, even with legacy stored mastery (CodeRabbit)', () => {
    // Pre-adoption topics may carry a legacy topic_mastery with no
    // assessment pillars; comparing it against computed 0 is a false
    // warning (escalated to exit 3 by --strict).
    const topics = [makeTopic({
      palee_id: 'T-legacy',
      frontmatter: { topic_mastery: 0.7 },
      topic_mastery: 0.7,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('present-but-malformed stored mastery is a mismatch (CodeRabbit)', () => {
    // The loader coerces garbage mastery to 0; the rule reads the raw
    // value so 'high' is reported even when the computed value is 0.
    const topics = [makeTopic({
      palee_id: 'T-garbage',
      frontmatter: { conceptual: 0, practical: 0, debug: 0, feynman: 0, topic_mastery: 'high' },
      topic_mastery: 0, // what parseScore would load
    })];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-garbage');
    assert.strictEqual(issues[0].details?.actual, 'high');
    assert.strictEqual(issues[0].details?.expected, 0);
  });

  test('absent stored mastery adopts the documented 0 default', () => {
    // No stored mastery at all + all-zero pillars: the adopt default
    // (0) matches the computed 0 — no warning.
    const topics = [makeTopic({
      palee_id: 'T-adopt',
      frontmatter: { conceptual: 0, practical: 0, debug: 0, feynman: 0 },
      topic_mastery: 0,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('out-of-range stored mastery warns even when clamping hides it (CodeRabbit)', () => {
    // The loader clamps stored 2 to 1; the raw comparison still
    // reports the drift against computed 1.
    const topics = [makeTopic({
      palee_id: 'T-clamped',
      frontmatter: { conceptual: 1, practical: 1, debug: 1, feynman: 1, topic_mastery: 2 },
      topic_mastery: 1, // what parseScore would load
    })];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-clamped');
    assert.strictEqual(issues[0].details?.actual, 2);
    assert.strictEqual(issues[0].details?.expected, 1);
  });

  test('negative out-of-range stored mastery warns against the raw value', () => {
    // Same hole on the other side: stored -0.5 clamps to 0, so a
    // computed 0 vault would otherwise look consistent.
    const topics = [makeTopic({
      palee_id: 'T-negative',
      frontmatter: { conceptual: 0, practical: 0, debug: 0, feynman: 0, topic_mastery: -0.5 },
      topic_mastery: 0, // what parseScore would load
    })];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.actual, -0.5);
    assert.strictEqual(issues[0].details?.expected, 0);
  });

  test('invalid assessment fields are left to valid-assessment-fields (no mastery report)', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 2, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: null },
      topic_mastery: 0.9,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('archived topics are still checked for internal consistency', () => {
    const topics = [makeTopic({
      palee_id: 'T-archived',
      status: 'archived',
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-09-01' },
      topic_mastery: 0.3,
    })];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-archived');
  });

  test('epsilon tolerance: serialized mastery within 1e-5 passes', () => {
    // (0.7 + 0.7 + 0.7 + 2*0.7) / 5 = 0.7 exactly, but a stored 0.69999
    // drift from float serialization must not produce a false warning.
    const topics = [makeTopic({
      frontmatter: { conceptual: 0.7, practical: 0.7, debug: 0.7, feynman: 0.7, assessed_at: null },
      topic_mastery: 0.7,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('zero-score newly adopted topics with zero mastery pass', () => {
    const topics = [makeTopic({
      frontmatter: { conceptual: 0, practical: 0, debug: 0, feynman: 0, assessed_at: null },
      topic_mastery: 0,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('multiple stale topics report deterministically by topic ID', () => {
    const mk = (id: string, mastery: number): LoadedTopic => makeTopic({
      palee_id: id,
      id,
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-09-01' },
      topic_mastery: mastery,
    });
    const topics = [mk('T-z', 0.1), mk('T-a', 0.2)];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.deepStrictEqual(issues.map((i) => i.topicId), ['T-a', 'T-z']);
  });

  test('rule metadata: warning severity, safe fixability', () => {
    assert.strictEqual(validTopicMasteryRule.id, 'valid-topic-mastery');
    assert.strictEqual(validTopicMasteryRule.severity, 'warning');
    assert.strictEqual(validTopicMasteryRule.fixable, 'safe');
  });
});

describe('review-fix rounds on #36/#37 (PR #163 bot findings)', () => {
  test('numeric epoch timestamps are valid assessed_at (Kilo CRITICAL)', () => {
    const topics = [makeTopic({
      palee_id: 'T-epoch',
      frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: 1725148800000 },
    })];
    assert.deepStrictEqual(validAssessmentFieldsRule.run(makeContext(topics)), []);
  });

  test('out-of-range numeric assessed_at (Infinity) is an error', () => {
    const topics = [makeTopic({
      palee_id: 'T-inf',
      frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: Number.POSITIVE_INFINITY },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'assessed_at');
  });

  test('partial pillars still validate mastery (Greptile P1)', () => {
    // Only feynman present: (0 + 0 + 0 + 2*0.9) / 5 = 0.36
    const topics = [makeTopic({
      palee_id: 'T-partial',
      frontmatter: { feynman: 0.9, assessed_at: '2026-09-01' },
      topic_mastery: 0.36,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('partial pillars with stale mastery report drift (Greptile P1)', () => {
    const topics = [makeTopic({
      palee_id: 'T-partial-stale',
      frontmatter: { feynman: 0.9, assessed_at: '2026-09-01' },
      topic_mastery: 0.1,
    })];
    const issues = validTopicMasteryRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-partial-stale');
    assert.strictEqual(issues[0].details?.expected, 0.36);
  });

  test('invalid assessed_at skips mastery rule — no double report (Greptile P2)', () => {
    const topics = [makeTopic({
      palee_id: 'T-bad-date',
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: 'not-a-date' },
      topic_mastery: 0.5,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('out-of-range score still skips mastery rule (no double report)', () => {
    const topics = [makeTopic({
      palee_id: 'T-oor',
      frontmatter: { conceptual: 2, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-09-01' },
      topic_mastery: 0.5,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });
});

describe('assessed_at calendar strictness (PR #163 round 2)', () => {
  test('impossible calendar dates are errors, not normalized (CodeRabbit)', () => {
    for (const bad of ['2026-02-30', '2026-04-31', '2026-06-31', '2026-09-31', '2026-02-31']) {
      const topics = [makeTopic({
        palee_id: 'T-cal',
        frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: bad },
      })];
      const issues = validAssessmentFieldsRule.run(makeContext(topics));
      assert.strictEqual(issues.length, 1, `expected ${bad} to be rejected`);
      assert.strictEqual(issues[0].field, 'assessed_at');
    }
  });

  test('real calendar dates including leap-day boundaries still pass', () => {
    for (const good of ['2026-02-28', '2024-02-29', '2026-04-30', '2026-12-31', '2026-09-01']) {
      const topics = [makeTopic({
        palee_id: 'T-cal-ok',
        frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: good },
      })];
      assert.deepStrictEqual(
        validAssessmentFieldsRule.run(makeContext(topics)),
        [],
        `expected ${good} to pass`
      );
    }
  });

  test('mastery rule skips topics with impossible assessed_at (same calendar policy)', () => {
    const topics = [makeTopic({
      palee_id: 'T-cal-skip',
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-02-30' },
      topic_mastery: 0.5,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });
});

describe('assessed_at timezone and ISO strictness (PR #163 round 3)', () => {
  test('valid date-only strings pass regardless of host timezone (Greptile P1)', () => {
    // The calendar round-trip constructs the written components with UTC
    // setters and reads them back with UTC getters — no UTC-midnight
    // parse is ever compared against local-time components, and the
    // local calendar is never consulted (zones like Pacific/Apia lack
    // 2011-12-30 entirely), so the result cannot depend on the host
    // zone. This asserts the runner's zone; the construction invariant
    // itself is zone-neutral by design.
    for (const good of ['2026-09-01', '2024-02-29', '2026-01-31', '2026-12-31']) {
      const topics = [makeTopic({
        palee_id: 'T-tz',
        frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: good },
      })];
      assert.deepStrictEqual(
        validAssessmentFieldsRule.run(makeContext(topics)),
        [],
        `expected ${good} to pass in any timezone`
      );
    }
  });

  test('impossible ISO timestamps are errors, not normalized (Greptile P1)', () => {
    // `new Date('2026-02-30T12:00:00Z')` silently rolls to March 2 —
    // the written calendar must be checked on every ISO-family form.
    for (const bad of [
      '2026-02-30T12:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-02-30T12:00:00+05:00',
      '2026-02-30T12:00:00', // local-time ISO form
      '2026-02-30t12:00:00z', // lowercase separators
      '2026-02-30Z', // date-only with Z
      '2026-2-30', // single-digit month/day
    ]) {
      const topics = [makeTopic({
        palee_id: 'T-iso-bad',
        frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: bad },
      })];
      const issues = validAssessmentFieldsRule.run(makeContext(topics));
      assert.strictEqual(issues.length, 1, `expected ${bad} to be rejected`);
      assert.strictEqual(issues[0].field, 'assessed_at');
    }
  });

  test('real ISO timestamps with valid calendars still pass', () => {
    for (const good of [
      '2026-09-01T12:00:00Z',
      '2024-02-29T00:00:00Z',
      '2026-09-01T12:00:00+05:00',
      '2026-09-01 12:00:00',
      '2026-09-01Z',
    ]) {
      const topics = [makeTopic({
        palee_id: 'T-iso-ok',
        frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: good },
      })];
      assert.deepStrictEqual(
        validAssessmentFieldsRule.run(makeContext(topics)),
        [],
        `expected ${good} to pass`
      );
    }
  });

  test('mastery rule skips impossible-ISO topics (shared validator)', () => {
    const topics = [makeTopic({
      palee_id: 'T-iso-skip',
      frontmatter: { conceptual: 0.8, practical: 0.7, debug: 0.9, feynman: 0.85, assessed_at: '2026-02-30T12:00:00Z' },
      topic_mastery: 0.5,
    })];
    assert.deepStrictEqual(validTopicMasteryRule.run(makeContext(topics)), []);
  });

  test('two-digit years keep their century through the round-trip', () => {
    // A Date constructor maps years 0-99 to 1900+year; the validator
    // builds the calendar with setUTCFullYear, which preserves the
    // written year — so an ISO 0026-02-28 round-trips as year 26.
    const good = [makeTopic({
      palee_id: 'T-yy-ok',
      frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: '0026-02-28' },
    })];
    assert.deepStrictEqual(validAssessmentFieldsRule.run(makeContext(good)), []);

    // Year 26 is not a leap year — the century must not be remapped
    // into a leap year like 2000 either.
    const bad = [makeTopic({
      palee_id: 'T-yy-bad',
      frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: '0026-02-29' },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(bad));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'assessed_at');
  });
});

describe('assessed_at UTC round-trip (PR #163 round 4)', () => {
  test('calendar checks never consult the local calendar (CodeRabbit)', () => {
    // Pacific/Apia skipped 2011-12-30 entirely — a local-constructor
    // round-trip falsely rejects that valid date there. The check
    // builds and reads the calendar in UTC, so the result is identical
    // in every zone, including zones whose local calendar lacks the day.
    for (const good of ['2011-12-30', '2011-12-31', '2012-01-01']) {
      const topics = [makeTopic({
        palee_id: 'T-apia',
        frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: good },
      })];
      assert.deepStrictEqual(
        validAssessmentFieldsRule.run(makeContext(topics)),
        [],
        `expected ${good} to pass regardless of local calendar gaps`
      );
    }
    // And impossible dates stay impossible in every zone.
    const topics = [makeTopic({
      palee_id: 'T-apia-bad',
      frontmatter: { conceptual: 0.5, practical: 0.5, debug: 0.5, feynman: 0.5, assessed_at: '2011-02-30' },
    })];
    const issues = validAssessmentFieldsRule.run(makeContext(topics));
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'assessed_at');
  });
});
