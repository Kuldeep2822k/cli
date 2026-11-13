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
import { MAX_NOTE_SOURCE_BYTES, noteExceedsReadCap } from './source-cap';
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
 * The normalized view of a PALEE topic note that does not depend on its body.
 *
 * @remarks
 * Everything {@link LoadedTopic} carries except `content` (P3-06): the
 * metadata-only load path ({@link loadTopicMetadata}) returns this shape for
 * the read-only commands, which never read `.content`, so their scan costs one
 * bounded read of the frontmatter head per note instead of a full-body read
 * plus a SHA-256 pass. Field normalization is identical to the full load —
 * both paths build through {@link buildTopicMetadata}.
 */
export interface TopicMetadata extends TopicNode {
  /** Canonical topic ID (`palee_id`) */
  id: string;
  /** Topic title */
  title: string;
  /** Relative POSIX path from the vault root */
  path: string;
  /** Absolute filesystem path to the Markdown note */
  filePath: string;
  /** Parsed YAML frontmatter dictionary */
  frontmatter: Record<string, unknown>;
}

/**
 * Fully materialized in-memory representation of a PALEE topic note loaded from disk.
 */
export interface LoadedTopic extends TopicMetadata {
  /** Full raw Markdown text content */
  content: string;
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
  /**
   * Pre-parsed frontmatter keyed by absolute path (P3-07 parse sharing).
   *
   * @remarks
   * Single-read collection seam: when the caller has already parsed the
   * snapshot bytes it injects via `contents`, the loader reuses that verdict
   * for injected paths instead of YAML-parsing the same bytes a second time.
   * Entries are consulted only for paths whose bytes were snapshot-injected
   * — disk-read bytes always parse fresh, because a shared verdict may
   * predate the read. A path absent from the map parses exactly as before,
   * so a caller can withhold any verdict it does not vouch for
   * (collect-vault omits every note carrying a parse diagnostic).
   */
  parsedFrontmatter?: Map<string, Record<string, unknown> | null>;
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
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return Math.floor(parsed);
    }
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
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return Math.floor(parsed);
    }
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
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}


/**
 * Extracts the identity fields both load paths derive from a parsed frontmatter.
 *
 * @param frontmatter - Parsed YAML frontmatter, or `null` when the note has none
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param filePath - Absolute path to the Markdown note
 * @returns The narrowed frontmatter plus the trimmed `palee_id`, vault-relative
 *   POSIX path, and resolved title — or `null` when the note carries no usable
 *   `palee_id`
 *
 * @remarks
 * Shared verbatim by {@link loadTopics} and {@link loadTopicMetadata} so the
 * "is this a topic note" predicate and the title fallback cannot drift between
 * a full load and a metadata-only load. The narrowed `frontmatter` travels with
 * the identity so callers never re-narrow the nullable parse result.
 */
function resolveTopicIdentity(
  frontmatter: Record<string, unknown> | null,
  vaultPath: string,
  filePath: string
): { frontmatter: Record<string, unknown>; paleeId: string; relPath: string; title: string } | null {
  if (!frontmatter) return null;
  const rawId = frontmatter.palee_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  return {
    frontmatter,
    paleeId: rawId.trim(),
    relPath: relativeVaultPath(vaultPath, filePath),
    title: typeof frontmatter.title === 'string' && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : stemOfNote(path.basename(filePath)),
  };
}

/**
 * Normalizes a topic note's frontmatter into the shared {@link TopicMetadata} shape.
 *
 * @param identity - Identity fields from {@link resolveTopicIdentity}
 * @param filePath - Absolute filesystem path to the Markdown note
 * @returns The normalized metadata both load paths return
 *
 * @remarks
 * Single source of the normalization rules — fallbacks, score clamping, type
 * coercion, dependency parsing, SM-2 defaults — so a metadata-only load
 * observes exactly the field values the full load would for the same note.
 */
