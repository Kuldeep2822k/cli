import fs from 'fs';
import path from 'path';
import { WalkOptions } from '../types';

/**
 * Vault Walker - Traverses Obsidian vault and collects markdown files
 * Excludes: .obsidian, .trash, .git, node_modules, dot-directories, symlinks
 */

const EXCLUDED_DIRS = new Set([
  '.obsidian',
  '.trash',
  '.git',
  'node_modules',
]);

function walkVault(vaultPath: string, options: WalkOptions = {}): string[] {
  const { followSymlinks = false } = options;
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Directory read permission denied - skip silently
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip symlinks unless explicitly following them
      if (entry.isSymbolicLink() && !followSymlinks) {
        continue;
      }

      // Skip hidden directories (starting with .)
      if (entry.isDirectory() && entry.name.startsWith('.')) {
        continue;
      }

      // Skip excluded directories
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(vaultPath);
  return results;
}

export { walkVault };
