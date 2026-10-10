import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
import { exitCodeFor } from './exit-codes';
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
        status: t.status,
        depends_on: t.depends_on,
        depends_on_source: t.depends_on_source,
        due_at: dueAt,
        repetition: t.repetition ?? 0,
        difficulty: t.difficulty ?? 'intermediate',
      });
    }

    // Archived topics are excluded from every derived plan figure (BUG-002),
    // matching `palee progress`. `total_topics` still counts all loaded notes.
    // The archived nodes stay in the graph itself: an archived prerequisite
    // that is already mastered must keep satisfying its dependents, whereas
    // dropping it would make `areDependenciesSatisfied` read it as a *missing*
    // dependency and silently hide ready topics.
    const activeTopics = Array.from(topics.values()).filter(t => t.status !== 'archived');
    const archivedCount = topics.size - activeTopics.length;

    const dueTopics: PlanTopic[] = [];
    for (const topic of activeTopics) {
      if (!topic.due_at || topic.due_at <= now) {
        dueTopics.push(topic);
      }
    }

    if (topics.size === 0) {
      if (jsonMode) {
        console.log(JSON.stringify({
          total_topics: 0,
          active_topic_count: 0,
          archived_topic_count: 0,
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

    // Quarantine counter covers learnable topics only (BUG-002).
    const quarantinedActiveCount = activeTopics.filter(t => !acyclicTopics.has(t.palee_id)).length;

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

    const masteredCount = activeTopics.filter(t => t.topic_mastery >= MASTERY_THRESHOLD).length;
    const learningCount = activeTopics.filter(t => t.topic_mastery > 0 && t.topic_mastery < MASTERY_THRESHOLD).length;
    const newCount = activeTopics.filter(t => t.topic_mastery === 0).length;

    // A topic whose prerequisites are unmet is simply absent from the ready
    // list, which is indistinguishable from "nothing left to study" — and when
    // the prerequisite id no longer resolves, no amount of reviewing will ever
    // make it appear. Name the blocker and what would clear it.
    const readyIds = new Set(readyTopics.map((t) => t.palee_id));
    const blocked: { id: string; title: string; waiting_on: string[] }[] = [];
    for (const [id, topic] of acyclicTopics) {
      // An archived note is not study material, so it cannot be "blocked by
      // prerequisites" either — reporting it here would re-introduce the leak
      // this change exists to close, through a section that did not exist when
      // the branch was written.
      if (topic.status === 'archived') continue;
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
      console.log(JSON.stringify({
        total_topics: topics.size,
        active_topic_count: activeTopics.length,
        archived_topic_count: archivedCount,
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
        quarantined_cycles: quarantinedCycles,
        quarantined_cycles_truncated: cyclesTruncated,
        blocked,
        counts: {
          due: dueTopics.length,
          ready: readyTopics.length,
          blocked: blocked.length,
          // `topics.size - acyclicTopics.size` would count an archived topic
          // sitting on a cycle; BUG-002 is that archived notes are reported as
          // if they were still study material, so the quarantined tally reads off
          // the active set like every other number in this payload.
          quarantined: quarantinedActiveCount,
          mastered: masteredCount,
          learning: learningCount,
          new: newCount,
        },
      }));
      return;
    }

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

    // Section 4: Summary stats — active topics only, archived called out
    // separately (BUG-002), mirroring `palee progress`.
    console.log('Progress Summary:');
    console.log(`  Total Topics: ${activeTopics.length}${archivedCount > 0 ? ` (${archivedCount} archived)` : ''}`);
    console.log(`  Mastered (≥70%): ${masteredCount}`);
    console.log(`  Learning: ${learningCount}`);
    console.log(`  New: ${newCount}`);

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export { planCommand };
export default planCommand;
