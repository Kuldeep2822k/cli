import fs from 'fs';
import path from 'path';
import { WalkOptions } from '../types';

/**
 * Vault Walker - Traverses Obsidian vault and collects markdown files
 * Excludes: .obsidian, .trash, .git, node_modules, dot-directories, symlinks
 */

const EXCLUDED_DIRS = new Set([
  'node_modules',
]);

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

      // Skip hidden directories (starting with .)
      if (isDir && entry.name.startsWith('.')) {
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

  walk(vaultPath);
  return results;
}

export { walkVault };
