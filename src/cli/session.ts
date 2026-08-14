import readline from 'readline';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
/**
 * Session Command Handler
 * Manages learning sessions and session memory
 */

import fs from 'fs';
import path from 'path';
import {
  getDrafts,
  rebuildHotAndIndex,
  writeSessionNote,
  writeDraftCheckpoint,
  generateSessionId,
  generateDraftId,
  parseFrontmatter,
  recoverDraft,
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
    const vaultPath = validateVaultPath(config.vaultPath);

    if (action === 'start') {
      const drafts = getDrafts(vaultPath);

      if (drafts.length > 0) {
        console.log(`Found ${drafts.length} unconfirmed draft session(s):`);
        for (const draftPath of drafts) {
          console.log(`  • ${path.basename(draftPath)}`);
        }

        if (!options.interactive) {
          console.log();
          console.log('Unconfirmed draft checkpoint detected.');
          console.log('Run "palee session start --interactive" to resolve.');
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
        fs.unlinkSync(hotPath);
        await rebuildHotAndIndex(vaultPath);
        hotContent = fs.readFileSync(hotPath, 'utf8');
        const parsed = parseFrontmatter(hotContent);
        frontmatter = parsed.frontmatter;
        body = parsed.body;
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

      const draftId = generateDraftId();
      const draftPath = await writeDraftCheckpoint(vaultPath, draftId, {
        topic_id: topicId,
        started_at: new Date().toISOString(),
      }, 'Draft checkpoint captured during learning session.');

      console.log(`✓ Draft checkpoint created: ${path.basename(draftPath)}`);
      return;
    }

    if (action === 'end') {
      const topicId = resolveSessionTopic(vaultPath, options.topic);
      if (!topicId) {
        console.error('Error: Topic required. Specify --topic <topic-id> or start a session on an active topic.');
        process.exitCode = 2;
        return;
      }

      const drafts = getDrafts(vaultPath);
      const sessionId = generateSessionId();

      const sessionPath = await writeSessionNote(vaultPath, {
        session_id: sessionId,
        topic_id: topicId,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      }, `Completed learning session for ${topicId}.`);

      // Clean up drafts on confirmed session end for the current topic
      for (const draftPath of drafts) {
        try {
          const content = fs.readFileSync(draftPath, 'utf8');
          const { frontmatter } = parseFrontmatter(content);
          if (frontmatter && frontmatter.topic_id === topicId) {
            fs.unlinkSync(draftPath);
          }
        } catch { /* ignore */ }
      }

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
        console.log('No session records found.');
        return;
      }

      const files = fs.readdirSync(sessionsDir);
      const confirmed = files.filter(f => f.startsWith('S-') && f.endsWith('.md')).sort().reverse();
      const drafts = files.filter(f => f.startsWith('DRAFT-S-') && f.endsWith('.md')).sort().reverse();

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
    process.exitCode = 5;
    return;
  }
}

export { sessionCommand };
export default sessionCommand;
