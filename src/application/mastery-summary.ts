/**
 * Mastery bucketing shared by the `plan`, `dashboard`, and `progress` read
 * models. Pure: no Commander, no process, no I/O.
 */

import { MASTERY_THRESHOLD } from '../engine/mastery';

export interface MasterySummary {
  /** Topics at or above the mastery threshold. */
  mastered: number;
  /** Topics with some mastery but still below the threshold. */
  learning: number;
  /** Topics with zero mastery. */
  new: number;
}

/**
 * Count topics into mastered / learning / new buckets by their mastery value.
 * The three buckets use independent predicates (a value outside `[0, threshold]`
 * boundaries falls into exactly one), matching the inline filters these call
 * sites previously duplicated.
 */
export function summarizeMastery(
  masteries: number[],
  threshold: number = MASTERY_THRESHOLD,
): MasterySummary {
  let mastered = 0;
  let learning = 0;
  let newCount = 0;
  for (const m of masteries) {
    if (m >= threshold) mastered++;
    if (m > 0 && m < threshold) learning++;
    if (m === 0) newCount++;
  }
  return { mastered, learning, new: newCount };
}
