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
 * A malformed path (too short or not self-closing) is a caller bug — throw
 * loudly rather than canonicalize garbage.
 *
 * @param path - Cycle path with repeated closing ID
 * @returns Canonically rotated copy (same length, closing ID preserved)
 * @throws When the path is not a self-closing cycle of at least 2 entries
 *
 * @example
 * ```typescript
 * canonicalizeCycle(['T-c', 'T-a', 'T-b', 'T-c']); // ['T-a', 'T-b', 'T-c', 'T-a']
 * ```
 */
function canonicalizeCycle(path: string[]): string[] {
  if (path.length < 2 || path[0] !== path[path.length - 1]) {
    throw new Error(
      `Invalid cycle path: must start and end with the same ID (got [${path.join(', ')}])`
    );
  }
  const nodes = path.slice(0, -1);
  if (nodes.length <= 1) return path.slice();
  let minIndex = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIndex]) minIndex = i;
  }
  return nodes.slice(minIndex).concat(nodes.slice(0, minIndex), [nodes[minIndex]]);
}

/**
 * Directed-edge view of the dependency graph, restricted to edges between
 * known topics and deduplicated so parallel/identical `depends_on` entries
 * cannot multiply traversal work. Self-edges are retained: a topic that
 * depends on itself is a one-node cycle (`T-a -> T-a`).
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns Map of topic ID to its unique, resolvable prerequisite IDs
 */
function buildEdgeMap(topics: Map<string, TopicNode>): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const [id, topic] of topics) {
    const seen = new Set<string>();
    const deps: string[] = [];
    for (const depId of getTopicDependencies(topic)) {
      if (topics.has(depId) && !seen.has(depId)) {
        seen.add(depId);
        deps.push(depId);
      }
    }
    edges.set(id, deps);
  }
  return edges;
}

/**
 * Enumerates the simple (elementary) cycles of one strongly connected component
 * using an explicit-stack adaptation of Johnson's algorithm.
 *
 * @remarks
 * Each cycle is canonicalized by {@link canonicalizeCycle} and deduplicated,
 * so every distinct loop inside the SCC is reported exactly once, with its
 * exact node path — including loops that share nodes or edges. Iteration is
 * ordered by the SCC's sorted node list, keeping the output deterministic.
 *
 * Johnson's deferred unblocking is preserved: a node whose subtree closed no
 * cycle stays blocked after backtracking and is recorded in its successors' B
 * sets, so fruitless regions are not re-explored per reaching path — the
 * enumeration cost stays proportional to the cycles reported, not to the
 * number of simple paths.
 *
 * @param scc - Nodes of one strongly connected component
 * @param edges - Deduplicated edge map (from {@link buildEdgeMap})
 * @param seen - Cross-call dedup set of canonicalized cycle keys
 * @param cycles - Output accumulator for canonicalized cycle paths
 */
function enumerateSccCycles(
  scc: Set<string>,
  edges: Map<string, string[]>,
  seen: Set<string>,
  cycles: string[][],
  maxCycles: number
): boolean {
  const order = Array.from(scc).sort();
  for (let startIndex = 0; startIndex < order.length; startIndex++) {
    const start = order[startIndex];
    // Nodes at or before `startIndex` are already covered as starts of earlier
    // scans; excluding them here prevents re-enumerating the same loops.
    const subScc = new Set(order.slice(startIndex));
    // Johnson's bookkeeping: `blocked` holds the current path plus every node
    // proven fruitless for it; `bSets` remembers, per node, which nodes were
    // blocked because they led into it.
    const blocked = new Set<string>([start]);
    const bSets = new Map<string, Set<string>>();
    // Per path entry: did this node's subtree close a cycle?
    const foundCycle: boolean[] = [false];

    // Explicit-stack DFS from `start`; path always begins at `start`.
    const path: string[] = [start];
    // Per path-node iterator state so backtracking resumes where it left off.
    // Popped frames are never re-entered (the descend branch always resets
    // to 0), so stale entries are harmless.
    const iterators = new Map<string, number>([[start, 0]]);

    while (path.length > 0) {
      // Budget: stop the entire enumeration once the cap is hit. Dense
      // SCCs can contain exponentially many elementary cycles; callers get
      // a bounded sample plus a truncation flag instead of an unbounded wait.
      if (cycles.length >= maxCycles) return true;
      const current = path[path.length - 1];
      const neighbors = edges.get(current) ?? [];
      let i = iterators.get(current) ?? 0;
      let advanced = false;

      while (i < neighbors.length) {
        const next = neighbors[i];
        i++;
        if (next === start) {
          // Closed a cycle through every node currently on the path.
          const cycle = canonicalizeCycle(path.concat(start));
          const key = cycle.join('\u0000');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
          foundCycle[path.length - 1] = true;
        } else if (subScc.has(next) && !blocked.has(next)) {
          // Descend. `blocked` subsumes path membership: `start` and every
          // pushed node are blocked, so a blocked `next` is either on the
          // path or provably fruitless for it.
          iterators.set(current, i);
          blocked.add(next);
          path.push(next);
          iterators.set(next, 0);
          foundCycle.push(false);
          advanced = true;
          break;
        }
      }

      if (!advanced) {
        // Exhausted `current`'s edges: backtrack.
        path.pop();
        if (foundCycle.pop()) {
          // A cycle closed below: propagate to the parent frame and unblock
          // `current` plus every blocked node whose only route led through
          // it. The cascade runs on an explicit work list, so large SCCs
          // cannot exhaust the call stack.
          if (foundCycle.length > 0) foundCycle[foundCycle.length - 1] = true;
          const work = [current];
          while (work.length > 0) {
            const node = work.pop()!;
            if (!blocked.has(node)) continue;
            blocked.delete(node);
            const routes = bSets.get(node);
            if (routes !== undefined) {
              for (const route of routes) work.push(route);
              routes.clear();
            }
          }
        } else {
          // No cycle below `current`: keep it blocked and record it in its
          // successors' B sets, so a later unblock cascade can free it.
          for (const succ of edges.get(current) ?? []) {
            if (!subScc.has(succ)) continue;
            let routes = bSets.get(succ);
            if (routes === undefined) {
              routes = new Set<string>();
              bSets.set(succ, routes);
            }
            routes.add(current);
          }
        }
      }
    }
  }

  // Every start node was exhausted without hitting the budget.
  return false;
}

