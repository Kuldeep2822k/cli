/**
 * Wikilink Parsing (Issue #73)
 *
 * @remarks
 * Parses Obsidian `[[target]]`, `[[target|alias]]`, and `[[target#heading]]`
 * links (anchors are stripped per #73). Phase of the auto-chain engine
 * extracted from `src/engine/auto-chain.ts` by the P3-14 phase split (#565).
 * Vault resolution lives in `src/storage/wikilink.ts`; this module only
 * parses. The roadmap importer and the prerequisite-prose scanner consume the
 * extraction over masked text from `./markup-masking`.
 */

/** A parsed Obsidian wikilink. */
export interface ParsedWikilink {
  /** Link target with any `#heading`/`#^block` anchor and `.md` suffix stripped */
  target: string;
  /** Display alias from `[[target|alias]]`, when present */
  alias?: string;
}

const SINGLE_WIKILINK = /^\[\[([^[#\]|]+?)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]$/;

/**
 * Parses a single Obsidian wikilink string.
 *
 * @param text - A complete `[[...]]` link
 * @returns The parsed target and optional alias, or `null` for malformed input
 *
 * @example
 * ```typescript
 * parseWikilink('[[MODULES/01-a|Alias]]'); // { target: 'MODULES/01-a', alias: 'Alias' }
 * parseWikilink('[[note#heading]]');       // { target: 'note' }
 * parseWikilink('[[broken');              // null
 * ```
 */
export function parseWikilink(text: string): ParsedWikilink | null {
  const match = SINGLE_WIKILINK.exec(text.trim());
  if (!match) {
    return null;
  }
  // Group 1 requires at least one character, so a match always fills it; the
  // guard keeps the type honest rather than asserting it.
  const rawTarget = match[1];
  if (rawTarget === undefined) {
    return null;
  }
  let target = rawTarget.trim();
  if (target.length === 0) {
    return null;
  }
  if (target.toLowerCase().endsWith('.md')) {
    target = target.slice(0, -3).trim();
  }
  if (target.length === 0) {
    return null;
  }
  const result: ParsedWikilink = { target };
  const alias = match[2] !== undefined ? match[2].trim() : '';
  if (alias.length > 0) {
    result.alias = alias;
  }
  return result;
}

const WIKILINK_GLOBAL = /\[\[([^[#\]|]+?)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

/**
 * True when the character at `index` is escaped, judged by backslash parity.
 *
 * @param text - The text being scanned
 * @param index - Offset of the token whose escapement is in question
 * @returns `true` only when an **odd** run of backslashes precedes the token
 *
 * @remarks
 * The parity matters, not just the last character: in `\\[[Alpha]]` the two
 * backslashes escape *each other*, so `[[Alpha]]` is a live link and the note
 * belongs in the chain. Reading only the immediately preceding character there
 * skipped a real link, which loses its `depends_on` silently whenever the
 * section holds other links too — the exact failure this guard exists to
 * prevent, pointed the wrong way.
 */
function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * Extracts every well-formed wikilink from a line or block of text, in order.
 *
 * @param text - Text to scan (a bullet item, a paragraph, …)
 * @returns Parsed links; malformed, nested `[[` and backslash-escaped sequences
 * are skipped
 */
export function extractWikilinks(text: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  WIKILINK_GLOBAL.lastIndex = 0;
  try {
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_GLOBAL.exec(text)) !== null) {
      // The global scan resumes inside `[[a[[b]]` and reports `[[b]]`, so a
      // well-formed tail of an unterminated link would still slip through.
      // A match whose prefix still has an open `[[` is nested, not a link.
      const prefix = text.slice(0, match.index);
      if (prefix.lastIndexOf('[[') > prefix.lastIndexOf(']]')) {
        continue;
      }
      // `\[[Alpha]]` is an escaped bracket, not a link: it renders as literal
      // `[[Alpha]]` text, which is how a roadmap documents a link without
      // activating it. Importing it would rewrite Alpha's `depends_on` from an
      // example the author deliberately switched off.
      if (isEscapedAt(text, match.index)) {
        continue;
      }
      const parsed = parseWikilink(match[0]);
      if (parsed) {
        links.push(parsed);
      }
    }
  } finally {
    WIKILINK_GLOBAL.lastIndex = 0;
  }
  return links;
}
