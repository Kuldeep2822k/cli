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
  // Case 1: Empty frontmatter fences with no intermediate content (---\n---)
  const emptyMatch = content.match(/^---\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (emptyMatch) {
    return { frontmatter: null, body: emptyMatch[1], raw: '' };
  }

  // Case 2: Populated frontmatter with mandatory newline before closing fence
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);

  if (!fmMatch) {
    return { frontmatter: null, body: content, raw: null };
  }

  const raw = fmMatch[1];
  const body = fmMatch[2];

  try {
    const doc = parseDocument(raw);
    if (doc.errors && doc.errors.length > 0) {
      return { frontmatter: null, body, raw, error: doc.errors[0].message };
    }
    const frontmatter = doc.toJSON() as Record<string, unknown>;
    return { frontmatter, body, raw, doc };
  } catch (e: unknown) {
    const err = e as NodeError;
    return { frontmatter: null, body, raw, error: err.message };
  }
}

/**
 * Updates or creates frontmatter key-value pairs while non-destructively preserving comments and formatting.
 *
 * @remarks
 * If frontmatter already exists, parses the raw YAML block into a CST `Document`, modifies only the specified keys,
 * and stringifies the updated YAML without reformatting or erasing unmanaged keys or comments.
 * If frontmatter does not exist, prefixes a new `---` YAML header block.
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
  const parsed = parseFrontmatter(content);
  if (parsed.error) {
    throw new Error(`Malformed frontmatter: ${parsed.error}`);
  }

  if (parsed.raw === null) {
    const doc = new Document(updates);
    const yamlContent = doc.toString();
    return `---\n${yamlContent}---\n${content}`;
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
  return `---\n${newYaml}---\n${parsed.body}`;
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
