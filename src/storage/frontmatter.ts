/**
 * Frontmatter Parser & Updater
 *
 * @remarks
 * Uses `yaml` Concrete Syntax Tree (CST) document manipulation to parse and update YAML frontmatter
 * in Markdown files while non-destructively preserving existing comments, property ordering, unknown keys,
 * custom formatting, and block scalar structures.
 */

import { parseDocument, Document } from 'yaml';
import crypto from 'crypto';
import { FrontmatterResult, NodeError } from '../types';

/**
 * Parses frontmatter YAML and body content from Markdown text.
 *
 * @remarks
 * Looks for opening and closing `---` delimiters at the beginning of the text.
 * If frontmatter is absent or malformed, gracefully returns body text with error diagnostics.
 *
 * @param content - Full text content of the Markdown file
 * @returns {@link FrontmatterResult} object with parsed frontmatter JSON dictionary, raw YAML string, CST doc, and body
 *
 * @example
 * ```typescript
 * const { frontmatter, body } = parseFrontmatter('---\npalee_id: math-101\n---\n# Topic Notes');
 * console.log(frontmatter?.palee_id); // 'math-101'
 * ```
 */
function parseFrontmatter(content: string): FrontmatterResult {
  // Strip a single leading BOM (U+FEFF) emitted by Windows editors.
  // Without this, the `^---` regex below cannot anchor and a valid
  // topic note silently vanishes from the snapshot with no finding.
  // Spec requirement: issue #26 / audit #171 finding #1.
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  // Case 1: Empty frontmatter fences with no intermediate content (---\n---)
  const emptyMatch = stripped.match(/^---\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (emptyMatch) {
    return { frontmatter: null, body: emptyMatch[1], raw: '' };
  }

  // Case 2: Populated frontmatter with mandatory newline before closing fence
  const fmMatch = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);

  if (!fmMatch) {
    return { frontmatter: null, body: stripped, raw: null };
  }

  const raw = fmMatch[1];
  const body = fmMatch[2];

  try {
    const doc = parseDocument(raw);
    if (doc.errors && doc.errors.length > 0) {
      return { frontmatter: null, body, raw, error: doc.errors[0].message };
    }
    const parsed = doc.toJSON();
    // Frontmatter must be a YAML mapping. A scalar value between `---`
    // fences (e.g. "Intro" in `---\nIntro\n---\nMore`) indicates
    // thematic breaks, not frontmatter — return as "no frontmatter."
    // Whitespace-only fenced blocks (e.g. `---\n\n---`) preserve raw
    // and body so updateFrontmatter replaces them instead of prepending.
    if (parsed === null || typeof parsed !== 'object') {
      if (raw.trim() === '') {
        return { frontmatter: null, body, raw };
      }
      return { frontmatter: null, body: stripped, raw: null };
    }
    // An array between fences is malformed frontmatter (not a mapping),
    // not thematic breaks — preserve raw and report an error so
    // updateFrontmatter rejects rather than duplicating the block.
    if (Array.isArray(parsed)) {
      return { frontmatter: null, body, raw, error: 'Frontmatter must be a YAML mapping, not a sequence' };
    }
    const frontmatter = parsed as Record<string, unknown>;
    return { frontmatter, body, raw, doc };
  } catch (e: unknown) {
    const err = e as NodeError;
    return { frontmatter: null, body, raw, error: err.message };
  }
}

/**
 * Detects the line terminator a note was written with.
 *
 * @remarks
 * The convention is read off the note's own bytes, never off `os.EOL`: a vault
 * legitimately mixes CRLF notes (Obsidian on Windows, `core.autocrlf=true`) with
 * LF notes. `updateFrontmatter` re-serialises only the head while the body keeps
 * the endings it has, so emitting the other convention splits the file in two and
 * turns a one-key change into a whole-file diff.
 *
 * @param region - Text to inspect: the original frontmatter block, or the whole file when it has none
 * @returns `'\r\n'` if the region contains a CRLF break, otherwise `'\n'`
 */
