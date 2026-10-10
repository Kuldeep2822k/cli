import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
import { ExitCode } from './exit-codes';
/**
 * Next Command Handler
 * Shows next topic(s) due for review
 */

import { loadTopics } from '../storage';
import { getNextTopics } from '../application/get-next-topics';
import { NextOptions } from '../types';

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
    const { dueTopics, totalTopics } = getNextTopics(topics, new Date());

    if (totalTopics === 0) {
      if (jsonMode) {
        if (options.all) {
          console.log(JSON.stringify({ due_topics: [], total_topics: 0, next: null }));
        } else {
          console.log(JSON.stringify({ next: null, due_count: 0, total_topics: 0 }));
        }
        return;
      }
      printEmptyVaultOnboarding();
      return;
    }

    if (dueTopics.length === 0) {
      if (jsonMode) {
        if (options.all) {
          console.log(JSON.stringify({ due_topics: [], total_topics: totalTopics, next: null }));
        } else {
          console.log(JSON.stringify({ next: null, due_count: 0, total_topics: totalTopics }));
        }
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

      if (options.all) {
        console.log(JSON.stringify({
          due_topics: serializedDue,
          total_topics: totalTopics,
          next: serializedDue[0] || null,
        }));
      } else {
        console.log(JSON.stringify({
          next: serializedDue[0] || null,
          due_count: dueTopics.length,
          total_topics: totalTopics,
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
    }

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = ExitCode.Unexpected;
    return;
  }
}

export { nextCommand };
export default nextCommand;
