import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  detectCycle,
  detectCycles,
  detectCyclesBounded,
  findCyclicSccNodes,
  getReadyTopics,
  quarantineCyclicTopics,
  validateDependencyGraph,
} from '../src/engine/dependency';
import { TopicNode } from '../src/types';

describe('Dependency Graph', () => {


  test('detects simple cycle', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const cycle = detectCycle(topics);
    assert.ok(cycle !== null);
    assert.ok(cycle!.includes('T-a'));
    assert.ok(cycle!.includes('T-b'));
  });

  test('detects longer cycle', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-c'], topic_mastery: 0 }],
      ['T-c', { palee_id: 'T-c', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const cycle = detectCycle(topics);
    assert.ok(cycle !== null);
    assert.strictEqual(cycle!.length, 4); // a -> b -> c -> a
  });

  test('returns null when no cycle exists', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: [], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-c', { palee_id: 'T-c', depends_on: ['T-b'], topic_mastery: 0 }],
    ]);

    const cycle = detectCycle(topics);
    assert.strictEqual(cycle, null);
  });

  // ─── #79: multi-cycle enumeration ───────────────────────────────────

  test('detectCycles enumerates every distinct cycle (#79)', () => {
    // Two disjoint cycles: T-a→T-b→T-a and T-c→T-d→T-c
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-c', { palee_id: 'T-c', depends_on: ['T-d'], topic_mastery: 0 }],
      ['T-d', { palee_id: 'T-d', depends_on: ['T-c'], topic_mastery: 0 }],
    ]);

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 2, 'Both disjoint cycles must be reported');

    const keys = cycles.map(c => c.join('\u0000')).sort();
    assert.ok(keys.includes('T-a\u0000T-b\u0000T-a'));
    assert.ok(keys.includes('T-c\u0000T-d\u0000T-c'));
  });

  test('detectCycles reports a figure-eight graph without duplication (#79)', () => {
    // Shared node T-x closes two distinct loops:
    // T-a→T-x→T-a and T-b→T-x→T-b
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-x'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-x'], topic_mastery: 0 }],
      ['T-x', { palee_id: 'T-x', depends_on: ['T-a', 'T-b'], topic_mastery: 0 }],
    ]);

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 2, 'Each distinct loop through the shared node is its own cycle');
    const keys = cycles.map(c => c.join('\u0000')).sort();
    assert.ok(keys.includes('T-a\u0000T-x\u0000T-a'));
    assert.ok(keys.includes('T-b\u0000T-x\u0000T-b'));
  });

  test('detectCycles reports overlapping cycles sharing an edge path (#79 review fix)', () => {
    // greptile/kilo case: A -> [B, C], B -> A, C -> B.
    // Both A-B-A and A-C-B-A must be reported — a plain three-color DFS
    // misses the second because B is BLACK when reached via C.
    const topics = new Map<string, TopicNode>([
      ['A', { palee_id: 'A', depends_on: ['B', 'C'], topic_mastery: 0 }],
      ['B', { palee_id: 'B', depends_on: ['A'], topic_mastery: 0 }],
      ['C', { palee_id: 'C', depends_on: ['B'], topic_mastery: 0 }],
    ]);

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 2, 'overlapping cycles sharing nodes must both be reported');
    const keys = cycles.map(c => c.join('\u0000')).sort();
    assert.ok(keys.includes('A\u0000B\u0000A'));
    assert.ok(keys.includes('A\u0000C\u0000B\u0000A'));
  });

  test('detectCycles reports both loops in a shared-back-edge diamond (#79 review fix)', () => {
    // coderabbit case: A→B, A→C, B→D, C→D, D→A. Cycles A-B-D-A and
    // A-C-D-A share the D→A back edge; both must be enumerated.
    const topics = new Map<string, TopicNode>([
      ['A', { palee_id: 'A', depends_on: ['B', 'C'], topic_mastery: 0 }],
      ['B', { palee_id: 'B', depends_on: ['D'], topic_mastery: 0 }],
      ['C', { palee_id: 'C', depends_on: ['D'], topic_mastery: 0 }],
      ['D', { palee_id: 'D', depends_on: ['A'], topic_mastery: 0 }],
    ]);

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 2, 'both diamond loops must be reported');
    const keys = cycles.map(c => c.join('\u0000')).sort();
    assert.ok(keys.includes('A\u0000B\u0000D\u0000A'));
    assert.ok(keys.includes('A\u0000C\u0000D\u0000A'));
  });

  test('detectCycles canonicalizes rotation — smallest ID leads (#79)', () => {
    // Entry point T-z reaches the T-a→T-b→T-a loop; traversal finds it from T-z
    // first, but the canonical rotation must start at T-a.
    const topics = new Map<string, TopicNode>([
      ['T-z', { palee_id: 'T-z', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(cycles[0], ['T-a', 'T-b', 'T-a']);
  });

  test('detectCycles returns empty array for acyclic graph (#79)', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: [], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    assert.deepStrictEqual(detectCycles(topics), []);
  });

  test('detectCycles reports self-referential dependency as a one-node cycle (#79 review fix)', () => {
    // greptile P1: buildEdgeMap used to drop self-edges (depId !== id), so
    // T-a -> [T-a] silently validated clean — a regression from pre-#79
    // detectCycle, which reported ['T-a', 'T-a'].
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-free', { palee_id: 'T-free', depends_on: [], topic_mastery: 0 }],
    ]);

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 1, 'self-loop must be reported as a cycle');
    assert.deepStrictEqual(cycles[0], ['T-a', 'T-a']);

    // And it flows through every consumer: detectCycle wrapper, quarantine, validation.
    assert.deepStrictEqual(detectCycle(topics), ['T-a', 'T-a']);

    const { acyclic, cycles: qCycles } = quarantineCyclicTopics(topics);
    assert.deepStrictEqual(qCycles, [['T-a', 'T-a']]);
    assert.ok(!acyclic.has('T-a'), 'self-referential topic must be quarantined');
    assert.ok(acyclic.has('T-free'), 'unrelated topic survives');

    const result = validateDependencyGraph(topics);
    assert.strictEqual(result.valid, false);
    const cycleError = result.errors.find(e => e.type === 'cycle');
    assert.ok(cycleError, 'self-loop must fail validation');
    assert.deepStrictEqual(cycleError!.path, ['T-a', 'T-a']);
  });

  test('detectCycle reports self-referential dependency (#79 review fix)', () => {
    // Pin the compatibility wrapper's contract directly: pre-#79 detectCycle
    // returned ['T-a', 'T-a'] for a self-dep; the wrapper must keep that.
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);
    assert.deepStrictEqual(detectCycle(topics), ['T-a', 'T-a']);
  });

  test('bounded enumeration caps pathological graphs and flags truncation (CodeRabbit #79)', () => {
    // Complete digraph on 8 nodes: every elementary cycle is distinct —
    // K8 contains 5000+ elementary cycles; unbounded enumeration of dense
    // but VALID vaults was the merge blocker.
    const n = 8;
    const topics = new Map<string, TopicNode>();
    for (let i = 0; i < n; i++) {
      const deps: string[] = [];
      for (let j = 0; j < n; j++) {
        if (j !== i) deps.push(`T-${j}`);
      }
      topics.set(`T-${i}`, { palee_id: `T-${i}`, depends_on: deps, topic_mastery: 0 });
    }

    const result = detectCyclesBounded(topics, 50);
    assert.strictEqual(result.cycles.length, 50, 'enumeration must stop at the cap');
    assert.strictEqual(result.truncated, true, 'truncation must be flagged');

    // No cap on small graphs: unchanged behavior.
    const small = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);
    const smallResult = detectCyclesBounded(small, 50);
    assert.deepStrictEqual(smallResult.cycles, [['T-a', 'T-b', 'T-a']]);
    assert.strictEqual(smallResult.truncated, false);
  });

  test('truncation never under-quarantines: SCC membership drives the blocked set (CodeRabbit #79)', () => {
    // Dense SCC where the bounded sample cannot list every cyclic node's
    // cycles: quarantine must still block EVERY cyclic node and dependents,
    // because membership comes from SCC analysis, not the sampled list.
    const n = 8;
    const topics = new Map<string, TopicNode>();
    for (let i = 0; i < n; i++) {
      const deps: string[] = [];
      for (let j = 0; j < n; j++) {
        if (j !== i) deps.push(`T-${j}`);
      }
      topics.set(`T-${i}`, { palee_id: `T-${i}`, depends_on: deps, topic_mastery: 0 });
    }
    // A dependent downstream of the cyclic component (must be blocked too).
    topics.set('T-downstream', { palee_id: 'T-downstream', depends_on: ['T-0'], topic_mastery: 0 });
    // An unrelated acyclic topic (must survive).
    topics.set('T-free', { palee_id: 'T-free', depends_on: [], topic_mastery: 0 });

    const { acyclic, cycles, truncated } = quarantineCyclicTopics(topics);

    assert.strictEqual(truncated, true, 'dense SCC must trip the cap');
    assert.strictEqual(cycles.length, 1000, 'sample is capped at the default');

    for (let i = 0; i < n; i++) {
      assert.ok(!acyclic.has(`T-${i}`), `cyclic node T-${i} must be quarantined despite truncation`);
    }
    assert.ok(!acyclic.has('T-downstream'), 'downstream dependent must be quarantined');
    assert.ok(acyclic.has('T-free'), 'unrelated acyclic topic must survive');
  });

  test('findCyclicSccNodes reports exactly the on-cycle set', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-c', { palee_id: 'T-c', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-self', { palee_id: 'T-self', depends_on: ['T-self'], topic_mastery: 0 }],
      ['T-free', { palee_id: 'T-free', depends_on: [], topic_mastery: 0 }],
    ]);

    const cyclic = findCyclicSccNodes(topics);
    assert.ok(cyclic.has('T-a') && cyclic.has('T-b'), 'two-node cycle members');
    assert.ok(cyclic.has('T-self'), 'self-loop node');
    assert.ok(!cyclic.has('T-c'), 'downstream dependent is NOT on-cycle');
    assert.ok(!cyclic.has('T-free'), 'acyclic node');
  });

  test('detectCycles output order is independent of map insertion order (#79 review fix)', () => {
    // greptile P2: same graph built twice with different insertion orders must
    // produce the identical cycle list (JSDoc contract: stable output).
    const build = (order: 'a-first' | 'z-first'): Map<string, TopicNode> => {
      const a = [
        ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
        ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ] as const;
      const z = [
        ['T-z1', { palee_id: 'T-z1', depends_on: ['T-z2'], topic_mastery: 0 }],
        ['T-z2', { palee_id: 'T-z2', depends_on: ['T-z1'], topic_mastery: 0 }],
      ] as const;
      const entries = order === 'a-first' ? [...a, ...z] : [...z, ...a];
      return new Map<string, TopicNode>(entries as unknown as Array<[string, TopicNode]>);
    };

    const fromA = detectCycles(build('a-first'));
    const fromZ = detectCycles(build('z-first'));
    assert.deepStrictEqual(fromZ, fromA, 'cycle list must not depend on insertion order');
    assert.strictEqual(fromA.length, 2);
    // Sorted canonical order: T-a cycle before T-z cycle.
    assert.deepStrictEqual(fromA[0], ['T-a', 'T-b', 'T-a']);
    assert.deepStrictEqual(fromA[1], ['T-z1', 'T-z2', 'T-z1']);
  });

  test('quarantineCyclicTopics survives a large SCC without stack overflow (#79 review fix)', () => {
    // greptile P1: the unblock cascade used to recurse once per blocked node.
    // Build a wide SCC (1000 nodes, each depending on the next and the first)
    // so enumeration's blocked/unblocked churn runs deep cascades.
    const n = 1000;
    const topics = new Map<string, TopicNode>();
    for (let i = 0; i < n; i++) {
      const dep = i === n - 1 ? 'T-scc-0' : `T-scc-${i + 1}`;
      topics.set(`T-scc-${i}`, { palee_id: `T-scc-${i}`, depends_on: [dep], topic_mastery: 0 });
    }

    const { cycles } = quarantineCyclicTopics(topics);
    assert.ok(cycles.length >= 1, 'the ring is a cycle');
  });

  test('detectCycles enumerates every elementary cycle of a dense SCC (#79 review fix)', () => {
    // CodeRabbit: the enumeration must keep Johnson's deferred unblocking, so
    // fruitless regions are not re-explored per reaching path. Pin completeness
    // on the worst case for that pruning: a complete digraph on 6 nodes, whose
    // elementary-cycle count is exactly sum of C(6,k)·(k-1)! for k=2..6 = 409.
    const n = 6;
    const topics = new Map<string, TopicNode>();
    for (let i = 0; i < n; i++) {
      const deps = [];
      for (let j = 0; j < n; j++) {
        if (i !== j) deps.push(`T-k-${j}`);
      }
      topics.set(`T-k-${i}`, { palee_id: `T-k-${i}`, depends_on: deps, topic_mastery: 0 });
    }

    const cycles = detectCycles(topics);
    assert.strictEqual(cycles.length, 409, 'complete digraph K6 has exactly 409 elementary cycles');
    // Canonical rotation means the lexicographically-smallest node leads each
    // cycle, so no two entries share a joined key.
    const keys = new Set(cycles.map(c => c.join('\u0000')));
    assert.strictEqual(keys.size, 409, 'every cycle must be distinct');
  });

  // ─── #79: quarantine ────────────────────────────────────────────────

  test('quarantineCyclicTopics removes cycle members and their dependents, keeps independent components (#79)', () => {
    const topics = new Map<string, TopicNode>([
      // Cyclic pair
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      // Downstream of the cycle: depends on a cycle member
      ['T-down', { palee_id: 'T-down', depends_on: ['T-a'], topic_mastery: 0 }],
      // Independent acyclic component
      ['T-free', { palee_id: 'T-free', depends_on: [], topic_mastery: 0 }],
      ['T-free-2', { palee_id: 'T-free-2', depends_on: ['T-free'], topic_mastery: 0.9 }],
    ]);

    const { acyclic, cycles } = quarantineCyclicTopics(topics);

    assert.strictEqual(cycles.length, 1);
    assert.ok(acyclic.has('T-free'), 'independent component survives');
    assert.ok(acyclic.has('T-free-2'), 'mastered independent topic survives');
    assert.ok(!acyclic.has('T-a'), 'cycle member quarantined');
    assert.ok(!acyclic.has('T-b'), 'cycle member quarantined');
    assert.ok(!acyclic.has('T-down'), 'dependent of a cycle member quarantined (undefined learning order)');
    assert.strictEqual(acyclic.size, 2);
  });

  test('quarantineCyclicTopics on acyclic graph returns full map and no cycles (#79)', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: [], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const { acyclic, cycles } = quarantineCyclicTopics(topics);
    assert.strictEqual(cycles.length, 0);
    assert.strictEqual(acyclic.size, 2);
  });

  test('quarantineCyclicTopics preserves an acyclic sibling prerequisite of a cyclic dep (#79 review fix)', () => {
    // coderabbit trigger: T-x depends on [T-a (cyclic), T-p (free)].
    // T-p shares the depends_on list with a cyclic topic but never reaches
    // a cycle itself — it must stay ready; only T-x (and the cycle) quarantines.
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-x', { palee_id: 'T-x', depends_on: ['T-a', 'T-p'], topic_mastery: 0 }],
      ['T-p', { palee_id: 'T-p', depends_on: [], topic_mastery: 0 }],
    ]);

    const { acyclic, cycles } = quarantineCyclicTopics(topics);

    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(acyclic.size, 1, 'only T-p survives');
    assert.ok(acyclic.has('T-p'), 'acyclic sibling prerequisite must NOT be quarantined');
    assert.ok(!acyclic.has('T-x'), 'dependent of a cyclic topic must be quarantined');
    assert.ok(!acyclic.has('T-a') && !acyclic.has('T-b'), 'cycle members must be quarantined');

    // And the surviving topic is ready to learn.
    const ready = getReadyTopics(acyclic);
    assert.deepStrictEqual(ready.map(t => t.palee_id), ['T-p']);
  });

  test('quarantineCyclicTopics handles a 5000-node linear chain without stack overflow (#79 review fix)', () => {
    // greptile P2: deep dependency chains must not recurse. Build a long
    // acyclic chain plus one cycle at the head; quarantine must complete.
    const topics = new Map<string, TopicNode>();
    topics.set('T-cycle-a', { palee_id: 'T-cycle-a', depends_on: ['T-cycle-b'], topic_mastery: 0 });
    topics.set('T-cycle-b', { palee_id: 'T-cycle-b', depends_on: ['T-cycle-a'], topic_mastery: 0 });
    for (let i = 0; i < 5000; i++) {
      const dep = i === 0 ? 'T-cycle-b' : `T-chain-${i - 1}`;
      topics.set(`T-chain-${i}`, { palee_id: `T-chain-${i}`, depends_on: [dep], topic_mastery: 0 });
    }

    const { acyclic, cycles } = quarantineCyclicTopics(topics);
    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(acyclic.size, 0, 'every chain node depends on the cycle transitively');
  });

  // ─── #79: deterministic ready ordering ───────────────────────────────

  test('getReadyTopics output order is deterministic regardless of map insertion order (#79)', () => {
    const mk = (order: string[]) => new Map<string, TopicNode>(order.map(id => [id, {
      palee_id: id, depends_on: [], topic_mastery: 0,
    }]));

    const ready1 = getReadyTopics(mk(['T-zeta', 'T-alpha', 'T-mid']));
    const ready2 = getReadyTopics(mk(['T-mid', 'T-zeta', 'T-alpha']));

    assert.deepStrictEqual(
      ready1.map(t => t.palee_id),
      ['T-alpha', 'T-mid', 'T-zeta'],
      'output must be ascending palee_id'
    );
    assert.deepStrictEqual(ready2.map(t => t.palee_id), ready1.map(t => t.palee_id));
  });



  test('getReadyTopics returns only topics with satisfied deps', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', topic_mastery: 0.9, depends_on: [] }],
      ['T-b', { palee_id: 'T-b', topic_mastery: 0.3, depends_on: ['T-a'] }],
      ['T-c', { palee_id: 'T-c', topic_mastery: 0.2, depends_on: ['T-b'] }],
    ]);

    const ready = getReadyTopics(topics, 0.7);
    const readyIds = ready.map(t => t.palee_id);

    assert.ok(readyIds.includes('T-b')); // T-a is mastered
    assert.ok(!readyIds.includes('T-c')); // T-b is not mastered
    assert.ok(!readyIds.includes('T-a')); // Already mastered
  });

  test('validateDependencyGraph detects missing dependencies', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-missing'], topic_mastery: 0 }],
    ]);

    const result = validateDependencyGraph(topics);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].type, 'missing_dependency');
    assert.strictEqual(result.errors[0].missing, 'T-missing');
  });

  test('validateDependencyGraph detects cycles', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const result = validateDependencyGraph(topics);
    assert.strictEqual(result.valid, false);
    const cycleError = result.errors.find(e => e.type === 'cycle');
    assert.ok(cycleError);
    assert.ok(cycleError!.path!.length > 0);
  });

  test('validateDependencyGraph reports every cycle, not just the first (#79)', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-c', { palee_id: 'T-c', depends_on: ['T-d'], topic_mastery: 0 }],
      ['T-d', { palee_id: 'T-d', depends_on: ['T-c'], topic_mastery: 0 }],
    ]);

    const result = validateDependencyGraph(topics);
    assert.strictEqual(result.valid, false);
    const cycleErrors = result.errors.filter(e => e.type === 'cycle');
    assert.strictEqual(cycleErrors.length, 2, 'one error per distinct cyclic component');
    const paths = cycleErrors.map(e => e.path!.join('\u0000')).sort();
    assert.ok(paths.includes('T-a\u0000T-b\u0000T-a'));
    assert.ok(paths.includes('T-c\u0000T-d\u0000T-c'));
  });

  test('validateDependencyGraph returns valid for clean graph', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: [], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const result = validateDependencyGraph(topics);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  test('getTopicDependencies ignores the legacy "dependencies" alias (canonical depends_on only — #140)', () => {
    // Runtime pin: a node carrying the legacy alias via the index signature
    // yields no edges — the engine reads canonical `depends_on` only.
    const legacyNode = {
      palee_id: 'T-legacy-alias',
      dependencies: ['T-prereq'],
      topic_mastery: 0,
    } as unknown as TopicNode;

    const { getTopicDependencies } = require('../src/engine/dependency');
    assert.deepStrictEqual(getTopicDependencies(legacyNode), []);
    assert.deepStrictEqual(
      getTopicDependencies({ palee_id: 'T-canonical', depends_on: ['T-prereq'], topic_mastery: 0 }),
      ['T-prereq']
    );
  });

});

