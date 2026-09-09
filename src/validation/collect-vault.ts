/**
 * Vault Collection for Validation (#25)
 *
 * @remarks
 * Builds the fully collected {@link ValidationContext} for the rule
 * framework in a single-read snapshot: every file is read exactly once by
 * `scanNotes`, and the same bytes feed both the per-file parse outcomes and
 * the normalized topic loading (via `loadTopics({ contents })`). A note
 * edited concurrently with validation therefore cannot make parse warnings
 * and graph rules observe different versions of the vault.
 *
 * Collection never throws on malformed notes: parse outcomes are preserved
 * per file so rules can report them as warnings while the rest of the vault
 * is still validated.
 */

import { loadTopics } from '../storage/loader';
import { scanNotes } from '../storage/scanner';
import { FileCache } from '../storage/cache';
import type { LoadedTopic } from '../storage/loader';
import type { ValidationContext } from './types';

/**
 * Options for {@link collectVault}.
 */
export interface CollectVaultOptions {
  /** Pre-scanned array of absolute file paths (avoids duplicate vault walks) */
  files?: string[];
  /**
   * Topic cache for non-injected reads; defaults to a fresh cache.
   *
   * @remarks Snapshot-injected files never touch this cache.
   */
  cache?: FileCache<LoadedTopic>;
}

/**
 * Collects the full vault state a validation run needs.
 *
 * @remarks
 * Single read pass: `scanNotes` reads each file once and captures its raw
 * content; those bytes are threaded into `loadTopics` so parse outcomes and
 * topics come from one snapshot of the vault. Malformed files never abort
 * collection — the invariant is one bad note = one warning, never a dead
 * scan.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param options - Collection options (`files`, `cache`)
 * @returns Fully collected {@link ValidationContext}
 *
 * @example
 * ```typescript
 * const context = collectVault(vaultPath);
 * const issues = runRules(context, rules);
 * ```
 */
function collectVault(
  vaultPath: string,
  options: CollectVaultOptions = {}
): ValidationContext {
  // Single-read snapshot: scanNotes captures raw content per file; the same
  // bytes feed parse outcomes and topic normalization (no second read, no
  // cache revalidation that could observe a different version mid-scan).
  const notes = scanNotes(vaultPath, {
    files: options.files,
    includeContent: true,
  });
  const files = notes.map((note) => note.absolutePath);
  const contents = new Map<string, string>();
  for (const note of notes) {
    // Only readable notes contribute bytes: a read-failure note has no
    // content, and injecting empty string would tell the loader a file is
    // blank when the truth is "could not read". Unreadable files are
    // simply absent from the snapshot — the readIncomplete flag carries
    // that signal to the rules.
    if (note.content !== undefined) {
      contents.set(note.absolutePath, note.content);
    }
  }

  const topics = loadTopics(vaultPath, {
    files,
    contents,
    cache: options.cache ?? new FileCache<LoadedTopic>(),
  });

  return {
    vaultPath,
    files,
    topics,
    notes,
    readIncomplete: notes.some((note) => note.readError !== undefined),
  };
}

export { collectVault };
export default collectVault;
