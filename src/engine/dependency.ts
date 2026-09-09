/**
 * Dependency Graph Engine
 *
 * @remarks
 * Analyzes topic prerequisite dependency graphs, executes depth-first cycle detection,
 * verifies prerequisite satisfaction thresholds, and determines which topics are ready for study.
 */

import { TopicNode, ValidationError, ValidationResult } from '../types';
import { MASTERY_THRESHOLD } from './mastery';

/**
 * Returns canonical prerequisite IDs from a topic node.
 *
 * @remarks
 * Reads the canonical `depends_on` field ONLY — the legacy `dependencies`
 * alias is not consulted (canonical since #137; type surface aligned in #140).
 * Storage-layer parsing tolerates the on-disk alias via `normalizeDependencies`,
 * but programmatic callers of the engine barrel must pass `depends_on`.
 *
 * @param topic - Canonical topic node
 * @returns Prerequisite topic IDs
 */
function getTopicDependencies(topic?: Partial<TopicNode> | null): string[] {
  return topic?.depends_on ?? [];
}

/**
 * Rotates a cycle path so its lexicographically-smallest ID leads, giving every
 * rotation of the same loop one canonical representation.
 *
 * @remarks
 * Input must start and end with the same ID (`path[0] === path[path.length - 1]`).
 *
 * @param path - Cycle path with repeated closing ID
 * @returns Canonically rotated copy (same length, closing ID preserved)
 *
 * @example
 * ```typescript
 * canonicalizeCycle(['T-c', 'T-a', 'T-b', 'T-c']); // ['T-a', 'T-b', 'T-c', 'T-a']
 * ```
 */
function canonicalizeCycle(path: string[]): string[] {
  const nodes = path.slice(0, -1);
  if (nodes.length <= 1) return path.slice();
  let minIndex = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIndex]) minIndex = i;
  }
  return nodes.slice(minIndex).concat(nodes.slice(0, minIndex), [nodes[minIndex]]);
}

/**
 * Traverses the dependency graph with a three-color DFS (white = unvisited,
 * gray = on the current path, black = finished), collecting every distinct
 * cycle in the graph.
 *
 * @remarks
 * A back-edge to a gray ancestor closes a cycle; its exact path is read off
 * the gray path stack, canonicalized so the same loop is never reported twice
 * regardless of entry point. Unlike the legacy two-color scan, traversal does
 * not abort on the first cycle — each cyclic component is recorded, and the
 * DFS continues so acyclic components remain usable (spec: three-color DFS with
 * cyclic-component quarantine, `planning/palee_cli_spec.md` §Dependency
 * processing, `planning/invariants.md` line 37).
 *
 * Determinism: roots are visited in `topics` insertion order and prerequisites
 * in declared order, so the returned cycle list is stable for a given map.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns Array of cycle paths (e.g. `[['T-a', 'T-b', 'T-a']]`), empty when acyclic
 */
