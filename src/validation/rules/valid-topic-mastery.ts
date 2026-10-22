/**
 * valid-topic-mastery rule (#37)
 *
 * @remarks
 * PALEE treats `topic_mastery` as derived data: the engine computes it from
 * the four assessment pillars. This rule recomputes the canonical value with
 * {@link computeTopicMastery} and warns when the stored value has drifted —
 * stale mastery makes recommendations and progress output lie even though
 * the raw assessment data is valid.
 *
 * Jurisdiction boundaries:
 * - Shape errors in the assessment fields belong to `valid-assessment-fields`
 *   (#36); when any pillar is not a finite number in `[0, 1]` (or
 *   `assessed_at` is invalid), this rule skips the topic rather than
 *   reporting a mastery warning on top of #36's errors.
 * - Missing assessment data (the newly-adopted default state, as well as
 *   any topic with a partial pillar set) has nothing to compare against and
 *   never reports — absent pillars mean "no data", per #277 and #300, not
 *   "zero". Only topics where all four pillars are present and shaped are
 *   eligible, and the formula is computed from those without inventing inputs.
 * - Archived topics are still checked: internal consistency matters for any
 *   topic the vault still stores.
 * - The stored value is read raw from frontmatter: the loader coerces
 *   present-but-malformed mastery to 0, which would silently bless garbage
 *   whenever the computed value is also 0.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { computeTopicMastery } from '../../engine/mastery';
import { isValidAssessedAt } from './assessed-at';
import { displayValue } from './diagnostic-value';

/** Assessment score fields consumed by the mastery formula. */
const SCORE_FIELDS = ['conceptual', 'practical', 'debug', 'feynman'] as const;

/** Epsilon for serialized-float drift (4-decimal canonical precision). */
const EPSILON = 1e-5;

/**
 * Checks one raw assessment score for shape validity.
 *
 * @remarks A valid score is a finite number in `[0, 1]`. Anything else —
 * including valid-looking numeric strings — belongs to #36, so this rule
 * treats it as "skip the topic".
 *
 * @param value - Raw frontmatter value
 * @returns True when the value is safe to feed the mastery formula
 */
function isShapedScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** Reports stored `topic_mastery` that drifts from the assessment formula. */
export const validTopicMasteryRule: ValidationRule = {
  id: 'valid-topic-mastery',
  description:
    'Stored topic_mastery must equal the weighted assessment formula when valid assessment data exists',
  severity: 'warning',
  fixable: 'safe',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      // Absent pillars mean "no data", not "zero", per the established
      // direction of #277 (carriedPillarScores omits absent pillars) and
      // #300 (review drops them). A topic with any missing pillar has
      // incomplete assessment data: the four-pillar formula cannot be
      // computed honestly, so there is nothing to compare against — the
      // same "no data" skip that already covers the all-absent default.
      const anyPillarAbsent = SCORE_FIELDS.some((field) => {
        const raw = topic.frontmatter[field];
        return raw === undefined || raw === null;
      });
      if (anyPillarAbsent) continue;

      const scores = SCORE_FIELDS.map((field): number | undefined => {
        const value: unknown = topic.frontmatter[field];
        // #36 reports non-numeric/out-of-range shapes; a present-but-malformed
        // value is `undefined` after the guard and must skip this rule.
        // Absent pillars never reach here: anyPillarAbsent above already skipped.
        return isShapedScore(value) ? value : undefined;
      });

      // #36 jurisdiction: a present-but-malformed score is `undefined` after
      // the isShapedScore guard above and must skip this rule — #36 owns
      // shape errors so this rule never double-reports them. Since any
      // absent pillar already caused an early skip, `scores` here is either
      // all numbers (valid shapes) or contains a leading undefined (shape
      // error), which is exactly the case this guard catches.
      if (
        scores.some((value, i) => {
          // `SCORE_FIELDS` is a fixed 4-tuple and `scores` was mapped from it,
          // so the index is always in bounds; the guard keeps the type honest
          // rather than asserting it.
          const field = SCORE_FIELDS[i];
          if (field === undefined) return false;
          const raw = topic.frontmatter[field];
          return value === undefined && raw !== undefined && raw !== null;
        })
      ) {
        continue;
      }

      // Invalid assessed_at belongs to #36 as well — a topic whose
      // assessment data has any shape problem is skipped here so a stale
      // mastery never double-reports on top of #36's error. Shared
      // calendar-strict validator: both rules agree on what a valid
      // assessed_at is (impossible dates like 2026-02-30 included).
      if (!isValidAssessedAt(topic.frontmatter.assessed_at)) continue;

      // All four pillars are present and shaped (absent ones were skipped
      // above; shape errors were skipped above), so every entry is a finite
      // number — no zero-fill needed.
      const present = scores as [number, number, number, number];

      const expected = computeTopicMastery(
        present[0],
        present[1],
        present[2],
        present[3]
      );
      // Raw on-disk mastery, not the loader-normalized value: parseScore
      // coerces present-but-malformed values to 0, which would silently
      // bless garbage mastery whenever the computed value is also 0. A
      // present value that is not a finite number is a mismatch by
      // definition — the stored derived data is not the formula output.
      const rawStored: unknown = topic.frontmatter.topic_mastery;
      const malformed =
        rawStored !== undefined &&
        rawStored !== null &&
        !(typeof rawStored === 'number' && Number.isFinite(rawStored));
      if (malformed) {
        issues.push({
          ruleId: 'valid-topic-mastery',
          severity: 'warning',
          message: `Topic ${topic.palee_id}: stored topic_mastery ${JSON.stringify(displayValue(rawStored))} does not match computed ${expected} from assessment scores`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'topic_mastery',
          details: { actual: displayValue(rawStored), expected },
        });
        continue;
      }

      // Finite raw values compare directly against the expected value,
      // before any loader normalization: parseScore clamps (stored 2 → 1)
      // and rounds, which would hide drift whenever the computed value
      // matches the normalized form (stored 2 vs computed 1). Every
      // legitimate write path stores the formula's own 4-decimal output,
      // so the epsilon (1e-5) still absorbs serialized-float drift.
      // Absent mastery loads as the documented 0 default.
      const actual =
        typeof rawStored === 'number' && Number.isFinite(rawStored)
          ? rawStored
          : topic.topic_mastery;

      if (Math.abs(actual - expected) > EPSILON) {
        issues.push({
          ruleId: 'valid-topic-mastery',
          severity: 'warning',
          message: `Topic ${topic.palee_id}: stored topic_mastery ${actual} does not match computed ${expected} from assessment scores`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'topic_mastery',
          details: { actual, expected },
        });
      }
    }

    // Deterministic report order: ascending topic ID, code-unit comparison.
    issues.sort((a, b) =>
      (a.topicId ?? '').localeCompare(b.topicId ?? '') ||
      (a.file ?? '').localeCompare(b.file ?? '')
    );

    return issues;
  },
};
