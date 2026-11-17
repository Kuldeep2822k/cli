/**
 * Roadmap Chain Synthesis (`--auto-chain` by `order`)
 *
 * @remarks
 * The chain-synthesis phase of `palee roadmap --from`, extracted from the
 * handler in `src/cli/roadmap.ts` by the P3-14 phase split (#565): topics with
 * an `order` field are chained head-to-tail, explicit dependencies always win,
 * and a synthesized edge that would close a cycle is dropped with a warning
 * instead of aborting the import (#73, INV-47). The validation pass labels the
 * edges this pass invented; the field derivation the notes are written with
 * lives in `./roadmap-resolve`.
 */

import { RoadmapTopic } from '../types';

/** Outcome of {@link applyRoadmapAutoChain}, used for deferred logging and cycle labels. */
export interface RoadmapChainResult {
  /** Every edge this pass synthesized, keyed `childId\u0000predecessorId` */
  synthesizedEdges: Set<string>;
  /** Edges dropped because they would have closed a cycle */
  skippedEdges: { from: string; to: string }[];
}

/**
 * Chains roadmap topics by their `order` field (#73, INV-47).
 *
 * @param topics - Roadmap topics, mutated in place
 * @returns Which edges were synthesized, and which were dropped as cycle-closing
 *
 * @remarks
 * Topics with an `order` sort first (ascending); topics without one keep
 * their file order and are appended after the ordered ones. A topic with no
 * (or an empty) `depends_on` is chained to the previous topic's ID — the
 * chain head receives nothing, so the dependencies its note already carries
 * on disk stay (#322). An explicit non-empty `depends_on`
 * always wins over the synthesized chain, and a topic whose dependencies are
 * already final (`chained`) is left alone.
 *
 * A synthesized edge is dropped, with a warning, when the predecessor already
 * reaches the topic through explicit or earlier synthesized deps: adding it
 * would close a cycle. The chain then simply restarts at that topic, whose own
 * `depends_on` is left exactly as authored, so an authored dependency and an
 * ordering coincidence cannot abort the import.
 * This reachability view covers the roadmap's own topics; a cycle that closes
 * only once existing vault topics are merged is still caught, fail-closed, by
 * the caller's graph validation.
 */
export function applyRoadmapAutoChain(topics: RoadmapTopic[]): RoadmapChainResult {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const synthesizedEdges = new Set<string>();
  const skippedEdges: { from: string; to: string }[] = [];

  const indexed = topics.map((topic, index) => ({ topic, index }));
  indexed.sort((a, b) => {
    const orderA = a.topic.order ?? Number.POSITIVE_INFINITY;
    const orderB = b.topic.order ?? Number.POSITIVE_INFINITY;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.index - b.index;
  });

  /** True when `start` already reaches `target` through dependencies assigned so far. */
  const reaches = (start: string, target: string): boolean => {
    const stack = [start];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === target) {
        return true;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      for (const dep of byId.get(id)?.depends_on ?? []) {
        stack.push(dep);
      }
    }
    return false;
  };

  indexed.forEach(({ topic }, rank) => {
    if (topic.chained || (topic.depends_on && topic.depends_on.length > 0)) {
      return;
    }
    if (rank === 0) {
      // Left unassigned rather than set to `[]` (#322): the head note may
      // already carry hand-authored dependencies on disk, and an explicit
      // empty list wins over preservation in `resolveTopicUpdates`, erasing
      // them. Same rule as the cycle-skip branch below.
      return;
    }
    const predecessorEntry = indexed[rank - 1];
    if (predecessorEntry === undefined) {
      // Unreachable: `rank === 0` returned above and `rank < indexed.length`,
      // so `rank - 1` is a valid index.
      return;
    }
    const predecessorId = predecessorEntry.topic.id;
    if (reaches(predecessorId, topic.id)) {
      // Left unassigned rather than set to `[]`: skipping an edge must not
      // also erase dependencies the note already had on disk, which an
      // explicit empty list would do (see `resolveTopicUpdates`).
      skippedEdges.push({ from: topic.id, to: predecessorId });
      console.log(
        `⚠ Warning: chain edge ${topic.id} -> ${predecessorId} skipped: would close a cycle. ` +
          `${topic.id} starts a new chain.`
      );
      return;
    }
    topic.depends_on = [predecessorId];
    synthesizedEdges.add(`${topic.id}\u0000${predecessorId}`);
  });

  return { synthesizedEdges, skippedEdges };
}
