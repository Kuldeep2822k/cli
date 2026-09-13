/**
 * Session Note Loader (#41/#42/#44 read path)
 *
 * @remarks
 * Storage-side single-read loader for the PALEE memory subsystem:
 * canonical session notes (`.palee/sessions/S-*.md` and
 * `DRAFT-S-*.md`), the derived session index (`.palee/index.md`),
 * and a tolerant hot-memory read (`.palee/hot.md`, delegated to
 * `readHotMemory`). All filesystem IO for session validation lives
 * here so rules stay pure — the same layering as `loader.ts` for
 * topics.
 *
 * The loader never throws on malformed notes: per-file parse
 * outcomes are preserved on `LoadedSession` so `valid-session-schema`
 * can report the defect while the rest of the vault is still
 * validated (one bad note = one finding, never a dead scan).
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './frontmatter';
import { relativeVaultPath } from './vault-walker';
import { readHotMemory } from './memory';

/**
 * A memory-subsystem component that could not be read during a scan.
 *
 * @remarks Component-level failures: the sessions directory could not
 * be enumerated, or `index.md`/`hot.md` exist but could not be read.
 * Distinct from a session note that failed to read (that failure is
 * retained on the {@link LoadedSession} entry). The validation
 * collector threads these into its context so the `read-failure`
 * rule can report the provisional snapshot.
 */
export interface MemoryReadError {
  /** Relative POSIX path of the component that failed to read */
  path: string;
  /** Read failure message */
  readError: string;
}

/**
 * A single session note read from `.palee/sessions/`, with its raw
 * parse outcome.
 *
 * @remarks `sessionId`/`isDraft` are derived from the FILENAME (the
 * only always-reliable signal when frontmatter is malformed or the
 * filename/ID disagree — which `valid-session-schema` reports
 * separately); `frontmatter` carries the raw parsed values, or null
 * when the YAML failed to parse (`parseError` says why).
 * `readError` is set when the file could not be read at all (locked
 * mid-scan, deleted concurrently) — the note stays in the list so
 * the collector's `readIncomplete` signal and a read-failure finding
 * can report the provisional snapshot; rules skip read-failed notes.
 */
export interface LoadedSession {
  /** Session ID derived from the filename (`S-…` / `DRAFT-S-…` stem) */
  sessionId: string;
  /** True when the filename marks the note as a draft checkpoint */
  isDraft: boolean;
  /** Relative POSIX path from the vault root (`.palee/sessions/…`) */
  path: string;
  /** Absolute filesystem path to the note */
  filePath: string;
  /** Raw parsed frontmatter; null when parsing failed or reading failed */
  frontmatter: Record<string, unknown> | null;
  /** Frontmatter parse error message; undefined when parsing succeeded */
  parseError?: string;
  /** Read failure message; undefined when the file read succeeded */
  readError?: string;
}

/**
 * The parsed derived session index (`.palee/index.md`).
 *
 * @remarks `missing` and `corrupt` carry `null` fields — the index is
 * a rebuildable projection, so absence is a state, not an error
 * (VERDICT decision 4); `refs` holds every session-shaped
 * `[[S-…]]`/`[[DRAFT-S-…]]` wikilink in body order, deduplicated, so
 * `valid-session-index` can check each against the confirmed-session
 * set. Non-session wikilinks (topic links, plain note titles) are
 * ignored — the index is editable Markdown and only session-shaped
 * links are index entries. `frontmatter` carries the parsed index
 * frontmatter (null when none) for the kind rule's conflict checks.
 */
export type SessionIndexRead =
  | { state: 'ok'; refs: string[]; frontmatter?: Record<string, unknown> | null }
  | { state: 'missing'; refs: null; frontmatter?: null }
  | { state: 'corrupt'; refs: null; frontmatter?: null; parseError: string };

/** Directory (relative to vault root) holding canonical session notes. */
const SESSIONS_DIR_SEGMENTS = ['.palee', 'sessions'];

/** Wikilink reference shape produced by `regenerateIndex`. */
const INDEX_REF_PATTERN = /\[\[([^\]]+)\]\]/g;

/**
 * Loads every session note (confirmed + draft) from the vault's
 * `.palee/sessions/` directory in one deterministic read pass.
 *
 * @remarks Files are visited in ascending filename order so findings
 * are deterministic regardless of OS readdir order. Notes that fail
 * to parse are returned (not skipped) with `frontmatter: null` and
 * `parseError` set — the schema rule reports them; unreadable files
 * are returned with `readError` set (the read-failure rule reports
 * them; the schema and downstream rules skip them) so a locked or
 * concurrently-deleted note never silently vanishes from the snapshot.
 * When the sessions directory does not exist, returns `[]` (an empty
 * memory subsystem is the fresh-vault state); a directory that EXISTS
 * but cannot be enumerated is reported through `readErrors`, never
 * silently treated as empty.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param readErrors - Collector-owned list to append component read failures to
 * @returns Session notes with parse outcomes, sorted by filename
 */
