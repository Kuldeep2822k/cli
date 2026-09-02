import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  detectCycle,
  getReadyTopics,
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

  test('validateDependencyGraph returns valid for clean graph', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: [], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
    ]);

    const result = validateDependencyGraph(topics);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  test('supports dependencies alias equivalently to depends_on across engine algorithms', () => {
    // TopicNode using only dependencies alias
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', topic_mastery: 0.8, depends_on: [] }],
      ['T-b', { palee_id: 'T-b', topic_mastery: 0.2, dependencies: ['T-a'], depends_on: [] }],
      ['T-c', { palee_id: 'T-c', topic_mastery: 0.2, dependencies: ['T-b'], depends_on: [] }],
    ]);

    const ready = getReadyTopics(topics, 0.7);
    const readyIds = ready.map(t => t.palee_id);

    // T-a is mastered (0.8 >= 0.7), so T-b whose dependency is T-a is ready
    assert.ok(readyIds.includes('T-b'));
    // T-b is not mastered (0.2 < 0.7), so T-c is NOT ready
    assert.ok(!readyIds.includes('T-c'));

    // Cycle detection works with dependencies alias
    const cyclicTopics = new Map<string, TopicNode>([
      ['T-x', { palee_id: 'T-x', topic_mastery: 0, dependencies: ['T-y'], depends_on: [] }],
      ['T-y', { palee_id: 'T-y', topic_mastery: 0, dependencies: ['T-x'], depends_on: [] }],
    ]);
    const cycle = detectCycle(cyclicTopics);
    assert.ok(cycle !== null);
    assert.ok(cycle!.includes('T-x'));
    assert.ok(cycle!.includes('T-y'));

    // Missing dependency validation works with dependencies alias
    const missingTopics = new Map<string, TopicNode>([
      ['T-1', { palee_id: 'T-1', topic_mastery: 0, dependencies: ['T-nonexistent'], depends_on: [] }],
    ]);
    const validation = validateDependencyGraph(missingTopics);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.errors[0].type, 'missing_dependency');
    assert.strictEqual(validation.errors[0].missing, 'T-nonexistent');
  });

  test('detects missing dependencies across both depends_on and dependencies when both keys are present', () => {
    const topics = new Map<string, TopicNode>([
      ['T-1', { palee_id: 'T-1', topic_mastery: 0, depends_on: ['T-missing-1'], dependencies: ['T-missing-2'] }],
    ]);
    const validation = validateDependencyGraph(topics);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.errors.length, 2);
    const missingIds = validation.errors.map(e => e.missing);
    assert.ok(missingIds.includes('T-missing-1'));
    assert.ok(missingIds.includes('T-missing-2'));
  });
});