function buildTopicMetadata(
  identity: { frontmatter: Record<string, unknown>; paleeId: string; relPath: string; title: string },
  filePath: string
): TopicMetadata {
  const { frontmatter } = identity;
  const dependsOn = normalizeDependencies(frontmatter.depends_on, frontmatter.dependencies);
  const dependsOnSource = normalizeDependsOnSource(frontmatter.depends_on_source);

  return {
    palee_id: identity.paleeId,
    id: identity.paleeId,
    title: identity.title,
    path: identity.relPath,
    filePath,
    frontmatter,
    difficulty: normalizeDifficulty(frontmatter.difficulty),
    depends_on: dependsOn,
    // `TopicNode.depends_on_source` does not admit an explicit `undefined`
    // under `exactOptionalPropertyTypes`, so the key is omitted (not
    // undefined-valued) when the note declares no source. No consumer
    // distinguishes an absent key from an undefined one.
    ...(dependsOnSource === undefined ? {} : { depends_on_source: dependsOnSource }),
    topic_mastery: parseScore(frontmatter.topic_mastery, 0.0),
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
}

/**
 * Byte size of one window in the metadata read (P3-06).
 *
 * @remarks
 * {@link readFrontmatterSlice} stops at the first complete frontmatter block,
 * so a note with a normal frontmatter head costs a single windowed read no
 * matter how large its body is; a note whose frontmatter is longer simply
 * costs one window per 8 KiB of frontmatter.
 */
const METADATA_READ_WINDOW_BYTES = 8192;

/**
 * Reads only the head of a note up to the end of its frontmatter block.
 *
 * @param filePath - Absolute path to the Markdown note
 * @param maxBytes - Upper bound on bytes to pull (the stat'd file size; the
 *   read cap has already been applied by the caller)
 * @returns The text read so far, or `null` when the note cannot be opened or read
 *
 * @remarks
 * P3-06: the metadata-only load path must not pay for note bodies, so this
 * accumulates bounded windows until {@link parseFrontmatter}'s two fence shapes
 * are complete in the text read so far — the empty `---`/`---` block, or a
 * populated block closed by a `---` line — and stops there. The stop regexes
 * mirror `parseFrontmatter`'s anchored fence matches exactly (BOM stripped
 * first, `\r?\n` breaks, the first `\n---` wins), so the bytes this returns
 * always let `parseFrontmatter` reach the same `frontmatter` verdict a full
 * read would: a completed block stays completed in every longer prefix, and a
 * file with no closing fence is read to `maxBytes` (EOF for an under-cap
 * note), which parses exactly like the full read. A multi-byte character cut
 * by a window boundary only mangles the intermediate probe text — continuation
 * bytes decode to U+FFFD, never to ASCII bytes, so the probe can neither
 * invent nor miss a fence — while the final parse runs over the whole
 * accumulated buffer with the block intact.
 */
function readFrontmatterSlice(filePath: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const windowBytes = Math.min(METADATA_READ_WINDOW_BYTES, maxBytes - total);
      const buf = Buffer.alloc(windowBytes);
      const bytesRead = fs.readSync(fd, buf, 0, windowBytes, total);
      if (bytesRead <= 0) break; // EOF — return what we hold
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      const text = Buffer.concat(chunks).toString('utf8');
      const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      if (!/^---\r?\n/.test(stripped)) break; // no frontmatter at byte 0
      if (/^---\r?\n---(?:\r?\n)?/.test(stripped)) break; // empty fence block complete
      if (/^---\r?\n[\s\S]*?\r?\n---/.test(stripped)) break; // populated block complete
      if (bytesRead < windowBytes) break; // EOF before any closing fence
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing an already-vanished handle — nothing to recover.
      }
    }
  }
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
 * @param options - Optional loader options (`files`, `contents`,
 *   `parsedFrontmatter`, `cache`)
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
  const parsedFrontmatter = isOptions
    ? (arg as LoadTopicsOptions).parsedFrontmatter
    : undefined;
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
    // P3-07: on the snapshot path, a caller-supplied parse of these exact
    // bytes replaces the re-parse. Only injected bytes consult the map —
    // disk-read bytes must parse fresh (a shared verdict may predate the
    // read) — and an absent entry parses as before, so a caller can
    // withhold any verdict it does not vouch for (collect-vault omits
    // every note carrying a parse diagnostic).
    // P3-07: on the snapshot path, a caller-supplied parse of these exact
    // bytes replaces the re-parse. Only injected bytes consult the map —
    // disk-read bytes must parse fresh (a shared verdict may predate the
    // read) — and an absent entry parses as before, so a caller can
    // withhold any verdict it does not vouch for (collect-vault omits
    // every note carrying a parse diagnostic).
    const sharedFrontmatter = fromSnapshot
      ? parsedFrontmatter?.get(filePath)
      : undefined;
    const frontmatter =
      sharedFrontmatter !== undefined
        ? sharedFrontmatter
        : parseFrontmatter(content).frontmatter;

    const identity = resolveTopicIdentity(frontmatter, vaultPath, filePath);
    if (identity === null) {
      // Record the verdict for the next scan. Snapshot bytes are excluded for
      // the same reason topics are: they are not what the disk holds.
      if (!fromSnapshot) {
        nonTopicCache.set(filePath, NON_TOPIC, computeFingerprint(content));
      }
      continue;
    }

    const topic: LoadedTopic = {
      ...buildTopicMetadata(identity, filePath),
      content,
    };

    // Snapshot-injected content never enters the cache — only bytes read
    // from disk in THIS call are cache-worthy (see fromSnapshot above) —
    // and P3-07: it is never fingerprinted either, because the hash only
    // feeds the cache entry the snapshot branch skips.
    if (!fromSnapshot) {
      cache.set(filePath, topic, computeFingerprint(content));
    }
    topics.push(topic);
  }

  return topics;
}

