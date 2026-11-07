/**
 * Display sanitisation for vault-derived text.
 *
 * A cloned or shared vault can carry ANSI/OSC escape sequences in a note's
 * frontmatter `title` (or H1), and the CLI printed them straight to the
 * terminal: `plan`'s due list, `next`, `dashboard`, `progress`, `review`,
 * `assess`, `session` and `adopt` all interpolate a stored title into human
 * output. An escape sequence there can recolor or hide warnings, retitle the
 * window, or set the clipboard via OSC 52 (#565 P2-06).
 *
 * The character class is `\p{Cc}` — C0, DEL and the C1 range, which is what a
 * terminal acts on. Whitespace-shaped controls (tab, newline, vertical tab,
 * form feed, carriage return) become a single space first: the loader trims a
 * title but does not collapse its interior newlines, and deleting them would
 * join words. Bidi overrides and isolates are removed explicitly — they are not
 * terminal commands, but U+202E and friends can reorder the rendered line —
 * while `\p{Cf}` characters that shape legitimate text (ZWJ, ZWNJ) are kept, so
 * accented titles and emoji sequences survive.
 *
 * JSON output is unaffected: machine consumers are entitled to the stored value,
 * and `JSON.stringify` escapes the C0 characters that matter for the ANSI/OSC
 * vector.
 *
 * @param value - Text derived from a vault note or configuration
 * @returns The same text with terminal-actionable characters removed
 */
export function sanitizeForDisplay(value: string): string {
  return value
    .replace(/[\t\n\v\f\r]+/g, ' ')
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\p{Cc}/gu, '');
}
