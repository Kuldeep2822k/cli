/**
 * valid-review-fields rule (#38)
 *
 * @remarks
 * Validates the RAW on-disk SM-2 review state on topic notes — the
 * loader coerces during normalization (`parseNumber` defaults garbage
 * to 2.5, `parseInteger` floors 4.7 and accepts strings), so this rule
 * reads the original frontmatter values to expose real vault
 * corruption instead of silently blessing it — the same rationale as
 * `valid-assessment-fields` (#36).
 *
 * Boundaries mirror the engine contract (`src/engine/sm2.ts`
 * `processReview` preconditions, frozen SM-2 invariants):
 * - `ease_factor`: number, finite, >= 1.3 (SM-2 floor)
 * - `interval_days`: number, finite, integer, >= 1
 * - `repetition`: number, finite, integer, >= 0
 * - `lapses`: number, finite, integer, >= 0
 * - `last_quality`: null, or an integer 0-5
 *
 * Missing fields are never reported: adopt writes the full review
 * block on every topic, so a missing key cannot be produced by any
 * PALEE writer and would only exist in hand-authored pre-adoption
 * notes — the documented adopt-default policy (missing = default
 * state, the same pass-through #36 gives missing assessment scores)
 * keeps them valid. `null` marks the never-reviewed state for
 * `last_quality`/`last_reviewed_at`/`due_at`; null ease/interval/
 * repetition/lapses values are NOT the adopt shape (adopt writes 2.5/
 * 1/0/0) and are reported as errors — a topic that can never have
 * been written by any PALEE command must not be silently blessed.
 *
 * Date fields belong to `valid-review-dates` (#39); this rule owns
 * the numeric/enum shape only.
 */

import type { ValidationRule, ValidationIssue } from '../types';

/** Numeric review fields with their SM-2 bounds. */
const NUMERIC_FIELDS = [
  { field: 'ease_factor', min: 1.3, integer: false },
  { field: 'interval_days', min: 1, integer: true },
  { field: 'repetition', min: 0, integer: true },
  { field: 'lapses', min: 0, integer: true },
] as const;

/**
 * Renders a value for diagnostics without JSON.stringify's non-finite
 * quirk.
 *
 * @remarks `JSON.stringify(NaN)` and `JSON.stringify(Infinity)` both
 * produce `null` — an invalid non-finite number would be misreported as
 * a literal null (a DIFFERENT invalid value). Keep the spelling
 * explicit so the finding names what is actually stored.
 */
function displayValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }
  return value;
}

/**
 * Reports SM-2 review state fields that violate the engine contract.
 */
export const validReviewFieldsRule: ValidationRule = {
  id: 'valid-review-fields',
  description:
    'Review state must match SM-2 bounds: ease_factor >= 1.3, interval_days >= 1, counters >= 0, last_quality null or integer 0-5',
  severity: 'error',
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      // Deterministic per-topic report order: the four numeric fields in
      // declaration order, then last_quality.
      for (const { field, min, integer } of NUMERIC_FIELDS) {
        const value = topic.frontmatter[field];
        if (value === undefined) continue; // adopt-default policy: missing = default state

        const valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= min &&
          (!integer || Number.isInteger(value));

        if (!valid) {
          issues.push({
            ruleId: 'valid-review-fields',
            severity: 'error',
            message: `Topic ${topic.palee_id}: review field ${field} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got ${JSON.stringify(displayValue(value))}`,
            file: topic.path,
            topicId: topic.palee_id,
            field,
            details: { actual: displayValue(value) },
          });
        }
      }

      // last_quality: null (never reviewed) or an integer quality 0-5 —
      // the engine's own `processReview` quality contract.
      const quality = topic.frontmatter.last_quality;
      if (quality === undefined) continue;
      const validQuality =
        quality === null ||
        (typeof quality === 'number' &&
          Number.isInteger(quality) &&
          quality >= 0 &&
          quality <= 5);
      if (!validQuality) {
        issues.push({
          ruleId: 'valid-review-fields',
          severity: 'error',
          message: `Topic ${topic.palee_id}: review field last_quality must be null or an integer 0-5, got ${JSON.stringify(displayValue(quality))}`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'last_quality',
          details: { actual: displayValue(quality) },
        });
      }
    }

    return issues;
  },
};
