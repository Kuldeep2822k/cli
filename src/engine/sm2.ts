/**
 * SM-2 Spaced Repetition Scheduling Engine
 *
 * @remarks
 * Implements SuperMemo-2 (SM-2) spaced repetition algorithm for scheduling topic reviews.
 * Computes interval expansions, ease factor deltas, lapse counters, and due dates.
 *
 * @see {@link https://www.supermemo.com/en/archives1990-2015/english/ol/sm2} SuperMemo SM-2 Specification
 */

import { Review } from '../types';

/**
 * Calculates the delta adjustment to the ease factor based on review quality.
 *
 * @remarks
 * Uses the canonical SM-2 formula:
 * `ΔEF = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)`
 *
 * Quality ratings:
 * - 5: Perfect response (+0.10)
 * - 4: Correct response after a hesitation (+0.00)
 * - 3: Correct response recalled with serious difficulty (-0.14)
 * - 2: Incorrect response; where the correct one seemed easy to recall (-0.32)
 * - 1: Incorrect response; the correct one remembered (-0.54)
 * - 0: Complete blackout (-0.80)
 *
 * @param quality - Review quality rating (integer from 0 to 5)
 * @returns Ease factor delta adjustment
 * @throws {Error} If quality is not an integer between 0 and 5
 */
function calculateEaseFactorDelta(quality: number): number {
  if (quality < 0 || quality > 5 || !Number.isInteger(quality)) {
    throw new Error(`Invalid quality: must be integer 0-5, got ${quality}`);
  }
  return 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
}

/**
 * Rounds a floating-point number using positive decimal half-up rounding (ties round towards +infinity).
 *
 * @param value - Numeric value to round
 * @param decimals - Number of decimal places to preserve
 * @returns Rounded numeric value
 *
 * @example
 * ```typescript
 * roundHalfUp(2.54567, 4); // 2.5457
 * ```
 */
function roundHalfUp(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier + 1e-10) / multiplier;
}

/**
 * Computes the next SM-2 spaced repetition state following a completed review.
 *
 * @remarks
 * Scheduling behavior:
 * - If `quality < 3` (review failure):
 *   - `repetition` resets to `0`
 *   - `interval_days` resets to `1`
 *   - `lapses` increments by 1 (only if topic had prior repetitions)
 * - If `quality >= 3` (successful review):
 *   - `repetition` increments by 1
 *   - `interval_days` becomes 1 for rep 1, 6 for rep 2, or `round(interval * ease_factor)` for rep > 2
 * - `ease_factor` updates by `calculateEaseFactorDelta(quality)`, clamped to a minimum of 1.3
 *
 * @param current - Current review state (ease_factor, interval_days, repetition, lapses)
 * @param quality - Review quality rating integer (0 - 5)
 * @returns Updated Partial review state with new intervals, ease factor, and counters
 * @throws {Error} If quality is out of bounds or current state fields are invalid
 *
 * @example
 * ```typescript
 * const next = processReview({ ease_factor: 2.5, interval_days: 1, repetition: 0 }, 5);
 * // returns { ease_factor: 2.6, interval_days: 1, repetition: 1, lapses: 0, last_quality: 5 }
 * ```
 */
function processReview(current: Partial<Review>, quality: number): Partial<Review> {
  // Validate quality
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new Error(`Invalid quality: must be integer 0-5, got ${quality}`);
  }

  const {
    ease_factor = 2.5,
    interval_days = 1,
    repetition = 0,
  } = current;

  // Validate current state
  if (ease_factor < 1.3) {
    throw new Error(`Invalid ease_factor: must be >= 1.3, got ${ease_factor}`);
  }
  if (interval_days < 1) {
    throw new Error(`Invalid interval_days: must be >= 1, got ${interval_days}`);
  }
  if (repetition < 0) {
    throw new Error(`Invalid repetition: must be >= 0, got ${repetition}`);
  }

  let newRepetition: number;
  let newInterval: number;
  let newEaseFactor: number;
  let lapses = current.lapses || 0;

  // Quality < 3: reset
  if (quality < 3) {
    // Lapse only if this was a previously learned topic
    if (repetition > 0) {
      lapses += 1;
    }
    newRepetition = 0;
    newInterval = 1;
  } else {
    // Successful review
    newRepetition = repetition + 1;

    if (newRepetition === 1) {
      newInterval = 1;
    } else if (newRepetition === 2) {
      newInterval = 6;
    } else {
      newInterval = Math.round(interval_days * ease_factor);
    }

    // Ensure minimum interval of 1
    newInterval = Math.max(1, newInterval);
  }

  // Update ease factor
  const delta = calculateEaseFactorDelta(quality);
  newEaseFactor = ease_factor + delta;
  newEaseFactor = Math.max(1.3, newEaseFactor);
  newEaseFactor = roundHalfUp(newEaseFactor, 4);

  return {
    ease_factor: newEaseFactor,
    interval_days: newInterval,
    repetition: newRepetition,
    lapses,
    last_quality: quality,
  };
}

/**
 * Formats a JavaScript Date object into a local date-only string (`YYYY-MM-DD`).
 *
 * @param date - Date to format
 * @returns Formatted date string (e.g. `'2026-08-24'`)
 */
function formatLocalDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Computes a target review due date by advancing calendar days in the local timezone.
 *
 * @remarks
 * Performs calendar arithmetic in the local timezone to avoid daylight saving shift discrepancies.
 *
 * @param fromDate - Starting baseline date, ISO string, or timestamp
 * @param days - Number of calendar days to advance
 * @returns Resulting due Date object
 *
 * @example
 * ```typescript
 * const dueDate = computeDueDate('2026-08-20', 6);
 * ```
 */
function computeDueDate(fromDate: Date | string | number, days: number): Date {
  let due: Date;
  if (typeof fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromDate.trim())) {
    const [year, month, day] = fromDate.trim().split('-').map(Number);
    due = new Date(year, month - 1, day);
    if (year >= 0 && year < 100) {
      due.setFullYear(year);
    }
  } else {
    due = new Date(fromDate);
  }
  // Perform calendar arithmetic in local timezone to avoid cross-DST shift bugs
  due.setDate(due.getDate() + days);
  return due;
}

export {
  calculateEaseFactorDelta,
  processReview,
  computeDueDate,
  formatLocalDateOnly,
  roundHalfUp,
};
