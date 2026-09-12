/**
 * Shared review-date shape validator (#39)
 *
 * @remarks
 * One date policy for every review-scheduling consumer: `last_reviewed_at`
 * and `due_at` are stored as date-only `YYYY-MM-DD` strings (Phase 1
 * persists `formatLocalDateOnly` output — the local calendar day, never a
 * timestamp), or `null` on newly adopted topics. Two properties make a
 * naive check insufficient:
 *
 * - **Silent normalization**: `new Date('2026-02-31')` rolls over to
 *   March 3 instead of failing — impossible calendar dates would pass.
 *   The calendar round-trip in `isRealCalendarDate` (shared with the
 *   `assessed_at` policy so the two can never disagree) rejects
 *   roll-overs.
 * - **Ambiguous spellings**: full ISO timestamps
 *   (`2026-09-01T12:00:00Z`) parse as dates but are NOT the product
 *   contract — review scheduling compares local calendar days, and a
 *   timestamp implies an instant. Date-only is enforced syntactically
 *   (strict zero-padded `YYYY-MM-DD`), so no timezone or `new Date`
 *   parsing quirk can influence the verdict.
 *
 * Determinism: validation is pure string/component analysis — no `new
 * Date(string)` parsing, so the result is identical in every timezone and
 * locale (the same guarantee `assessed-at.ts` documents).
 */

import { isRealCalendarDate } from './assessed-at';

/** Strict zero-padded date-only spelling: `YYYY-MM-DD`. */
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Components of a strictly date-only `YYYY-MM-DD` string.
 */
export interface ParsedDateOnly {
  /** Written year */
  year: number;
  /** Written month, 1-based (1 = January) */
  month: number;
  /** Written day of month */
  day: number;
}

/**
 * Extracts the components of a strict date-only `YYYY-MM-DD` string.
 *
 * @remarks Rejects every other spelling — full timestamps
 * (`2026-09-01T12:00:00Z`), single-digit components (`2026-9-1`),
 * non-strings, numbers — because date-only is the persisted product
 * contract (#39). No calendar plausibility check happens here; use
 * {@link isValidReviewDate} for the full verdict.
 *
 * @param value - Raw frontmatter value
 * @returns Date components, or null when the value is not strict date-only
 */
export function parseDateOnly(value: unknown): ParsedDateOnly | null {
  if (typeof value !== 'string') return null;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/**
 * Validates a review date value: null, absent, or a real `YYYY-MM-DD`
 * calendar date.
 *
 * @remarks The written calendar is verified with the shared
 * `isRealCalendarDate` round-trip, so impossible dates
 * (`2026-02-31`) are rejected instead of silently normalized —
 * the same policy `assessed_at` follows.
 *
 * @param value - Raw frontmatter value for `last_reviewed_at` or `due_at`
 * @returns True when the value is acceptable
 */
export function isValidReviewDate(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const parsed = parseDateOnly(value);
  if (parsed === null) return false;
  return isRealCalendarDate(parsed.year, parsed.month, parsed.day);
}