/**
 * Enumerates every distinct simple cycle in the topic graph.
 *
 * @remarks
 * Two-stage, recursion-free algorithm (stack-safe for deep dependency chains
 * and large strongly connected components):
 * 1. Strongly connected components via an iterative Tarjan pass. Any topic
 *    outside a multi-node SCC is provably cycle-free — except a singleton
 *    with a self-edge (`T-a` depends on `T-a`), which is a one-node cycle.
 * 2. Elementary-cycle enumeration inside each multi-node SCC (Johnson-style,
 *    with explicit stacks — including the unblock cascade), canonicalized so
 *    every distinct loop is reported exactly once with its exact path —
 *    including overlapping cycles that share nodes or back edges. Acyclic
 *    components are never touched, matching the spec's quarantine contract
 *    (`planning/palee_cli_spec.md` §Dependency processing,
 *    `planning/invariants.md` line 37).
 *
 * Determinism: enumeration inside an SCC starts from sorted nodes, and the
 * final cycle list is sorted by canonical path, so the output is stable for
 * a given graph regardless of map insertion order.
 *
 * Complexity: O(V + E) for SCC detection plus Johnson's bound per cyclic SCC.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns Array of cycle paths (e.g. `[['T-a', 'T-b', 'T-a']]`), empty when acyclic
 */
function detectCycles(topics: Map<string, TopicNode>): string[][] {
  return detectCyclesCore(topics, Number.POSITIVE_INFINITY).cycles;
}

/**
 * Result shape for bounded cycle enumeration.
 */
export interface DetectCyclesResult {
  /** Distinct canonicalized cycle paths, sorted; possibly truncated */
  cycles: string[][];
  /** True when `maxCycles` stopped the enumeration early */
  truncated: boolean;
}

/**
 * Bounded cycle enumeration for user-facing commands.
 *
 * @remarks
 * Same enumeration as {@link detectCycles}, capped at `maxCycles` distinct
 * cycles (default 1000). Dense-but-valid dependency SCCs contain
 * exponentially many elementary cycles; interactive commands (`plan`) use
 * this form so pathological vaults produce output in bounded time with a
 * `truncated` flag instead of an unbounded wait. Quarantine correctness is
 * unaffected — membership comes from SCC analysis, not the sample.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @param maxCycles - Maximum distinct cycles to record (default 1000)
 * @returns Sorted cycle list (possibly truncated) plus the truncation flag
 */
function detectCyclesBounded(
  topics: Map<string, TopicNode>,
  maxCycles: number = 1000
): DetectCyclesResult {
  return detectCyclesCore(topics, maxCycles);
}

/**
 * Core enumeration shared by the unbounded and bounded public forms.
 */
