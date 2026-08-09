/**
 * SM-2 Spaced Repetition Algorithm
 * Implements the deterministic scheduling engine from palee_cli_spec.md
 */
import { Review } from '../types';

/**
 * Calculate SM-2 ease factor delta
 * @param {number} quality - Quality rating (0-5)
 * @returns {number} Ease factor delta
 */
function calculateEaseFactorDelta(quality: number): number {
  if (quality < 0 || quality > 5 || !Number.isInteger(quality)) {
    throw new Error(`Invalid quality: must be integer 0-5, got ${quality}`);
  }
  return 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
}

/**
 * Round using positive decimal half-up rounding
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundHalfUp(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier + 1e-10) / multiplier;
}

/**
 * Process a review and compute next SM-2 state
 * @param {object} current - Current review state
 * @param {number} quality - Quality rating (0-5)
 * @returns {object} New review state
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
 * Format Date to local date-only string (YYYY-MM-DD)
 * @param {Date} date
 * @returns {string}
 */
function formatLocalDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Compute due date by adding calendar days
 * @param {Date} fromDate - Starting date
 * @param {number} days - Days to add
 * @returns {Date}
 */
function computeDueDate(fromDate: Date | string | number, days: number): Date {
  const due = new Date(fromDate);
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
