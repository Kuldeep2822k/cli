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
 * - Symbolic link *files* (when followSymlinks is enabled) whose real target lies outside the vault are excluded.
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
  const { followSymlinks = false, excludeDirs = [] } = options;
  const results: string[] = [];
  const visited = new Set<string>();
  const customExcluded = new Set([...EXCLUDED_DIRS, ...excludeDirs]);
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

  /**
   * Recursively traverses a subdirectory, filtering entries against exclusion rules.
   *
   * @param dir - Directory path to traverse
   * @returns Void
   *
   * @remarks
   * Evaluates directory entries with symlink escape protection, dot-directory exclusion, and custom filter rules.
   *
   * @example
   * ```typescript
   * walk('/vault/topics');
   * ```
   */
  function walk(dir: string): void {
    let realDir = dir;
    if (followSymlinks) {
      try { 
        realDir = fs.realpathSync(dir);
        const relativePath = path.relative(resolvedVaultPath, realDir);
        if (
          path.isAbsolute(relativePath) ||
          relativePath === '..' ||
          relativePath.startsWith('..' + path.sep) ||
          relativePath.startsWith('../') ||
          relativePath.split(path.sep).includes('..')
        ) return;
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
      if (isDir && customExcluded.has(entry.name)) {
        continue;
      }

      if (isDir) {
        walk(fullPath);
      } else if (isFil && entry.name.endsWith('.md')) {
        // For symlinked files, validate their real target is within the vault
        if (entry.isSymbolicLink() && followSymlinks) {
          try {
            const realFile = fs.realpathSync(fullPath);
            const fileRel = path.relative(resolvedVaultPath, realFile);
            if (
              path.isAbsolute(fileRel) ||
              fileRel === '..' ||
              fileRel.startsWith('..' + path.sep) ||
              fileRel.startsWith('../')
            ) {
              continue; // symlink target is outside vault — skip
            }
          } catch {
            continue; // dead or unresolvable symlink — skip
          }
        }
        results.push(fullPath);
      }
    }
  }

  walk(resolvedVaultPath);
  return results;
}

/**
 * Ensures a directory inside the vault exists, validating path boundaries and preventing symlink escapes.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param targetPath - Absolute or relative path to target directory or file within the vault
 * @returns Canonical path to the ensured directory
 * @throws {Error} If targetPath escapes vault boundary or resolves outside vault via symlinks
 *
 * @remarks
 * Performs rigorous security and normalization checks:
 * 1. Resolves canonical vault root via `fs.realpathSync`.
 * 2. Normalizes relative target paths against `resolvedVault`.
 * 3. Validates boundary containment across relative traversal (`..`) and Windows drive roots.
 * 4. Checks pre-creation ancestor paths to prevent symlink escape outside the vault.
 * 5. Recursively creates the directory and asserts final canonical path containment.
 *
 * @example
 * ```typescript
 * const dir = ensureVaultDirectory('/path/to/vault', 'topics/math/algebra.md');
 * ```
 */
function ensureVaultDirectory(vaultPath: string, targetPath: string): string {
  const resolvedVault = fs.realpathSync(path.resolve(vaultPath));
  const absoluteTarget = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(resolvedVault, targetPath);
  const targetDir = path.extname(absoluteTarget) ? path.dirname(absoluteTarget) : absoluteTarget;

  // Boundary check: ensure targetDir does not escape vault across relative or cross-drive paths
  const relative = path.relative(resolvedVault, targetDir);
  if (
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    relative.startsWith('../') ||
    relative.split(path.sep).includes('..')
  ) {
    throw new Error(`Path escapes vault boundary: ${targetPath}`);
  }

  // Pre-creation ancestor symlink validation: ensure existing parent paths do not resolve outside the vault
  let existingAncestor = targetDir;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  if (fs.existsSync(existingAncestor)) {
    const canonicalAncestor = fs.realpathSync(existingAncestor);
    if (canonicalAncestor !== resolvedVault && !canonicalAncestor.startsWith(resolvedVault + path.sep)) {
      throw new Error(`Symlink escape detected: ${targetPath} resolves outside vault`);
    }
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const canonicalDir = fs.realpathSync(targetDir);
  if (canonicalDir !== resolvedVault && !canonicalDir.startsWith(resolvedVault + path.sep)) {
    throw new Error(`Symlink escape detected: ${targetPath} resolves outside vault`);
  }

  return canonicalDir;
}

export { walkVault, ensureVaultDirectory };
