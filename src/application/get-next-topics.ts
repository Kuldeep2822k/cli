/**
 * `get-next-topics` use-case: the pure core behind `palee next`.
 *
 * Given loaded topics and the current time, it returns the actionable set
 * (never-reviewed topics plus elapsed reviews) ordered null-first then oldest,
 * **restricted to topics whose prerequisites are satisfied**, along with the
 * topics it withheld and why. It touches no Commander or process state so it
 * can be unit-tested and reused by non-CLI interfaces — and reused by the other
 * read models: `plan` dedupes its "Reviews Due" list against this gate (#306)
 * and `dashboard` draws `next_review` from it (#307 residue), so a learner
 * never gets two answers about the same note.
 */

import { LoadedTopic } from '../storage';
import { areDependenciesSatisfied, getTopicDependencies, quarantineCyclicTopics } from '../engine/dependency';
import { MASTERY_THRESHOLD } from '../engine/mastery';
import { Difficulty, TopicNode } from '../types';
import { compareDue, normalizeDueDate, partitionDue } from './due-topics';

export interface NextTopic {
  id: string;
  title: string;
  path: string;
  dueAt: Date | null;
  mastery: number;
  repetition: number;
  difficulty?: Difficulty;
  /**
   * Frontmatter `status` (`not_started` / `learning` / `archived` / …).
   *
   * @remarks Carried so a consumer that must hide archived notes — `dashboard`
   * (BUG-002) — can filter this set without re-deriving the ordering rules.
   */
  status?: string;
}

/**
 * A due topic that the prerequisite gate withheld, with the blockers named in
 * the exact wording `palee plan` uses for its "Blocked by prerequisites" list.
 */
export interface BlockedNextTopic {
  id: string;
  title: string;
  path: string;
  /** Mastery of the blocked topic itself (always below the threshold). */
  mastery: number;
  /** Human-readable blocker phrases; never empty. */
  waiting_on: string[];
}

export interface NextTopicsResult {
  /** Actionable topics, ordered never-reviewed first then oldest due. */
  dueTopics: NextTopic[];
  /** Count of all loaded topics (not just the due ones). */
  totalTopics: number;
  /**
   * Due topics excluded from {@link NextTopicsResult.dueTopics} because a
   * prerequisite is unmet (#305). Topics not due at all are never listed —
   * nothing was withheld from them.
   */
  blockedTopics: BlockedNextTopic[];
}

/**
 * Names the prerequisites that currently hold `topic` back.
 *
 * @remarks
 * Presentation half of the gate: the decision itself is the engine's
 * {@link areDependenciesSatisfied}, never a re-derivation of it. This walks the
 * same dependency list only to phrase each blocker — a dangling reference is
 * reported as missing (INV-24), an unmastered one as mastery against
 * `MASTERY_THRESHOLD`, matching `plan`'s wording byte-for-byte.
 *
 * @param topic - Candidate topic
 * @param topics - Full topic graph, keyed by `palee_id`
 * @param threshold - Mastery a prerequisite must reach to stop gating
 * @returns One phrase per unmet prerequisite; empty when nothing gates
 */
function describeUnmetDependencies(
  topic: TopicNode,
  topics: Map<string, TopicNode>,
  threshold: number
): string[] {
  const waitingOn: string[] = [];
  for (const depId of getTopicDependencies(topic)) {
    const dep = topics.get(depId);
    if (!dep) {
      waitingOn.push(`${depId} is not in the vault (run palee validate)`);
      continue;
    }
    const depMastery = dep.topic_mastery ?? 0;
    if (depMastery < threshold) {
      const title = dep.title ?? depId;
      waitingOn.push(`${title} (${depId}) at mastery ${depMastery.toFixed(4)}, needs ${threshold.toFixed(2)}`);
    }
  }
  return waitingOn;
}

