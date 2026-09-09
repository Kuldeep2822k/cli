import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  detectCycle,
  detectCycles,
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

