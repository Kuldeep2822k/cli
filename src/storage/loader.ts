/**
 * Topic Loader
 *
 * @remarks
 * Centralized boundary for scanning, parsing, normalizing, and loading PALEE topics from an Obsidian vault.
 * Guarantees uniform fallback values, score clamping, type coercion, and dependency parsing across all CLI commands.
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from './vault-walker';
import { computeFingerprint, parseFrontmatter } from './frontmatter';
import { FileCache } from './cache';
import { normalizeDependencies } from './dependencies';
import { TopicNode, normalizeDifficulty } from '../types';

/** Module-level topic file cache */
const topicCache = new FileCache<LoadedTopic>();

/**
 * Returns the module-level topic cache instance.
 *
 * @returns FileCache instance holding parsed topic notes
 * @remarks
 * Reserved shared-cache seam for future layers (Phase-2 AI read tools, MCP escape hatch, validation framework #25 / #129).
 * In-process tests and consumers needing cache isolation should inject their own `FileCache<LoadedTopic>` via
 * `loadTopics(vaultPath, { cache })` instead of relying on this shared instance.
 */
export function getTopicCache(): FileCache<LoadedTopic> {
  return topicCache;
}

/**
 * Fully materialized in-memory representation of a PALEE topic note loaded from disk.
 */
export interface LoadedTopic extends TopicNode {
  /** Canonical topic ID (`palee_id`) */
  id: string;
  /** Topic title */
  title: string;
  /** Relative POSIX path from the vault root */
  path: string;
  /** Absolute filesystem path to the Markdown note */
  filePath: string;
  /** Full raw Markdown text content */
  content: string;
  /** Parsed YAML frontmatter dictionary */
  frontmatter: Record<string, unknown>;
}

/**
 * Options for {@link loadTopics}.
 */
export interface LoadTopicsOptions {
  /** Pre-scanned array of absolute file paths (avoids duplicate vault walks) */
  files?: string[];
  /**
   * Caller-supplied file contents keyed by absolute path (snapshot injection).
   *
   * @remarks Single-read collection seam (#25): when bytes are provided for
   * a path, they are used verbatim — no filesystem read and no cache
   * read/write — so the loader observes the same snapshot the caller saw.
   * Unlisted paths fall back to the normal read + cache path.
   */
  contents?: Map<string, string>;
  /** Cache to read from and populate; defaults to the shared `getTopicCache()` instance */
  cache?: FileCache<LoadedTopic>;
}

/**
 * Parses and clamps a score value to `[0.0, 1.0]` with 4 decimal places.
 *
 * @remarks
 * If `val` cannot be parsed into a finite number, the provided `fallback` value is returned
 * unchanged without clamping.
 *
 * @param val - Score input
 * @param fallback - Default fallback if invalid (default: 0.0)
 * @returns Clamped numeric score or raw fallback
 *
 * @example
 * ```typescript
 * parseScore(0.85432); // 0.8543
 * parseScore('0.5');   // 0.5
 * parseScore(null, 0); // 0
 * ```
 */
function parseScore(val: unknown, fallback: number = 0.0): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return Math.round(Math.max(0, Math.min(1, val)) * 10000) / 10000;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return Math.round(Math.max(0, Math.min(1, parsed)) * 10000) / 10000;
      }
    }
  }
  return fallback;
}

/**
 * Coerces and floors an input value into an integer.
 *
 * @remarks
 * If `val` cannot be parsed into a finite integer, the provided `fallback` value is returned
 * unchanged without integer flooring.
 *
 * @param val - Numeric input
 * @param fallback - Default fallback value (default: 0)
 * @returns Integer value or raw fallback
 *
 * @example
 * ```typescript
 * parseInteger(4.8);   // 4
 * parseInteger('10');  // 10
 * parseInteger(null);  // 0
 * ```
 */
function parseInteger(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

/**
 * Parses a floating-point number with fallback.
 *
 * @param val - Numeric input
 * @param fallback - Default fallback value (default: 0)
 * @returns Floating point number
 *
 * @remarks
 * Verifies numeric finiteness and parses stringified numbers.
 *
 * @example
 * ```typescript
 * parseNumber('2.5', 2.5); // 2.5
 * parseNumber(null, 2.5);  // 2.5
 * ```
 */
function parseNumber(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return val;
  }
  if (typeof val === 'string') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}


