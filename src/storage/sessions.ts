/**
 * Session Notes — Loader and Canonical Writers
 *
 * @remarks
 * The canonical-session half of the memory subsystem: everything about the
 * notes in `.palee/sessions/S-*.md` and `DRAFT-S-*.md`. The loader half
 * (#41/#42/#44 read path) is the storage-side single-read pass for the PALEE
 * memory subsystem: canonical session notes, the derived session index
 * (`.palee/index.md`), and a tolerant hot-memory read (`.palee/hot.md`,
 * delegated to `readHotMemory`). All filesystem IO for session validation
 * lives here so rules stay pure — the same layering as `loader.ts` for
 * topics. The writer half holds the canonical note's lifecycle: id minting,
 * the OCC-guarded save, the locked delete, and the completed-session probe.
 *
 * The loader never throws on malformed notes: per-file parse
 * outcomes are preserved on `LoadedSession` so `valid-session-schema`
 * can report the defect while the rest of the vault is still
 * validated (one bad note = one finding, never a dead scan).
 *
 * P3-14 (#565): the writer half was extracted from `src/storage/memory.ts`,
 * which now re-exports this module's surface unchanged. The hot/index and
 * active-session state lives in `./hot-index`, the draft checkpoints in
 * `./drafts`, and the shared `.palee` tree guards in `./palee-dirs`.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { atomicWrite, isConflictError } from './atomic-write';
import { Lock } from './lock';
import { relativeVaultPath } from './vault-walker';
import { getSessionsDir } from './palee-dirs';
import { readHotMemory } from './hot-index';
import { CompletedSessionRecord } from '../types';

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
 * (ADR-0008 decision 4); `refs` holds every session-shaped
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
    // Group 1 requires at least one character, so a match always fills it;
    // the guard keeps the type honest rather than asserting it.
    const rawRef = match[1];
    if (rawRef === undefined) continue;
    const ref = rawRef.trim();
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

/**
 * Generates a unique canonical session identifier with timestamp and random entropy.
 *
 * @returns Session ID string formatted as `S-YYYYMMDDTHHMMSS-XXXXXXXX`
 * @remarks Formats UTC timestamp segments and appends 4 bytes of random hex entropy.
 * The timestamp only carries whole seconds, so the entropy alone separates two
 * sessions started in the same second — and a repeated ID is not cosmetic:
 * `writeSessionNote` takes the OCC fingerprint from the *target* file, so a
 * collision satisfies its own check and `renameSync` silently replaces the
 * earlier session note. `generateDraftId` already draws 4 bytes for the same reason.
 * @example
 * ```typescript
 * const id = generateSessionId(); // "S-20260823T153000-a1b2c3d4"
 * ```
 */
export function generateSessionId(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const timestamp = `${year}${month}${day}T${hours}${minutes}${seconds}`;
  const random = crypto.randomBytes(4).toString('hex');
  return `S-${timestamp}-${random}`;
}

/**
 * Saves a completed study session note with frontmatter metadata to `.palee/sessions/S-*.md`.
 *
 * @param vaultPath - Absolute path to Obsidian vault root
 * @param sessionData - Session metadata (ID, topic ID, timestamps)
 * @param bodyContent - Markdown note body written during study
 * @returns Absolute path to the saved session note
 * @remarks Captures existing note fingerprint for optimistic concurrency control (OCC).
 * @example
 * ```typescript
 * const notePath = await writeSessionNote('/vault', {
 *   session_id: 'S-20260830T100000-abcd1234',
 *   topic_id: 'topic-math',
 *   started_at: '2026-08-30T10:00:00Z',
 *   ended_at: '2026-08-30T10:30:00Z',
 *   duration_minutes: 30,
 * }, 'Note body');
 * ```
 */