/**
 * Options for {@link loadTopicMetadata}.
 */
export interface LoadTopicMetadataOptions {
  /** Pre-scanned array of absolute file paths (avoids duplicate vault walks) */
  files?: string[];
}

/**
 * Scans the vault and loads every topic note's metadata — everything
 * {@link loadTopics} normalizes, minus the body.
 *
 * @remarks
 * P3-06: `next`, `plan`, `dashboard` and `progress` never read a topic's
 * `.content`, yet the full load paid for every body twice — one
 * `readFileSync` of the whole note and one SHA-256 fingerprint over it. This
 * path reads only the frontmatter head ({@link readFrontmatterSlice}) and
 * hashes nothing, so a scan's IO is bounded by the frontmatter size rather
 * than the note size, while every field is normalized by the same helpers
 * ({@link resolveTopicIdentity}, {@link buildTopicMetadata}) — the returned
 * {@link TopicMetadata} values match {@link loadTopics}' field-for-field.
 *
 * Declines mirror the full load exactly: a note over `MAX_NOTE_SOURCE_BYTES`
 * is skipped stat-first and never opened (ADR-0018's documented decline), an
 * unreadable or vanished note is skipped silently, and a note without a
 * usable `palee_id` is not a topic.
 *
 * Deliberately uncached: a metadata entry would have to be fingerprinted on
 * its frontmatter slice, and `FileCache`'s freshness check validates by
 * re-reading the WHOLE file and re-hashing the full body — the exact IO this
 * path exists to avoid, on every hit inside the unsettled horizon. A bounded
 * slice read is already cheap enough that a cache buys nothing measurable,
 * and keeping the shared topic and non-topic caches exclusive to the full
 * load keeps their full-content fingerprints meaningful. Repeated in-process
 * metadata scans therefore re-read the head; correctness never depends on it.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param options - Optional loader options (`files`)
 * @returns Array of parsed and normalized {@link TopicMetadata} instances
 *
 * @example
 * ```typescript
 * const topics = loadTopicMetadata('/path/to/vault');
 * console.log(`Loaded ${topics.length} topic summaries`);
 * ```
 */
export function loadTopicMetadata(
  vaultPath: string,
  options?: LoadTopicMetadataOptions
): TopicMetadata[] {
  const scanFiles = options?.files ?? walkVault(vaultPath);
  const topics: TopicMetadata[] = [];

  for (const filePath of scanFiles) {
    let fileSize: number;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {
      continue; // Transient error or file deleted/locked by concurrent writer - skip gracefully
    }
    // Stat first (ADR-0018): the same read-cap decline as the full load —
    // the file is never opened, so an oversized document costs no IO.
    if (noteExceedsReadCap(fileSize)) {
      continue;
    }
    const slice = readFrontmatterSlice(filePath, fileSize);
    if (slice === null) continue;
    const { frontmatter } = parseFrontmatter(slice);
    const identity = resolveTopicIdentity(frontmatter, vaultPath, filePath);
    if (identity === null) continue;
    topics.push(buildTopicMetadata(identity, filePath));
  }

  return topics;
}


