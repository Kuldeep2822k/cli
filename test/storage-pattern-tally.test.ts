import { test, describe } from 'node:test';
import assert from 'node:assert';
// Namespace import rather than a named one: `tallyPatterns` is the symbol under test,
// and a namespace lookup fails as an assertion in this file instead of taking the whole
// module down at import time.
import * as patternMatcher from '../src/storage/pattern-matcher';

/**
 * #312 — `matchesPattern` OR-folds its patterns, so a caller could only ever print one
 * aggregate number and a pattern that names no file in scope was indistinguishable from
 * a filter that worked on an empty inbox. `tallyPatterns` keeps the accounting per
 * pattern, over the same dialect `matchesPattern` applies.
 */
describe('Per-pattern match tally (#312)', () => {
  const scope = ['MODULES/01-lesson.md', 'MODULES/01/runbook-template.md', 'drafts/01-draft.md'];

  test('every supplied pattern gets an entry, including the ones that matched nothing', () => {
    const tallies = patternMatcher.tallyPatterns(scope, '*draft*, a/*.md');
    assert.deepStrictEqual(tallies, [
      { pattern: '*draft*', matches: 1 },
      { pattern: 'a/*.md', matches: 0 },
    ]);
  });

  test('entries come back in the order supplied, deduplicated, with blanks dropped', () => {
    const tallies = patternMatcher.tallyPatterns(scope, '*lesson*, , *lesson*,');
    assert.deepStrictEqual(tallies.map((t) => t.pattern), ['*lesson*']);
    assert.strictEqual(patternMatcher.tallyPatterns(scope, '').length, 0);
    assert.strictEqual(patternMatcher.tallyPatterns([], '*').length, 1);
    assert.strictEqual(patternMatcher.tallyPatterns([], '*')[0].matches, 0, 'an empty scope makes every pattern dead');
  });

  test('backslash separators and a leading ./ normalise to the same entry the matcher uses', () => {
    assert.deepStrictEqual(
      patternMatcher.tallyPatterns(scope, '.\\MODULES\\*, ./MODULES/**').map((t) => t.pattern),
      ['MODULES/*', 'MODULES/**']
    );
  });

  test('the tally is the same dialect matchesPattern OR-folds', () => {
    for (const pattern of ['*draft*', 'MODULES/**', 'a/*.md', '*TEMPLATE*', 'notes', '01-*']) {
      assert.strictEqual(
        patternMatcher.tallyPatterns(scope, pattern)[0].matches > 0,
        scope.some((p) => patternMatcher.matchesPattern(p, pattern)),
        `pattern ${pattern} must be judged live by exactly the rule matchesPattern applies`
      );
    }
  });

  test('an array input keeps its commas, as matchesPattern does', () => {
    const tallies = patternMatcher.tallyPatterns(scope, ['*draft*,*lesson*']);
    assert.strictEqual(tallies.length, 1, 'one entry, not two');
    assert.strictEqual(tallies[0].matches, 0, 'and the comma is literal inside an array entry');
  });
});
