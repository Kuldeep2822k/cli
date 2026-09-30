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
 * SM-2 bounds check for one numeric review field (engine contract).
 */
function isNumericReviewValueValid(value: unknown, min: number, integer: boolean): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    (!integer || Number.isInteger(value))
  );
}

/** SM-2 bounds check for `last_quality` (never-reviewed = null, else integer 0-5). */
function isLastQualityValid(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5)
  );
}

/**
 * Adopt-written defaults for the review block. `validate --fix` resets
 * corrupted fields to exactly this adopt shape (missing fields are left
 * missing — the adopt-default policy above).
 */
const SM2_REVIEW_DEFAULTS: Record<string, unknown> = {
  ease_factor: 2.5,
  interval_days: 1,
  repetition: 0,
  lapses: 0,
  last_quality: null,
};

/**
 * Computes the `--fix` repair map for one raw frontmatter block.
 *
 * @param frontmatter - Raw (unnormalized) note frontmatter
 * @returns Field → adopt-default map for every invalid review field, or
 * `null` when nothing needs repair. An invalid value makes the whole SM-2
 * state untrustworthy, so each offending field is reset to the adopt
 * default rather than clamped.
 */
function repairReviewFields(frontmatter: Record<string, unknown>): Record<string, unknown> | null {
  const fixes: Record<string, unknown> = {};
  for (const { field, min, integer } of NUMERIC_FIELDS) {
    const value = frontmatter[field];
    if (value === undefined) continue;
    if (!isNumericReviewValueValid(value, min, integer)) {
      fixes[field] = SM2_REVIEW_DEFAULTS[field];
    }
  }
  const quality = frontmatter.last_quality;
  if (quality !== undefined && !isLastQualityValid(quality)) {
    fixes.last_quality = SM2_REVIEW_DEFAULTS.last_quality;
  }
  return Object.keys(fixes).length > 0 ? fixes : null;
}

/**
 * Reports SM-2 review state fields that violate the engine contract.
 */
export const validReviewFieldsRule: ValidationRule = {
  id: 'valid-review-fields',
  description:
    'Review state must match SM-2 bounds: ease_factor >= 1.3, interval_days >= 1, counters >= 0, last_quality null or integer 0-5',
  severity: 'error',
  fixable: 'manual', // kept per #38 metadata contract; `validate --fix` still offers a best-effort reset to adopt defaults (BUG-003)
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      // Deterministic per-topic report order: the four numeric fields in
      // declaration order, then last_quality.
      for (const { field, min, integer } of NUMERIC_FIELDS) {
        const value = topic.frontmatter[field];
        if (value === undefined) continue; // adopt-default policy: missing = default state

        if (!isNumericReviewValueValid(value, min, integer)) {
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
      if (!isLastQualityValid(quality)) {
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

export { repairReviewFields, SM2_REVIEW_DEFAULTS };
