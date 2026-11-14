/**
 * PALEE Hot Memory, Session Index and Active-Session Marker
 *
 * @remarks
 * The working-state half of the memory subsystem — everything that lives at
 * the top of `.palee/` rather than inside `.palee/sessions/`:
 *
 * - **Working Memory**: `.palee/hot.md` (capped at 250 words of recent active
 *   context), read tolerantly and rebuilt by {@link rebuildHotAndIndex}.
 * - **Session Index**: `.palee/index.md` listing chronological study sessions.
 * - **Active-Session Marker**: `.palee/active-session.md`, the canonical
 *   in-progress session state — owned here because {@link rebuildHotAndIndex}
 *   is the reader that reconciles it with the derived views, and owning it
 *   here keeps `sessions.ts` (the canonical-note writer) free of any
 *   hot/index import.
 *
 * Extracted from `src/storage/memory.ts` by the P3-14 phase split (#565);
 * `memory.ts` re-exports this module's surface unchanged. The canonical
 * session notes and the draft checkpoints live in `./sessions` and
 * `./drafts`; the shared `.palee` tree guards live in `./palee-dirs`.
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { atomicWrite, isConflictError } from './atomic-write';
import { Lock } from './lock';
import { getPaleeDir, getSessionsDir } from './palee-dirs';
import { SUPPORTED_SCHEMA_VERSION } from '../engine/topic-id';
import { HotMemoryData, ActiveSessionData, SessionRecord, NodeError } from '../types';

/**
 * Maximum number of words retained in the active working memory (`hot.md`) summary body.
 *
 * @remarks Reserved for valid-hot-memory validation rule (#43) enforcing word count against the 250-word cap.
 */
export const MAX_HOT_WORDS = 250;

/** Extracts the session ID stem from a session filename or path. */
const sessionStem = (p: string): string => path.basename(p, '.md');

/**
 * Read outcome for `.palee/hot.md`, distinguishing why frontmatter is unavailable.
 *
 * @remarks
 * - `ok`: parsed frontmatter carries the supported schema version (`palee_schema: 1`).
 * - `schema-invalid`: parsed frontmatter lacks `palee_schema` or carries an unsupported
 *   version (tolerant fields still exposed).
 * - `no-frontmatter`: no parsable frontmatter block (absent or empty fences).
 * - `corrupt`: frontmatter delimiters present but YAML failed to parse.
 * - `missing`: file does not exist (`ENOENT`).
 */
export type HotMemoryReadState =
  | 'ok'
  | 'missing'
  | 'no-frontmatter'
  | 'corrupt'
  | 'schema-invalid';

/**
 * Tolerant read result for `.palee/hot.md`.
 *
 * @remarks
 * Fields are best-effort partial views for legacy/foreign files; callers apply
 * their own session policy. Unknown keys are ignored, never rejected.
 */
export interface HotMemoryRead {
  state: HotMemoryReadState;
  frontmatter: Partial<HotMemoryData> | null;
  body: string;
}

/**
 * Reads and classifies `.palee/hot.md` without applying any session policy.
 *
 * @param vaultPath - Vault root path
 * @returns Tolerant read result with classification state, partial frontmatter, and body
 * @remarks
 * `ENOENT` maps to `missing`; other filesystem errors are thrown so existing
 * callers keep deciding whether to swallow them. Parser errors map to `corrupt`.
 * Does not rebuild files, mutate state, or print output.
 * @example
 * ```typescript
 * const read = readHotMemory('/vault');
 * if (read.state === 'ok') console.log(read.frontmatter?.active_topic);
 * ```
 */