/**
 * The shared prerequisite gate: which of these topics cannot be studied yet?
 *
 * @remarks
 * A topic is blocked when all three hold — it is not archived, it is not yet
 * mastered (`topic_mastery < threshold`, so reviewing an already-learned note
 * is never gated), and the engine's {@link areDependenciesSatisfied} says a
 * prerequisite is unmet (INV-24, INV-47). Advisory edges (`toc`, `tie`) and
 * missing references are handled by that predicate, so this stays in step with
 * `getReadyTopics` without duplicating any mastery comparison.
 *
 * Topics on or downstream of a dependency cycle are never reported as blocked
 * (INV-25): their ordering claim is what got quarantined, so the gate is
 * undefined for them, and `plan` keeps such a note in "Reviews Due" and reports
 * it under Quarantined Cycles instead. `next` must not disagree by silently
 * withholding it.
 *
 * The graph is built from every topic passed in, archived ones included:
 * dropping an archived prerequisite would read as a *missing* dependency and
 * hide ready topics (BUG-002).
 *
 * @param topics - Loaded topics — the vault graph as one read model sees it
 * @param threshold - Mastery a prerequisite must reach to stop gating
 * @returns Map of blocked `palee_id` to blocker details, in graph order
 */
export function findPrerequisiteBlocked(
  topics: readonly TopicNode[],
  threshold: number = MASTERY_THRESHOLD
): Map<string, BlockedNextTopic> {
  const blocked = new Map<string, BlockedNextTopic>();

  const graph = new Map<string, TopicNode>();
  let hasEdges = false;
  for (const topic of topics) {
    graph.set(topic.palee_id, topic);
    if ((topic.depends_on ?? []).length > 0) hasEdges = true;
  }
  // No prerequisites anywhere: nothing can gate, and cycle enumeration (which
  // needs edges) cannot find a cycle either. Skip both passes.
  if (!hasEdges) return blocked;

  const { acyclic } = quarantineCyclicTopics(graph);

  for (const [id, topic] of acyclic) {
    if (topic.status === 'archived') continue;
    const mastery = topic.topic_mastery ?? 0;
    if (mastery >= threshold) continue;
    if (areDependenciesSatisfied(topic, graph, threshold)) continue;
    const waitingOn = describeUnmetDependencies(topic, graph, threshold);
    if (waitingOn.length === 0) continue;
    blocked.set(id, {
      id,
      title: topic.title ?? id,
      path: topic.path ?? '',
      mastery,
      waiting_on: waitingOn,
    });
  }

  return blocked;
}

export function getNextTopics(topics: LoadedTopic[], now: Date): NextTopicsResult {
  const blocked = findPrerequisiteBlocked(topics);

  const candidates: NextTopic[] = topics.map((t) => ({
    id: t.palee_id,
    title: t.title,
    path: t.path,
    dueAt: normalizeDueDate(t.due_at),
    mastery: t.topic_mastery,
    repetition: t.repetition ?? 0,
    difficulty: t.difficulty,
    status: typeof t.status === 'string' ? t.status : undefined,
  }));

  // `next`/`plan` treat `neverReviewed ∪ dueReviews` as actionable (see
  // partitionDue), minus whatever the prerequisite gate holds back (#305).
  const { dueReviews, neverReviewed } = partitionDue(candidates, now, (c) => c.dueAt);
  const actionable = [...neverReviewed, ...dueReviews].sort((a, b) => compareDue(a.dueAt, b.dueAt));

  const dueTopics: NextTopic[] = [];
  const blockedTopics: BlockedNextTopic[] = [];
  for (const topic of actionable) {
    const blocker = blocked.get(topic.id);
    if (blocker) {
      blockedTopics.push({
        id: topic.id,
        title: topic.title,
        path: topic.path,
        mastery: topic.mastery,
        waiting_on: blocker.waiting_on,
      });
    } else {
      dueTopics.push(topic);
    }
  }

  return { dueTopics, totalTopics: topics.length, blockedTopics };
}
