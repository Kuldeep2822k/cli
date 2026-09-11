/**
 * valid-assessment-fields rule (#36)
 *
 * @remarks
 * Validates the RAW on-disk assessment shape on topic notes — the loader
 * clamps and coerces scores during normalization, so this rule reads the
 * original frontmatter values to expose real vault corruption instead of
 * silently blessing it. Scores must be finite numbers in [0.0, 1.0];
 * `assessed_at` must be null or a parseable date. Shape only — mastery
 * formula consistency belongs to `valid-topic-mastery` (#37).
 */

import type { ValidationRule, ValidationIssue } from '../types';

/** Assessment score fields covered by this rule. */
const SCORE_FIELDS = ['conceptual', 'practical', 'debug', 'feynman'] as const;

/**
 * Validates an `assessed_at` value: null, absent, or a parseable date.
 *
 * @remarks
 * YAML parses bare timestamps like `1725148800000` as numbers (ms since
 * epoch) and quoted/unquoted date strings as strings — both are accepted
 * storage forms. `Date` objects cannot reach this rule (frontmatter is
 * plain YAML scalars), so they are not handled.
 *
 * @param value - Raw frontmatter value for `assessed_at`
 * @returns True when the value is acceptable
 */
function isValidAssessedAt(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') {
    // Numeric epoch timestamps (ms since epoch) are valid dates.
    return !Number.isNaN(new Date(value).getTime());
  }
  if (typeof value === 'string') {
    return !Number.isNaN(new Date(value).getTime());
  }
  return false;
}

/** Reports assessment fields that are missing range or type validity. */
export const validAssessmentFieldsRule: ValidationRule = {
  id: 'valid-assessment-fields',
  description: 'Assessment scores must be numbers within 0.0-1.0; assessed_at must be null or a valid date',
  severity: 'error',
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      // Deterministic per-topic report order: score fields in declaration
      // order, then assessed_at.
      const rawFields: Array<{ field: string; value: unknown }> = SCORE_FIELDS.map((field) => ({
        field,
        value: topic.frontmatter[field],
      }));
      rawFields.push({ field: 'assessed_at', value: topic.frontmatter.assessed_at });

      for (const { field, value } of rawFields) {
        if (field === 'assessed_at') {
          if (!isValidAssessedAt(value)) {
            issues.push({
              ruleId: 'valid-assessment-fields',
              severity: 'error',
              message: `Topic ${topic.palee_id}: assessed_at must be null or a valid date, got ${JSON.stringify(value)}`,
              file: topic.path,
              topicId: topic.palee_id,
              field,
              details: { actual: value },
            });
          }
          continue;
        }

        const isMissing = value === null || value === undefined;
        if (isMissing) continue; // documented default policy: missing = 0 on adoption

        const isValid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 1;
        if (!isValid) {
          issues.push({
            ruleId: 'valid-assessment-fields',
            severity: 'error',
            message: `Topic ${topic.palee_id}: assessment field ${field} must be a number within 0.0-1.0, got ${JSON.stringify(value)}`,
            file: topic.path,
            topicId: topic.palee_id,
            field,
            details: { actual: value },
          });
        }
      }
    }

    return issues;
  },
};
