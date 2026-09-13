/**
 * Shared diagnostic-value rendering (#166)
 *
 * @remarks
 * `JSON.stringify(NaN)` and `JSON.stringify(Infinity)` both produce
 * `null`, so validation findings that interpolate stored values with
 * JSON.stringify misreport non-finite frontmatter (YAML `.nan`,
 * `.inf`) as literal `null` — for date fields where null is a VALID
 * value, the message reads self-contradictory ("must be null … got
 * null") and sends the user to inspect a null that is not there.
 *
 * This hoists the `displayValue()` pattern `valid-review-fields`
 * introduced in PR #165 to every diagnostic site: non-finite numbers
 * render their explicit spelling ("NaN" | "Infinity" |
 * "-Infinity"), everything else passes through unchanged. Use it for
 * human-readable messages AND inside `details.actual` payloads — the
 * JSON formatters serialize both, and `JSON.stringify` of the string
 * "NaN" round-trips as the string, preserving the distinction.
 */

/**
 * Renders a stored frontmatter value for diagnostics without
 * JSON.stringify's non-finite quirk.
 *
 * @param value - Raw stored value
 * @returns The value itself, or the explicit spelling for non-finite numbers
 */
export function displayValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value); // "NaN" | "Infinity" | "-Infinity"
  }
  return value;
}
