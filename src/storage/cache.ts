/**
 * Memory-Resident File Cache with Unsettled Horizon
 *
 * @remarks
 * Caches parsed frontmatter and AST structures in memory while guarding against stale reads:
 * - **Unsettled Horizon (2,000 ms)**: If a file was modified within the last 2 seconds, re-computes its SHA-256 fingerprint on read to detect in-flight disk edits.
 * - **Outside Unsettled Horizon**: Validates `mtime` and `size` for fast O(1) cache hits.
 * - **Automatic Invalidation**: Purges cache entries on size mismatch or missing file states.
 */

import fs from 'fs';
import { computeFingerprint } from './frontmatter';
import { CacheEntry } from '../types';

/**
 * Window in milliseconds (2,000 ms) after a file's last modification during
 * which {@link FileCache.get} re-reads the file and re-verifies its SHA-256
 * fingerprint instead of trusting the cached `mtime`/`size`, so in-flight disk
 * edits landing within the same filesystem-timestamp granularity are not served
 * from a stale cache entry.
 */
const UNSETTLED_HORIZON = 2000;

/**
 * Default maximum number of entries retained in a {@link FileCache} before
 * least-recently-verified eviction kicks in.
 *
 * @remarks
 * Bounds memory growth when scanning large vaults. When the cache exceeds this
 * cap, the entry with the oldest `lastVerified` timestamp (the least recently
 * read or written) is evicted first (LRU).
 */
const MAX_CACHE_ENTRIES = 2000;

/**
 * Generic in-memory file cache keyed by filesystem path.
 *
 * @typeParam T - Type of cached payload (e.g. parsed topic AST, YAML document, or frontmatter dictionary)
 *
 * @remarks
 * Maintains an in-memory map of file paths to their parsed contents, stats (`mtime`, `size`), and SHA-256 content fingerprints.
 * Implements deterministic cache invalidation with zero environment-dependent leaks (`NODE_ENV` independent):
 * - Checks file existence and size via `fs.statSync`.
 * - If modified within the `UNSETTLED_HORIZON` (2,000 ms), reads content and validates SHA-256 fingerprint against disk.
 * - If modified outside the unsettled horizon, verifies `mtime` matches cached timestamp before returning cached data.
 * - Automatically evicts deleted, truncated, or concurrently modified files.
 *
 * @example
 * ```typescript
 * const cache = new FileCache<LoadedTopic>();
 * cache.set('/path/to/note.md', topicData, fingerprint);
 * const cached = cache.get('/path/to/note.md');
 * ```
 */
class FileCache<T = unknown> {
  private cache: Map<string, CacheEntry<T>>;
  private readonly maxEntries: number;

  /**
   * Initializes a new empty FileCache.
   *
   * @param maxEntries - Maximum number of entries to retain before
   *   least-recently-verified (LRU) eviction. Defaults to {@link MAX_CACHE_ENTRIES}.
   *
   * @remarks
   * Creates an internal `Map` instance to hold path-to-entry associations.
   *
   * @example
   * ```typescript
   * const cache = new FileCache<Topic>();
   * ```
   */
  constructor(maxEntries: number = MAX_CACHE_ENTRIES) {
    this.cache = new Map();
    this.maxEntries = maxEntries > 0 ? maxEntries : MAX_CACHE_ENTRIES;
  }

