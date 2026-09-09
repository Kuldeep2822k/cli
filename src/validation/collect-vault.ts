/**
 * Vault Collection for Validation (#25)
 *
 * @remarks
 * Orchestrates storage-layer reading into a single fully collected
 * {@link ValidationContext} for the rule framework. Collection never throws
 * on malformed notes: parse outcomes are preserved per file so rules can
 * report them as warnings while the rest of the vault is still validated.
 */

import { loadTopics } from '../storage/loader';
import { scanNotes } from '../storage/scanner';
import { FileCache } from '../storage/cache';
import type { LoadedTopic } from '../storage/loader';
import { ValidationContext } from './types';

/**
 * Options for {@link collectVault}.
 */
export interface CollectVaultOptions {
  /** Pre-scanned array of absolute file paths (avoids duplicate vault walks) */
  files?: string[];
  /** Topic cache to read from and populate; defaults to a fresh cache */
  cache?: FileCache<LoadedTopic>;
}

/**
 * Collects the full vault state a validation run needs.
 *
 * @remarks
 * Single walk shared by both readers: `scanNotes` reports per-file parse
 * outcomes (including malformed YAML), and `loadTopics` normalizes PALEE
 * topics for engine consumption. Malformed files never abort collection —
 * the invariant is one bad note = one warning, never a dead scan.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param options - Collection options (`files`, `cache`)
 * @returns Fully collected {@link ValidationContext}
 *
 * @example
 * ```typescript
 * const context = collectVault(vaultPath, { cache: new FileCache() });
 * const issues = runRules(context, rules);
 * ```
 */
function collectVault(
  vaultPath: string,
  options: CollectVaultOptions = {}
): ValidationContext {
  // Single read pass: one scan produces both the per-file note outcomes and
  // the file list the topic loader reuses (no second walk, no double reads).
  const notes = scanNotes(vaultPath, { files: options.files });
  const files = notes.map((n) => n.absolutePath);
  const topics = loadTopics(vaultPath, {
    files,
    cache: options.cache ?? new FileCache<LoadedTopic>(),
  });

  return {
    vaultPath,
    files,
    topics,
    notes,
  };
}

export { collectVault };
export default collectVault;
