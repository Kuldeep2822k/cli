import readline from 'readline';
import { loadConfig } from './config';
import { isJsonOutput, validateVaultPath } from './onboarding';
import { ExitCode, exitCodeFor } from './exit-codes';
/**
 * Session Command Handler
 * Manages learning sessions and session memory
 */

import fs from 'fs';
import path from 'path';
import {
  loadTopics,
  getDrafts,
  getTopicDrafts,
  deleteTopicDrafts,
  resetHotMemory,
  rebuildHotAndIndex,
  updateHotMemory,
  readHotMemory,
  resolveActiveTopic,
  writeSessionNote,
  writeDraftCheckpoint,
  generateSessionId,
  generateDraftId,
  recoverDraft,
} from '../storage';
import type { LoadedTopic } from '../storage';
import { resolveTopicQuery } from './topic-query';
import { DraftRecoveryAction, SessionOptions } from '../types';

/**
 * The outcome of deciding which topic a session action belongs to.
 *
 * @remarks
 * `not-found` and `ambiguous` are separate kinds because the learner needs a
 * different remedy for each: a typo is retyped, while a substring that several
 * topics share has to be narrowed to one of the listed candidates.
 */
export type SessionTopicOutcome =
  | { kind: 'topic'; topicId: string }
  | { kind: 'none' }
  | { kind: 'not-found'; query: string }
  | { kind: 'ambiguous'; query: string; candidates: LoadedTopic[] };

/** The two outcomes that are a refused `--topic` argument rather than a decision. */
type SessionTopicFailure = Extract<SessionTopicOutcome, { kind: 'not-found' | 'ambiguous' }>;

/**
 * Narrows a {@link SessionTopicOutcome} to the two kinds that must stop the action.
 *
 * @param outcome - The resolution to classify
 * @returns `true` when the argument named no topic or several of them
 */
function isSessionTopicFailure(outcome: SessionTopicOutcome): outcome is SessionTopicFailure {
  return outcome.kind === 'not-found' || outcome.kind === 'ambiguous';
}

/**
 * Resolves the active topic identifier for a study session, against the vault.
 *
 * @param vaultPath - Absolute path to Obsidian vault root
 * @param explicitTopic - Optional topic query passed explicitly via `--topic`
 * @returns The full resolution: a topic ID, or the reason the argument could not
 * be turned into one
 * @remarks
 * An explicit `--topic` is resolved the same way `review` and `assess` resolve
 * their topic argument — through {@link resolveTopicQuery} — so the session is
 * recorded against the topic's canonical `palee_id` and a query naming nothing
 * (or several things) is refused instead of being written out verbatim (#302).
 * A query matching one topic exactly also matches a title, so
 * `session start --topic "Recursion"` records whatever ID that title resolves to.
 *
 * When `--topic` is omitted, the fallback stays hot memory's `active_topic` and is
 * *not* re-resolved: `hot.md` is canonical, and refusing to end a session because
 * the note was deleted or renamed since the session started would destroy real
 * work. That fallback is only reachable through a value the learner was allowed to
 * store, which is exactly what the explicit path above now guarantees.
 * @example
 * ```typescript
 * const outcome = resolveSessionTopicResolution('/vault', 'topic-linear-algebra');
 * if (outcome.kind === 'topic') console.log(outcome.topicId);
 * ```
 */