function detectCyclesCore(topics: Map<string, TopicNode>, maxCycles: number): DetectCyclesResult {
  const edges = buildEdgeMap(topics);

  // ── Stage 1: iterative Tarjan SCC ──────────────────────────────────
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const tarjanStack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  // Frame: [node, next-neighbor-index]. Simulates recursion explicitly.
  const frames: Array<[string, number]> = [];
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    frames.push([root, 0]);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [node] = frame;
      if (!index.has(node)) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        tarjanStack.push(node);
        onStack.add(node);
      }

      const neighbors = edges.get(node) ?? [];
      let descended = false;
      while (frame[1] < neighbors.length) {
        const next = neighbors[frame[1]];
        frame[1]++;
        if (!index.has(next)) {
          frames.push([next, 0]);
          descended = true;
          break;
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
        }
      }
      if (descended) continue;

      // All neighbors processed — is this an SCC root?
      if (lowlink.get(node) === index.get(node)) {
        const scc: string[] = [];
        let popped: string;
        do {
          popped = tarjanStack.pop()!;
          onStack.delete(popped);
          scc.push(popped);
        } while (popped !== node);
        sccs.push(scc);
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1];
        lowlink.set(parent[0], Math.min(lowlink.get(parent[0])!, lowlink.get(node)!));
      }
    }
  }

  // ── Stage 2: enumerate cycles in each SCC ───────────────────────────
  // Multi-node SCCs: full elementary-cycle enumeration. Singleton SCCs:
  // cyclic only via a self-edge (T-a depends on T-a) — a one-node cycle.
  // `maxCycles` bounds the work: dense SCCs contain exponentially many
  // elementary cycles, and consumers only need a bounded sample plus the
  // knowledge that truncation happened.
  const seen = new Set<string>();
  const cycles: string[][] = [];
  let truncated = false;
  for (const scc of sccs) {
    if (cycles.length >= maxCycles) {
      truncated = true;
      break;
    }
    if (scc.length === 1) {
      const node = scc[0];
      if ((edges.get(node) ?? []).includes(node)) {
        cycles.push([node, node]);
      }
      continue;
    }
    if (enumerateSccCycles(new Set(scc), edges, seen, cycles, maxCycles)) {
      truncated = true;
      break;
    }
  }

  // Tarjan discovers SCCs in insertion-dependent order; sort the final list
  // so the contract holds — stable output regardless of map insertion order.
  // Each path is canonically rotated, so its joined form is a stable key.
  cycles.sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : a.join('\u0000') > b.join('\u0000') ? 1 : 0));

  return { cycles, truncated };
}

/**
 * Detects cyclic dependencies within the topic graph.
 *
 * @remarks
 * Thin compatibility wrapper over {@link detectCycles}: returns the first
 * cycle in {@link detectCycles}'s sorted canonical order (lexicographically
 * smallest path first), or `null` when the graph is acyclic — including
 * self-referential topics (`T-a` depends on `T-a`), reported as
 * `['T-a', 'T-a']`. Callers that need every cyclic component (quarantine,
 * full validation reports) should call {@link detectCycles} directly.
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
 * Finds every node that sits on at least one dependency cycle.
 *
 * @remarks
 * Membership is derived from strongly connected components — a node is
 * cyclic iff it belongs to a multi-node SCC or has a self-edge — which is
 * O(V+E) and independent of cycle ENUMERATION. This is the truncation-proof
 * primitive: {@link detectCyclesBounded} may cap its output for pathological
 * graphs (dense SCCs contain exponentially many elementary cycles), but
 * quarantine membership never depends on how many cycles were listed.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns Set of IDs on at least one cycle
 */
function findCyclicSccNodes(topics: Map<string, TopicNode>): Set<string> {
  const edges = buildEdgeMap(topics);

  // Iterative Tarjan SCC (same frame simulation as detectCyclesCore).
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const tarjanStack: string[] = [];
  let counter = 0;
  const cyclic = new Set<string>();

  const frames: Array<[string, number]> = [];
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    frames.push([root, 0]);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [node] = frame;
      if (!index.has(node)) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        tarjanStack.push(node);
        onStack.add(node);
      }

      const neighbors = edges.get(node) ?? [];
      let descended = false;
      while (frame[1] < neighbors.length) {
        const next = neighbors[frame[1]];
        frame[1]++;
        if (!index.has(next)) {
          frames.push([next, 0]);
          descended = true;
          break;
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
        }
      }
      if (descended) continue;

      if (lowlink.get(node) === index.get(node)) {
        const scc: string[] = [];
        let popped: string;
        do {
          popped = tarjanStack.pop()!;
          onStack.delete(popped);
          scc.push(popped);
        } while (popped !== node);
        if (scc.length > 1) {
          for (const id of scc) cyclic.add(id);
        } else if ((edges.get(node) ?? []).includes(node)) {
          cyclic.add(node); // self-loop: T-a depends on T-a
        }
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1];
        lowlink.set(parent[0], Math.min(lowlink.get(parent[0])!, lowlink.get(node)!));
      }
    }
  }

  return cyclic;
}

