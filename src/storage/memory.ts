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
import { HotMemoryData, SessionRecord, DraftRecoveryAction } from '../types';

/** Maximum number of words retained in the active working memory (`hot.md`) summary body */
const MAX_HOT_WORDS = 250;

/**
 * Ensures and returns the `.palee` hidden directory inside the vault.
 *
 * @param vaultPath - Vault root path
 * @returns Path to `.palee` directory
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
 * @returns Session ID string (e.g. `S-20260824T103000-a1b2`)
 */
function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, '').split('.')[0]; // YYYYMMDDTHHMMSS
  const random = crypto.randomBytes(2).toString('hex');
  return `S-${dateStr}-${random}`;
}

/**
 * Generates a unique draft checkpoint identifier.
 *
 * @returns Draft ID string (e.g. `DRAFT-S-3f8a9c12`)
 */
function generateDraftId(): string {
  const random = crypto.randomBytes(4).toString('hex');
  return `DRAFT-S-${random}`;
}

/**
 * Truncates text to a maximum number of whitespace-delimited words.
 *
 * @param text - Text to truncate
 * @param maxWords - Maximum number of words allowed
 * @returns Truncated text with trailing ellipsis if shortened
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
 */
function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Formats a Date object into an ISO date-only string (`YYYY-MM-DD`).
 *
 * @param date - Date to format
 * @returns Formatted date string
 */
function formatDateOnly(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Writes a confirmed canonical session note to `.palee/sessions/S-*.md` with atomic OCC write.
 *
 * @param vaultPath - Vault root directory path
 * @param sessionData - Session metadata (ID, topic ID, timestamps)
 * @param bodyContent - Markdown note body written during study
 * @returns Absolute path to the saved session note
 */
async function writeSessionNote(
  vaultPath: string,
  sessionData: Omit<SessionRecord, 'palee_schema' | 'status'>,
  bodyContent: string
): Promise<string> {
  const sessionsDir = getSessionsDir(vaultPath);
  const filePath = path.join(sessionsDir, `${sessionData.session_id}.md`);

  const fullData: SessionRecord = {
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

  const content = updateFrontmatter(`# Session: ${fullData.session_id}\n\n${bodyContent.trim()}`, frontmatterObj);
  let expectedFingerprint: string | null = null;
  if (fs.existsSync(filePath)) {
    expectedFingerprint = computeFingerprint(fs.readFileSync(filePath, 'utf8'));
  }

  await atomicWrite(vaultPath, filePath, content, expectedFingerprint);
  return filePath;
}

/**
 * Writes or updates the active working memory file (`.palee/hot.md`).
 *
 * @remarks
 * Summary body is capped at 250 words and frontmatter tracks `last_session`, `active_topic`, and `updated_at`.
 *
 * @param vaultPath - Vault root path
 * @param lastSessionId - ID of latest completed session or null
 * @param activeTopicId - ID of currently active topic or null
 * @param summaryBody - Notes text to distill into hot memory
 * @returns Absolute path to `hot.md`
 */
async function updateHotMemory(
  vaultPath: string,
  lastSessionId: string | null,
  activeTopicId: string | null,
  summaryBody: string
): Promise<string> {
  const paleeDir = getPaleeDir(vaultPath);
  const hotPath = path.join(paleeDir, 'hot.md');

  const truncatedBody = truncateWords(summaryBody, MAX_HOT_WORDS);

  const hotData: HotMemoryData = {
    palee_schema: 1,
    memory_id: 'H-active',
    last_session: lastSessionId,
    active_topic: activeTopicId,
    updated_at: formatDateOnly(new Date()),
  };

  const frontmatterObj: Record<string, unknown> = {
    palee_schema: hotData.palee_schema,
    memory_id: hotData.memory_id,
    last_session: hotData.last_session,
    active_topic: hotData.active_topic,
    updated_at: hotData.updated_at,
  };

  const content = updateFrontmatter(truncatedBody, frontmatterObj);
  let expectedFingerprint: string | null = null;
  if (fs.existsSync(hotPath)) {
    expectedFingerprint = computeFingerprint(fs.readFileSync(hotPath, 'utf8'));
  }

  await atomicWrite(vaultPath, hotPath, content, expectedFingerprint);
  return hotPath;
}

/**
 * Rebuilds `.palee/index.md` listing all confirmed study sessions in reverse chronological order.
 *
 * @param vaultPath - Vault root path
 * @returns Absolute path to `index.md`
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
          if (frontmatter && frontmatter.session_id) {
            sessions.push({
              palee_schema: (frontmatter.palee_schema as number) || 1,
              session_id: frontmatter.session_id as string,
              topic_id: (frontmatter.topic_id as string) || 'unknown',
              started_at: (frontmatter.started_at as string) || '',
              ended_at: (frontmatter.ended_at as string) || '',
              status: (frontmatter.status as 'completed' | 'draft') || 'completed',
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

  // Sort newest first
  sessions.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

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
  let expectedFingerprint: string | null = null;
  if (fs.existsSync(indexPath)) {
    expectedFingerprint = computeFingerprint(fs.readFileSync(indexPath, 'utf8'));
  }

  await atomicWrite(vaultPath, indexPath, content, expectedFingerprint);
  return indexPath;
}

/**
 * Re-scans all session files on disk and rebuilds both `hot.md` and `index.md`.
 *
 * @param vaultPath - Vault root path
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
  let expectedFingerprint: string | null = null;
  if (fs.existsSync(filePath)) {
    expectedFingerprint = computeFingerprint(fs.readFileSync(filePath, 'utf8'));
  }

  await atomicWrite(vaultPath, filePath, content, expectedFingerprint);
  return filePath;
}

/**
 * Discovers all active draft checkpoint files in `.palee/sessions/`.
 *
 * @param vaultPath - Vault root path
 * @returns Array of absolute file paths to active draft notes
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
 */
async function recoverDraft(
  vaultPath: string,
  draftPath: string,
  action: DraftRecoveryAction
): Promise<void> {
  if (!fs.existsSync(draftPath)) return;

  if (action === 'discard') {
    fs.unlinkSync(draftPath);
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
    const startedAt = frontmatter ? (frontmatter.started_at as string) || new Date().toISOString() : new Date().toISOString();

    await writeSessionNote(vaultPath, {
      session_id: newSessionId,
      topic_id: topicId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    }, body);

    fs.unlinkSync(draftPath);

    await rebuildHotAndIndex(vaultPath);
    return;
  }

  if (action === 'resume') {
    // Keep draft for resumption
    return;
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
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  recoverDraft,
  MAX_HOT_WORDS,
};