export function readHotMemory(vaultPath: string): HotMemoryRead {
  // Direct path join: a read must never create the .palee directory (no getPaleeDir here)
  const hotPath = path.join(vaultPath, '.palee', 'hot.md');
  let content: string;
  try {
    content = fs.readFileSync(hotPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing', frontmatter: null, body: '' };
    }
    throw err;
  }

  const { frontmatter, body, error } = parseFrontmatter(content);
  if (error) {
    return { state: 'corrupt', frontmatter: null, body };
  }
  if (!frontmatter) {
    return { state: 'no-frontmatter', frontmatter: null, body };
  }
  if (frontmatter.palee_schema !== 1) {
    return { state: 'schema-invalid', frontmatter: frontmatter as Partial<HotMemoryData>, body };
  }
  return { state: 'ok', frontmatter: frontmatter as Partial<HotMemoryData>, body };
}

/**
 * Resolves the active topic from a hot-memory read.
 *
 * @param read - Result of {@link readHotMemory}
 * @returns Trimmed active topic ID, or null when absent, blank, `(none)`, or unparsable
 * @example
 * ```typescript
 * const topic = resolveActiveTopic(readHotMemory('/vault'));
 * ```
 */
export function resolveActiveTopic(read: HotMemoryRead): string | null {
  const fm = read.frontmatter;
  if (fm && typeof fm.active_topic === 'string') {
    const active = fm.active_topic.trim();
    if (active.length > 0 && active.toLowerCase() !== '(none)') {
      return active;
    }
  }
  return null;
}

/**
 * Truncates text to a maximum word count, appending an ellipsis if trimmed.
 *
 * @param text - Input string to truncate
 * @param maxWords - Upper bound on word count (e.g. 250)
 * @returns Truncated string with trailing `...` if truncated
 * @remarks Splits text on whitespace and joins up to maxWords words.
 * Reserved for valid-hot-memory validation rule (#43) enforcing word count against the 250-word cap.
 * @example
 * ```typescript
 * const truncated = truncateWords('One two three four', 2); // "One two..."
 * ```
 */
export function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Counts whitespace-delimited words in a string.
 *
 * @param text - Input text
 * @returns Number of words
 * @remarks Returns 0 for empty or whitespace-only input strings.
 * Reserved for valid-hot-memory validation rule (#43) enforcing word count against the 250-word cap.
 * @example
 * ```typescript
 * const count = countWords('Study notes for machine learning'); // 5
 * ```
 */
export function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Formats a Date object into a local-time date string (`YYYY-MM-DD`).
 *
 * @param date - Date to format
 * @returns Date string formatted as `YYYY-MM-DD` in local timezone
 * @remarks
 * Uses local-time getters (`getFullYear`, `getMonth`, `getDate`) intentionally,
 * as this formats display-oriented fields (`updated_at`) reflecting the user's calendar date.
 * Session IDs use UTC via `generateSessionId` for cross-timezone uniqueness.
 * @example
 * ```typescript
 * const formatted = formatDateOnly(new Date('2026-08-30T10:00:00Z')); // "2026-08-30" (in UTC+0)
 * ```
 */
export function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Writes or updates the active working memory file (`.palee/hot.md`).
 *
 * @remarks
 * Summary body is capped at 250 words and frontmatter tracks `last_session`, `active_topic`, `started_at`, and `updated_at`.
 *
 * @param vaultPath - Vault root path
 * @param lastSessionId - ID of latest completed session or null
 * @param activeTopicId - ID of currently active topic or null
 * @param summaryBody - Notes text to distill into hot memory
 * @param startedAt - ISO timestamp when the active topic session started or null
 * @returns Absolute path to `hot.md`
 * @example
 * ```typescript
 * const hotPath = await updateHotMemory('/vault', 'S-1', 'topic-1', 'Active study notes', '2026-08-30T10:00:00Z');
 * ```
 */
export async function updateHotMemory(
  vaultPath: string,
  lastSessionId: string | null,
  activeTopicId: string | null,
  summaryBody: string,
  startedAt: string | null = null
): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const hotPath = path.join(paleeDir, 'hot.md');

  const truncatedBody = truncateWords(summaryBody, MAX_HOT_WORDS);

  const hotData: HotMemoryData = {
    palee_schema: 1,
    memory_id: 'H-active',
    last_session: lastSessionId,
    active_topic: activeTopicId,
    started_at: startedAt,
    updated_at: formatDateOnly(new Date()),
  };

  const frontmatterObj: Record<string, unknown> = {
    palee_schema: hotData.palee_schema,
    memory_id: hotData.memory_id,
    last_session: hotData.last_session,
    active_topic: hotData.active_topic,
    started_at: hotData.started_at,
    updated_at: hotData.updated_at,
  };

  const content = updateFrontmatter(truncatedBody, frontmatterObj);
  let expectedFingerprint: string | null = null;
  // Absence is an expectation the write carries, not a null fingerprint — a null
  // fingerprint disabled `atomicWrite`'s OCC block entirely, so two concurrent
  // `session start` invocations each expecting no `hot.md` let the loser silently
  // overwrite the winner's just-created file (#327).
  let expectExists = true;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(hotPath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectExists = false;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, hotPath, content, expectedFingerprint, { expectExists });
  return hotPath;
}