function loadSessions(
  vaultPath: string,
  readErrors: MemoryReadError[] = []
): LoadedSession[] {
  const sessionsDir = path.join(vaultPath, ...SESSIONS_DIR_SEGMENTS);
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return []; // no .palee/sessions yet — fresh vault, not an error
    }
    // The path exists but cannot be enumerated (ENOTDIR: something
    // replaced the directory with a file; EPERM/EACCES: permissions) —
    // existing-but-unreadable is never the same as absent, and the
    // caller's readErrors entry reports the provisional snapshot.
    readErrors.push({
      path: '.palee/sessions/',
      readError: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const sessions: LoadedSession[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue;
    const isDraft = file.startsWith('DRAFT-S-');
    const isConfirmed = file.startsWith('S-');
    // Stray non-session markdown in the sessions dir (backups, editor
    // droppage) is NOT canonical session data — excluded from the
    // loaded set here and never schema-judged. Only S-*/DRAFT-S-*
    // filenames are session notes; the stem is the ID signal.
    if (!isDraft && !isConfirmed) continue;

    const filePath = path.join(sessionsDir, file);
    const sessionId = file.slice(0, -'.md'.length);
    const relPath = relativeVaultPath(vaultPath, filePath);

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
      // Unreadable (locked mid-scan, deleted concurrently): the note
      // STAYS in the list with readError set — the collector threads
      // it into readIncomplete so the provisional scan is visible,
      // and rules skip read-failed notes. Silently dropping it would
      // hide the incomplete snapshot (Greptile P1 / Kilo CRITICAL).
      const readError = err instanceof Error ? err.message : String(err);
      sessions.push({
        sessionId,
        isDraft,
        path: relPath,
        filePath,
        frontmatter: null,
        readError,
      });
      continue;
    }

    const { frontmatter, error } = parseFrontmatter(content);
    const loaded: LoadedSession = {
      sessionId,
      isDraft,
      path: relPath,
      filePath,
      frontmatter: (frontmatter as Record<string, unknown> | null) ?? null,
      ...(error !== undefined ? { parseError: error } : {}),
    };
    sessions.push(loaded);
  }
  return sessions;
}

/**
 * Reads and classifies the derived session index
 * (`.palee/index.md`).
 *
 * @remarks Tolerant read: `missing` when the file does not exist
 * (fresh vault or not yet regenerated — a rebuildable projection's
 * absence is never an error), `corrupt` with the parser message when
 * its frontmatter cannot be parsed, `ok` with every deduplicated
 * session-shaped `[[S-…]]`/`[[DRAFT-S-…]]` wikilink in first-seen
 * order otherwise. Non-session wikilinks (`[[T-…]]` topic links,
 * plain note titles) are ignored — the index is editable Markdown
 * and only session-shaped links are index entries. A read failure on
 * an existing index (locked mid-scan, EISDIR) is appended to
 * `readErrors` and the read is classified `missing` — the index rule
 * never reports on it, the read-failure rule does.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param readErrors - Collector-owned list to append component read failures to
 * @returns Classified index read with references when parseable
 */
function readSessionIndex(
  vaultPath: string,
  readErrors: MemoryReadError[] = []
): SessionIndexRead {
  const indexPath = path.join(vaultPath, '.palee', 'index.md');
  let content: string;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Exists but unreadable — the provisional snapshot is reported
      // by the read-failure rule; the index rule sees a missing index
      // (a legal state it never reports on).
      readErrors.push({
        path: '.palee/index.md',
        readError: err instanceof Error ? err.message : String(err),
      });
    }
    return { state: 'missing', refs: null, frontmatter: null };
  }

  const { frontmatter, body, error } = parseFrontmatter(content);
  if (error !== undefined) {
    return { state: 'corrupt', refs: null, frontmatter: null, parseError: error };
  }

  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(INDEX_REF_PATTERN)) {
    const ref = match[1].trim();
    // Only session-shaped links are index entries; a topic link or a
    // hand-added note link in the editable body is not a session ref.
    if (ref.length === 0 || !(ref.startsWith('S-') || ref.startsWith('DRAFT-S-'))) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return {
    state: 'ok',
    refs,
    frontmatter: (frontmatter as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Convenience read of `.palee/hot.md` for validation consumers.
 *
 * @remarks Thin delegation to `readHotMemory` so consumers have one
 * import for the whole memory subsystem; classification semantics
 * (`ok` / `missing` / `no-frontmatter` / `corrupt` / `schema-invalid`)
 * stay owned by `memory.ts` (#130 read-state contract).
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @returns Tolerant hot-memory read
 */
function readHotMemoryForValidation(vaultPath: string) {
  return readHotMemory(vaultPath);
}

export {
  loadSessions,
  readSessionIndex,
  readHotMemoryForValidation,
};