/**
 * Scans the vault and parses all Markdown files containing a valid `palee_id`.
 *
 * @remarks
 * Normalizes all frontmatter fields, sets default SM-2 values if omitted,
 * and extracts prerequisite dependencies from `depends_on` or `dependencies` arrays.
 *
 * Overloads:
 * - `loadTopics(vaultPath, files?)` — legacy positional form; uses the shared topic cache.
 * - `loadTopics(vaultPath, options?)` — options form; pass `{ cache }` to inject a dedicated
 *   `FileCache<LoadedTopic>` (isolated tests, per-consumer caching) and/or `{ files }`.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param files - Optional pre-scanned array of absolute file paths (avoids duplicate vault walks)
 * @param options - Optional loader options (`files`, `cache`)
 * @returns Array of parsed and normalized {@link LoadedTopic} instances
 *
 * @example
 * ```typescript
 * const topics = loadTopics('/path/to/vault');
 * console.log(`Loaded ${topics.length} topics`);
 *
 * // Isolated cache injection:
 * const topics2 = loadTopics('/path/to/vault', { cache: new FileCache() });
 * ```
 */
export function loadTopics(vaultPath: string, files?: string[]): LoadedTopic[];
export function loadTopics(vaultPath: string, options?: LoadTopicsOptions): LoadedTopic[];
export function loadTopics(
  vaultPath: string,
  arg?: string[] | LoadTopicsOptions
): LoadedTopic[] {
  // Runtime `null` (JS callers) must keep the legacy fallback: the old
  // `files ?? walkVault` tolerated it, so null is not treated as options.
  const isOptions = arg !== undefined && arg !== null && !Array.isArray(arg);
  const files = isOptions ? (arg as LoadTopicsOptions).files : (arg as string[] | undefined);
  const contents = isOptions ? (arg as LoadTopicsOptions).contents : undefined;
  const cache = isOptions
    ? ((arg as LoadTopicsOptions).cache ?? topicCache)
    : topicCache;

  const scanFiles = files ?? walkVault(vaultPath);
  const topics: LoadedTopic[] = [];

  for (const filePath of scanFiles) {
    // Snapshot injection (#25): caller-provided bytes are used verbatim —
    // no read, no cache read, no cache write — so loader and scanner
    // observe the same content even under concurrent edits.
    const injected = contents?.get(filePath);
    let content: string;
    if (injected !== undefined) {
      content = injected;
    } else {
      const cached = cache.get(filePath);
      if (cached) {
        topics.push(cached);
        continue;
      }

      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue; // Transient error or file deleted/locked by concurrent writer - skip gracefully
      }
    }
    const { frontmatter } = parseFrontmatter(content);

    if (!frontmatter || typeof frontmatter.palee_id !== 'string' || !frontmatter.palee_id.trim()) {
      continue;
    }

    const paleeId = frontmatter.palee_id.trim();
    const relPath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
    const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : path.basename(filePath, '.md');

    const dependsOn = normalizeDependencies(frontmatter.depends_on, frontmatter.dependencies);

    const difficulty = normalizeDifficulty(frontmatter.difficulty);
    const topicMastery = parseScore(frontmatter.topic_mastery, 0.0);

    const topic: LoadedTopic = {
      palee_id: paleeId,
      id: paleeId,
      title,
      path: relPath,
      filePath,
      content,
      frontmatter,
      difficulty,
      depends_on: dependsOn,
      topic_mastery: topicMastery,
      status: typeof frontmatter.status === 'string' ? frontmatter.status.trim().toLowerCase() : 'not_started',
      conceptual: parseScore(frontmatter.conceptual, 0.0),
      practical: parseScore(frontmatter.practical, 0.0),
      debug: parseScore(frontmatter.debug, 0.0),
      feynman: parseScore(frontmatter.feynman, 0.0),
      ease_factor: parseNumber(frontmatter.ease_factor, 2.5),
      interval_days: parseInteger(frontmatter.interval_days, 1),
      repetition: parseInteger(frontmatter.repetition, 0),
      lapses: parseInteger(frontmatter.lapses, 0),
      last_quality: typeof frontmatter.last_quality === 'number' && Number.isFinite(frontmatter.last_quality)
        ? Math.floor(frontmatter.last_quality)
        : null,
      assessed_at: frontmatter.assessed_at ? String(frontmatter.assessed_at) : null,
      last_reviewed_at: frontmatter.last_reviewed_at ? String(frontmatter.last_reviewed_at) : null,
      due_at: frontmatter.due_at ? String(frontmatter.due_at) : null,
    };

    const fp = computeFingerprint(content);
    cache.set(filePath, topic, fp);
    topics.push(topic);
  }

  return topics;
}


