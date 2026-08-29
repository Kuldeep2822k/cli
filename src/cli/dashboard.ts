/**
 * Dashboard Command Handler
 * Interactive learning dashboard (Phase 1: text summary only)
 */

import { loadTopics } from '../storage/loader';
import { MASTERY_THRESHOLD } from '../engine/mastery';

import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
import { Difficulty, DashboardOptions } from '../types';


interface DashboardTopic {
  id: string;
  title: string;
  mastery: number;
  repetition: number;
  lapses: number;
  difficulty: Difficulty;
  due_at: Date | null;
}

/**
 * CLI command handler for displaying the learning dashboard summary.
 *
 * @param options - Dashboard display options including optional `--json` format.
 * @returns Promise resolving when dashboard output finishes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * and process.exitCode = 5 on unexpected exceptions.
 */
async function dashboardCommand(options: DashboardOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
    if (!vaultPath) return;

    const loaded = loadTopics(vaultPath);
    const now = new Date();

    const topics: DashboardTopic[] = loaded.map((t) => {
      let dueAt = t.due_at ? new Date(t.due_at) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) {
        dueAt = null;
      }
      return {
        id: t.palee_id,
        title: t.title,
        mastery: t.topic_mastery,
        repetition: t.repetition ?? 0,
        lapses: t.lapses ?? 0,
        difficulty: t.difficulty ?? 'intermediate',
        due_at: dueAt,
      };
    });


    if (topics.length === 0) {
      if (jsonMode) {
        console.log(JSON.stringify({
          total_topics: 0,
          mastered: 0,
          learning: 0,
          new: 0,
          mastered_pct: 0,
          learning_pct: 0,
          new_pct: 0,
          reviews_due: 0,
          by_difficulty: {
            beginner: { total: 0, mastered: 0 },
            intermediate: { total: 0, mastered: 0 },
            advanced: { total: 0, mastered: 0 },
          },
          next_review: null,
        }));
        return;
      }
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║              PALEE Learning Dashboard                     ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log();
      printEmptyVaultOnboarding();
      return;
    }

    // Stats
    const total = topics.length;
    const mastered = topics.filter(t => t.mastery >= MASTERY_THRESHOLD).length;
    const learning = topics.filter(t => t.mastery > 0 && t.mastery < MASTERY_THRESHOLD).length;
    const newTopics = topics.filter(t => t.mastery === 0).length;
    const dueTopics = topics.filter(t => t.due_at && t.due_at <= now);
    const due = dueTopics.length;

    const masteredPct = total > 0 ? (mastered / total * 100).toFixed(1) : '0.0';
    const learningPct = total > 0 ? (learning / total * 100).toFixed(1) : '0.0';
    const newPct = total > 0 ? (newTopics / total * 100).toFixed(1) : '0.0';

    const byDiff: Record<string, DashboardTopic[]> = {
      beginner: topics.filter(t => t.difficulty === 'beginner'),
      intermediate: topics.filter(t => t.difficulty === 'intermediate'),
      advanced: topics.filter(t => t.difficulty === 'advanced'),
    };

    let next: DashboardTopic | null = null;
    if (dueTopics.length > 0) {
      dueTopics.sort((a, b) => {
        if (!a.due_at) return -1;
        if (!b.due_at) return 1;
        return a.due_at.getTime() - b.due_at.getTime();
      });
      next = dueTopics[0];
    }

    if (jsonMode) {
      console.log(JSON.stringify({
        total_topics: total,
        mastered,
        learning,
        new: newTopics,
        mastered_pct: total > 0 ? Number(masteredPct) : 0,
        learning_pct: total > 0 ? Number(learningPct) : 0,
        new_pct: total > 0 ? Number(newPct) : 0,
        reviews_due: due,
        by_difficulty: {
          beginner: {
            total: byDiff.beginner.length,
            mastered: byDiff.beginner.filter(t => t.mastery >= MASTERY_THRESHOLD).length,
          },
          intermediate: {
            total: byDiff.intermediate.length,
            mastered: byDiff.intermediate.filter(t => t.mastery >= MASTERY_THRESHOLD).length,
          },
          advanced: {
            total: byDiff.advanced.length,
            mastered: byDiff.advanced.filter(t => t.mastery >= MASTERY_THRESHOLD).length,
          },
        },
        next_review: next ? {
          id: next.id,
          title: next.title,
          mastery: next.mastery,
          repetition: next.repetition,
          due_at: next.due_at ? next.due_at.toISOString() : null,
        } : null,
      }));
      return;
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              PALEE Learning Dashboard                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    console.log(`Total Topics:      ${total}`);
    console.log(`Mastered (≥70%):   ${mastered} (${masteredPct}%)`);
    console.log(`Learning:          ${learning} (${learningPct}%)`);
    console.log(`New:               ${newTopics} (${newPct}%)`);
    console.log(`Due for Review:    ${due}`);
    console.log();

    // By difficulty
    console.log('By Difficulty:');
    for (const [level, list] of Object.entries(byDiff)) {
      if (list.length > 0) {
        const masteredInLevel = list.filter(t => t.mastery >= MASTERY_THRESHOLD).length;

        console.log(`  ${level.padEnd(15)}: ${list.length} topics (${masteredInLevel} mastered)`);
      }
    }
    console.log();

    // Next review
    if (next) {
      console.log('Next Review:');
      console.log(`  ${next.title} (${next.id})`);
      console.log(`  Mastery: ${(next.mastery * 100).toFixed(1)}% | Reps: ${next.repetition}`);
      console.log();
    }

    console.log('─────────────────────────────────────────────────────────────');
    console.log('Run "palee next" to start reviewing');
    console.log('Run "palee plan" to see today\'s learning plan');

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = 5;
    return;
  }
}

export { dashboardCommand };
export default dashboardCommand;
