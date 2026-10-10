/**
 * Dashboard Command Handler
 * Interactive learning dashboard (Phase 1: text summary only)
 */

import { loadTopics } from '../storage';
import { MASTERY_THRESHOLD } from '../engine/mastery';
import { normalizeDueDate, partitionDue } from '../application/due-topics';
import { getNextTopics } from '../application/get-next-topics';
import { summarizeMastery } from '../application/mastery-summary';

import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
import { exitCodeFor } from './exit-codes';
import { Difficulty, DashboardOptions } from '../types';


interface DashboardTopic {
  id: string;
  title: string;
  mastery: number;
  repetition: number;
  lapses: number;
  difficulty: Difficulty;
  status: string;
  due_at: Date | null;
}

/**
 * CLI command handler for displaying the learning dashboard summary.
 *
 * @param options - Dashboard display options including optional `--json` format.
 * @returns Promise resolving when dashboard output finishes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * and process.exitCode = 5 on unexpected exceptions.
 *
 * @example
 * ```typescript
 * await dashboardCommand({ json: true });
 * ```
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
      return {
        id: t.palee_id,
        title: t.title,
        mastery: t.topic_mastery,
        repetition: t.repetition ?? 0,
        lapses: t.lapses ?? 0,
        difficulty: t.difficulty ?? 'intermediate',
        status: typeof t.status === 'string' ? t.status : 'not_started',
        due_at: normalizeDueDate(t.due_at),
      };
    });


    if (topics.length === 0) {
      if (jsonMode) {
        console.log(JSON.stringify({
          total_topics: 0,
          active_topic_count: 0,
          archived_topic_count: 0,
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
      console.log('║                  PALEE Learning Dashboard                  ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log();
      printEmptyVaultOnboarding();
      return;
    }

    // Stats — archived topics are excluded from every derived figure (BUG-002),
    // matching `palee progress`. `total_topics` still counts all loaded notes.
    const activeTopics = topics.filter(t => t.status !== 'archived');
    const archivedCount = topics.length - activeTopics.length;

    const total = activeTopics.length;
    const { mastered, learning, new: newTopics } = summarizeMastery(activeTopics.map(t => t.mastery));
    // The dashboard's "Due for Review" is a review-backlog metric: never-reviewed
    // topics are reported separately as "New", so only elapsed scheduled reviews
    // count here (dueReviews), unlike `next`/`plan`.
    const dueTopics = partitionDue(activeTopics, now, t => t.due_at).dueReviews;
    const due = dueTopics.length;

    const masteredPct = total > 0 ? (mastered / total * 100).toFixed(1) : '0.0';
    const learningPct = total > 0 ? (learning / total * 100).toFixed(1) : '0.0';
    const newPct = total > 0 ? (newTopics / total * 100).toFixed(1) : '0.0';

    const byDiff: Record<string, DashboardTopic[]> = {
      beginner: activeTopics.filter(t => t.difficulty === 'beginner'),
      intermediate: activeTopics.filter(t => t.difficulty === 'intermediate'),
      advanced: activeTopics.filter(t => t.difficulty === 'advanced'),
    };

    // `next_review` is "the review `palee next` would hand you now", so it draws
    // from that command's own prerequisite-gated actionable set (#307 residue):
    // a never-reviewed note is actionable for `next`, and reporting
    // `next_review: null` while printing `Run "palee next" to start reviewing`
    // contradicted the prompt two lines later. Archived topics stay hidden
    // (BUG-002), while the graph the gate reads is the full loaded set — so a
    // mastered archived prerequisite still satisfies its dependents. This does
    // not touch the `reviews_due` backlog metric above, which counts elapsed
    // scheduled reviews only.
    const { dueTopics: actionable } = getNextTopics(loaded, now);
    const next = actionable.find((t) => t.status !== 'archived') ?? null;

    if (jsonMode) {
      console.log(JSON.stringify({
        total_topics: topics.length,
        active_topic_count: total,
        archived_topic_count: archivedCount,
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
          due_at: next.dueAt ? next.dueAt.toISOString() : null,
        } : null,
      }));
      return;
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                  PALEE Learning Dashboard                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    console.log(`Total Topics:      ${total}${archivedCount > 0 ? ` (${archivedCount} archived)` : ''}`);
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

    console.log('──────────────────────────────────────────────────────────────');
    console.log('Run "palee next" to start reviewing');
    console.log('Run "palee plan" to see today\'s learning plan');

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export { dashboardCommand };
export default dashboardCommand;
