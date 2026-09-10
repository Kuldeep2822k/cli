/**
 * Note Scanner
 *
 * @remarks
 * Storage-boundary reader that walks a vault and reports per-file
 * frontmatter parse outcomes for the validation framework (#25).
 * A file with malformed YAML yields an entry with `parseError` set —
 * reading never throws, so one bad note cannot abort a vault scan.
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from './vault-walker';
import { parseFrontmatter } from './frontmatter';
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
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e: unknown) {
      // Retain the note with a read error so rules can warn that
      // validation ran on an incomplete snapshot instead of silently
      // shrinking the graph (which would turn transient locks into
      // false missing-dependency errors).
      const err = e as NodeJS.ErrnoException;
      notes.push({
        absolutePath: filePath,
        relativePath: path.relative(vaultPath, filePath).replace(/\\/g, '/'),
        frontmatter: null,
        readError: err.message,
      });
      continue;
    }

    const { frontmatter, error } = parseFrontmatter(content);

    // An opening `---` fence with no closing fence is invisible to
    // parseFrontmatter (it only sees "no frontmatter found"). Flag it only
    // when the body reads like YAML — a legal note opening with a `---`
    // thematic break (horizontal rule) must not be reported as malformed.
    let parseError = error;
    if (!parseError && frontmatter === null && /^---\r?\n/.test(content) && !content.includes('\n---')) {
      const fenceBody = content.slice(content.indexOf('\n') + 1);
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
    }

    notes.push({
      absolutePath: filePath,
      relativePath: path.relative(vaultPath, filePath).replace(/\\/g, '/'),
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