export async function writeSessionNote(
  vaultPath: string,
  sessionData: Omit<CompletedSessionRecord, 'palee_schema' | 'status'>,
  bodyContent: string
): Promise<string> {
  const sessionsDir = getSessionsDir(vaultPath);
  const filePath = path.join(sessionsDir, `${sessionData.session_id}.md`);

  const fullData: CompletedSessionRecord = {
    palee_schema: 1,
    ...sessionData,
    status: 'completed',
  };

  const frontmatterObj: Record<string, unknown> = {
    palee_schema: fullData.palee_schema,
    session_id: fullData.session_id,
    topic_id: fullData.topic_id,
    started_at: fullData.started_at,
    ended_at: fullData.ended_at,
    status: fullData.status,
  };
  if (fullData.duration_minutes !== undefined) {
    frontmatterObj.duration_minutes = fullData.duration_minutes;
  }
  const content = updateFrontmatter(`# Session: ${fullData.session_id}\n\n${bodyContent.trim()}`, frontmatterObj);
  let expectedFingerprint: string | null = null;
  // Absence is an expectation the write carries, not a null fingerprint: a null
  // fingerprint skipped `atomicWrite`'s whole OCC block, so a concurrent creator's
  // fresh file was overwritten with no conflict (#327).
  let expectExists = true;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(filePath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectExists = false;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, filePath, content, expectedFingerprint, { expectExists });
  return filePath;
}

/** Returns true when a completed session note with the supplied ID exists. */
export function hasCompletedSession(vaultPath: string, sessionId: string): boolean {
  if (!/^S-[\w-]+$/.test(sessionId)) return false;
  const sessionPath = path.join(getSessionsDir(vaultPath), `${sessionId}.md`);
  try {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(sessionPath, 'utf8'));
    return frontmatter?.session_id === sessionId && frontmatter.status === 'completed';
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Safely unlinks a completed session note or draft checkpoint file within `.palee/sessions/`.
 *
 * @param vaultPath - Vault root path
 * @param targetPath - Path to the session note or draft file
 * @returns `true` when the target is gone (unlinked here, or already absent),
 *   `false` when the unlink was skipped because another live process holds the
 *   target's lock
 * @remarks Validates that the target path does not escape `.palee/sessions/` directory.
 * The unlink runs under the target's lock — the same one `atomicWrite` on this file
 * takes — so it cannot pull the file out from under a concurrent writer mid-rename
 * (#565 P3-02). A live lock is not an error: like `clearActiveSession`, the unlink
 * is skipped and the target left for whoever holds it, reported to the caller as
 * not-deleted rather than thrown.
 * @example
 * ```typescript
 * if (!deleteSessionNote('/vault', '/vault/.palee/sessions/DRAFT-S-1.md')) {
 *   console.warn('Draft is locked by another process; left in place.');
 * }
 * ```
 */
export function deleteSessionNote(vaultPath: string, targetPath: string): boolean {
  const sessionsDir = getSessionsDir(vaultPath);
  const resolvedSessions = fs.realpathSync(sessionsDir);
  let resolvedTarget: string;
  if (fs.existsSync(targetPath)) {
    resolvedTarget = fs.realpathSync(targetPath);
  } else {
    const parentDir = path.dirname(targetPath);
    const resolvedParent = fs.existsSync(parentDir) ? fs.realpathSync(parentDir) : path.resolve(parentDir);
    resolvedTarget = path.join(resolvedParent, path.basename(targetPath));
  }

  // Boundary check: ensure target is within .palee/sessions/
  if (!resolvedTarget.startsWith(resolvedSessions + path.sep) && resolvedTarget !== resolvedSessions) {
    throw new Error(`Security error: Cannot delete session file outside sessions directory: ${targetPath}`);
  }

  // The unlink takes the target's lock: a concurrent `atomicWrite` on this same
  // file holds it across its temp-write and rename, and an unguarded unlink raced
  // that rename — surfacing EPERM/EBUSY on Windows or deleting the file the writer
  // was about to replace. Contentions yield like `clearActiveSession`/`resetHotMemory`:
  // a live writer re-creating the target is exactly when deleting it is wrong.
  const lock = new Lock(vaultPath, resolvedTarget);
  let lockAcquired = false;
  try {
    try {
      lock.acquireSync();
      lockAcquired = true;
    } catch (err: unknown) {
      if (isConflictError(err)) return false;
      throw err;
    }
    try {
      if (fs.existsSync(resolvedTarget)) {
        fs.unlinkSync(resolvedTarget);
      }
      return true;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code !== 'ENOENT') throw err;
      return true;
    }
  } finally {
    if (lockAcquired) {
      lock.release();
    }
  }
}

export {
  loadSessions,
  readSessionIndex,
  readHotMemoryForValidation,
};
