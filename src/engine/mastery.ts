/**
 * Mastery Engine
 *
 * @remarks
 * Computes overall topic mastery from the four-pillar pedagogical assessment model:
 * - **Conceptual Understanding** (20% weight)
 * - **Practical Application** (20% weight)
 * - **Debugging & Troubleshooting** (20% weight)
 * - **Feynman Technique Articulation** (40% weight - double weighted)
 */

/**
 * Mastery Threshold (70% / 0.70)
 *
 * @remarks
 * A topic is considered "mastered" and satisfies downstream prerequisites when
 * its weighted mastery score reaches or exceeds `0.70`.
 */
export const MASTERY_THRESHOLD = 0.7;

/**
 * Optional four-pillar assessment score inputs for mastery calculations.
 */
export interface AssessmentPillars {
  /** Conceptual understanding score (0.0 - 1.0) */
  conceptual?: number | null;
  /** Practical implementation score (0.0 - 1.0) */
  practical?: number | null;
  /** Debugging competency score (0.0 - 1.0) */
  debug?: number | null;
  /** Feynman articulation score (0.0 - 1.0) */
  feynman?: number | null;
}

/**
 * Normalizes a score or mastery value by clamping between `0.0` and `1.0` and rounding to 4 decimal places.
 *
 * @remarks
 * - Coerces finite numeric strings.
 * - Clamps negative values to `0.0` and values greater than `1.0` to `1.0`.
 * - Safely returns `0.0` for `NaN`, `null`, `undefined`, non-numeric strings, or non-finite values.
 *
 * @param val - Raw score input
 * @returns Normalized score floating-point value clamped to `[0.0, 1.0]` with 4 decimal precision
 *
 * @example
 * ```typescript
 * normalizeScore(0.85432); // 0.8543
 * normalizeScore('0.9');    // 0.9
 * normalizeScore(-0.5);     // 0
 * normalizeScore('invalid');// 0
 * ```
 */
export function normalizeScore(val: unknown): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 0;
    const clamped = Math.max(0, Math.min(1, val));
    return Math.round(clamped * 10000) / 10000;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        const clamped = Math.max(0, Math.min(1, parsed));
        return Math.round(clamped * 10000) / 10000;
      }
    }
  }
  return 0;
}

/**
 * Calculates overall topic mastery from assessment scores using the canonical weighted formula:
 * `topic_mastery = round((conceptual + practical + debug + (2 * feynman)) / 5, 4)`
 *
 * @remarks
 * Each pillar is normalized to `[0.0, 1.0]` before calculation.
 * Returns `0.0` if all inputs are omitted or zero.
 *
 * @param conceptual - Conceptual understanding score (default: 0)
 * @param practical - Practical application score (default: 0)
 * @param debug - Debugging ability score (default: 0)
 * @param feynman - Feynman articulation score (default: 0)
 * @returns Weighted topic mastery score between `0.0` and `1.0` (4 decimal places)
 *
 * @example
 * ```typescript
 * const mastery = computeTopicMastery(0.8, 0.7, 0.9, 0.85);
 * // returns round((0.8 + 0.7 + 0.9 + 2 * 0.85) / 5, 4) = 0.82
 * ```
 */
export function computeTopicMastery(
  conceptual: number | string = 0,
  practical: number | string = 0,
  debug: number | string = 0,
  feynman: number | string = 0
): number {
  const c = normalizeScore(conceptual);
  const p = normalizeScore(practical);
  const d = normalizeScore(debug);
  const f = normalizeScore(feynman);

  const weightedSum = c + p + d + 2 * f;
  const rawMastery = weightedSum / 5;

  return Math.round(rawMastery * 10000) / 10000;
}
