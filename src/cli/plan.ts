import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
import { ExitCode } from './exit-codes';
/**
 * Plan Command Handler
 * Shows learning plan for the day
 */

import { loadTopics } from '../storage';
import { getReadyTopics, getTopicDependencies, quarantineCyclicTopics } from '../engine/dependency';
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
 * @param options - Plan command options including `--json`.
 * @returns Promise resolving when plan output finishes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path or invalid options,
 * and process.exitCode = 5 on unexpected exceptions.
 * A blocked note appears under Blocked only, never also under Reviews Due;
 * mastery buckets always reconcile (new is the remainder after mastered/learning).
 *
 * @example
 * ```typescript
 * await planCommand({ json: true });
 * ```
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
        depends_on_source: t.depends_on_source,
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
          quarantined_cycles: [],
          quarantined_cycles_truncated: false,
          blocked: [],
          counts: {
            due: 0,
            ready: 0,
            blocked: 0,
            quarantined: 0,
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

    // Quarantine cyclic components before computing readiness (#79): topics on
    // or downstream of a dependency cycle have undefined learning order, so the
    // ready-to-learn list is computed over the acyclic subgraph only. Reviews
    // due (SM-2 state) stay on the full map — a quarantined topic's review
    // schedule is still real.
    const { acyclic: acyclicTopics, cycles: quarantinedCycles, truncated: cyclesTruncated } = quarantineCyclicTopics(topics);

    // Get ready to learn (deps satisfied, not mastered) — acyclic components only
    const readyTopics = getReadyTopics(acyclicTopics, MASTERY_THRESHOLD) as PlanTopic[];

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

    // Mastery buckets always reconcile with the total: mastered and learning
    // are counted directly, and new is the remainder — so a missing or
    // non-numeric mastery reads as new rather than vanishing from the summary.
    const masteredCount = Array.from(topics.values()).filter(t => (t.topic_mastery ?? 0) >= MASTERY_THRESHOLD).length;
    const learningCount = Array.from(topics.values()).filter(t => {
      const mastery = t.topic_mastery ?? 0;
      return mastery > 0 && mastery < MASTERY_THRESHOLD;
    }).length;
    const newCount = topics.size - masteredCount - learningCount;

    // A topic whose prerequisites are unmet is simply absent from the ready
    // list, which is indistinguishable from "nothing left to study" — and when
    // the prerequisite id no longer resolves, no amount of reviewing will ever
    // make it appear. Name the blocker and what would clear it.
    const readyIds = new Set(readyTopics.map((t) => t.palee_id));
    const blocked: { id: string; title: string; waiting_on: string[] }[] = [];
    for (const [id, topic] of acyclicTopics) {
      if ((topic.topic_mastery ?? 0) >= MASTERY_THRESHOLD) continue;
      if (readyIds.has(id)) continue;
      const waitingOn: string[] = [];
      for (const depId of getTopicDependencies(topic)) {
        const dep = topics.get(depId);
        if (!dep) {
          waitingOn.push(`${depId} is not in the vault (run palee validate)`);
          continue;
        }
        const depMastery = dep.topic_mastery ?? 0;
        if (depMastery < MASTERY_THRESHOLD) {
          waitingOn.push(
            `${dep.title ?? depId} (${depId}) at mastery ${depMastery.toFixed(4)}, needs ${MASTERY_THRESHOLD.toFixed(2)}`
          );
        }
      }
      if (waitingOn.length > 0) {
        blocked.push({ id, title: topic.title ?? id, waiting_on: waitingOn });
      }
    }

    if (jsonMode) {
      // A blocked note is not an actionable review: it appears under Blocked
      // with its prerequisite, never twice. Quarantined reviews stay, per the
      // SM-2 comment above — only prerequisite-blocked notes are hidden here.
      const blockedIds = new Set(blocked.map((b) => b.id));
      const visibleDue = sortedDue.filter((t) => !blockedIds.has(t.palee_id));
      console.log(JSON.stringify({
        total_topics: topics.size,
        reviews_due: visibleDue.map(t => ({
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
        quarantined_cycles: quarantinedCycles,
        quarantined_cycles_truncated: cyclesTruncated,
        blocked,
        counts: {
          due: visibleDue.length,
          ready: readyTopics.length,
          blocked: blocked.length,
          quarantined: topics.size - acyclicTopics.size,
          mastered: masteredCount,
          learning: learningCount,
          new: newCount,
        },
      }));
      return;
    }

    // Human path uses the same de-duplication as JSON: blocked notes live
    // under Blocked only, so Reviews Due never names a note twice.
    const blockedIds = new Set(blocked.map((b) => b.id));
    const visibleDue = sortedDue.filter((t) => !blockedIds.has(t.palee_id));

    console.log('=== Today\'s Learning Plan ===\n');

    // Section 0: Quarantined dependency cycles (ready list excludes them)
    if (quarantinedCycles.length > 0) {
      console.log(`Quarantined Cycles: ${quarantinedCycles.length}${cyclesTruncated ? ' (truncated — more cycles exist)' : ''}`);
      for (const cycle of quarantinedCycles) {
        console.log(`  ⚠ Dependency cycle quarantined: ${cycle.join(' → ')}`);
      }
      console.log('  Topics on these cycles (and their dependents) are excluded from Ready to Learn.');
      console.log();
    }

    // Section 1: Due for review (blocked notes excluded above)
    console.log(`Reviews Due: ${visibleDue.length}`);
    if (visibleDue.length > 0) {
      for (let i = 0; i < Math.min(5, visibleDue.length); i++) {
        const topic = visibleDue[i];
        const dueStr = topic.due_at
          ? topic.due_at.toISOString().split('T')[0]
          : 'Never reviewed';
        console.log(`  • ${topic.title} (${topic.palee_id}) - Due: ${dueStr}`);
      }

      if (visibleDue.length > 5) {
        console.log(`  ... and ${visibleDue.length - 5} more`);
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

    // Section 3: Blocked by prerequisites — the topics absent from the list
    // above, and why.
    if (blocked.length > 0) {
      console.log(`Blocked by prerequisites: ${blocked.length}`);
      for (const item of blocked.slice(0, 5)) {
        console.log(`  • ${item.title} (${item.id}) — waiting on ${item.waiting_on.join('; ')}`);
      }

      if (blocked.length > 5) {
        console.log(`  ... and ${blocked.length - 5} more`);
      }
      console.log();
    }

    // Section 4: Summary stats
    console.log('Progress Summary:');
    console.log(`  Total Topics: ${topics.size}`);
    console.log(`  Mastered (≥70%): ${masteredCount}`);
    console.log(`  Learning: ${learningCount}`);
    console.log(`  New: ${newCount}`);

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = ExitCode.Unexpected;
    return;
  }
}

export { planCommand };
export default planCommand;
