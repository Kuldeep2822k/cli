/**
 * Shared `assessed_at` shape validator (PR #163)
 *
 * @remarks
 * One calendar policy for every consumer: `assessed_at` must be `null`,
 * absent, or a REAL calendar date. Three JavaScript quirks make a bare
 * `!Number.isNaN(new Date(v).getTime())` insufficient:
 *
 * - **Silent normalization**: `new Date('2026-02-30')` rolls over to
 *   March 2 instead of failing — impossible calendar dates would pass.
 *   A calendar round-trip (construct the written year/month/day, then
 *   read the components back) rejects roll-overs.
 * - **Timezone skew**: ISO date-only strings parse at UTC midnight, but
 *   local-time getters then read the previous calendar day in zones west
 *   of UTC. All calendar round-trips here use local-time constructors
 *   and local getters together, so no valid date depends on the host
 *   timezone — and no invalid date sneaks through in any zone either.
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
 * Checks whether a written date is a real calendar date.
 *
 * @remarks Constructs the written components as a local calendar date
 * and reads them back — `new Date(2026, 1, 30)` rolls over to March 2,
 * so a mismatch means the written day does not exist. Pure local-time
 * arithmetic: both construction and read-back are local, so the result
 * is identical in every timezone (no UTC-midnight vs local-day skew).
 * Years 0-99 are re-pinned with `setFullYear` (the constructor maps them
 * to 1900+year) — the same convention as `computeDueDate` in the engine.
 *
 * @param year - Written year
 * @param month - Written month, 1-based (1 = January)
 * @param day - Written day
 * @returns True when the components form a real calendar date
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const constructed = new Date(year, month - 1, day);
  if (year >= 0 && year < 100) {
    constructed.setFullYear(year);
  }
  return (
    constructed.getFullYear() === year &&
    constructed.getMonth() === month - 1 &&
    constructed.getDate() === day
  );
}

/**
 * Extracts leading calendar components from a date string.
 *
 * @remarks Matches a leading `YYYY-MM-DD` (month/day single- or
 * double-digit) optionally followed by more string content
 * (`T12:00:00Z`, `t12:00:00z`, ` 12:00:00`, `T12:00:00+05:00`, or a
 * trailing `Z`/`z` on a date-only form). Anything the ISO parser
 * accepts as a date-time gets its written calendar checked here, so
 * impossible ISO timestamps (`2026-02-30T12:00:00Z`) cannot slip past
 * on the time components' coattails. Non-matching strings return null.
 *
 * @param raw - Original raw string value
 * @returns `[year, month, day]` numbers, or null when no leading
 * calendar date is present
 */
function leadingCalendar(raw: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?=[Tt ]|[Zz]|$)/.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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
    const calendar = leadingCalendar(value);
    // ISO-family strings (date-only or timestamp) carry explicit calendar
    // components — a real-date check on the written spelling is the truth,
    // and `new Date` is only trusted for the overall parse.
    if (calendar) {
      const [y, m, d] = calendar;
      if (!isRealCalendarDate(y, m, d)) return false;
    }
    return !Number.isNaN(new Date(value).getTime());
  }
  return false;
}
