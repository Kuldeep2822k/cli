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
 *   compare against and never reports.
 * - Archived topics are still checked: internal consistency matters for any
 *   topic the vault still stores.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { computeTopicMastery } from '../../engine/mastery';

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
      const scores = SCORE_FIELDS.map((field): number | string | undefined => {
        const value: unknown = topic.frontmatter[field];
        return isShapedScore(value) ? value : undefined;
      });

      // #36 jurisdiction: invalid score shapes are reported there, not here.
      if (scores.some((value) => value === undefined)) continue;

      // Newly-adopted topics: all scores are 0 and mastery is 0 — matching,
      // so the general path covers it. But a topic with all four scores
      // present at 0 and a NON-zero mastery is stale; do not special-case
      // zero, the formula comparison handles it.

      const expected = computeTopicMastery(
        scores[0],
        scores[1],
        scores[2],
        scores[3]
      );
      // LoadedTopic.topic_mastery is the loader-normalized value (parseScore
      // with 0 default) — the same number every runtime consumer sees.
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