  /**
   * Retrieves a cached entry for the given file path if the file has not been modified on disk.
   *
   * @param filePath - Absolute path to cached file
   * @returns Cached data object if valid, or `null` on cache miss / invalidation
   *
   * @remarks
   * Evaluates cache freshness deterministically:
   * 1. If entry not in map, returns `null`.
   * 2. Checks `fs.statSync(filePath)`. If size does not match, entry is deleted and returns `null`.
   * 3. If within 2,000ms unsettled horizon, recomputes SHA-256 hash. If hash matches, refreshes `lastVerified` and returns data; otherwise evicts entry and returns `null`.
   * 4. If outside unsettled horizon and `mtime` matches, refreshes `lastVerified` and returns data.
   * 5. If `mtime` differs, recomputes hash to confirm content equivalence before updating timestamp or evicting.
   * 6. On any filesystem error (e.g. `ENOENT` / deletion), evicts entry and returns `null`.
   *
   * @example
   * ```typescript
   * const data = cache.get('/vault/topic.md');
   * if (data !== null) {
   *   console.log('Cache hit:', data);
   * }
   * ```
   */
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
        entry.lastVerified = now;
        return entry.data;
      }

      // Outside unsettled horizon and mtime matches - cache hit
      if (entry.mtime === mtime) {
        // Same-second edits on filesystems with whole-second mtime resolution
        // produce an identical mtime, so mtime equality alone cannot be trusted
        // here. When the mtime carries no sub-second precision, fall back to a
        // fingerprint check before trusting the cached entry (#367).
        if (mtime % 1000 === 0) {
          const content = fs.readFileSync(filePath, 'utf8');
          const fingerprint = computeFingerprint(content);

          if (fingerprint !== entry.fingerprint) {
            this.cache.delete(filePath);
            return null;
          }
        }

        entry.lastVerified = now;
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
      entry.lastVerified = now;
      return entry.data;

    } catch {
      // File no longer exists or read error
      this.cache.delete(filePath);
      return null;
    }
  }

  /**
   * Stores a data object and its content fingerprint in the cache.
   *
   * @param filePath - Absolute path to cached file
   * @param data - Parsed data payload to store
   * @param fingerprint - Current SHA-256 content hash of the file
   * @returns Void
   *
   * @remarks
   * Captures current `mtime` and `size` via `fs.statSync`. If the file does not exist or stat fails, the entry is not stored.
   *
   * @example
   * ```typescript
   * const hash = computeFingerprint(content);
   * cache.set('/vault/note.md', parsedAst, hash);
   * ```
   */
  set(filePath: string, data: T, fingerprint?: string): void {
    try {
      const stats = fs.statSync(filePath);
      const fp = fingerprint ?? computeFingerprint(fs.readFileSync(filePath, 'utf8'));
      this.cache.set(filePath, {
        mtime: stats.mtimeMs,
        size: stats.size,
        fingerprint: fp,
        data,
        lastVerified: Date.now(),
      });
      this.evictIfNeeded();
    } catch {
      // File doesn't exist - don't cache
    }
  }

  /**
   * Evicts the least-recently-verified entry while the cache exceeds its cap.
   *
   * @returns Void
   *
   * @remarks
   * Enforces the LRU bound established by the constructor's `maxEntries`.
   * The entry with the smallest `lastVerified` timestamp — the one least
   * recently read (via {@link FileCache.get}) or written (via
   * {@link FileCache.set}) — is removed first. Because `set` adds a single
   * entry at a time, at most one entry is evicted per call (#368).
   */
  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestVerified = Infinity;

      for (const [key, entry] of this.cache) {
        if (entry.lastVerified < oldestVerified) {
          oldestVerified = entry.lastVerified;
          oldestKey = key;
        }
      }

      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Manually evicts a specific file entry from the cache.
   *
   * @param filePath - Path to invalidate
   * @returns Void
   *
   * @remarks
   * Removes the corresponding entry from the internal map immediately.
   *
   * @example
   * ```typescript
   * cache.invalidate('/vault/note.md');
   * ```
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Clears all entries from the cache.
   *
   * @returns Void
   *
   * @remarks
   * Clears the entire internal cache map, resetting memory footprint to zero.
   *
   * @example
   * ```typescript
   * cache.clear();
   * ```
   */
  clear(): void {
    this.cache.clear();
  }
}

export { FileCache, UNSETTLED_HORIZON, MAX_CACHE_ENTRIES };
