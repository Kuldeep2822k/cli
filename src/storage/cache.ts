import fs from 'fs';
import { computeFingerprint } from './frontmatter';
import { CacheEntry } from '../types';

/**
 * File cache with unsettled horizon (2 seconds)
 * Prevents reusing stale cache during rapid edit cycles
 */

const UNSETTLED_HORIZON = 2000; // 2 seconds in milliseconds

class FileCache<T = unknown> {
  private cache: Map<string, CacheEntry<T>>;

  constructor() {
    this.cache = new Map();
  }

  get(filePath: string): T | null {
    const entry = this.cache.get(filePath);
    if (!entry) return null;

    try {
      const stats = fs.statSync(filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // Size mismatch - cache invalid
      if (entry.size !== size) {
        this.cache.delete(filePath);
        return null;
      }

      // Within unsettled horizon - recompute fingerprint
      const now = Date.now();
      if ((now - mtime) < UNSETTLED_HORIZON) {
        const content = fs.readFileSync(filePath, 'utf8');
        const fingerprint = computeFingerprint(content);

        if (fingerprint !== entry.fingerprint) {
          this.cache.delete(filePath);
          return null;
        }

        // Fingerprint matches - update cache
        entry.mtime = mtime;
        return entry.data;
      }

      // Outside unsettled horizon and mtime matches - cache hit
      if (entry.mtime === mtime) {
        return entry.data;
      }

      // mtime changed outside unsettled horizon - verify fingerprint
      const content = fs.readFileSync(filePath, 'utf8');
      const fingerprint = computeFingerprint(content);

      if (fingerprint !== entry.fingerprint) {
        this.cache.delete(filePath);
        return null;
      }

      // Fingerprint matches - update mtime
      entry.mtime = mtime;
      return entry.data;

    } catch {
      // File no longer exists or read error
      this.cache.delete(filePath);
      return null;
    }
  }

  set(filePath: string, data: T, fingerprint: string): void {
    try {
      const stats = fs.statSync(filePath);
      this.cache.set(filePath, {
        mtime: stats.mtimeMs,
        size: stats.size,
        fingerprint,
        data,
      });
    } catch {
      // File doesn't exist - don't cache
    }
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  clear(): void {
    this.cache.clear();
  }
}

export { FileCache, UNSETTLED_HORIZON };
