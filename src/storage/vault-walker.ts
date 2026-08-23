/**
 * Vault Walker
 *
 * @remarks
 * Recursively discovers Markdown files across an Obsidian vault directory hierarchy.
 * Ignores hidden dot-directories (`.obsidian`, `.trash`, `.git`, `.palee`), `node_modules`,
 * and dotfiles, with built-in protection against circular symlinks and unreadable subdirectories.
 */

import fs from 'fs';
import path from 'path';
import { WalkOptions } from '../types';

/** Specific top-level directory names permanently excluded from scanning */
const EXCLUDED_DIRS = new Set([
  'node_modules',
]);

/**
 * Traverses an Obsidian vault directory and returns absolute paths to all discovered Markdown (`.md`) notes.
 *
 * @remarks
 * Exclusion rules:
 * - Dot-directories (e.g. `.obsidian`, `.trash`, `.git`, `.palee`) matching directory entry names are skipped.
 * - Dot-files (e.g. `.hidden.md`, `.DS_Store`) are skipped.
 * - Non-markdown files are skipped.
 * - `node_modules` directory entries are skipped.
 * - Symbolic links are ignored by default unless `options.followSymlinks` is explicitly enabled.
 *
 * @param vaultPath - Path to the root Obsidian vault directory
 * @param options - Traversal options (e.g., `followSymlinks`)
 * @returns Array of absolute file paths to discovered `.md` files
 * @throws {Error} If the vault path does not exist, is not a directory, or lacks read permissions
 *
 * @example
 * ```typescript
 * const markdownFiles = walkVault('/Users/alex/Documents/ObsidianVault');
 * console.log(`Found ${markdownFiles.length} notes`);
 * ```
 */
function walkVault(vaultPath: string, options: WalkOptions = {}): string[] {
  const { followSymlinks = false } = options;
  const results: string[] = [];
  const visited = new Set<string>();
  const resolvedVaultPath = path.resolve(vaultPath);

  if (!fs.existsSync(resolvedVaultPath)) {
    throw new Error(`Vault path does not exist: ${resolvedVaultPath}`);
  }
  const rootStat = fs.statSync(resolvedVaultPath);
  if (!rootStat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${resolvedVaultPath}`);
  }
  try {
    fs.accessSync(resolvedVaultPath, fs.constants.R_OK);
  } catch {
    throw new Error(`Vault path is not readable (permission denied): ${resolvedVaultPath}`);
  }

  function walk(dir: string): void {
    let realDir = dir;
    if (followSymlinks) {
      try { 
        realDir = fs.realpathSync(dir);
        const relativePath = path.relative(resolvedVaultPath, realDir);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;
      } catch { return; }
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Directory read permission denied - skip silently
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      let isDir = entry.isDirectory();
      let isFil = entry.isFile();

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) {
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          isDir = stat.isDirectory();
          isFil = stat.isFile();
        } catch {
          // Dead link, skip
          continue;
        }
      }

      // Skip dot-files and dot-directories (.obsidian, .trash, .git, .hidden.md, etc.)
      if (entry.name.startsWith('.')) {
        continue;
      }

      // Skip excluded directories
      if (isDir && EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      if (isDir) {
        walk(fullPath);
      } else if (isFil && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(resolvedVaultPath);
  return results;

}

export { walkVault };
