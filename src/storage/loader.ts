/**
 * Topic Loader
 *
 * @remarks
 * Centralized boundary for scanning, parsing, normalizing, and loading PALEE topics from an Obsidian vault.
 * Guarantees uniform fallback values, score clamping, type coercion, and dependency parsing across all CLI commands.
 */

import fs from 'fs';
import path from 'path';
import { walkVault, relativeVaultPath, stemOfNote } from './vault-walker';
import { computeFingerprint, parseFrontmatter } from './frontmatter';
import { FileCache } from './cache';
import { MAX_NOTE_SOURCE_BYTES } from './source-cap';
import { normalizeDependencies } from './dependencies';
import { TopicNode, normalizeDifficulty, normalizeAssessedAt, normalizeDependsOnSource } from '../types';

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
 * Cached verdict for a file that is not a PALEE topic note.
 *
 * @remarks
 * `FileCache.get` returns `T | null` where `null` already means "not cached",
 * so a negative verdict needs its own value shape — a marker object the loader
 * recognizes — rather than a falsy payload (Issue #331).
 */
export interface NonTopicNote {
  /** Discriminant: this path was parsed and carries no usable `palee_id` */
  readonly palee_non_topic: true;
}

/** Single shared marker payload: the path is the state, the value never varies. */
const NON_TOPIC: NonTopicNote = { palee_non_topic: true };

/**
 * Cap on negatively cached non-topic verdicts (Issue #331).
 *
 * @remarks
 * Non-topic markers live in their own {@link FileCache} rather than sharing the
 * topic cache, because topic lookups must keep their hit rate: in a vault of
 * several thousand ordinary notes, markers written into the topic cache would
 * push every real topic past `MAX_CACHE_ENTRIES` on each scan and turn the fix
 * into a re-parse of the topics it was meant to protect. Separating the caches
 * bounds the markers on their own cap and leaves topic eviction exactly as it
 * was. Markers hold no content — path, `mtime`, `size` and a fingerprint each —
 * so the cap costs well under a megabyte of resident state.
 */
export const MAX_NON_TOPIC_CACHE_ENTRIES = 2000;

/** Module-level negative cache: paths known not to be topic notes */
const nonTopicCache = new FileCache<NonTopicNote>(MAX_NON_TOPIC_CACHE_ENTRIES);

/**
 * Returns the module-level negative ("not a topic") cache.
 *
 * @returns FileCache instance holding non-topic verdicts
 * @remarks
 * Companion of {@link getTopicCache} for Issue #331: it exists so a caller or a
 * test can inspect and clear the negative half of the loader's state. Entries
 * are fingerprint/mtime-validated exactly like topic entries, so an edited file
 * that gains a `palee_id` is loaded on the next pass without any clearing.
 * Unlike the topic cache, it is never injected per call: a snapshot-injected
 * load (`{ contents }`) reads bytes the disk does not have, so it neither reads
 * nor writes either cache.
 */
export function getNonTopicCache(): FileCache<NonTopicNote> {
  return nonTopicCache;
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
 * Coerces an input value into an integer, or `null` when it is not a finite number.
 *
 * @remarks
 * Mirrors {@link parseInteger}'s coercion (finite check, string parsing, flooring)
 * but preserves the optional SM-2 "no value yet" state as `null` instead of a numeric
 * fallback. Quoted YAML numbers (`last_quality: "4"`) therefore parse the same way the
 * sibling integer fields (`interval_days`, `repetition`, `lapses`) already accept them.
 *
 * @param val - Numeric input
 * @returns Integer value, or `null` if the value cannot be parsed into a finite integer
 *
 * @example
 * ```typescript
 * parseOptionalInteger(4.8);   // 4
 * parseOptionalInteger('4');   // 4
 * parseOptionalInteger('bad'); // null
 * parseOptionalInteger(null);  // null
 * ```
 */
function parseOptionalInteger(val: unknown): number | null {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
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
 * Two bounds keep a repeated load cheap:
 * - Non-topic verdicts are negatively cached by path in
 *   {@link getNonTopicCache}, fingerprint-validated like every other entry, so
 *   an ordinary note costs one `stat` rather than a read plus a YAML parse on
 *   each scan (#331).
 * - A file larger than `MAX_NOTE_SOURCE_BYTES` is declined stat-first and never
 *   read (#332); `scanNotes` reports the same decline as a per-file diagnostic.
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
    // observe the same content even under concurrent edits. Injected
    // content must never enter the cache: it is snapshot truth, not
    // on-disk truth, and a cached injected value would poison later
    // non-snapshot loads against the file's real bytes.
    const injected = contents?.get(filePath);
    let content: string;
    let fromSnapshot = false;
    if (injected !== undefined) {
      content = injected;
      fromSnapshot = true;
    } else {
      const cached = cache.get(filePath);
      if (cached) {
        topics.push(cached);
        continue;
      }

      // Negative cache (#331): a path already known not to be a topic note.
      // The hit costs one `stat`, not a read plus a YAML parse, so scan cost
      // tracks the topic count instead of the total vault size.
      if (nonTopicCache.get(filePath)) {
        continue;
      }

      try {
        // Stat first (#332): a document over the shared read cap is never
        // loaded — an exported log or generated index in the vault is not a
        // note, and reading it whole on every scan made scan cost unbounded.
        // The scan path reports the same decline as a per-file diagnostic;
        // here the file simply is not a topic, exactly as an unreadable one is
        // not, so the skip is silent by design.
        if (fs.statSync(filePath).size > MAX_NOTE_SOURCE_BYTES) {
          continue;
        }
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue; // Transient error or file deleted/locked by concurrent writer - skip gracefully
      }
    }
    const { frontmatter } = parseFrontmatter(content);

    if (!frontmatter || typeof frontmatter.palee_id !== 'string' || !frontmatter.palee_id.trim()) {
      // Record the verdict for the next scan. Snapshot bytes are excluded for
      // the same reason topics are: they are not what the disk holds.
      if (!fromSnapshot) {
        nonTopicCache.set(filePath, NON_TOPIC, computeFingerprint(content));
      }
      continue;
    }

    const paleeId = frontmatter.palee_id.trim();
    const relPath = relativeVaultPath(vaultPath, filePath);
    const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : stemOfNote(path.basename(filePath));

    const dependsOn = normalizeDependencies(frontmatter.depends_on, frontmatter.dependencies);
    const dependsOnSource = normalizeDependsOnSource(frontmatter.depends_on_source);

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
      depends_on_source: dependsOnSource,
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
      last_quality: parseOptionalInteger(frontmatter.last_quality),
      assessed_at: normalizeAssessedAt(frontmatter.assessed_at),
      last_reviewed_at: frontmatter.last_reviewed_at ? String(frontmatter.last_reviewed_at) : null,
      due_at: frontmatter.due_at ? String(frontmatter.due_at) : null,
    };

    const fp = computeFingerprint(content);
    // Snapshot-injected content never enters the cache — only bytes read
    // from disk in THIS call are cache-worthy (see fromSnapshot above).
    if (!fromSnapshot) {
      cache.set(filePath, topic, fp);
    }
    topics.push(topic);
  }

  return topics;
}


