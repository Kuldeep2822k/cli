import { describe, test } from 'node:test';
import assert from 'node:assert';
import { computeTopicMastery, normalizeScore } from '../src/engine/mastery';
import { getReadyTopics } from '../src/engine/dependency';
import { TopicNode } from '../src/types';


describe('Mastery Engine', () => {
  test('normalizeScore clamps, rounds, and parses string numbers', () => {
    assert.strictEqual(normalizeScore('0.85'), 0.85);
    assert.strictEqual(normalizeScore('  1.5  '), 1.0);
    assert.strictEqual(normalizeScore('-0.5'), 0.0);
    assert.strictEqual(normalizeScore('invalid'), 0.0);
    assert.strictEqual(normalizeScore(undefined), 0.0);
    assert.strictEqual(normalizeScore(null), 0.0);
    assert.strictEqual(normalizeScore(0.333333), 0.3333);
  });

  test('computeTopicMastery accepts string inputs', () => {
    assert.strictEqual(computeTopicMastery('0.8', '0.6', '0.4', '0.9'), 0.72);
  });

  test('returns 0.0 for default or zero inputs', () => {

    assert.strictEqual(computeTopicMastery(), 0.0);
    assert.strictEqual(computeTopicMastery(0, 0, 0, 0), 0.0);
  });

  test('returns 1.0 for perfect scores across all four dimensions', () => {
    assert.strictEqual(computeTopicMastery(1, 1, 1, 1), 1.0);
  });

  test('applies 40% double weight to Feynman technique dimension', () => {
    // Conceptual (20%): 1.0 * (1/5) = 0.2
    const conceptualOnly = computeTopicMastery(1.0, 0.0, 0.0, 0.0);
    assert.strictEqual(conceptualOnly, 0.2);

    // Practical (20%): 1.0 * (1/5) = 0.2
    const practicalOnly = computeTopicMastery(0.0, 1.0, 0.0, 0.0);
    assert.strictEqual(practicalOnly, 0.2);

    // Debug (20%): 1.0 * (1/5) = 0.2
    const debugOnly = computeTopicMastery(0.0, 0.0, 1.0, 0.0);
    assert.strictEqual(debugOnly, 0.2);

    // Feynman (40%): 1.0 * (2/5) = 0.4
    const feynmanOnly = computeTopicMastery(0.0, 0.0, 0.0, 1.0);
    assert.strictEqual(feynmanOnly, 0.4);
  });

  test('computes mixed assessment score correctly', () => {
    // (0.8 + 0.6 + 0.4 + 2 * 0.9) / 5 = (1.8 + 1.8) / 5 = 3.6 / 5 = 0.72
    const mastery = computeTopicMastery(0.8, 0.6, 0.4, 0.9);
    assert.strictEqual(mastery, 0.72);
  });

  test('rounds result to 4 decimal places', () => {
    // (0.9999 + 0.9999 + 0.9999 + 2 * 0.6668) / 5 = 4.3333 / 5 = 0.86666... -> 0.8667
    const mastery = computeTopicMastery(0.9999, 0.9999, 0.9999, 0.6668);
    assert.strictEqual(mastery, 0.8667);
  });


  test('clamps out-of-range inputs between 0.0 and 1.0', () => {
    assert.strictEqual(computeTopicMastery(-0.5, -1, -2, -3), 0.0);
    assert.strictEqual(computeTopicMastery(1.5, 2.0, 3.0, 4.0), 1.0);
  });

  test('handles non-numeric and NaN values gracefully', () => {
    assert.strictEqual(computeTopicMastery(NaN, Number.POSITIVE_INFINITY, NaN, 0.5), 0.2);
  });

  test('calculated mastery unlocks dependent topics in getReadyTopics', () => {
    const prereqMastery = computeTopicMastery(0.7, 0.7, 0.7, 0.7); // 0.7 >= 0.7 threshold
    assert.strictEqual(prereqMastery, 0.7);

    const topics = new Map<string, TopicNode>([
      [
        'T-prereq',
        {
          palee_id: 'T-prereq',
          title: 'Prerequisite Topic',
          path: 'prereq.md',
          depends_on: [],
          topic_mastery: prereqMastery,
        },
      ],
      [
        'T-child',
        {
          palee_id: 'T-child',
          title: 'Dependent Topic',
          path: 'child.md',
          depends_on: ['T-prereq'],
          topic_mastery: 0.0,
        },
      ],
    ]);


    const readyTopics = getReadyTopics(topics, 0.7);
    // T-prereq is already mastered (0.7 >= 0.7), so it is not in ready
    // T-child has all dependencies satisfied (T-prereq >= 0.7) and mastery < 0.7, so it is unlocked and ready
    assert.strictEqual(readyTopics.length, 1);
    assert.strictEqual(readyTopics[0].palee_id, 'T-child');
  });
});