function detectCycles(topics: Map<string, TopicNode>): string[][] {
  const GRAY = 1;
  const BLACK = 2;

  // White is implicit: absent from the color map.
  const color = new Map<string, number>();
  const pathStack: string[] = [];
  const seen = new Set<string>();
  const cycles: string[][] = [];

  /**
   * Recursive three-color DFS visitor.
   *
   * @param id - Topic identifier to visit
   * @remarks Records a canonicalized cycle on every gray back-edge.
   */
  function visit(id: string): void {
    const state = color.get(id);
    if (state === GRAY) {
      const cycleStart = pathStack.indexOf(id);
      const cycle = canonicalizeCycle(pathStack.slice(cycleStart).concat(id));
      const key = cycle.join('\u0000');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (state === BLACK) return;

    const topic = topics.get(id);
    if (!topic) {
      color.set(id, BLACK);
      return;
    }

    color.set(id, GRAY);
    pathStack.push(id);

    for (const depId of getTopicDependencies(topic)) {
      visit(depId);
    }

    pathStack.pop();
    color.set(id, BLACK);
  }

  for (const id of topics.keys()) {
    visit(id);
  }

  return cycles;
}

/**
 * Detects cyclic dependencies within the topic graph using depth-first search (DFS) with a 3-color visiting state.
 *
 * @remarks
 * Thin compatibility wrapper over {@link detectCycles}: returns the first
 * cycle found in traversal order, or `null` when the graph is acyclic. Callers
 * that need every cyclic component (quarantine, full validation reports) should
 * call {@link detectCycles} directly.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns Array of topic IDs representing the cycle loop (e.g. `['A', 'B', 'C', 'A']`), or `null` if acyclic
 *
 * @example
 * ```typescript
 * const cycle = detectCycle(topicMap);
 * if (cycle) {
 *   console.error(`Dependency cycle: ${cycle.join(' -> ')}`);
 * }
 * ```
 */
function detectCycle(topics: Map<string, TopicNode>): string[] | null {
  const cycles = detectCycles(topics);
  return cycles.length > 0 ? cycles[0] : null;
}

/**
 * Collects every topic that is part of, or downstream of, a dependency cycle.
 *
 * @remarks
 * A topic is cyclic-blocked if it can reach a cycle in the dependency graph —
 * its learning order is undefined even though it is not itself on the loop.
 * Companion topics that merely share an edge with cyclic nodes are NOT
 * blocked: only reachability into a cycle matters.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @param cycles - Cycle paths from {@link detectCycles}
 * @returns Set of topic IDs on or reaching any cycle
 */
function collectBlockedFromCycles(
  topics: Map<string, TopicNode>,
  cycles: string[][]
): Set<string> {
  const blocked = new Set<string>();
  const onCycle = new Set<string>();
  for (const cycle of cycles) {
    for (const id of cycle) onCycle.add(id);
  }

  /**
   * Iterative DFS marking every node whose dependency closure reaches a cycle node.
   *
   * @param start - Topic identifier to explore from
   */
  function markReachableIntoCycle(start: string): void {
    if (blocked.has(start)) return;
    const stack = [start];
    const localVisited = new Set<string>([start]);
    let reachesCycle = onCycle.has(start);

    while (stack.length > 0) {
      const id = stack.pop()!;
      const topic = topics.get(id);
      if (!topic) continue;
      for (const depId of getTopicDependencies(topic)) {
        if (onCycle.has(depId)) reachesCycle = true;
        if (!localVisited.has(depId)) {
          localVisited.add(depId);
          stack.push(depId);
        }
      }
    }

    if (reachesCycle) {
      for (const id of localVisited) blocked.add(id);
    }
  }

  for (const id of topics.keys()) {
    markReachableIntoCycle(id);
  }

  return blocked;
}

/**
 * Quarantines cyclic components from the topic graph so acyclic components keep working.
 *
 * @remarks
 * Implements the spec's quarantine contract: every topic on or downstream of a
 * dependency cycle is removed from the working graph (its learning order is
 * undefined), while all other topics — including those in unrelated acyclic
 * components — remain usable by `next`/`plan`. The returned `acyclic` map
 * preserves the original insertion order of surviving topics; `cycles` carries
 * the exact canonicalized cycle paths for reporting.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns `{ acyclic, cycles }` — the cycle-free subgraph and every distinct cycle path
 *
 * @example
 * ```typescript
 * const { acyclic, cycles } = quarantineCyclicTopics(topicMap);
 * const ready = getReadyTopics(acyclic);
 * ```
 */
function quarantineCyclicTopics(topics: Map<string, TopicNode>): {
  acyclic: Map<string, TopicNode>;
  cycles: string[][];
} {
  const cycles = detectCycles(topics);
  if (cycles.length === 0) {
    return { acyclic: new Map(topics), cycles };
  }

  const blocked = collectBlockedFromCycles(topics, cycles);
  const acyclic = new Map<string, TopicNode>();
  for (const [id, topic] of topics) {
    if (!blocked.has(id)) acyclic.set(id, topic);
  }

  return { acyclic, cycles };
}

/**
 * Checks whether all prerequisite dependencies for a given topic exist and meet or exceed the mastery threshold.
 *
 * @param topic - The topic node whose dependencies are being evaluated
 * @param topics - Map of all known topic nodes in the vault
 * @param threshold - Minimum mastery score required (default: {@link MASTERY_THRESHOLD} = 0.70)
 * @returns `true` if all prerequisite dependencies exist and have `topic_mastery >= threshold`, otherwise `false`
 *
 * @remarks
 * Validates that every prerequisite is present in the vault and has achieved the target mastery score.
 *
 * @example
 * ```typescript
 * const satisfied = areDependenciesSatisfied(topic, topicMap, 0.7);
 * ```
 */
function areDependenciesSatisfied(
  topic: TopicNode,
  topics: Map<string, TopicNode>,
  threshold: number = MASTERY_THRESHOLD
): boolean {
  const deps = getTopicDependencies(topic);

  for (const depId of deps) {
    const depTopic = topics.get(depId);
    if (!depTopic) {
      return false; // Missing dependency
    }

    const mastery = depTopic.topic_mastery || 0;
    if (mastery < threshold) {
      return false; // Dependency not mastered
    }
  }

  return true;
}

/**
 * Identifies unmastered topics whose prerequisite dependencies are fully satisfied and ready for study.
 *
 * @remarks
 * Filters topics where:
 * 1. `topic_mastery < threshold` (not yet mastered)
 * 2. Every prerequisite dependency has `topic_mastery >= threshold`
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @param threshold - Mastery threshold score (default: {@link MASTERY_THRESHOLD} = 0.70)
 * @returns Array of {@link TopicNode} objects ready for immediate learning, sorted by `palee_id`
 *
 * @example
 * ```typescript
 * const ready = getReadyTopics(topicMap);
 * console.log(`Ready to study: ${ready.map(t => t.title).join(', ')}`);
 * ```
 */
function getReadyTopics(
  topics: Map<string, TopicNode>,
  threshold: number = MASTERY_THRESHOLD
): TopicNode[] {
  const ready: TopicNode[] = [];

  for (const [, topic] of topics) {
    const mastery = topic.topic_mastery || 0;

    // Skip if already mastered
    if (mastery >= threshold) continue;

    // Check dependencies
    if (areDependenciesSatisfied(topic, topics, threshold)) {
      ready.push(topic);
    }
  }

  // Deterministic output contract (#79): ascending palee_id, independent of
  // vault-walk insertion order. Presentation sorts (difficulty, due date)
  // build on this stable base.
  ready.sort((a, b) => a.palee_id.localeCompare(b.palee_id));
  return ready;
}

/**
 * Validates the topological integrity of the complete dependency graph.
 *
 * @remarks
 * Performs two verification checks:
 * 1. Missing dependencies: Ensures all referenced prerequisite IDs exist in the vault.
 * 2. Cycles: Runs {@link detectCycles} and reports EVERY cyclic component
 *    (one error per distinct cycle, with its exact canonicalized path) instead
 *    of aborting at the first — acyclic components stay usable (#79).
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns {@link ValidationResult} containing boolean status and any detected {@link ValidationError} items
 *
 * @example
 * ```typescript
 * const result = validateDependencyGraph(topicMap);
 * if (!result.valid) {
 *   console.error('Validation errors found:', result.errors);
 * }
 * ```
 */
function validateDependencyGraph(topics: Map<string, TopicNode>): ValidationResult {
  const errors: ValidationError[] = [];

  // Check for missing dependencies
  for (const [id, topic] of topics) {
    const deps = getTopicDependencies(topic);
    for (const depId of deps) {
      if (!topics.has(depId)) {
        errors.push({
          type: 'missing_dependency',
          topic: id,
          missing: depId,
          message: `Topic ${id} depends on missing topic ${depId}`,
        });
      }
    }
  }

  // Check for cycles — report every distinct cyclic component (#79)
  const cycles = detectCycles(topics);
  for (const cycle of cycles) {
    errors.push({
      type: 'cycle',
      path: cycle,
      message: `Circular dependency detected: ${cycle.join(' -> ')}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export {
  detectCycle,
  detectCycles,
  quarantineCyclicTopics,
  areDependenciesSatisfied,
  getReadyTopics,
  validateDependencyGraph,
  getTopicDependencies,
};
