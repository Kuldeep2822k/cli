/**
 * PALEE Draft Checkpoints and Crash Recovery
 *
 * @remarks
 * The draft half of the memory subsystem — the in-progress checkpoint files
 * (`.palee/sessions/DRAFT-S-*.md`) and the recovery pass that resolves them
 * into completed sessions or discards them. Extracted from
 * `src/storage/memory.ts` by the P3-14 phase split (#565); `memory.ts`
 * re-exports this module's surface unchanged.
 *
 * Canonical session notes are written by `./sessions`; the derived views and
 * the active-session marker by `./hot-index`; the shared `.palee` tree guards
 * by `./palee-dirs`.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { atomicWrite, isConflictError } from './atomic-write';
import { getSessionsDir } from './palee-dirs';
import { generateSessionId, writeSessionNote, deleteSessionNote } from './sessions';
import { rebuildHotAndIndex } from './hot-index';
import { DraftRecoveryAction } from '../types';

/**
 * Generates a unique checkpoint identifier for in-progress draft sessions.
 *
 * @returns Draft ID string formatted as `DRAFT-S-XXXXXXXX`
 * @remarks Uses 4 bytes of cryptographic random hex entropy.
 * @example
 * ```typescript
 * const draftId = generateDraftId(); // "DRAFT-S-1a2b3c4d"
 * ```
 */
export function generateDraftId(): string {
  const random = crypto.randomBytes(4).toString('hex');
  return `DRAFT-S-${random}`;
}

/** Maximum retry attempts when writeDraftCheckpoint encounters an OCC conflict (#358). */
const MAX_CHECKPOINT_ATTEMPTS = 3;
const CHECKPOINT_RETRY_BASE_MS = 50;
const CHECKPOINT_RETRY_JITTER = 0.25;
const CHECKPOINT_RETRY_MAX_MS = 300;

/**
 * Writes an intermediate draft checkpoint for an in-progress study session (`.palee/sessions/DRAFT-S-*.md`).
 *
 * @param vaultPath - Vault root path
 * @param draftId - Draft ID (`DRAFT-S-*`)
 * @param sessionData - Session metadata
 * @param bodyContent - Draft notes content
 * @returns Absolute path to the written draft checkpoint file
 * @remarks Draft checkpoints persist temporary learning state to prevent data loss on unexpected exits.
 * @example
 * ```typescript
 * const draftFile = await writeDraftCheckpoint('/vault', 'DRAFT-S-1a2b', { topic_id: 't-1', started_at: '2026-08-30T10:00:00Z' }, 'Draft body');
 * ```
 */
export async function writeDraftCheckpoint(
  vaultPath: string,
  draftId: string,
  sessionData: { topic_id: string; started_at: string },
  bodyContent: string
): Promise<string> {
  const sessionsDir = getSessionsDir(vaultPath);
  const filePath = path.join(sessionsDir, `${draftId}.md`);

  const frontmatterObj: Record<string, unknown> = {
    palee_schema: 1,
    session_id: draftId,
    topic_id: sessionData.topic_id,
    started_at: sessionData.started_at,
    ended_at: null,
    status: 'draft',
  };

  const content = updateFrontmatter(`# Draft Session: ${draftId}\n\n${bodyContent.trim()}`, frontmatterObj);

  // A checkpoint's whole purpose is crash recovery, so an OCC conflict must not
  // lose the write: re-read the fingerprint and rewrite instead of propagating
  // ECONFLICT (#358). Bounded retries — a writer that never stops winning means
  // live contention, and spinning forever is worse than surfacing the failure.
  // Note: the retry winner deliberately wins and overwrites with this writer's
  // pre-rendered snapshot (same-session duplicate crash recovery), not a merge.
  let lastConflict: unknown = null;
  for (let attempt = 1; attempt <= MAX_CHECKPOINT_ATTEMPTS; attempt++) {
    let expectedFingerprint: string | null = null;
    // A draft checkpoint is written twice for the same id (first checkpoint, then
    // refresh), so absence is only the first case; stating it keeps the OCC guard on
    // in both (#327).
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

    try {
      await atomicWrite(vaultPath, filePath, content, expectedFingerprint, { expectExists });
      return filePath;
    } catch (err: unknown) {
      if (!isConflictError(err)) {
        throw err;
      }
      lastConflict = err;
      // Back off with jitter before re-contending, so a busy winning writer is not
      // met head-to-head on every re-read/re-write (the atomic-write retry idiom).
      // Never sleep after the final attempt — that path just throws the conflict.
      if (attempt < MAX_CHECKPOINT_ATTEMPTS) {
        const baseDelay = CHECKPOINT_RETRY_BASE_MS * attempt;
        const jittered = baseDelay + (Math.random() * 2 - 1) * baseDelay * CHECKPOINT_RETRY_JITTER;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(0, Math.min(jittered, CHECKPOINT_RETRY_MAX_MS)));
        });
      }
    }
  }
  throw lastConflict;
}