/** Reads the canonical in-progress session marker, or null when no session is active. */
export function readActiveSession(vaultPath: string): ActiveSessionData | null {
  const statePath = path.join(vaultPath, '.palee', 'active-session.md');
  try {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(statePath, 'utf8'));
    if (!frontmatter || frontmatter.palee_schema !== 1) return null;
    if (
      typeof frontmatter.session_id !== 'string' ||
      typeof frontmatter.topic_id !== 'string' ||
      typeof frontmatter.started_at !== 'string'
    ) return null;
    return {
      palee_schema: 1,
      session_id: frontmatter.session_id,
      topic_id: frontmatter.topic_id,
      started_at: frontmatter.started_at,
      updated_at: typeof frontmatter.updated_at === 'string' ? frontmatter.updated_at : '',
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes the canonical in-progress session marker used for active-session recovery. */
export async function writeActiveSession(
  vaultPath: string,
  session: Pick<ActiveSessionData, 'session_id' | 'topic_id' | 'started_at'>
): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const statePath = path.join(paleeDir, 'active-session.md');
  const content = updateFrontmatter('# Active Session\n', {
    palee_schema: 1,
    session_id: session.session_id,
    topic_id: session.topic_id,
    started_at: session.started_at,
    updated_at: formatDateOnly(new Date()),
  });
  let expectedFingerprint: string | null = null;
  let expectExists = true;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(statePath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') expectExists = false;
    else throw err;
  }
  await atomicWrite(vaultPath, statePath, content, expectedFingerprint, { expectExists });
  return statePath;
}

/**
 * Removes the canonical in-progress marker after the session is recorded.
 *
 * @remarks
 * The unlink runs under the marker's target lock — the same one
 * `writeActiveSession`'s `atomicWrite` takes. A lock held by a live writer is
 * not an error here: the clear is skipped and a later `session end` re-clears
 * through the already-recorded path.
 */
export async function clearActiveSession(vaultPath: string): Promise<void> {
  // `getPaleeDir`, not a bare `path.join` (#544): with `.palee` planted as a
  // junction the unguarded `unlinkSync` deleted the marker outside the vault.
  // The containment assertion runs before the `mkdirSync` and before the `Lock`
  // is constructed, so a planted link is refused without creating anything.
  const paleeDir = getPaleeDir(vaultPath);
  const statePath = path.join(paleeDir, 'active-session.md');

  // The marker is an `atomicWrite` target, so the unlink takes the same target
  // lock (#544): lockless it raced a concurrent `session start` mid-rename —
  // resurrecting the marker after `end` reported success, or surfacing
  // EPERM/EBUSY on Windows. Contentions yield like `resetHotMemory`: a live
  // writer is re-creating the marker, which is exactly when clearing it would
  // be wrong.
  const lock = new Lock(vaultPath, statePath);
  let lockAcquired = false;
  try {
    try {
      await lock.acquire();
      lockAcquired = true;
    } catch (err: unknown) {
      if (isConflictError(err)) return;
      throw err;
    }
    try {
      fs.unlinkSync(statePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  } finally {
    if (lockAcquired) {
      lock.release();
    }
  }
}

/**
 * Safely resets or deletes the active working memory file (`.palee/hot.md`).
 *
 * @param vaultPath - Vault root path
 * @returns Absolute path to `hot.md`
 * @remarks Deletes `hot.md` if it exists, ignoring missing file errors. The unlink
 * is taken under the same target lock every other `hot.md` mutation goes through,
 * so it cannot pull the file out from under a concurrent `atomicWrite` mid-rename.
 * A lock held by another live process is not an error here: the reset is skipped
 * and the caller's rebuild writes the replacement through that lock.
 * @example
 * ```typescript
 * await resetHotMemory('/vault');
 * ```
 */
export async function resetHotMemory(vaultPath: string): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const hotPath = path.join(paleeDir, 'hot.md');

  // Contention must not escape as `ECONFLICT`: this is the recovery step for a
  // corrupt `hot.md`, and INV-45 requires that path to rebuild rather than fail.
  // A live lock means some other process is maintaining the file right now, which
  // is the healthy case, so the reset yields and `rebuildHotAndIndex` — the only
  // caller's next statement — overwrites it under the same lock. Letting the error
  // through would turn a recoverable vault into exit 4.
  const lock = new Lock(vaultPath, hotPath);
  let lockAcquired = false;
  try {
    try {
      await lock.acquire();
      lockAcquired = true;
    } catch (e: unknown) {
      if (isConflictError(e)) return hotPath;
      throw e;
    }

    if (fs.existsSync(hotPath)) {
      try {
        fs.unlinkSync(hotPath);
      } catch (e: unknown) {
        const err = e as NodeError;
        if (err.code !== 'ENOENT') throw err;
      }
    }
  } finally {
    if (lockAcquired) {
      lock.release();
    }
  }

  return hotPath;
}

/**
 * The draft gate both derived views apply: a session file that carries a
 * `session_id` which is not a `DRAFT-*` placeholder and is not `status: draft`.
 *
 * @remarks
 * Extracted so `regenerateIndex` and `rebuildHotAndIndex` cannot drift apart on
 * what history is (ADR-0019). A note failing this is not a candidate at all, so
 * it is never counted as skipped either: an in-progress draft is not a session
 * the learner lost.
 */
function isSessionCandidate(
  frontmatter: Record<string, unknown> | null
): frontmatter is Record<string, unknown> {
  return (
    frontmatter !== null &&
    Boolean(frontmatter.session_id) &&
    !String(frontmatter.session_id).startsWith('DRAFT-') &&
    frontmatter.status !== 'draft'
  );
}

/**
 * The eligibility predicate both derived views apply to a confirmed session:
 * {@link isSessionCandidate} plus the strict `palee_schema` gate.
 *
 * @remarks
 * `hot.md` and `index.md` are two views of one rebuild pass, so a session the
 * index refuses to list must not be the `last_session` hot memory points at
 * (#542). The schema check mirrors `readHotMemory` (#361): an unknown or missing
 * `palee_schema` is never coerced to 1.
 */
function isConfirmedSession(
  frontmatter: Record<string, unknown> | null
): frontmatter is Record<string, unknown> {
  return isSessionCandidate(frontmatter) && frontmatter.palee_schema === SUPPORTED_SCHEMA_VERSION;
}

/**
 * Rebuilds `.palee/index.md` listing all confirmed study sessions in reverse chronological order.
 *
 * @param vaultPath - Vault root path
 * @returns Absolute path to `index.md`
 * @remarks Reads all confirmed session files and aggregates them into a markdown index with frontmatter.
 * @example
 * ```typescript
 * const indexPath = await regenerateIndex('/vault');
 * ```
 */
export async function regenerateIndex(vaultPath: string): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const indexPath = path.join(paleeDir, 'index.md');
  const sessionsDir = getSessionsDir(vaultPath);

  const sessions: (SessionRecord & { fileStem: string })[] = [];
  // Confirmed sessions skipped because they could not be read or carry an
  // unsupported schema. Surfaced in the report so `Total Sessions` no longer
  // silently undercounts reality (#361, #362).
  let skippedCount = 0;
  if (fs.existsSync(sessionsDir)) {
    // Ascending filename order, as `loadSessions` already uses: two sessions that
    // share a `started_at` must be listed in the same order on every OS, not in
    // whatever order readdir returns them.
    const files = fs.readdirSync(sessionsDir).sort();
    for (const file of files) {
      if (file.startsWith('S-') && file.endsWith('.md')) {
        const filePath = path.join(sessionsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0) {
            continue;
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const { frontmatter, error } = parseFrontmatter(content);
          // Corrupt frontmatter on a non-empty S- file: a session we cannot
          // read. Count it rather than dropping it silently (#362).
          if (error) {
            skippedCount++;
            continue;
          }
          if (isSessionCandidate(frontmatter)) {
            // Strict schema gate mirroring readHotMemory (#361): do not coerce
            // an unknown/missing palee_schema to 1. Skip and count instead.
            if (!isConfirmedSession(frontmatter)) {
              skippedCount++;
              continue;
            }
            sessions.push({
              palee_schema: frontmatter.palee_schema as number,
              session_id: frontmatter.session_id as string,
              topic_id: (frontmatter.topic_id as string) || 'unknown',
              started_at: (frontmatter.started_at as string) || '',
              ended_at: (frontmatter.ended_at as string) || '',
              status: 'completed',
              // The wikilink ref must be the filename stem, not
              // frontmatter.session_id: the session loader derives IDs from the
              // filename (the only reliable signal when the two disagree), and
              // valid-session-index checks refs against that ID space (#359).
              fileStem: sessionStem(file),
            });
          }
        } catch {
          // Unreadable session file (IO error). Count it so the total does not
          // silently undercount, but never delete or mutate session files
          // during index rebuild (#362).
          skippedCount++;
        }
      }
    }
  }

  // Sort newest first with NaN protection
  sessions.sort((a, b) => {
    const timeA = a.started_at ? new Date(a.started_at).getTime() : 0;
    const timeB = b.started_at ? new Date(b.started_at).getTime() : 0;
    const safeA = Number.isNaN(timeA) ? 0 : timeA;
    const safeB = Number.isNaN(timeB) ? 0 : timeB;
    return safeB - safeA;
  });

  let indexBody = '# PALEE Session Index\n\n';
  if (sessions.length === 0) {
    indexBody += 'No confirmed sessions recorded.\n';
  } else {
    indexBody += `Total Sessions: ${sessions.length}\n\n`;
    for (const s of sessions) {
      const dateStr = s.started_at ? s.started_at.split('T')[0] : 'Unknown date';
      indexBody += `- [[${s.fileStem}]] - Topic: ${s.topic_id} (${dateStr})\n`;
    }
  }
  if (skippedCount > 0) {
    indexBody += `\nSkipped (unreadable or unsupported schema): ${skippedCount}\n`;
  }

  const frontmatterObj: Record<string, unknown> = {
    palee_schema: 1,
    type: 'session_index',
    updated_at: formatDateOnly(new Date()),
  };

  const content = updateFrontmatter(indexBody, frontmatterObj);
  let expectedFingerprint: string | null = null;
  // Same modelling as `updateHotMemory`: a missing `index.md` is an expectation of
  // absence, so a concurrent rebuild that created it in the meantime conflicts
  // instead of being overwritten (#327).
  let expectExists = true;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(indexPath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectExists = false;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, indexPath, content, expectedFingerprint, { expectExists });
  return indexPath;
}

/**
 * Re-scans all session files on disk and rebuilds both `hot.md` and `index.md`.
 *
 * @param vaultPath - Vault root path
 * @returns Promise resolving when rebuilding completes
 * @remarks Finds the newest completed session file and generates active hot memory and session index.
 * @example
 * ```typescript
 * await rebuildHotAndIndex('/vault');
 * ```
 */
export async function rebuildHotAndIndex(vaultPath: string): Promise<void> {
  const sessionsDir = getSessionsDir(vaultPath);
  let newestSession: { file: string; frontmatter: Record<string, unknown>; body: string } | null = null;
  // Lowest possible rank, so a parseable timestamp of any era (including
  // pre-1970) outranks an unparseable one instead of being filtered out.
  let newestTime = -Infinity;

  if (fs.existsSync(sessionsDir)) {
    // Ascending filename order, as `loadSessions` uses, so a tie on `started_at`
    // resolves to the same session on every OS instead of to whatever readdir
    // happened to return. The comparison below stays `>=` deliberately:
    // `newestTime` starts at -Infinity and an unparseable `started_at` is ranked at
    // -Infinity too, so under `>` a vault whose sessions all carry unreadable dates
    // would select nothing and erase hot memory (BUG-005).
    const files = fs.readdirSync(sessionsDir).sort();
    for (const file of files) {
      if (file.startsWith('S-') && file.endsWith('.md')) {
        const filePath = path.join(sessionsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0) {
            continue;
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const { frontmatter, body } = parseFrontmatter(content);
          // The same confirmed-session predicate `regenerateIndex` applies, schema
          // gate included: hot.md is the other view of this one rebuild pass, and
          // it used to select a session the index had skipped as unsupported, so
          // the two derived files disagreed about the same vault (#542).
          if (isConfirmedSession(frontmatter)) {
            // Apply the same NaN protection `regenerateIndex` uses: an
            // unparseable `started_at` (hand-edited or corrupted frontmatter)
            // yields NaN, and `NaN >= newestTime` is always false, which would
            // disqualify every canonical session and erase hot memory. Rank it
            // lowest instead of dropping it, so any parseable timestamp — even
            // a pre-1970 one — still wins, and derived views stay non-empty.
            const parsedTime = new Date((frontmatter.started_at as string) || 0).getTime();
            const time = Number.isNaN(parsedTime) ? Number.NEGATIVE_INFINITY : parsedTime;
            if (time >= newestTime) {
              newestTime = time;
              newestSession = { file: filePath, frontmatter, body };
            }
          }
        } catch {
          // Never delete or mutate session files during hot/index rebuild.
        }
      }
    }
  }

  const activeSession = readActiveSession(vaultPath);
  if (newestSession) {
    // Derive the id from the filename stem, not frontmatter.session_id: hot.md
    // is validated against the same filename-derived ID space as the index
    // (valid-hot-memory checks fm.last_session there), so a disagreeing
    // session_id would leave a dangling reference (#359).
    const lastSessionId = sessionStem(newestSession.file);
    const activeTopicId = activeSession?.topic_id || null;
    // #329: `hot.md` is derived from this note, so its `started_at` has to agree with
    // the note it came from. Dropping the fifth argument let `updateHotMemory`'s
    // default blank the field on every rebuild. Normalize through `Date` so the
    // session/hot full ISO form (ms + `Z`) is what lands in `hot.md` — never the
    // `YYYY-MM-DD` shape the review/due fields use — and keep an absent or
    // unparseable start as `null` rather than the string "null" (BUG-005: such a
    // note is still selected, so it must still yield a usable working memory).
    const rawStarted = activeSession?.started_at;
    let newestStartMs = Number.NaN;
    if (typeof rawStarted === 'string') {
      newestStartMs = Date.parse(rawStarted.trim());
    }
    const startedAt = Number.isNaN(newestStartMs) ? null : new Date(newestStartMs).toISOString();
    await updateHotMemory(
      vaultPath,
      lastSessionId,
      activeTopicId,
      newestSession.body,
      startedAt
    );
  } else {
    await updateHotMemory(
      vaultPath,
      null,
      activeSession?.topic_id || null,
      activeSession ? 'Active learning session in progress.' : 'No learning history recorded yet.',
      activeSession?.started_at || null
    );
  }

  await regenerateIndex(vaultPath);
}
