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
 * - Missing assessment data (the newly-adopted default state) has nothing to
 *   compare against and never reports — that includes legacy topics whose
 *   pre-adoption `topic_mastery` predates the assessment formula.
 * - Archived topics are still checked: internal consistency matters for any
 *   topic the vault still stores.
 * - The stored value is read raw from frontmatter: the loader coerces
 *   present-but-malformed mastery to 0, which would silently bless garbage
 *   whenever the computed value is also 0.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { computeTopicMastery } from '../../engine/mastery';
import { isValidAssessedAt } from './assessed-at';

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
      // All four pillars absent: the newly-adopted default state has no
      // assessment data to derive mastery from. A stored non-zero legacy
      // mastery here is pre-adoption data, not drift against this
      // formula — comparing it against computed 0 would be a false
      // warning (escalated to exit 3 by --strict). Partial assessments
      // remain eligible: present pillars feed the formula with the
      // documented 0 default for absent ones.
      const allPillarsAbsent = SCORE_FIELDS.every(
        (field) =>
          topic.frontmatter[field] === undefined ||
          topic.frontmatter[field] === null
      );
      if (allPillarsAbsent) continue;

      const scores = SCORE_FIELDS.map((field): number | undefined => {
        const value: unknown = topic.frontmatter[field];
        // #36 reports non-numeric/out-of-range shapes; missing pillars are the
        // documented adopt default (0) and DO feed the formula — partial
        // assessments are valid input, not a skip condition.
        return isShapedScore(value) ? value : undefined;
      });

      // #36 jurisdiction: invalid score SHAPES are reported there, not here.
      // A present-but-malformed value is `undefined` after the guard and
      // must skip this rule; an absent pillar normalizes to 0 below.
      if (
        scores.some(
          (value, i) =>
            value === undefined &&
            topic.frontmatter[SCORE_FIELDS[i]] !== undefined &&
            topic.frontmatter[SCORE_FIELDS[i]] !== null
        )
      ) {
        continue;
      }

      // Invalid assessed_at belongs to #36 as well — a topic whose
      // assessment data has any shape problem is skipped here so a stale
      // mastery never double-reports on top of #36's error. Shared
      // calendar-strict validator: both rules agree on what a valid
      // assessed_at is (impossible dates like 2026-02-30 included).
      if (!isValidAssessedAt(topic.frontmatter.assessed_at)) continue;

      // Missing pillars default to 0 per the adopt policy — the same
      // normalization the loader applies (parseScore with 0 fallback).
      const present = scores.map((value) => value ?? 0);

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
          message: `Topic ${topic.palee_id}: stored topic_mastery ${JSON.stringify(rawStored)} does not match computed ${expected} from assessment scores`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'topic_mastery',
          details: { actual: rawStored, expected },
        });
        continue;
      }

      // Finite raw values compare through the loader-normalized
      // LoadedTopic.topic_mastery — the same number every runtime
      // consumer sees (parseScore clamps and rounds); absent mastery
      // loads as the documented 0 default.
      const actual = topic.topic_mastery;

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
