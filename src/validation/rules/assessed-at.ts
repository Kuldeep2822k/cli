/**
 * Shared `assessed_at` shape validator (PR #163)
 *
 * @remarks
 * One calendar policy for every consumer: `assessed_at` must be `null`,
 * absent, or a REAL calendar date. Two JavaScript quirks make a bare
 * `!Number.isNaN(new Date(v).getTime())` insufficient:
 *
 * - **Silent normalization**: `new Date('2026-02-30')` rolls over to
 *   March 2 instead of failing — impossible calendar dates would pass.
 *   The round-trip check (serialize the parsed date back to its
 *   `YYYY-MM-DD` form and compare) rejects roll-overs.
 * - **Number coercion**: YAML parses bare epoch timestamps as numbers;
 *   numbers must reach `new Date(value)` (epoch-ms), never
 *   `new Date(String(value))` — stringified epoch digits are not a
 *   parseable date string.
 *
 * Consumers: `valid-assessment-fields` (reports the error) and
 * `valid-topic-mastery` (jurisdiction skip predicate). Keeping one
 * implementation means the two rules can never disagree about what a
 * valid `assessed_at` is.
 */

/**
 * Checks whether a parsed date's calendar components were normalized.
 *
 * @remarks Only exact `YYYY-MM-DD` strings are round-tripped. Other
 * formats (ISO timestamps, epoch numbers) are left to the parse
 * itself: it either rejects them (NaN) or accepts them — and an
 * accepted ISO timestamp can silently normalize an impossible date
 * (`2026-02-30T12:00:00Z` parses as March 2), so those values pass
 * through without a calendar check.
 *
 * @param raw - Original raw value
 * @param parsed - The value parsed into a Date
 * @returns True when the Date's real calendar equals the written one
 */
function calendarMatches(raw: string, parsed: Date): boolean {
  const isoForm = /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = isoForm.exec(raw);
  if (!match) return true; // non-plain forms: the successful parse is the truth
  const [, y, m, d] = match;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}` === `${y}-${m}-${d}`;
}

/**
 * Validates an `assessed_at` value: null, absent, or a real calendar date.
 *
 * @param value - Raw frontmatter value for `assessed_at`
 * @returns True when the value is acceptable
 */
export function isValidAssessedAt(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    return !Number.isNaN(new Date(value).getTime());
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return false;
    return calendarMatches(value, parsed);
  }
  return false;
}
