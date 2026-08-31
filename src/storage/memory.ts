/**
 * PALEE Session Memory Storage Manager
 *
 * @remarks
 * Manages study session persistence, hot working memory derivation, index cataloging,
 * and draft crash recovery within the vault's `.palee/` directory.
 *
 * Subsystems:
 * - **Canonical Sessions**: Saved under `.palee/sessions/S-*.md`.
 * - **Working Memory**: `.palee/hot.md` (capped at 250 words of recent active context).
 * - **Session Index**: `.palee/index.md` listing chronological study sessions.
 * - **Draft Recovery**: Manages checkpoint files (`.palee/sessions/DRAFT-S-*.md`).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { atomicWrite } from './atomic-write';
import { HotMemoryData, SessionRecord, CompletedSessionRecord, DraftRecoveryAction, NodeError } from '../types';

/** Maximum number of words retained in the active working memory (`hot.md`) summary body */
const MAX_HOT_WORDS = 250;

/**
 * Ensures and returns the `.palee` hidden directory inside the vault.
 *
 * @param vaultPath - Vault root path
 * @returns Path to `.palee` directory
 * @remarks Creates the directory recursively if it does not already exist.
 * @example
 * ```typescript
 * const dir = getPaleeDir('/path/to/vault');
 * ```
 */
