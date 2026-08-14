import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Difficulty, Topic } from '../src/types';

describe('Difficulty Enum & Types', () => {
  test('Difficulty type accommodates beginner, intermediate, and advanced', () => {
    const difficulties: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
    assert.strictEqual(difficulties.length, 3);
    assert.ok(difficulties.includes('beginner'));
    assert.ok(difficulties.includes('intermediate'));
    assert.ok(difficulties.includes('advanced'));
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
});
