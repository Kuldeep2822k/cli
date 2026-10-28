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

/**
 * True when a value contains itself, through an array or an object.
 *
 * @param value - The value to probe
 * @param chain - The objects on the current path (internal)
 * @returns `true` for a self-referential structure
 */
function isCyclic(value: unknown, chain: Set<unknown> = new Set()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (chain.has(value)) return true;
  chain.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (isCyclic(child, chain)) return true;
  }
  chain.delete(value);
  return false;
}

/**
 * Safely serializes a value to a JSON string, returning a fallback marker
 * when the value contains a cycle or a non-JSON-encodable type such as
 * `bigint`.
 *
 * @param value - The value to serialize
 * @returns A valid JSON string, or `"[circular]"` / `"[non-serializable]"`
 */
function safeStringify(value: unknown): string {
  try {
    if (isCyclic(value)) return '[circular]';
    return JSON.stringify(value);
  } catch {
    return '[non-serializable]';
  }
}

/**
 * Formats a raw frontmatter value for a human-readable diagnostic message.
 *
 * @remarks
 * Unlike `JSON.stringify(displayValue(...))`, this renders non-finite numbers
 * as bare spellings (`NaN`, `Infinity`, `-Infinity`) — not as quoted strings —
 * so the diagnostic reads the actual numeric spelling rather than an opaque
 * JSON-string token. Strings, booleans, and finite numbers follow JSON
 * conventions: strings are quoted, booleans and numbers are bare. Composite
 * values (objects, arrays) are serialized with safe guards that catch cycles
 * and non-JSON scalars (e.g. `bigint`) before they can throw, returning a
 * readable fallback marker instead.
 *
 * @param value - Raw stored value — untrusted frontmatter
 * @returns A human-readable, safe-to-interpolate string representation
 */
export function formatDiagnosticValue(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value); // NaN | Infinity | -Infinity
  }
  if (typeof value === 'string') {
    return safeStringify(value); // "soon"
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value); // true | false | 42 | -1
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  return safeStringify(value); // {"a":1} | [1,2] | [circular] | [non-serializable]
}