/**
 * Discovers all active draft checkpoint files in `.palee/sessions/`.
 *
 * @param vaultPath - Vault root path
 * @returns Array of absolute file paths to active draft notes
 * @remarks Scans the sessions directory for files prefixed with `DRAFT-S-`.
 * @example
 * ```typescript
 * const drafts = getDrafts('/vault');
 * ```
 */
export function getDrafts(vaultPath: string): string[] {
  const sessionsDir = getSessionsDir(vaultPath);
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir).sort();
  return files
    .filter(f => f.startsWith('DRAFT-S-') && f.endsWith('.md'))
    .map(f => path.join(sessionsDir, f));
}

/**
 * Handles resolution of an unfinished session draft.
 *
 * @param vaultPath - Vault root path
 * @param draftPath - Path to draft checkpoint note
 * @param action - Action to take: `'save'`, `'discard'`, `'resume'`, or `'ignore'`
 * @returns Promise resolving when draft recovery action is executed
 * @remarks If saving, validates draft start recency (clamping timestamps in the future or older than 24h).
 * @example
 * ```typescript
 * await recoverDraft('/vault', '/vault/.palee/sessions/DRAFT-S-1a2b.md', 'save');
 * ```
 */
export async function recoverDraft(
  vaultPath: string,
  draftPath: string,
  action: DraftRecoveryAction
): Promise<void> {
  if (!fs.existsSync(draftPath)) return;

  if (action === 'discard') {
    deleteSessionNote(vaultPath, draftPath);
    return;
  }

  if (action === 'ignore') {
    return;
  }

  if (action === 'save') {
    const content = fs.readFileSync(draftPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);
    const newSessionId = generateSessionId();

    const topicId = frontmatter ? (frontmatter.topic_id as string) || 'unknown' : 'unknown';
    const rawStarted = frontmatter && typeof frontmatter.started_at === 'string' ? frontmatter.started_at.trim() : '';
    const nowIso = new Date().toISOString();
    const nowTime = new Date(nowIso).getTime();
    const draftStart = rawStarted && !Number.isNaN(new Date(rawStarted).getTime()) ? new Date(rawStarted).getTime() : nowTime;
    let parsedStart = draftStart;

    // Clock skew tolerance mirrors src/cli/session.ts: a start timestamp within
    // 60s of now (future or past) is accepted as-is; more than 60s in the
    // future clamps to now, and stale drafts (older than 24h) clamp to
    // now - 24h per the documented recovery rule.
    if (parsedStart > nowTime + 60000) {
      parsedStart = nowTime;
    } else if (nowTime - parsedStart > 24 * 60 * 60 * 1000) {
      parsedStart = nowTime - 24 * 60 * 60 * 1000;
    }

    const startedAt = new Date(parsedStart).toISOString();
    const endedAt = nowIso;
    const durationMs = Math.max(0, new Date(endedAt).getTime() - parsedStart);
    const durationMinutes = Number.isFinite(durationMs) ? Math.round(durationMs / 60000) : 0;

    // #328 idempotence. Saving is not one transaction: a pass can die after the
    // session note reaches the vault but before the draft is retired, leaving both
    // files, and the next run then has to tell "already saved" from "not yet saved".
    // The session frontmatter carries no provenance key back to the draft, and adding
    // one would change the pinned session format (and every fingerprint of it), so the
    // match is made on bytes a save already leaves behind. `writeSessionNote` copies
    // the draft body verbatim under its own heading, so the draft's
    // `# Draft Session: <id>` line — carrying the draft's own id — survives inside the
    // completed note. That is the exact signal. Two drafts always get different
    // `DRAFT-S-<8 hex>` ids, so unlike a topic-and-time comparison it can never
    // confuse a second draft of the same topic with a retry of the first.
    // Hand-edited drafts need not carry that heading, so a weaker second match covers
    // them: same topic, same notes (the heading lines stripped), a `started_at` inside
    // the window this pass resolves to, and a note written after this draft — the only
    // order a save of this draft could have produced.
    const draftHeading = `# Draft Session: ${path.basename(draftPath, '.md')}`;
    const notesOf = (text: string): string => {
      let notes = text.trim();
      while (/^# (?:Draft )?Session:/.test(notes)) {
        notes = notes.replace(/^# (?:Draft )?Session:[^\n]*\n*/, '').trim();
      }
      return notes;
    };
    const draftNotes = notesOf(body);
    // ±60s is the same clock-skew tolerance the clamp above uses. The window spans the
    // draft's own start, this pass's resolution, and the draft's last checkpoint,
    // because a stale or future-dated draft clamps to the *then*-current instant: any
    // earlier pass resolved somewhere inside that span, never outside it.
    let draftMtimeMs = Number.NaN;
    try {
      draftMtimeMs = fs.statSync(draftPath).mtimeMs;
    } catch {
      // The draft vanished between the read and here; fall through to the write, which
      // is today's behaviour and never loses the notes in front of us.
    }
    const acceptedStartLow = Math.min(
      draftStart,
      parsedStart,
      ...(Number.isNaN(draftMtimeMs) ? [] : [draftMtimeMs])
    ) - 60000;
    const acceptedStartHigh = Math.max(draftStart, parsedStart) + 60000;
    let alreadySavedSessionId: string | null = null;
    const sessionsDir = getSessionsDir(vaultPath);
    if (fs.existsSync(sessionsDir)) {
      // Ascending filename order, as every other scan in this module uses.
      for (const file of fs.readdirSync(sessionsDir).sort()) {
        if (!file.startsWith('S-') || file.startsWith('DRAFT-S-') || !file.endsWith('.md')) continue;
        const candidatePath = path.join(sessionsDir, file);
        try {
          const candidateStat = fs.statSync(candidatePath);
          if (candidateStat.size === 0) continue;
          const candidate = parseFrontmatter(fs.readFileSync(candidatePath, 'utf8'));
          const fm = candidate.frontmatter;
          if (!fm || typeof fm.session_id !== 'string' || fm.session_id.startsWith('DRAFT-')) continue;
          if (fm.status !== 'completed') continue;
          if (String(fm.topic_id ?? 'unknown') !== topicId) continue;
          const rawCandidateStart = typeof fm.started_at === 'string' ? fm.started_at.trim() : '';
          const candidateStartMs = rawCandidateStart ? new Date(rawCandidateStart).getTime() : Number.NaN;
          if (Number.isNaN(candidateStartMs)) continue;
          if (candidateStartMs < acceptedStartLow || candidateStartMs > acceptedStartHigh) continue;
          if (candidate.body.includes(draftHeading)) {
            alreadySavedSessionId = fm.session_id;
            break;
          }
          // Empty notes carry no identifying signal: `notesOf === ''` would
          // match any no-notes completed session of this topic in the window,
          // so with drafts scanned in filename order (not creation order) an
          // older draft could be read as "already saved" by a newer draft's
          // session and silently dropped (#329). Require non-empty notes here;
          // a no-notes retry is still caught by the draft-id heading match above,
          // and the only cost is a possible duplicate for a hand-edited,
          // headingless, note-less draft — never a lost session.
          if (
            draftNotes !== '' &&
            !Number.isNaN(draftMtimeMs) &&
            notesOf(candidate.body) === draftNotes &&
            candidateStat.mtimeMs >= draftMtimeMs
          ) {
            alreadySavedSessionId = fm.session_id;
            break;
          }
        } catch {
          // Unreadable candidate: never block recovery over a note we cannot read.
        }
      }
    }

    if (alreadySavedSessionId === null) {
      await writeSessionNote(vaultPath, {
        session_id: newSessionId,
        topic_id: topicId,
        started_at: startedAt,
        ended_at: endedAt,
        duration_minutes: durationMinutes,
      }, body);
    }

    // #328 ordering. `rebuildHotAndIndex` regenerates `.palee/hot.md` and
    // `.palee/index.md` from the session files, so a throw there costs nothing
    // permanent — the next rebuild reconciles it. Retiring the draft first is what
    // made the failure unrecoverable: it destroyed the only marker that recovery was
    // still pending while leaving the derived views unwritten. The draft is therefore
    // retired last, once the canonical note exists and the views agree with it; if
    // the unlink itself fails the draft survives and the pass above recognises the
    // session it already produced instead of minting a second one.
    await rebuildHotAndIndex(vaultPath);
    deleteSessionNote(vaultPath, draftPath);
    return;
  }

  if (action === 'resume') {
    // Keep draft for resumption
    return;
  }
}

/**
 * Retrieves all active draft checkpoints matching a specific topic ID.
 *
 * @param vaultPath - Vault root path
 * @param topicId - Topic ID
 * @returns Array of matching draft records with path, started_at timestamp, and body
 * @remarks Filters all existing draft checkpoints by `topic_id`.
 * @example
 * ```typescript
 * const topicDrafts = getTopicDrafts('/vault', 'topic-123');
 * ```
 */
export function getTopicDrafts(vaultPath: string, topicId: string): Array<{ path: string; started_at: string; body: string }> {
  const drafts = getDrafts(vaultPath);
  const matches: Array<{ path: string; started_at: string; body: string }> = [];
  for (const draftPath of drafts) {
    try {
      const content = fs.readFileSync(draftPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      if (frontmatter && frontmatter.topic_id === topicId) {
        matches.push({
          path: draftPath,
          started_at: (frontmatter.started_at as string) || '',
          body,
        });
      }
    } catch {
      // ignore read errors
    }
  }
  return matches;
}

/** Returns which supplied draft checkpoints a completed session already records as consumed. */
export function getConsumedDraftPaths(vaultPath: string, draftPaths: string[]): Set<string> {
  const draftMarkers = new Map(draftPaths.map((draftPath) => [
    `Draft checkpoint: ${path.basename(draftPath)}`,
    draftPath,
  ]));
  const consumed = new Set<string>();
  if (draftMarkers.size === 0) return consumed;
  const sessionsDir = getSessionsDir(vaultPath);
  if (!fs.existsSync(sessionsDir)) return consumed;
  for (const file of fs.readdirSync(sessionsDir).sort()) {
    if (!file.startsWith('S-') || !file.endsWith('.md')) continue;
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      if (frontmatter?.status !== 'completed') continue;
      for (const [marker, draftPath] of draftMarkers) {
        if (body.includes(marker)) consumed.add(draftPath);
      }
    } catch {
      // An unreadable completed note cannot prove that this draft was consumed.
    }
  }
  return consumed;
}

/**
 * Deletes draft checkpoints matching a specific topic ID.
 *
 * @param vaultPath - Vault root path
 * @param topicId - Topic ID
 * @param draftPaths - Optional allow-list of the exact draft paths to delete — the
 *   checkpoints the caller's session recorded as consumed
 * @returns Object with `deleted` paths array and `errors` array of `{ path, error }` for any failures
 * @remarks
 * When `draftPaths` is supplied, only those files are deleted (#565 P3-02): a
 * same-topic draft that appeared after the caller's scan — a concurrent
 * `session draft` on the topic — was never consumed by the caller's session and
 * must survive for the session that holds it. Without the list the historical
 * behavior stands: every same-topic draft present now is deleted. Each listed
 * path is still verified to be a draft of `topicId` before the unlink.
 *
 * A draft whose target lock is held by a live writer is left in place
 * (`deleteSessionNote` yields) and is counted as neither deleted nor errored.
 * Read errors (ENOENT, EACCES), parse errors, and unlink errors are captured in
 * the returned `errors` array rather than swallowed silently.
 * @example
 * ```typescript
 * const { deleted, errors } = deleteTopicDrafts('/vault', 'topic-123');
 * if (errors.length > 0) { console.warn('Cleanup warnings:', errors); }
 * ```
 */
export function deleteTopicDrafts(
  vaultPath: string,
  topicId: string,
  draftPaths?: readonly string[]
): { deleted: string[]; errors: Array<{ path: string; error: Error }> } {
  const scopedPaths = draftPaths ? [...new Set(draftPaths)].sort() : null;
  const drafts = scopedPaths ?? getDrafts(vaultPath);
  const deleted: string[] = [];
  const errors: Array<{ path: string; error: Error }> = [];

  for (const draftPath of drafts) {
    try {
      const content = fs.readFileSync(draftPath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter && frontmatter.topic_id === topicId && deleteSessionNote(vaultPath, draftPath)) {
        deleted.push(draftPath);
      }
    } catch (err: unknown) {
      errors.push({ path: draftPath, error: err as Error });
    }
  }

  return { deleted, errors };
}
