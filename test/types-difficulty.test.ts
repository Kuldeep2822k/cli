import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Difficulty, Topic, normalizeDifficulty } from '../src/types';

describe('Difficulty Enum & Types', () => {
  test('Difficulty type accommodates beginner, intermediate, and advanced', () => {
    const difficulties: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
    assert.strictEqual(difficulties.length, 3);
    assert.ok(difficulties.includes('beginner'));
    assert.ok(difficulties.includes('intermediate'));
    assert.ok(difficulties.includes('advanced'));
  });

  test('normalizeDifficulty normalizes canonical strings', () => {
    assert.strictEqual(normalizeDifficulty('beginner'), 'beginner');
    assert.strictEqual(normalizeDifficulty('intermediate'), 'intermediate');
    assert.strictEqual(normalizeDifficulty('advanced'), 'advanced');
  });

  test('normalizeDifficulty handles whitespace and uppercase casing', () => {
    assert.strictEqual(normalizeDifficulty('  Advanced  '), 'advanced');
    assert.strictEqual(normalizeDifficulty('BEGINNER'), 'beginner');
    assert.strictEqual(normalizeDifficulty('\tIntermediate\n'), 'intermediate');
  });

  test('normalizeDifficulty coerces numeric levels (1-5)', () => {
    assert.strictEqual(normalizeDifficulty(1), 'beginner');
    assert.strictEqual(normalizeDifficulty(0), 'beginner');
    assert.strictEqual(normalizeDifficulty(2), 'intermediate');
    assert.strictEqual(normalizeDifficulty(3), 'intermediate');
    assert.strictEqual(normalizeDifficulty(4), 'advanced');
    assert.strictEqual(normalizeDifficulty(5), 'advanced');
  });

  test('normalizeDifficulty coerces stringified numbers', () => {
    assert.strictEqual(normalizeDifficulty('1'), 'beginner');
    assert.strictEqual(normalizeDifficulty(' 2 '), 'intermediate');
    assert.strictEqual(normalizeDifficulty('3'), 'intermediate');
    assert.strictEqual(normalizeDifficulty('4'), 'advanced');
    assert.strictEqual(normalizeDifficulty(' 5 '), 'advanced');
  });

  test('normalizeDifficulty safely falls back to intermediate on unknown values', () => {
    assert.strictEqual(normalizeDifficulty(null), 'intermediate');
    assert.strictEqual(normalizeDifficulty(undefined), 'intermediate');
    assert.strictEqual(normalizeDifficulty(''), 'intermediate');
    assert.strictEqual(normalizeDifficulty('expert'), 'intermediate');
    assert.strictEqual(normalizeDifficulty({}), 'intermediate');
    assert.strictEqual(normalizeDifficulty(Number.NaN), 'intermediate');
  });

  test('Topic interface accepts Difficulty string enum', () => {
    const topic: Topic = {
      palee_schema: 1,
      palee_id: 'T-test-topic',
      topic: 'Test Topic',
      status: 'learning',
      difficulty: 'advanced',
      dependencies: [],
      assessment: {
        conceptual: 0.8,
        practical: 0.9,
        debug: 0.7,
        feynman: 0.85,
        assessed_at: new Date().toISOString(),
      },
      review: {
        interval_days: 6,
        repetition: 2,
        ease_factor: 2.5,
        lapses: 0,
        last_quality: 4,
        last_reviewed_at: new Date().toISOString(),
        due_at: new Date().toISOString(),
      },
    };

    assert.strictEqual(topic.difficulty, 'advanced');
  });

  test('Topic and TopicNode allow alias-only configurations at TypeScript boundary', () => {
    // Topic with only dependencies
    const topicWithDeps: Topic = {
      palee_schema: 1,
      palee_id: 'T-deps-only',
      topic: 'Deps Only',
      status: 'learning',
      difficulty: 'beginner',
      dependencies: ['T-prereq'],
      assessment: {
        conceptual: 0.8,
        practical: 0.8,
        debug: 0.8,
        feynman: 0.8,
        assessed_at: new Date().toISOString(),
      },
      review: {
        interval_days: 1,
        repetition: 0,
        ease_factor: 2.5,
        lapses: 0,
        last_quality: 0,
        last_reviewed_at: new Date().toISOString(),
        due_at: new Date().toISOString(),
      },
    };
    assert.deepStrictEqual(topicWithDeps.dependencies, ['T-prereq']);

    // Topic with only depends_on alias
    const topicWithDependsOn: Topic = {
      palee_schema: 1,
      palee_id: 'T-depends-on-only',
      topic: 'Depends On Only',
      status: 'learning',
      difficulty: 'beginner',
      depends_on: ['T-prereq'],
      assessment: {
        conceptual: 0.8,
        practical: 0.8,
        debug: 0.8,
        feynman: 0.8,
        assessed_at: new Date().toISOString(),
      },
      review: {
        interval_days: 1,
        repetition: 0,
        ease_factor: 2.5,
        lapses: 0,
        last_quality: 0,
        last_reviewed_at: new Date().toISOString(),
        due_at: new Date().toISOString(),
      },
    };
    assert.deepStrictEqual(topicWithDependsOn.depends_on, ['T-prereq']);

    // TopicNode with only dependencies
    const nodeWithDeps: import('../src/types').TopicNode = {
      palee_id: 'T-node-deps',
      dependencies: ['T-parent'],
      topic_mastery: 0.5,
    };
    assert.deepStrictEqual(nodeWithDeps.dependencies, ['T-parent']);

    // TopicNode with only depends_on
    const nodeWithDependsOn: import('../src/types').TopicNode = {
      palee_id: 'T-node-depends',
      depends_on: ['T-parent'],
      topic_mastery: 0.5,
    };
    assert.deepStrictEqual(nodeWithDependsOn.depends_on, ['T-parent']);
  });

  test('Session and SessionRecord enforce discriminated union invariants', () => {
    const completedSession: import('../src/types').CompletedSession = {
      palee_schema: 1,
      session_id: 'S-20260824T000000-abcd',
      topic_id: 'T-math',
      started_at: '2026-08-24T00:00:00.000Z',
      ended_at: '2026-08-24T00:30:00.000Z',
      status: 'completed',
    };
    assert.strictEqual(completedSession.status, 'completed');
    assert.strictEqual(typeof completedSession.ended_at, 'string');

    const draftSession: import('../src/types').DraftSession = {
      palee_schema: 1,
      session_id: 'DRAFT-S-12345678',
      topic_id: 'T-math',
      started_at: '2026-08-24T00:00:00.000Z',
      ended_at: null,
      status: 'draft',
    };
    assert.strictEqual(draftSession.status, 'draft');
    assert.strictEqual(draftSession.ended_at, null);
  });
});

