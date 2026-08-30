import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
/**
 * Next Command Handler
 * Shows next topic(s) due for review
 */

import { loadTopics } from '../storage';
import { Difficulty, NextOptions } from '../types';


interface DueTopic {
  id: string;
  title: string;
  path: string;
  dueAt: Date | null;
  mastery: number;
  repetition: number;
  difficulty?: Difficulty;
}

/**
 * CLI command handler for showing the next due topics for review.
 *
 * @param options - Next command options including `--tag`, `--difficulty`, and `--json`.
 * @returns Promise resolving when output is complete.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * and process.exitCode = 5 on unexpected exceptions.
 */
async function nextCommand(options: NextOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
    if (!vaultPath) return;

    const topics = loadTopics(vaultPath);
    const totalTopics = topics.length;
    const dueTopics: DueTopic[] = [];
    const now = new Date();

    for (const t of topics) {
      let dueAt = t.due_at ? new Date(t.due_at) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) {
        dueAt = null; // Treat invalid dates as null (due immediately)
      }

      // Topics without due_at (or with invalid dates) are new and always ready
      if (!dueAt || dueAt <= now) {
        dueTopics.push({
          id: t.palee_id,
          title: t.title,
          path: t.path,
          dueAt: dueAt,
          mastery: t.topic_mastery,
          repetition: t.repetition ?? 0,
          difficulty: t.difficulty,
        });
      }
    }


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

    // Sort by due date (null first, then oldest)
    dueTopics.sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return -1;
      if (!b.dueAt) return 1;
      return a.dueAt.getTime() - b.dueAt.getTime();
    });

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
    process.exitCode = 5;
    return;
  }
}

export { nextCommand };
export default nextCommand;