function detectLineTerminator(region: string): '\r\n' | '\n' {
  return region.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Wraps re-serialised YAML in `---` fences using the note's own line terminator.
 *
 * @remarks
 * `Document.toString()` always emits LF, so the YAML body has to be retimed too —
 * fences in one convention around a body in another is the same split file.
 *
 * @param yamlText - YAML block as produced by `Document.toString()`, terminated by LF
 * @param eol - Line terminator detected from the note by {@link detectLineTerminator}
 * @returns Opening fence, YAML body, and closing fence, each ended with `eol`
 */
function renderFencedBlock(yamlText: string, eol: '\r\n' | '\n'): string {
  // `/\r?\n/` rather than `/\n/` keeps an already-CRLF sequence from gaining a
  // second CR, and touches nothing else: CR is only consumed as a line break.
  return `---${eol}${yamlText.replace(/\r?\n/g, eol)}---${eol}`;
}

/**
 * Updates or creates frontmatter key-value pairs while non-destructively preserving comments and formatting.
 *
 * @remarks
 * If frontmatter already exists, parses the raw YAML block into a CST `Document`, modifies only the specified keys,
 * and stringifies the updated YAML without reformatting or erasing unmanaged keys or comments.
 * If frontmatter does not exist, prefixes a new `---` YAML header block.
 *
 * The line terminator and any leading BOM of the note are reproduced, so rewriting one
 * key changes only the lines that key occupies.
 *
 * @param content - Existing file content
 * @param updates - Map of frontmatter key-value pairs to set or update
 * @param removals - Frontmatter keys to remove
 * @returns Modified file content with updated frontmatter
 * @throws {Error} If existing frontmatter contains unparseable syntax errors
 *
 * @example
 * ```typescript
 * const updated = updateFrontmatter(existingContent, {
 *   topic_mastery: 0.85,
 *   last_reviewed_at: '2026-08-24T12:00:00Z'
 * });
 * ```
 */
function updateFrontmatter(
  content: string,
  updates: Record<string, unknown>,
  removals: string[] = []
): string {
  // parseFrontmatter drops a leading BOM to anchor its fence regex, but the BOM
  // belongs to the file rather than to the frontmatter — read it back here so
  // every return site can hand it to the writer untouched.
  const bom = content.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const text = bom !== '' ? content.slice(1) : content;

  const parsed = parseFrontmatter(text);
  if (parsed.error) {
    throw new Error(`Malformed frontmatter: ${parsed.error}`);
  }

  if (parsed.raw === null) {
    const doc = new Document(updates);
    const yamlContent = doc.toString();
    // No existing block to sample, so the file as a whole decides: the body
    // being prefixed below is that same text and keeps its endings.
    const eol = detectLineTerminator(text);
    return `${bom}${renderFencedBlock(yamlContent, eol)}${text}`;
  }

  // Parse as YAML document to preserve CST (handling empty raw block if present)
  const doc = parsed.raw.trim().length > 0 ? parseDocument(parsed.raw) : new Document({});

  for (const key of removals) {
    doc.delete(key);
  }
  for (const [key, value] of Object.entries(updates)) {
    doc.set(key, value);
  }

  const newYaml = doc.toString();
  // A non-null `raw` means the fence regex matched, so `parsed.body` is a literal
  // suffix of `text` and its complement is the original block — fences included.
  // Those fences carry the convention even when a single-key `raw` has no break.
  const eol = detectLineTerminator(text.slice(0, text.length - parsed.body.length));
  return `${bom}${renderFencedBlock(newYaml, eol)}${parsed.body}`;
}

/**
 * Computes a SHA-256 hexadecimal hash fingerprint of a string content.
 *
 * @remarks
 * Used by Optimistic Concurrency Control (OCC) and caching layers to detect out-of-band modifications.
 *
 * @param content - Text content to fingerprint
 * @returns 64-character hexadecimal SHA-256 hash string
 *
 * @example
 * ```typescript
 * const fingerprint = computeFingerprint('# Topic Note\nContent...');
 * console.log(fingerprint.length); // 64
 * ```
 */
function computeFingerprint(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export {
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
};
