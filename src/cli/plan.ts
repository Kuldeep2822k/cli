import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
/**
 * Plan Command Handler
 * Shows learning plan for the day
 */

import { loadTopics } from '../storage/loader';
import { getReadyTopics } from '../engine/dependency';
import { MASTERY_THRESHOLD } from '../engine/mastery';
import { Difficulty, PlanOptions, TopicNode } from '../types';





interface PlanTopic extends TopicNode {
  title: string;
  path: string;
  due_at: Date | null;
  repetition: number;
  difficulty: Difficulty;
}

/**
 * CLI command handler for displaying the daily learning plan.
 *
 * @param options - Plan command options including `--ready`, `--all`, `--limit`, `--tag`, `--difficulty`, and `--json`.
 * @returns Promise resolving when plan output finishes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path or invalid options,
 * and process.exitCode = 5 on unexpected exceptions.
 */
async function planCommand(options: PlanOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
    if (!vaultPath) return;

    const loaded = loadTopics(vaultPath);
    const topics = new Map<string, PlanTopic>();
    const now = new Date();

    for (const t of loaded) {
      let dueAt = t.due_at ? new Date(t.due_at) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) {
        dueAt = null;
      }

      topics.set(t.palee_id, {
        palee_id: t.palee_id,
        title: t.title,
        path: t.path,
        topic_mastery: t.topic_mastery,
        depends_on: t.depends_on,
        due_at: dueAt,
        repetition: t.repetition ?? 0,
        difficulty: t.difficulty ?? 'intermediate',
      });
    }


    const dueTopics: PlanTopic[] = [];
    for (const topic of topics.values()) {
      if (!topic.due_at || topic.due_at <= now) {
        dueTopics.push(topic);
      }
    }

    if (topics.size === 0) {
      if (jsonMode) {
        console.log(JSON.stringify({
          total_topics: 0,
          reviews_due: [],
          ready_to_learn: [],
          counts: {
            due: 0,
            ready: 0,
            mastered: 0,
            learning: 0,
            new: 0,
          },
        }));
        return;
      }
      console.log('=== Today\'s Learning Plan ===\n');
      printEmptyVaultOnboarding();
      return;
    }

    // Get ready to learn (deps satisfied, not mastered)
    const readyTopics = getReadyTopics(topics, MASTERY_THRESHOLD) as PlanTopic[];

    const diffOrder: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };
    const sortedDue = dueTopics.slice().sort((a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return -1;
      if (!b.due_at) return 1;
      return a.due_at.getTime() - b.due_at.getTime();
    });
    const sortedReady = readyTopics.slice().sort((a, b) => {
      return (diffOrder[a.difficulty] ?? 1) - (diffOrder[b.difficulty] ?? 1);
    });

    const masteredCount = Array.from(topics.values()).filter(t => t.topic_mastery >= MASTERY_THRESHOLD).length;
    const learningCount = Array.from(topics.values()).filter(t => t.topic_mastery > 0 && t.topic_mastery < MASTERY_THRESHOLD).length;
    const newCount = Array.from(topics.values()).filter(t => t.topic_mastery === 0).length;


    if (jsonMode) {
      console.log(JSON.stringify({
        total_topics: topics.size,
        reviews_due: sortedDue.map(t => ({
          id: t.palee_id,
          title: t.title,
          path: t.path,
          due_at: t.due_at ? t.due_at.toISOString() : null,
          repetition: t.repetition,
          difficulty: t.difficulty,
        })),
        ready_to_learn: sortedReady.map(t => ({
          id: t.palee_id,
          title: t.title,
          path: t.path,
          topic_mastery: t.topic_mastery,
          difficulty: t.difficulty,
        })),
        counts: {
          due: dueTopics.length,
          ready: readyTopics.length,
          mastered: masteredCount,
          learning: learningCount,
          new: newCount,
        },
      }));
      return;
    }

    console.log('=== Today\'s Learning Plan ===\n');

    // Section 1: Due for review
    console.log(`Reviews Due: ${dueTopics.length}`);
    if (dueTopics.length > 0) {
      for (let i = 0; i < Math.min(5, sortedDue.length); i++) {
        const topic = sortedDue[i];
        const dueStr = topic.due_at
          ? topic.due_at.toISOString().split('T')[0]
          : 'Never reviewed';
        console.log(`  • ${topic.title} (${topic.palee_id}) - Due: ${dueStr}`);
      }

      if (sortedDue.length > 5) {
        console.log(`  ... and ${sortedDue.length - 5} more`);
      }
    }
    console.log();

    // Section 2: Ready to learn
    console.log(`Ready to Learn: ${readyTopics.length}`);
    if (readyTopics.length > 0) {
      for (let i = 0; i < Math.min(5, sortedReady.length); i++) {
        const topic = sortedReady[i];
        console.log(`  • ${topic.title} (${topic.palee_id}) - ${topic.difficulty}`);
      }

      if (sortedReady.length > 5) {
        console.log(`  ... and ${sortedReady.length - 5} more`);
      }
    }
    console.log();

    // Section 3: Summary stats
    console.log('Progress Summary:');
    console.log(`  Total Topics: ${topics.size}`);
    console.log(`  Mastered (≥70%): ${masteredCount}`);
    console.log(`  Learning: ${learningCount}`);
    console.log(`  New: ${newCount}`);

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = 5;
    return;
  }
}

export { planCommand };
export default planCommand;
