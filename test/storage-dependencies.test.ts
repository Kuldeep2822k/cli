import { describe, test } from 'node:test';
import assert from 'node:assert';
import { normalizeDependencies } from '../src/storage/dependencies';

describe('normalizeDependencies behavioral unit tests (Issue #382)', () => {
  test('returns an empty array when both inputs are undefined', () => {
    assert.deepStrictEqual(normalizeDependencies(), []);
  });

  test('extracts and trims array entries, dropping null/empty values', () => {
    assert.deepStrictEqual(
      normalizeDependencies(['  T-1  ', null, '', ' ', 'T-2']),
      ['T-1', 'T-2']
    );
  });

  test('splits comma-separated strings and trims each token', () => {
    assert.deepStrictEqual(
      normalizeDependencies('T-1 , T-2,T-3'),
      ['T-1', 'T-2', 'T-3']
    );
  });

  test('unions canonical depends_on first, then legacy dependencies, deduping overlaps', () => {
    assert.deepStrictEqual(
      normalizeDependencies(['T-1', 'T-2'], ['T-2', 'T-3']),
      ['T-1', 'T-2', 'T-3']
    );
  });

  test('coerces non-null, non-string array entries via String()', () => {
    assert.deepStrictEqual(normalizeDependencies([1, 2, 3]), ['1', '2', '3']);
  });

  test('ignores unsupported scalar/object inputs', () => {
    assert.deepStrictEqual(normalizeDependencies(42, { nope: true }), []);
  });

  test('treats a whitespace-only string as empty', () => {
    assert.deepStrictEqual(normalizeDependencies('   '), []);
  });

  test('preserves wikilink syntax verbatim', () => {
    assert.deepStrictEqual(
      normalizeDependencies('[[T-math]], [[T-geometry]]'),
      ['[[T-math]]', '[[T-geometry]]']
    );
  });

  test('preserves first-seen order when the same id appears across both fields', () => {
    assert.deepStrictEqual(
      normalizeDependencies(['T-b', 'T-a'], 'T-a, T-c'),
      ['T-b', 'T-a', 'T-c']
    );
  });
});
