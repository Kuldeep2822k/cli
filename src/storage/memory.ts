import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { atomicWrite } from './atomic-write';
import { HotMemoryData, SessionRecord, DraftRecoveryAction } from '../types';

/**
 * PALEE Session Memory Storage Manager
 * Implements canonical sessions, derived hot.md & index.md, and draft recovery.
 */

const MAX_HOT_WORDS = 250;

function getPaleeDir(vaultPath: string): string {
  const dir = path.join(vaultPath, '.palee');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getSessionsDir(vaultPath: string): string {
  const dir = path.join(vaultPath, '.palee', 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, '').split('.')[0]; // YYYYMMDDTHHMMSS
  const random = crypto.randomBytes(2).toString('hex');
  return `S-${dateStr}-${random}`;
}

function generateDraftId(): string {
  const random = crypto.randomBytes(4).toString('hex');
  return `DRAFT-S-${random}`;
}

/**
 * Truncate text to max words
 */
function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Count words in a string
 */
function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Format Date to YYYY-MM-DD (date only)
 */
function formatDateOnly(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Write a confirmed canonical session note to .palee/sessions/S-*.md
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
 * Write or update .palee/hot.md derived view (body capped at 250 words, updated_at as YYYY-MM-DD)
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
 * Rebuild .palee/index.md derived view listing all sessions
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
 * Rebuild hot.md and index.md from canonical sessions
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
 * Write a draft checkpoint for an active session (DRAFT-S-*.md)
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
    ended_at: new Date().toISOString(),
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
 * List all active draft checkpoints in .palee/sessions/
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
 * Recover or handle a draft checkpoint
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
