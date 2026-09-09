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
 * @param options - Scan options (`files` for a pre-scanned file list)
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
    } catch {
      continue; // Transient error or file deleted/locked by concurrent writer - skip gracefully
    }

    const { frontmatter, error } = parseFrontmatter(content);

    // An opening `---` fence with no closing fence is invisible to
    // parseFrontmatter (it only sees "no frontmatter found"). Surface it as
    // a parse error so the validation rule can warn instead of skipping.
    let parseError = error;
    if (!parseError && frontmatter === null && /^---\r?\n/.test(content) && !content.includes('\n---')) {
      parseError = 'Unclosed frontmatter block: opening `---` fence has no closing `---`';
    }

    notes.push({
      absolutePath: filePath,
      relativePath: path.relative(vaultPath, filePath).replace(/\\/g, '/'),
      frontmatter,
      ...(parseError ? { parseError } : {}),
    });
  }

  notes.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return notes;
}

export { scanNotes };
export default scanNotes;
