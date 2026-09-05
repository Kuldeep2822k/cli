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

});

