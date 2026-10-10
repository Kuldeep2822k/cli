import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
import { exitCodeFor } from './exit-codes';
/**
 * Next Command Handler
 * Shows next topic(s) due for review
 */

import { loadTopics } from '../storage';
import { getNextTopics } from '../application/get-next-topics';
import { NextOptions } from '../types';

/**
 * Machine-readable gating state for `next --json` (#305).
 *
 * - `ready` — {@link NextJson.next} names a topic.
 * - `blocked` — nothing is actionable, and every candidate is waiting on a
 *   prerequisite listed in `blocked`.
 * - `nothing_due` — nothing is actionable and nothing is blocked: either the
 *   vault is empty or every review is scheduled for the future.
 *
 * @remarks Additive keys only; `next`, `due_count`, `due_topics` and
 * `total_topics` keep their existing meaning (INV-30).
 */
type NextStatus = 'ready' | 'blocked' | 'nothing_due';

/**
 * CLI command handler for showing the next due topics for review.
 *
 * @param options - Next command options including `--all` and `--json`.
 * @returns Promise resolving when output is complete.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * and process.exitCode = 5 on unexpected exceptions.
 *
 * @example
 * ```typescript
 * await nextCommand({ all: true });
 * ```
 */
async function nextCommand(options: NextOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
    if (!vaultPath) return;

    const topics = loadTopics(vaultPath);
    const { dueTopics, totalTopics, blockedTopics } = getNextTopics(topics, new Date());

    const status: NextStatus = dueTopics.length > 0 ? 'ready' :
      blockedTopics.length > 0 ? 'blocked' : 'nothing_due';

    if (totalTopics === 0) {
      if (jsonMode) {
        if (options.all) {
          console.log(JSON.stringify({ due_topics: [], total_topics: 0, next: null, status, blocked: [] }));
        } else {
          console.log(JSON.stringify({ next: null, due_count: 0, total_topics: 0, status, blocked: [] }));
        }
        return;
      }
      printEmptyVaultOnboarding();
      return;
    }

    if (dueTopics.length === 0) {
      if (jsonMode) {
        const blocked = blockedTopics.map((t) => ({
          id: t.id,
          title: t.title,
          path: t.path,
          mastery: t.mastery,
          waiting_on: t.waiting_on,
        }));
        if (options.all) {
          console.log(JSON.stringify({
            due_topics: [],
            total_topics: totalTopics,
            next: null,
            status,
            blocked,
          }));
        } else {
          console.log(JSON.stringify({
            next: null,
            due_count: 0,
            total_topics: totalTopics,
            status,
            blocked,
          }));
        }
        return;
      }
      if (blockedTopics.length > 0) {
        printBlockedTopics(blockedTopics);
        return;
      }
      console.log('No topics due for review.');
      return;
    }

    if (jsonMode) {
      const serializedDue = dueTopics.map(t => ({
        id: t.id,
        title: t.title,
        path: t.path,
        due_at: t.dueAt ? t.dueAt.toISOString() : null,
        mastery: t.mastery,
        repetition: t.repetition,
      }));
      const blocked = blockedTopics.map((t) => ({
        id: t.id,
        title: t.title,
        path: t.path,
        mastery: t.mastery,
        waiting_on: t.waiting_on,
      }));

      if (options.all) {
        console.log(JSON.stringify({
          due_topics: serializedDue,
          total_topics: totalTopics,
          next: serializedDue[0] || null,
          status,
          blocked,
        }));
      } else {
        console.log(JSON.stringify({
          next: serializedDue[0] || null,
          due_count: dueTopics.length,
          total_topics: totalTopics,
          status,
          blocked,
        }));
      }
      return;
    }

    if (options.all) {
      console.log(`${dueTopics.length} topic(s) due for review:\n`);
      for (const topic of dueTopics) {
        const dueStr = topic.dueAt
          ? topic.dueAt.toISOString().split('T')[0]
          : 'Never reviewed';
        console.log(`  ${topic.id} - ${topic.title}`);
        console.log(`    Due: ${dueStr} | Mastery: ${(topic.mastery * 100).toFixed(1)}% | Reps: ${topic.repetition}`);
        console.log(`    Path: ${topic.path}`);
        console.log();
      }
    } else {
      const next = dueTopics[0];
      const dueStr = next.dueAt
        ? next.dueAt.toISOString().split('T')[0]
        : 'Never reviewed';

      console.log('Next topic due for review:');
      console.log();
      console.log(`  ${next.title}`);
      console.log(`  ID: ${next.id}`);
      console.log(`  Due: ${dueStr}`);
      console.log(`  Mastery: ${(next.mastery * 100).toFixed(1)}%`);
      console.log(`  Repetitions: ${next.repetition}`);
      console.log(`  Path: ${next.path}`);
      console.log();
    }

    // A topic the learner expected to see is absent because a prerequisite is
    // unmet; name that instead of leaving the gap unexplained (#305).
    if (blockedTopics.length > 0) {
      printBlockedCountWarning(blockedTopics.length);
    }

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

/**
 * Nothing is actionable and every candidate is gated: say so, and name each
 * blocking prerequisite with its mastery against the readiness threshold,
 * rather than silently returning the blocked topic or claiming nothing is due.
 */
function printBlockedTopics(
  blockedTopics: { id: string; title: string; waiting_on: string[] }[]
): void {
  console.log('Nothing to review — every due topic is blocked by prerequisites:\n');
  for (const topic of blockedTopics.slice(0, 5)) {
    console.log(`  • ${topic.title} (${topic.id}) — waiting on ${topic.waiting_on.join('; ')}`);
  }
  if (blockedTopics.length > 5) {
    console.log(`  ... and ${blockedTopics.length - 5} more`);
  }
  console.log();
  console.log('Study the prerequisite first (see: palee plan).');
}

/** Trailing note for the ready paths: some due topics were withheld by the gate. */
function printBlockedCountWarning(count: number): void {
  if (count === 1) {
    console.log('⚠ 1 due topic is waiting on a prerequisite — see: palee plan');
  } else {
    console.log(`⚠ ${count} due topics are waiting on prerequisites — see: palee plan`);
  }
}

export { nextCommand };
export default nextCommand;
