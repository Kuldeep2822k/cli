/**
 * Mastery Engine
 * Computes topic mastery based on the four-pillar pedagogical assessment model:
 * - Conceptual (20% weight)
 * - Practical (20% weight)
 * - Debug (20% weight)
 * - Feynman (40% weight - double weighted)
 */

export interface AssessmentPillars {
  conceptual?: number | null;
  practical?: number | null;
  debug?: number | null;
  feynman?: number | null;
}

/**
 * Calculates topic mastery from assessment scores using the canonical weighted formula:
 * topic_mastery = round((conceptual + practical + debug + (2 * feynman)) / 5, 4)
 *
 * Each dimension is clamped between 0.0 and 1.0. Returns 0.0 if all inputs are missing/zero.
 */
export function computeTopicMastery(
  conceptual: number = 0,
  practical: number = 0,
  debug: number = 0,
  feynman: number = 0
): number {
  const clamp = (val: unknown): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
    return Math.max(0, Math.min(1, val));
  };


  const c = clamp(conceptual);
  const p = clamp(practical);
  const d = clamp(debug);
  const f = clamp(feynman);

  const weightedSum = c + p + d + 2 * f;
  const rawMastery = weightedSum / 5;

  return Math.round(rawMastery * 10000) / 10000;
}
