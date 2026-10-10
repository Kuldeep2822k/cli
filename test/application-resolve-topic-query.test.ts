import { test, describe } from 'node:test';
import assert from 'node:assert';
import { matchesTopicQuery } from '../src/application/resolve-topic-query';

describe('matchesTopicQuery', () => {
  test('matches an exact id', () => {
    assert.strictEqual(matchesTopicQuery('T-calculus', 'Calculus', 'T-calculus'), true);
  });

  test('matches an id substring', () => {
    assert.strictEqual(matchesTopicQuery('T-calculus', 'Calculus', 'calc'), true);
  });

  test('matches a title substring case-insensitively', () => {
    assert.strictEqual(matchesTopicQuery('T-001', 'Linear Algebra', 'ALGEBRA'), true);
  });

  test('id substring match is case-sensitive (matches current behavior)', () => {
    assert.strictEqual(matchesTopicQuery('T-Calculus', 'Something', 'calculus'), false);
  });

  test('returns false when nothing matches', () => {
    assert.strictEqual(matchesTopicQuery('T-001', 'Linear Algebra', 'topology'), false);
  });
});
