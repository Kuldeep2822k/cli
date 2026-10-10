import { test, describe } from 'node:test';
import assert from 'node:assert';
import { summarizeMastery } from '../src/application/mastery-summary';

describe('summarizeMastery', () => {
  test('buckets by threshold with independent predicates', () => {
    const result = summarizeMastery([0, 0.3, 0.69, 0.7, 0.95], 0.7);
    assert.deepStrictEqual(result, { mastered: 2, learning: 2, new: 1 });
  });

  test('a value exactly at the threshold counts as mastered, not learning', () => {
    assert.deepStrictEqual(summarizeMastery([0.7], 0.7), { mastered: 1, learning: 0, new: 0 });
  });

  test('zero mastery counts as new, never learning', () => {
    assert.deepStrictEqual(summarizeMastery([0, 0, 0], 0.7), { mastered: 0, learning: 0, new: 3 });
  });

  test('empty input yields all-zero buckets', () => {
    assert.deepStrictEqual(summarizeMastery([], 0.7), { mastered: 0, learning: 0, new: 0 });
  });

  test('uses the MASTERY_THRESHOLD default when no threshold is passed', () => {
    // 0 is always new and 1 is always mastered regardless of the threshold value.
    assert.deepStrictEqual(summarizeMastery([0, 1]), { mastered: 1, learning: 0, new: 1 });
  });
});
