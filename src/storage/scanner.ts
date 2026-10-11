/**
 * Note Scanner
 *
 * @remarks
 * Storage-boundary reader that walks a vault and reports per-file
 * frontmatter parse outcomes for the validation framework (#25).
 * A file with malformed YAML yields an entry with `parseError` set —
 * reading never throws, so one bad note cannot abort a vault scan.
 * Every note read is bounded first by the stat-first size guard in
 * `./source-cap` (#332): a document over the cap is declined with a
 * `readError` diagnostic instead of being read and line-scanned whole.
 */

import fs from 'fs';
import { walkVault, relativeVaultPath } from './vault-walker';
import { parseFrontmatter } from './frontmatter';
import { MAX_NOTE_SOURCE_BYTES, oversizedNoteDiagnostic } from './source-cap';
import { ScannedNote } from '../types';

/**
 * Options for {@link scanNotes}.
 */
export interface ScanNotesOptions {
  /** Pre-scanned array of absolute file paths (avoids duplicate vault walks) */
  files?: string[];
  /**
   * Capture each file's raw content on the returned notes.
   *
   * @remarks Enables single-read collection: the caller can thread the same
   * bytes into `loadTopics({ contents })` so parse outcomes and topic
   * loading observe one snapshot of the vault.
   */
  includeContent?: boolean;
}


/**
 * True when a line opens with indentation (a space or a tab).
 *
 * @remarks
 * Indented lines are YAML continuations — a block-scalar body (`description: |`
 * followed by `  ## Details`) or a nested collection — so only column-0 lines
 * are candidates for Markdown body-text detection.
 */
function isIndentedLine(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t');
}

/**
 * True when a column-0 line continues the block's YAML *data*: a top-level
 * sequence item or a mapping entry.
 *
 * @remarks
 * Deliberately lenient about quoted keys: `"custom: property": value` finds a
 * separator colon and counts as data, which is what it is. A comment is YAML
 * *syntax*, not data, so it never counts — the boundary this feeds has to stay
 * where the entries stop.
 */
function isTopLevelYamlData(trimmed: string): boolean {
  if (trimmed.startsWith('-')) return true;
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) return false;
  const afterColon = trimmed.slice(colonIndex + 1);
  return afterColon.startsWith(' ') || afterColon.startsWith('\t') || afterColon === '';
}

/**
 * Index of the last column-0 line that carries YAML data, or `-1` when the
 * block holds none. Blank and comment lines are stepped over: they neither end
 * nor extend the data region.
 */
function lastYamlDataIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isIndentedLine(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (isTopLevelYamlData(trimmed)) return i;
  }
  return -1;
}

/**
 * Checks whether raw frontmatter text contains lines that look like Markdown body text
 * rather than YAML key-value pairs or comments (#171.11).
 *
 * @remarks
 * In YAML a `#` starts a comment regardless of how many hashes follow it, so
 * `## key points` inside a frontmatter block is legal YAML that parses cleanly —
 * it is never body text and must never cost the note its metadata (#319).
 *
 * The Markdown-heading shape still has to stay fatal where it is not a comment
 * but a swallowed paragraph, and the two cases are the same bytes, so the
 * decision is made by *position*: a heading line counts as body text only when
 * (a) a column-0 blank line already ended the mapping and (b) no YAML data line
 * follows it — i.e. it sits in the trailing region directly against the closing
 * `---`. That is the signature of a frontmatter block whose real closing fence
 * is missing, where the `---` is a thematic break and the "frontmatter" is the
 * note's body (#171.11). Pinned by the
 * `unclosed fence followed by body thematic break with markdown subheadings`
 * case in test/storage-scanner.test.ts, against its mirror pair where the same
 * heading is adjacent to the entries and therefore legal.
 *
 * Residual limits of the heuristic, accepted on purpose and in both directions:
 * a note that puts a blank line before a *trailing* `##` comment — the one shape
 * byte-for-byte identical to a swallowed heading — is still reported; and a
 * swallowed heading followed by a line that merely looks like `key: value` is
 * no longer reported, because the data-shaped line says the block kept running.
 * The second gap is the cheaper failure: the note still parses, the leak costs a
 * warning rather than the note's metadata. Comments attached to the entries they
 * document, which is how frontmatter comments are written, are never affected.
 */
function hasBodyTextLines(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  const dataEndsAt = lastYamlDataIndex(lines);
  // True once a column-0 blank line has ended the mapping region. An indented
  // blank does not count: it belongs to a block scalar or a nested collection.
  let mappingEnded = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      if (!isIndentedLine(line)) mappingEnded = true;
      continue;
    }
    if (!isIndentedLine(line)) {
      // YAML comment (`#`, `##`, `####`, …): legal anywhere the data still runs.
      if (trimmed.startsWith('#')) {
        if (mappingEnded && index > dataEndsAt && /^#{2,6}\s+\S/.test(trimmed)) {
          return true;
        }
        continue;
      }
      // Markdown blockquotes (> quote)
      if (/^>\s+\S/.test(trimmed)) {
        return true;
      }
      // Markdown list items (unordered * or +, ordered 1.)
      if (/^[*+]\s+\S/.test(trimmed) || /^\d+\.\s+\S/.test(trimmed)) {
        return true;
      }
      // Any data line below this point keeps the mapping open.
      mappingEnded = false;
      if (trimmed.startsWith('-')) {
        // Top-level sequence item
        continue;
      }
      // Quoted keys (single or double) are intentional YAML — never
      // flag them as body text regardless of inner content.
      // Scan past the quoted key to find the mapping separator colon,
      // ensuring colons inside the quotes are not treated as separators.
      if (trimmed.startsWith('"')) {
        let i = 1;
        let closed = false;
        while (i < trimmed.length) {
          if (trimmed[i] === '\\') {
            i += 2;
          } else if (trimmed[i] === '"') {
            closed = true;
            break;
          } else {
            i++;
          }
        }
        if (closed && trimmed.slice(i + 1).trimStart().startsWith(':')) {
          continue;
        }
        return true;
      }
      if (trimmed.startsWith("'")) {
        let i = 1;
        let closed = false;
        while (i < trimmed.length) {
          if (trimmed[i] === "'") {
            if (i + 1 < trimmed.length && trimmed[i + 1] === "'") {
              i += 2;
            } else {
              closed = true;
              break;
            }
          } else {
            i++;
          }
        }
        if (closed && trimmed.slice(i + 1).trimStart().startsWith(':')) {
          continue;
        }
        return true;
      }
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex !== -1) {
        // In YAML, a block mapping separator colon must be followed by
        // whitespace (space or tab) or be at the end of the line.
        // A colon followed immediately by non-whitespace (e.g. `http://` or
        // `12:30`) cannot represent a YAML mapping separator.
        const afterColon = trimmed.slice(colonIndex + 1);
        if (!afterColon.startsWith(' ') && !afterColon.startsWith('\t') && afterColon !== '') {
          return true;
        }
      } else {
        // Line at column 0 with no colon, not comment, not sequence
        return true;
      }
    }
  }
  return false;
}

