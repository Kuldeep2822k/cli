/**
 * Mastery Engine
 * Computes topic mastery based on the four-pillar pedagogical assessment model:
 * - Conceptual (20% weight)
 * - Practical (20% weight)
 * - Debug (20% weight)
 * - Feynman (40% weight - double weighted)
 */

/**
 * Mastery Threshold (70% / 0.7)
 * A topic is considered "mastered" when its weighted mastery score reaches or exceeds 0.70.
 */
export const MASTERY_THRESHOLD = 0.7;

export interface AssessmentPillars {
  conceptual?: number | null;
  practical?: number | null;
  debug?: number | null;
  feynman?: number | null;
}

/**
 * Normalizes a score or mastery value by clamping between 0.0 and 1.0 and rounding to 4 decimals.
 * Coerces numeric strings if finite, and falls back to 0.0 for non-finite values.
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
 * Calculates topic mastery from assessment scores using the canonical weighted formula:
 * topic_mastery = round((conceptual + practical + debug + (2 * feynman)) / 5, 4)
 *
 * Each dimension is clamped between 0.0 and 1.0. Returns 0.0 if all inputs are missing/zero.
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