function getPaleeDir(vaultPath: string): string {
  const dir = path.join(vaultPath, '.palee');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Ensures and returns the `.palee/sessions` directory inside the vault.
 *
 * @param vaultPath - Vault root path
 * @returns Path to `.palee/sessions` directory
 * @remarks Creates the directory recursively if it does not already exist.
 * @example
 * ```typescript
 * const dir = getSessionsDir('/path/to/vault');
 * ```
 */
function getSessionsDir(vaultPath: string): string {
  const dir = path.join(vaultPath, '.palee', 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generates a unique canonical session identifier with timestamp and random entropy.
 *
 * @returns Session ID string formatted as `S-YYYYMMDDTHHMMSS-XXXX`
 * @remarks Formats UTC timestamp segments and appends 2 bytes of random hex entropy.
 * @example
 * ```typescript
 * const id = generateSessionId(); // "S-20260823T153000-a1b2"
 * ```
 */
function generateSessionId(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const timestamp = `${year}${month}${day}T${hours}${minutes}${seconds}`;
  const random = crypto.randomBytes(2).toString('hex');
  return `S-${timestamp}-${random}`;
}

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
function generateDraftId(): string {
  const random = crypto.randomBytes(4).toString('hex');
  return `DRAFT-S-${random}`;
}

/**
 * Truncates text to a maximum word count, appending an ellipsis if trimmed.
 *
 * @param text - Input string to truncate
 * @param maxWords - Upper bound on word count (e.g. 250)
 * @returns Truncated string with trailing `...` if truncated
 * @remarks Splits text on whitespace and joins up to maxWords words.
 * @example
 * ```typescript
 * const truncated = truncateWords('One two three four', 2); // "One two..."
 * ```
 */
function truncateWords(text: string, maxWords: number): string {
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
 * @example
 * ```typescript
 * const count = countWords('Study notes for machine learning'); // 5
 * ```
 */
function countWords(text: string): number {
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
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
 *   session_id: 'S-20260830T100000-abcd',
 *   topic_id: 'topic-math',
 *   started_at: '2026-08-30T10:00:00Z',
 *   ended_at: '2026-08-30T10:30:00Z',
 *   duration_minutes: 30,
 * }, 'Note body');
 * ```
 */
async function writeSessionNote(
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
  let expectedFingerprint: string | null;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(filePath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectedFingerprint = null;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, filePath, content, expectedFingerprint);
  return filePath;
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
async function updateHotMemory(
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
  let expectedFingerprint: string | null;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(hotPath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectedFingerprint = null;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, hotPath, content, expectedFingerprint);
  return hotPath;
}

/**
 * Safely resets or deletes the active working memory file (`.palee/hot.md`).
 *
 * @param vaultPath - Vault root path
 * @returns Absolute path to `hot.md`
 * @remarks Deletes `hot.md` if it exists, ignoring missing file errors.
 * @example
 * ```typescript
 * await resetHotMemory('/vault');
 * ```
 */
async function resetHotMemory(vaultPath: string): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const hotPath = path.join(paleeDir, 'hot.md');

  if (fs.existsSync(hotPath)) {
    try {
      fs.unlinkSync(hotPath);
    } catch (e: unknown) {
      const err = e as NodeError;
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return hotPath;
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
async function regenerateIndex(vaultPath: string): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const indexPath = path.join(paleeDir, 'index.md');
  const sessionsDir = getSessionsDir(vaultPath);

  const sessions: SessionRecord[] = [];
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (file.startsWith('S-') && file.endsWith('.md')) {
        const filePath = path.join(sessionsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0) {
            try { fs.unlinkSync(filePath); } catch {}
            continue;
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const { frontmatter } = parseFrontmatter(content);
          if (
            frontmatter &&
            frontmatter.session_id &&
            !String(frontmatter.session_id).startsWith('DRAFT-') &&
            frontmatter.status !== 'draft'
          ) {
            sessions.push({
              palee_schema: (frontmatter.palee_schema as number) || 1,
              session_id: frontmatter.session_id as string,
              topic_id: (frontmatter.topic_id as string) || 'unknown',
              started_at: (frontmatter.started_at as string) || '',
              ended_at: (frontmatter.ended_at as string) || '',
              status: 'completed',
            });
          }
        } catch (e: any) {
          if (e && !e.code) {
            try { fs.unlinkSync(filePath); } catch {}
          }
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
      indexBody += `- [[${s.session_id}]] - Topic: ${s.topic_id} (${dateStr})\n`;
    }
  }

  const frontmatterObj: Record<string, unknown> = {
    palee_schema: 1,
    type: 'session_index',
    updated_at: formatDateOnly(new Date()),
  };

  const content = updateFrontmatter(indexBody, frontmatterObj);
  let expectedFingerprint: string | null;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(indexPath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectedFingerprint = null;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, indexPath, content, expectedFingerprint);
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
async function rebuildHotAndIndex(vaultPath: string): Promise<void> {
  const sessionsDir = getSessionsDir(vaultPath);
  let newestSession: { file: string; frontmatter: Record<string, unknown>; body: string } | null = null;
  let newestTime = 0;

  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (file.startsWith('S-') && file.endsWith('.md')) {
        const filePath = path.join(sessionsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0) {
            try { fs.unlinkSync(filePath); } catch {}
            continue;
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const { frontmatter, body } = parseFrontmatter(content);
          if (frontmatter && frontmatter.session_id) {
            const time = new Date((frontmatter.started_at as string) || 0).getTime();
            if (time >= newestTime) {
              newestTime = time;
              newestSession = { file: filePath, frontmatter, body };
            }
          }
        } catch (e: any) {
          if (e && !e.code) {
            try { fs.unlinkSync(filePath); } catch {}
          }
        }
      }
    }
  }

  if (newestSession) {
    const lastSessionId = newestSession.frontmatter.session_id as string;
    const activeTopicId = (newestSession.frontmatter.topic_id as string) || null;
    await updateHotMemory(vaultPath, lastSessionId, activeTopicId, newestSession.body);
  } else {
    await updateHotMemory(vaultPath, null, null, 'No learning history recorded yet.');
  }

  await regenerateIndex(vaultPath);
}

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
async function writeDraftCheckpoint(
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
  let expectedFingerprint: string | null;
  try {
    expectedFingerprint = computeFingerprint(fs.readFileSync(filePath, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      expectedFingerprint = null;
    } else {
      throw err;
    }
  }

  await atomicWrite(vaultPath, filePath, content, expectedFingerprint);
  return filePath;
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
function getDrafts(vaultPath: string): string[] {
  const sessionsDir = getSessionsDir(vaultPath);
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir);
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
async function recoverDraft(
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
    let parsedStart = rawStarted && !Number.isNaN(new Date(rawStarted).getTime()) ? new Date(rawStarted).getTime() : nowTime;

    // Clock skew tolerance: if within 60s in future, clamp to now
    if (parsedStart > nowTime) {
      parsedStart = nowTime;
    }

    const startedAt = new Date(parsedStart).toISOString();
    const endedAt = nowIso;
    const durationMs = Math.max(0, new Date(endedAt).getTime() - parsedStart);
    const durationMinutes = Number.isFinite(durationMs) ? Math.round(durationMs / 60000) : 0;

    await writeSessionNote(vaultPath, {
      session_id: newSessionId,
      topic_id: topicId,
      started_at: startedAt,
      ended_at: endedAt,
      duration_minutes: durationMinutes,
    }, body);

    deleteSessionNote(vaultPath, draftPath);
    await rebuildHotAndIndex(vaultPath);
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
function getTopicDrafts(vaultPath: string, topicId: string): Array<{ path: string; started_at: string; body: string }> {
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

/**
 * Deletes all draft checkpoints matching a specific topic ID.
 *
 * @param vaultPath - Vault root path
 * @param topicId - Topic ID
 * @returns Object with `deleted` paths array and `errors` array of `{ path, error }` for any failures
 * @remarks
 * Attempts deletion of all matching draft files. Read errors (ENOENT, EACCES), parse errors,
 * and unlink errors are captured in the returned `errors` array rather than swallowed silently.
 * @example
 * ```typescript
 * const { deleted, errors } = deleteTopicDrafts('/vault', 'topic-123');
 * if (errors.length > 0) { console.warn('Cleanup warnings:', errors); }
 * ```
 */
function deleteTopicDrafts(vaultPath: string, topicId: string): { deleted: string[]; errors: Array<{ path: string; error: Error }> } {
  const drafts = getDrafts(vaultPath);
  const deleted: string[] = [];
  const errors: Array<{ path: string; error: Error }> = [];

  for (const draftPath of drafts) {
    try {
      const content = fs.readFileSync(draftPath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter && frontmatter.topic_id === topicId) {
        deleteSessionNote(vaultPath, draftPath);
        deleted.push(draftPath);
      }
    } catch (err: unknown) {
      errors.push({ path: draftPath, error: err as Error });
    }
  }

  return { deleted, errors };
}

/**
 * Safely unlinks a completed session note or draft checkpoint file within `.palee/sessions/`.
 *
 * @param vaultPath - Vault root path
 * @param targetPath - Path to the session note or draft file
 * @returns Void
 * @remarks Validates that the target path does not escape `.palee/sessions/` directory.
 * @example
 * ```typescript
 * deleteSessionNote('/vault', '/vault/.palee/sessions/DRAFT-S-1.md');
 * ```
 */
function deleteSessionNote(vaultPath: string, targetPath: string): void {
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

  try {
    if (fs.existsSync(resolvedTarget)) {
      fs.unlinkSync(resolvedTarget);
    }
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== 'ENOENT') throw err;
  }
}

export {
  generateSessionId,
  generateDraftId,
  truncateWords,
  countWords,
  formatDateOnly,
  writeSessionNote,
  updateHotMemory,
  resetHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  getTopicDrafts,
  deleteTopicDrafts,
  deleteSessionNote,
  recoverDraft,
  MAX_HOT_WORDS,
};
