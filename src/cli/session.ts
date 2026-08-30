import readline from 'readline';
import { loadConfig } from './config';
import { isJsonOutput, validateVaultPath } from './onboarding';
/**
 * Session Command Handler
 * Manages learning sessions and session memory
 */

import fs from 'fs';
import path from 'path';
import {
  getDrafts,
  getTopicDrafts,
  deleteTopicDrafts,
  resetHotMemory,
  rebuildHotAndIndex,
  updateHotMemory,
  writeSessionNote,
  writeDraftCheckpoint,
  generateSessionId,
  generateDraftId,
  parseFrontmatter,
  recoverDraft,
  isConflictError,
} from '../storage';
import { SessionOptions } from '../types';

export function resolveSessionTopic(vaultPath: string, explicitTopic?: string): string | null {
  if (explicitTopic && explicitTopic.trim().length > 0) {
    const trimmed = explicitTopic.trim();
    if (trimmed.toLowerCase() !== '(none)') {
      return trimmed;
    }
    return null;
  }

  // Check .palee/hot.md for active_topic
  const hotPath = path.join(vaultPath, '.palee', 'hot.md');
  if (fs.existsSync(hotPath)) {
    try {
      const content = fs.readFileSync(hotPath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      if (
        frontmatter &&
        typeof frontmatter.active_topic === 'string'
      ) {
        const active = frontmatter.active_topic.trim();
        if (active.length > 0 && active.toLowerCase() !== '(none)') {
          return active;
        }
      }
    } catch {
      // ignore parse error, fallback to null
    }
  }

  return null;
}

async function sessionCommand(action: string, options: SessionOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
    if (!vaultPath) return;

    if (action === 'start') {
      const drafts = getDrafts(vaultPath);

      if (drafts.length > 0) {
        if (jsonMode) {
          console.log(JSON.stringify({
            status: 'drafts_pending',
            draft_count: drafts.length,
            drafts: drafts.map((d) => path.basename(d)),
            message: 'Unconfirmed draft checkpoints detected. Run with --interactive to resolve.',
          }));
          process.exitCode = 2;
          return;
        }

        console.log(`Found ${drafts.length} unconfirmed draft session(s):`);
        for (const draftPath of drafts) {
          console.log(`  • ${path.basename(draftPath)}`);
        }

        if (!options.interactive) {
          console.log();
          console.log('Unconfirmed draft checkpoint detected.');
          console.log('Run "palee session start --interactive" to resolve.');
          process.exitCode = 2;
          return;
        }

        
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

        for (const draftPath of drafts) {
          console.log(`\nDraft: ${path.basename(draftPath)}`);
          let recoveryAction: 'resume' | 'save' | 'discard' | 'ignore' | null = null;
          while (!recoveryAction) {
            const answer = (await question('[R]esume  [S]ave as session  [D]iscard  [I]gnore: ')).trim().toLowerCase();
            if (answer === 'r') recoveryAction = 'resume';
            else if (answer === 's') recoveryAction = 'save';
            else if (answer === 'd') recoveryAction = 'discard';
            else if (answer === 'i') recoveryAction = 'ignore';
          }
          await recoverDraft(vaultPath, draftPath, recoveryAction);
        }
        rl.close();
      }

      // Check / rebuild hot memory
      const hotPath = path.join(vaultPath, '.palee', 'hot.md');
      if (!fs.existsSync(hotPath)) {
        console.log('Building working memory (hot.md)...');
        await rebuildHotAndIndex(vaultPath);
      }

      let hotContent = fs.readFileSync(hotPath, 'utf8');
      let { frontmatter, body, error } = parseFrontmatter(hotContent);

      if (error || (frontmatter && !frontmatter.palee_schema)) {
        console.warn('Corrupt hot memory detected. Rebuilding...');
        await resetHotMemory(vaultPath);
        await rebuildHotAndIndex(vaultPath);
        hotContent = fs.readFileSync(hotPath, 'utf8');
        const parsed = parseFrontmatter(hotContent);
        frontmatter = parsed.frontmatter;
        body = parsed.body;
      }

      const resolvedTopic = resolveSessionTopic(vaultPath, options.topic);
      const nowIso = new Date().toISOString();
      const nowTime = new Date(nowIso).getTime();
      if (resolvedTopic) {
        let startedAtToPersist = nowIso;
        const activeTopic = frontmatter && typeof frontmatter.active_topic === 'string' ? frontmatter.active_topic.trim() : '';
        const rawStarted = frontmatter && typeof frontmatter.started_at === 'string' ? frontmatter.started_at.trim() : '';
        const parsedStart = rawStarted && !Number.isNaN(new Date(rawStarted).getTime()) ? new Date(rawStarted).getTime() : 0;

        // If already active on the same topic within 24h and not in future, preserve started_at
        if (activeTopic === resolvedTopic && parsedStart > 0 && (nowTime - parsedStart) <= 24 * 60 * 60 * 1000 && parsedStart <= nowTime + 60000) {
          startedAtToPersist = new Date(parsedStart).toISOString();
        }

        await updateHotMemory(
          vaultPath,
          (frontmatter?.last_session as string) || null,
          resolvedTopic,
          body || '',
          startedAtToPersist
        );
        hotContent = fs.readFileSync(hotPath, 'utf8');
        const refreshed = parseFrontmatter(hotContent);
        frontmatter = refreshed.frontmatter;
        body = refreshed.body;
      }

      console.log('=== PALEE Session Started ===\n');
      if (!config.aiProvider) {
        console.log('No AI provider configured.\n');
      }
      if (frontmatter) {
        console.log(`Active Topic: ${frontmatter.active_topic || '(none)'}`);
        console.log(`Last Session: ${frontmatter.last_session || '(none)'}`);
        console.log(`Last Updated: ${frontmatter.updated_at || '(none)'}`);
        console.log();
      }

      console.log('Working Memory (hot.md):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(body.trim());
      console.log('─────────────────────────────────────────────────────────────');
      return;
    }

    if (action === 'draft') {
      const topicId = resolveSessionTopic(vaultPath, options.topic);
      if (!topicId) {
        console.error('Error: Topic required. Specify --topic <topic-id> or start a session on an active topic.');
        process.exitCode = 2;
        return;
      }

      let draftStart = new Date().toISOString();
      const hotPath = path.join(vaultPath, '.palee', 'hot.md');
      if (fs.existsSync(hotPath)) {
        try {
          const { frontmatter } = parseFrontmatter(fs.readFileSync(hotPath, 'utf8'));
          if (
            frontmatter &&
            frontmatter.active_topic === topicId &&
            typeof frontmatter.started_at === 'string' &&
            frontmatter.started_at.trim().length > 0 &&
            !Number.isNaN(new Date(frontmatter.started_at).getTime())
          ) {
            draftStart = frontmatter.started_at.trim();
          }
        } catch {
          // ignore read error
        }
      }

      const draftId = generateDraftId();
      const draftPath = await writeDraftCheckpoint(
        vaultPath,
        draftId,
        {
          topic_id: topicId,
          started_at: draftStart,
        },
        `Draft learning notes for ${topicId}.`
      );

      console.log(`✓ Draft checkpoint created: ${draftId}`);
      console.log(`  Path: ${path.relative(vaultPath, draftPath)}`);
      return;
    }

    if (action === 'end') {
      const topicId = resolveSessionTopic(vaultPath, options.topic);
      if (!topicId) {
        console.error('Error: Topic required. Specify --topic <topic-id> or start a session on an active topic.');
        process.exitCode = 2;
        return;
      }

      const nowIso = new Date().toISOString();
      const nowTime = new Date(nowIso).getTime();
      const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

      // 3-tier timestamp recovery algorithm
      // Tier 1: Check draft checkpoints for earliest started_at within 24h
      const matchingDrafts = getTopicDrafts(vaultPath, topicId).filter((d) => {
        if (!d.started_at) return false;
        const t = new Date(d.started_at).getTime();
        return !Number.isNaN(t) && (nowTime - t) <= MAX_DURATION_MS && t <= nowTime + 60000;
      });
      let startedAt: string | null = null;
      if (matchingDrafts.length > 0) {
        matchingDrafts.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
        startedAt = matchingDrafts[0].started_at;
      }

      // Tier 2: Check active hot memory
      if (!startedAt) {
        const hotPath = path.join(vaultPath, '.palee', 'hot.md');
        if (fs.existsSync(hotPath)) {
          try {
            const { frontmatter } = parseFrontmatter(fs.readFileSync(hotPath, 'utf8'));
            const activeTopic = frontmatter && typeof frontmatter.active_topic === 'string' ? frontmatter.active_topic.trim() : '';
            const rawStarted = frontmatter && typeof frontmatter.started_at === 'string' ? frontmatter.started_at.trim() : '';
            const parsedStart = rawStarted && !Number.isNaN(new Date(rawStarted).getTime()) ? new Date(rawStarted).getTime() : 0;
            if (activeTopic === topicId && parsedStart > 0 && (nowTime - parsedStart) <= MAX_DURATION_MS && parsedStart <= nowTime + 60000) {
              startedAt = new Date(parsedStart).toISOString();
            }
          } catch {
            // ignore parse error
          }
        }
      }

      // Tier 3: Fallback to current instant
      const endedAt = nowIso;
      if (!startedAt || Number.isNaN(new Date(startedAt).getTime())) {
        startedAt = endedAt;
      }

      // Calculate actual elapsed duration
      const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
      const durationMinutes = Math.round(durationMs / 60000);

      const sessionId = generateSessionId();

      const sessionPath = await writeSessionNote(vaultPath, {
        session_id: sessionId,
        topic_id: topicId,
        started_at: startedAt,
        ended_at: endedAt,
        duration_minutes: durationMinutes,
      }, `Completed learning session for ${topicId}.\nDuration: ${durationMinutes} min.`);

      // Clean up drafts on confirmed session end for the current topic
      deleteTopicDrafts(vaultPath, topicId);

      // Regenerate derived views
      await rebuildHotAndIndex(vaultPath);

      console.log(`✓ Session recorded: ${sessionId}`);
      console.log(`  Path: ${path.relative(vaultPath, sessionPath)}`);
      console.log('✓ Working memory (hot.md) and index (index.md) updated.');
      return;
    }

    if (action === 'list') {
      const sessionsDir = path.join(vaultPath, '.palee', 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        if (jsonMode) {
          console.log(JSON.stringify({
            confirmed: [],
            drafts: [],
            total_confirmed: 0,
            total_drafts: 0,
          }));
          return;
        }
        console.log('No session records found.');
        return;
      }

      const files = fs.readdirSync(sessionsDir);
      const confirmed = files.filter(f => f.startsWith('S-') && f.endsWith('.md')).sort().reverse();
      const drafts = files.filter(f => f.startsWith('DRAFT-S-') && f.endsWith('.md')).sort().reverse();

      if (jsonMode) {
        console.log(JSON.stringify({
          confirmed,
          drafts,
          total_confirmed: confirmed.length,
          total_drafts: drafts.length,
        }));
        return;
      }

      console.log('=== PALEE Sessions ===\n');
      console.log(`Confirmed Sessions: ${confirmed.length}`);
      for (const file of confirmed.slice(0, 10)) {
        console.log(`  • ${file}`);
      }
      if (confirmed.length > 10) {
        console.log(`  ... and ${confirmed.length - 10} more`);
      }

      if (drafts.length > 0) {
        console.log(`\nActive Drafts: ${drafts.length}`);
        for (const file of drafts) {
          console.log(`  • ${file}`);
        }
      }

      return;
    }

    console.error(`Error: Unknown session action: '${action}'`);
    console.error('Valid actions: start, end, draft, list');
    process.exitCode = 2;
    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = isConflictError(e) ? 4 : 5;
    return;
  }
}

export { sessionCommand };
export default sessionCommand;