export function resolveSessionTopicResolution(
  vaultPath: string,
  explicitTopic?: string
): SessionTopicOutcome {
  const trimmed = typeof explicitTopic === 'string' ? explicitTopic.trim() : '';
  if (trimmed.length > 0) {
    if (trimmed.toLowerCase() === '(none)') return { kind: 'none' };
    const resolution = resolveTopicQuery(loadTopics(vaultPath), trimmed);
    if (resolution.kind === 'none') return { kind: 'not-found', query: trimmed };
    if (resolution.kind === 'ambiguous') {
      return { kind: 'ambiguous', query: trimmed, candidates: resolution.candidates };
    }
    return { kind: 'topic', topicId: resolution.topic.palee_id };
  }

  // Check .palee/hot.md for active_topic; read/parse failures mean no active topic
  try {
    const active = resolveActiveTopic(readHotMemory(vaultPath));
    return active ? { kind: 'topic', topicId: active } : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/**
 * Resolves the active topic identifier for a study session.
 *
 * @param vaultPath - Absolute path to Obsidian vault root
 * @param explicitTopic - Optional topic query passed explicitly via `--topic`
 * @returns The resolved topic ID, or `null` if none
 * @remarks Convenience wrapper over {@link resolveSessionTopicResolution} for
 * callers that only need the ID; use that function when the reason a `null` came
 * back has to be reported (a phantom `--topic` and a missing `active_topic` are
 * both `null` here but exit with different messages).
 * @example
 * ```typescript
 * const topic = resolveSessionTopic('/vault', 'topic-linear-algebra');
 * ```
 */
export function resolveSessionTopic(vaultPath: string, explicitTopic?: string): string | null {
  const outcome = resolveSessionTopicResolution(vaultPath, explicitTopic);
  return outcome.kind === 'topic' ? outcome.topicId : null;
}

/**
 * Reports a `--topic` argument that could not be resolved to one topic.
 *
 * @param outcome - The failed {@link SessionTopicOutcome}
 * @param jsonMode - Whether to emit the machine-readable form
 * @returns `true`; the caller returns after calling this
 * @remarks
 * Sets {@link ExitCode.Usage} (2) — a wrong or ambiguous argument is usage, not a
 * crash, and the same class `review`/`assess` already exit 2 for. Wording matches
 * `review` so the identical string produces the identical complaint whichever
 * command the learner typed it into; in JSON mode the same sentence travels in the
 * `error` field, as `progress --json` does.
 * @example
 * ```typescript
 * if (isSessionTopicFailure(outcome)) {
 *   reportUnresolvedSessionTopic(outcome, false);
 *   return;
 * }
 * ```
 */
function reportUnresolvedSessionTopic(outcome: SessionTopicFailure, jsonMode: boolean): true {
  if (outcome.kind === 'ambiguous') {
    const matches = outcome.candidates.map((c) => c.palee_id);
    if (jsonMode) {
      console.error(JSON.stringify({
        error: `Multiple topics match: ${outcome.query}`,
        matches,
      }));
    } else {
      console.error(`Error: Multiple topics match "${outcome.query}":`);
      for (const candidate of outcome.candidates) {
        console.error(`  - ${candidate.palee_id}: ${candidate.title}`);
      }
      console.error('Please provide a more specific query.');
    }
    process.exitCode = ExitCode.Usage;
    return true;
  }

  if (jsonMode) {
    console.error(JSON.stringify({ error: `No topic found matching "${outcome.query}"` }));
  } else {
    console.error(`Error: No topic found matching "${outcome.query}"`);
  }
  process.exitCode = ExitCode.Usage;
  return true;
}

/**
 * CLI command handler for managing learning session lifecycle and working memory.
 *
 * @param action - Session action: `'start'`, `'end'`, `'draft'`, or `'list'`
 * @param options - Session command options (topic, interactive, json)
 * @returns Promise resolving when session action completes
 * @remarks Sets `process.exitCode = 2` on validation/argument error, `4` on OCC conflict, or `5` on runtime error.
 * @example
 * ```typescript
 * await sessionCommand('start', { topic: 'topic-1', interactive: false });
 * ```
 */
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
        // readline stops calling question callbacks once stdin closes, so a
        // prompt outstanding at that moment would never settle and the run
        // would end silently with exit code 0 and the drafts unresolved.
        let inputExhausted = false;
        rl.once('close', () => {
          inputExhausted = true;
        });
        /**
         * Prompts the user with a question string via readline and returns the trimmed response.
         *
         * @param q - Prompt query string
         * @returns Promise resolving to user input text, or `null` when stdin closed before an answer
         * @remarks Wraps readline question in a promise.
         * @example
         * ```typescript
         * const ans = await question('Proceed? ');
         * ```
         */
        function question(q: string): Promise<string | null> {
          return new Promise<string | null>((resolve) => {
            if (inputExhausted) {
              resolve(null);
              return;
            }
            const onClosed = (): void => resolve(null);
            rl.once('close', onClosed);
            rl.question(q, (answer) => {
              rl.off('close', onClosed);
              resolve(answer);
            });
          });
        }

        const unresolvedDrafts: string[] = [];
        for (const draftPath of drafts) {
          const draftName = path.basename(draftPath);
          if (inputExhausted) {
            unresolvedDrafts.push(draftName);
            continue;
          }
          console.log(`\nDraft: ${draftName}`);
          let recoveryAction: DraftRecoveryAction | null = null;
          while (!recoveryAction) {
            const answer = await question('[R]esume  [S]ave as session  [D]iscard  [I]gnore: ');
            if (answer === null) break;
            const trimmed = answer.trim().toLowerCase();
            if (trimmed === 'r') recoveryAction = 'resume';
            else if (trimmed === 's') recoveryAction = 'save';
            else if (trimmed === 'd') recoveryAction = 'discard';
            else if (trimmed === 'i') recoveryAction = 'ignore';
          }
          if (!recoveryAction) {
            unresolvedDrafts.push(draftName);
            continue;
          }
          await recoverDraft(vaultPath, draftPath, recoveryAction);
        }
        rl.close();

        if (unresolvedDrafts.length > 0) {
          // An unanswered menu is the condition the non-interactive path above
          // already refuses with exit 2: the checkpoints are neither resolved
          // nor discarded, so no session may start on top of them.
          console.error('Draft recovery was not completed (stdin closed).');
          console.error('Unresolved draft checkpoint(s):');
          for (const name of unresolvedDrafts) {
            console.error(`  • ${name}`);
          }
          console.error('Run "palee session start --interactive" at a terminal to resolve them.');
          process.exitCode = ExitCode.Usage;
          return;
        }
      }

      // #302: an explicit `--topic` is resolved against the vault before anything is
      // written, so a phantom ID cannot even leave the derived views pointing at it.
      // Without the flag there is nothing to validate yet: the hot-memory fallback
      // stays where it is below, so the `hot.md` read order that
      // `test/session-hot-reads.test.ts` characterizes is untouched.
      const explicitOutcome =
        options.topic && options.topic.trim().length > 0
          ? resolveSessionTopicResolution(vaultPath, options.topic)
          : null;
      if (explicitOutcome && isSessionTopicFailure(explicitOutcome)) {
        reportUnresolvedSessionTopic(explicitOutcome, jsonMode);
        return;
      }

      // Check / rebuild hot memory
      const hotPath = path.join(vaultPath, '.palee', 'hot.md');
      if (!fs.existsSync(hotPath)) {
        console.log('Building working memory (hot.md)...');
        await rebuildHotAndIndex(vaultPath);
      }

      let hotRead = readHotMemory(vaultPath);
      let { frontmatter, body } = hotRead;

      if (hotRead.state === 'corrupt' || hotRead.state === 'schema-invalid') {
        console.warn('Corrupt hot memory detected. Rebuilding...');
        await resetHotMemory(vaultPath);
        await rebuildHotAndIndex(vaultPath);
        hotRead = readHotMemory(vaultPath);
        frontmatter = hotRead.frontmatter;
        body = hotRead.body;
      }

      // hot.md was verified present (or just rebuilt) above; `missing` here means it
      // was removed in that window. The pre-refactor code hit this via an unguarded
      // readFileSync and failed with exit 5 — preserve that outcome instead of
      // reporting a successful start against a vanished working memory.
      if (hotRead.state === 'missing') {
        throw new Error('.palee/hot.md disappeared during session start');
      }

      const resolvedTopic = explicitOutcome
        ? explicitOutcome.kind === 'topic'
          ? explicitOutcome.topicId
          : null
        : resolveSessionTopic(vaultPath, options.topic);
      const nowIso = new Date().toISOString();
      const nowTime = new Date(nowIso).getTime();
      if (resolvedTopic) {
        let startedAtToPersist = nowIso;
        const activeTopic = frontmatter && typeof frontmatter.active_topic === 'string' ? frontmatter.active_topic.trim() : '';
        const rawStarted = frontmatter && typeof frontmatter.started_at === 'string' ? frontmatter.started_at.trim() : '';
        const parsedStart = rawStarted && !Number.isNaN(new Date(rawStarted).getTime()) ? new Date(rawStarted).getTime() : 0;

        // If already active on the same topic and not in future (with 60s skew tolerance), preserve started_at
        if (activeTopic === resolvedTopic && parsedStart > 0 && parsedStart <= nowTime + 60000) {
          startedAtToPersist = new Date(Math.min(parsedStart, nowTime)).toISOString();
        }

        await updateHotMemory(
          vaultPath,
          (frontmatter?.last_session as string) || null,
          resolvedTopic,
          body || '',
          startedAtToPersist
        );
        const refreshed = readHotMemory(vaultPath);
        if (refreshed.state === 'missing') {
          // hot.md existed for the write above; missing immediately after means an
          // external removal in that window. The pre-refactor code hit this via an
          // unguarded readFileSync (exit 5) — preserve that outcome.
          throw new Error('.palee/hot.md disappeared after session start write');
        }
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
      const topicOutcome = resolveSessionTopicResolution(vaultPath, options.topic);
      if (isSessionTopicFailure(topicOutcome)) {
        reportUnresolvedSessionTopic(topicOutcome, jsonMode);
        return;
      }
      const topicId = topicOutcome.kind === 'topic' ? topicOutcome.topicId : null;
      if (!topicId) {
        console.error('Error: Topic required. Specify --topic <topic-id> or start a session on an active topic.');
        process.exitCode = 2;
        return;
      }

      let draftStart = new Date().toISOString();
      try {
        const hot = readHotMemory(vaultPath);
        const fm = hot.frontmatter;
        if (
          fm &&
          fm.active_topic === topicId &&
          typeof fm.started_at === 'string' &&
          fm.started_at.trim().length > 0 &&
          !Number.isNaN(new Date(fm.started_at).getTime())
        ) {
          const parsedCandidate = new Date(fm.started_at.trim()).getTime();
          const nowMs = Date.now();
          if ((nowMs - parsedCandidate) <= 24 * 60 * 60 * 1000 && parsedCandidate <= nowMs) {
            draftStart = fm.started_at.trim();
          }
        }
      } catch {
        // ignore read error
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
      const topicOutcome = resolveSessionTopicResolution(vaultPath, options.topic);
      if (isSessionTopicFailure(topicOutcome)) {
        reportUnresolvedSessionTopic(topicOutcome, jsonMode);
        return;
      }
      const topicId = topicOutcome.kind === 'topic' ? topicOutcome.topicId : null;
      if (!topicId) {
        console.error('Error: Topic required. Specify --topic <topic-id> or start a session on an active topic.');
        process.exitCode = 2;
        return;
      }

      const nowIso = new Date().toISOString();
      const nowTime = new Date(nowIso).getTime();

      // 3-tier timestamp recovery algorithm
      // Tier 1: Check draft checkpoints for earliest started_at
      const matchingDrafts = getTopicDrafts(vaultPath, topicId).filter((d) => {
        if (!d.started_at) return false;
        const t = new Date(d.started_at).getTime();
        return !Number.isNaN(t) && t <= nowTime + 60000;
      });
      let startedAt: string | null = null;
      if (matchingDrafts.length > 0) {
        matchingDrafts.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
        // Stale draft tolerance: clamp to no earlier than 24h before now (matches draft-write path)
        const minStart = nowTime - 24 * 60 * 60 * 1000;
        const draftStart = Math.max(new Date(matchingDrafts[0].started_at).getTime(), minStart);
        startedAt = new Date(Math.min(draftStart, nowTime)).toISOString();
      }

      // Tier 2: Check active hot memory
      if (!startedAt) {
        try {
          const hot = readHotMemory(vaultPath);
          const fm = hot.frontmatter;
          const activeTopic = fm && typeof fm.active_topic === 'string' ? fm.active_topic.trim() : '';
          const rawStarted = fm && typeof fm.started_at === 'string' ? fm.started_at.trim() : '';
          const parsedStart = rawStarted && !Number.isNaN(new Date(rawStarted).getTime()) ? new Date(rawStarted).getTime() : 0;
          if (activeTopic === topicId && parsedStart > 0 && parsedStart <= nowTime + 60000) {
            // Stale hot-memory tolerance: clamp to no earlier than 24h before now (matches Tier-1 draft clamp)
            const minStart = nowTime - 24 * 60 * 60 * 1000;
            startedAt = new Date(Math.max(Math.min(parsedStart, nowTime), minStart)).toISOString();
          }
        } catch {
          // ignore parse error
        }
      }

      // Tier 3: Fallback to current instant
      const endedAt = nowIso;
      if (!startedAt || Number.isNaN(new Date(startedAt).getTime())) {
        startedAt = endedAt;
      }

      // Calculate actual elapsed duration
      const startMs = new Date(startedAt).getTime();
      const endMs = new Date(endedAt).getTime();
      const durationMs = endMs >= startMs ? endMs - startMs : 0;
      const durationMinutes = Number.isFinite(durationMs) ? Math.round(durationMs / 60000) : 0;

      const sessionId = generateSessionId();

      const sessionPath = await writeSessionNote(vaultPath, {
        session_id: sessionId,
        topic_id: topicId,
        started_at: startedAt,
        ended_at: endedAt,
        duration_minutes: durationMinutes,
      }, `Completed learning session for ${topicId}.\nDuration: ${durationMinutes} min.`);

      // Clean up drafts on confirmed session end for the current topic
      const cleanupResult = deleteTopicDrafts(vaultPath, topicId);
      if (cleanupResult.errors.length > 0) {
        console.warn(`⚠ Warning: Failed to clean up ${cleanupResult.errors.length} draft(s) — manual cleanup may be needed.`);
        process.exitCode = 1;
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
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export { sessionCommand };
export default sessionCommand;