/**
 * Scans vault Markdown files and reports per-file frontmatter parse outcomes.
 *
 * @remarks
 * Every scanned file produces exactly one {@link ScannedNote}: a file whose
 * YAML cannot be parsed keeps `frontmatter: null` and carries the parser
 * message in `parseError`; a file with no frontmatter at all is not an error.
 * Unreadable files (deleted mid-scan, locked by another writer) are skipped
 * gracefully, mirroring `loadTopics`. Results are sorted by relative path so
 * downstream output is deterministic across platforms.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param options - Scan options (`files` for a pre-scanned file list,
 * `includeContent` to capture raw bytes per note)
 * @returns One parse-outcome entry per readable file, sorted by relative path
 *
 * @example
 * ```typescript
 * const notes = scanNotes('/path/to/vault');
 * const broken = notes.filter((n) => n.parseError);
 * ```
 */
function scanNotes(vaultPath: string, options: ScanNotesOptions = {}): ScannedNote[] {
  const scanFiles = options.files ?? walkVault(vaultPath);
  const notes: ScannedNote[] = [];

  for (const filePath of scanFiles) {
    let content: string;
    try {
      // Stat first (#332): a document over the read cap is declined without
      // being read at all, so the bound covers the IO and the line scan, not
      // only the parse — the same shape the TOC reader uses for oversized
      // documents (src/storage/toc.ts, issue #263).
      const sizeInBytes = fs.statSync(filePath).size;
      if (sizeInBytes > MAX_NOTE_SOURCE_BYTES) {
        notes.push({
          absolutePath: filePath,
          relativePath: relativeVaultPath(vaultPath, filePath),
          frontmatter: null,
          readError: oversizedNoteDiagnostic(sizeInBytes),
        });
        continue;
      }
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e: unknown) {
      // Retain the note with a read error so rules can warn that
      // validation ran on an incomplete snapshot instead of silently
      // shrinking the graph (which would turn transient locks into
      // false missing-dependency errors).
      const err = e as NodeJS.ErrnoException;
      notes.push({
        absolutePath: filePath,
        relativePath: relativeVaultPath(vaultPath, filePath),
        frontmatter: null,
        readError: err.message,
      });
      continue;
    }

    const { frontmatter: parsedFrontmatter, error, raw } = parseFrontmatter(content);
    let frontmatter = parsedFrontmatter;
    let parseError = error;

    // Detect body content accidentally parsed as YAML (#171.11)
    if (!parseError && frontmatter !== null && raw !== null && raw !== '' && hasBodyTextLines(raw)) {
      parseError =
        'Unclosed frontmatter block: opening `---` fence has no closing `---` ' +
        '(body content was parsed as frontmatter)';
      frontmatter = null;
    }

    // An opening `---` fence with no closing fence is invisible to
    // parseFrontmatter (it only sees "no frontmatter found"). Flag it only
    // when the body reads like YAML — a legal note opening with a `---`
    // thematic break (horizontal rule) must not be reported as malformed.
    // Normalize a leading BOM the same way parseFrontmatter does,
    // so the fence anchor regex matches consistently.
    const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (!parseError && frontmatter === null && /^---\r?\n/.test(normalized)) {
      if (raw === null) {
        const fenceBody = normalized.slice(normalized.indexOf('\n') + 1);
        const looksLikeYaml =
          // key: value at any indent (keys start A-Z, a-z, or _)
          /^[ \t]*[A-Za-z_][\w-]*:(\s|$)/m.test(fenceBody) ||
          // sequence items, column-0 or indented: "- item"
          /^[ \t]*-\s+\S/m.test(fenceBody);
        if (looksLikeYaml) {
          parseError =
            'Unclosed frontmatter block: opening `---` fence has no closing `---` ' +
            '(if the opening line is a horizontal rule, use `***` instead)';
        }
      } else if (raw !== '' && hasBodyTextLines(raw)) {
        parseError =
          'Unclosed frontmatter block: opening `---` fence has no closing `---` ' +
          '(body content was parsed as frontmatter)';
      }
    }

    notes.push({
      absolutePath: filePath,
      relativePath: relativeVaultPath(vaultPath, filePath),
      frontmatter,
      ...(parseError ? { parseError } : {}),
      ...(options.includeContent ? { content } : {}),
    });
  }

  notes.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return notes;
}

export { scanNotes };
export default scanNotes;