/**
 * Collects every topic that is part of, or downstream of, a dependency cycle.
 *
 * @remarks
 * A topic is cyclic-blocked if it can reach a cycle in the dependency graph —
 * its learning order is undefined even though it is not itself on the loop.
 * Companion topics that merely share an edge with cyclic nodes are NOT
 * blocked: only reverse reachability from an on-cycle node matters. A topic
 * whose sibling prerequisite is acyclic stays usable.
 *
 * Computed in O(V + E): a single reverse-graph traversal (dependents →
 * prerequisites inverted) seeded from all on-cycle nodes, instead of a
 * per-node forward closure.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @param cycles - Cycle paths from {@link detectCycles}
 * @returns Set of topic IDs on any cycle or depending (transitively) on one
 */
function collectBlockedFromCycles(
  topics: Map<string, TopicNode>,
  cycles: string[][],
  cyclicNodes?: Set<string>
): Set<string> {
  const blocked = new Set<string>();
  const onCycle = new Set<string>();
  for (const cycle of cycles) {
    for (const id of cycle) onCycle.add(id);
  }
  // SCC membership is the authoritative on-cycle set — every enumerated
  // cycle only visits cyclic nodes, but the reverse does not hold when the
  // enumeration is truncated, so seed from membership when available.
  if (cyclicNodes !== undefined) {
    for (const id of cyclicNodes) onCycle.add(id);
  }
  if (onCycle.size === 0) return blocked;

  // Reverse edges: prerequisite -> dependents.
  const dependents = new Map<string, string[]>();
  for (const [id, topic] of topics) {
    for (const depId of getTopicDependencies(topic)) {
      if (!topics.has(depId) || depId === id) continue;
      const list = dependents.get(depId);
      if (list) list.push(id);
      else dependents.set(depId, [id]);
    }
  }

  // Seed with on-cycle nodes and walk dependents transitively: every topic
  // that depends on a blocked topic is itself blocked.
  const stack = Array.from(onCycle);
  for (const id of onCycle) blocked.add(id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const dependentId of dependents.get(id) ?? []) {
      if (!blocked.has(dependentId)) {
        blocked.add(dependentId);
        stack.push(dependentId);
      }
    }
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
  truncated: boolean;
} {
  // Membership first: SCC analysis decides WHAT to quarantine in O(V+E),
  // independent of how many cycles the (bounded) enumeration lists.
  const cyclicNodes = findCyclicSccNodes(topics);
  if (cyclicNodes.size === 0) {
    return { acyclic: new Map(topics), cycles: [], truncated: false };
  }

  // Display sample: bounded enumeration so pathological-but-valid vaults
  // (dense SCCs with exponentially many elementary cycles) cannot stall
  // `plan`; `truncated` tells callers the list is a sample, not a census.
  const { cycles, truncated } = detectCyclesBounded(topics);

  const blocked = collectBlockedFromCycles(topics, cycles, cyclicNodes);
  const acyclic = new Map<string, TopicNode>();
  for (const [id, topic] of topics) {
    if (!blocked.has(id)) acyclic.set(id, topic);
  }

  return { acyclic, cycles, truncated };
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

  // Deterministic output contract (#79): ascending palee_id by code-unit
  // comparison — locale-independent and stable across runtimes, matching the
  // comparison `canonicalizeCycle` uses. Presentation sorts (difficulty, due
  // date) build on this stable base.
  ready.sort((a, b) => (a.palee_id < b.palee_id ? -1 : a.palee_id > b.palee_id ? 1 : 0));
  return ready;
}

/**
 * Finds every dependency reference that points to a non-existent topic.
 *
 * @remarks
 * The missing-dependency half of {@link validateDependencyGraph}, extracted
 * so callers can check dangling references without also paying for cycle
 * detection. Findings carry the engine's canonical `missing_dependency`
 * `ValidationError` shape. Deterministic: iterates the map in insertion
 * order, dependencies in list order.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns One `missing_dependency` error per dangling reference
 *
 * @example
 * ```typescript
 * const missing = findMissingDependencies(topicMap);
 * if (missing.length > 0) {
 *   console.error('Dangling references:', missing.map((e) => e.missing));
 * }
 * ```
 */
function findMissingDependencies(topics: Map<string, TopicNode>): ValidationError[] {
  const errors: ValidationError[] = [];
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
  return errors;
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
  errors.push(...findMissingDependencies(topics));

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
  detectCyclesBounded,
  quarantineCyclicTopics,
  findCyclicSccNodes,
  areDependenciesSatisfied,
  getReadyTopics,
  validateDependencyGraph,
  findMissingDependencies,
  getTopicDependencies,
};
