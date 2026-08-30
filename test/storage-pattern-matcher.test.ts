import { test, describe } from 'node:test';
import assert from 'node:assert';
import { matchesPattern, matchesTags, extractTags, validatePattern } from '../src/storage/pattern-matcher';

describe('Pattern and Glob Matcher', () => {
  test('matches simple file basenames and wildcards', () => {
    assert.strictEqual(matchesPattern('note.md', '*.md'), true);
    assert.strictEqual(matchesPattern('note.txt', '*.md'), false);
    assert.strictEqual(matchesPattern('MODULES/05-containers/runbook-template.md', '*template*'), true);
    assert.strictEqual(matchesPattern('MODULES/05-containers/01-mental-model.md', '*template*'), false);
  });

  test('matches root-level files and nested files with recursive glob **/*.md', () => {
    assert.strictEqual(matchesPattern('README.md', '**/*.md'), true);
    assert.strictEqual(matchesPattern('index.md', '**/*.md'), true);
    assert.strictEqual(matchesPattern('README.txt', '**/*.md'), false);
    assert.strictEqual(matchesPattern('MODULES/01-intro.md', '**/*.md'), true);
    assert.strictEqual(matchesPattern('MODULES/sub/deep/note.md', '**/*.md'), true);
  });

  test('handles middle /**/ and trailing /** correctly', () => {
    // Middle /**/ zero directories
    assert.strictEqual(matchesPattern('src/test.md', 'src/**/test.md'), true);
    // Middle /**/ multiple directories
    assert.strictEqual(matchesPattern('src/storage/sub/test.md', 'src/**/test.md'), true);

    // Trailing /**
    assert.strictEqual(matchesPattern('MODULES/01-linux.md', 'MODULES/**'), true);
    assert.strictEqual(matchesPattern('MODULES/01-linux/perf.md', 'MODULES/**'), true);
    assert.strictEqual(matchesPattern('PROJECTS/01.md', 'MODULES/**'), false);
  });

  test('matches single character wildcard (?)', () => {
    assert.strictEqual(matchesPattern('note-1.md', 'note-?.md'), true);
    assert.strictEqual(matchesPattern('note-12.md', 'note-?.md'), false);
    assert.strictEqual(matchesPattern('MODULES/01-a/test.md', 'MODULES/0?-a/*'), true);
  });

  test('matches character classes, ranges, and negation', () => {
    assert.strictEqual(matchesPattern('01-concept.md', '0[1-4]-*'), true);
    assert.strictEqual(matchesPattern('05-concept.md', '0[1-4]-*'), false);
    assert.strictEqual(matchesPattern('MODULES/02-linux/03-perf.md', '0[1-4]-*'), true);
    assert.strictEqual(matchesPattern('a-note.md', '[!0-9]-*'), true);
    assert.strictEqual(matchesPattern('1-note.md', '[!0-9]-*'), false);
  });

  test('handles metacharacters and unclosed brackets safely', () => {
    assert.strictEqual(matchesPattern('note (1).md', 'note (*).md'), true);
    assert.strictEqual(matchesPattern('c++.md', 'c++.*'), true);
    assert.strictEqual(matchesPattern('note[1.md', 'note[1.md'), true);
  });

  test('normalizes Windows-style backslash paths and patterns', () => {
    assert.strictEqual(matchesPattern('MODULES\\02-linux\\01-perf.md', 'MODULES/**'), true);
    assert.strictEqual(matchesPattern('MODULES/02-linux/01-perf.md', 'MODULES\\**'), true);
  });

  test('avoids false-positive substring matches for non-wildcard patterns', () => {
    assert.strictEqual(matchesPattern('extra.md', 'a.md'), false);
    assert.strictEqual(matchesPattern('contemporary.md', 'temp'), false);
    assert.strictEqual(matchesPattern('MODULES-BACKUP/perf.md', 'MODULES'), false);
    assert.strictEqual(matchesPattern('MODULES/perf.md', 'MODULES'), true);
  });

  test('matches comma-separated patterns and array pattern lists', () => {
    const patterns = '01-*, deep-dive*, lab-*';
    assert.strictEqual(matchesPattern('01-intro.md', patterns), true);
    assert.strictEqual(matchesPattern('deep-dive-01.md', patterns), true);
    assert.strictEqual(matchesPattern('lab-01.md', patterns), true);
    assert.strictEqual(matchesPattern('exam.md', patterns), false);

    assert.strictEqual(matchesPattern('01-concept.md', ['template-*', '01-*', 'lab-*']), true);
    assert.strictEqual(matchesPattern('other.md', ['template-*', '01-*']), false);
  });

  test('matches multiple separated /**/ bands in linear time without ReDoS', () => {
    const multiBand = Array(15).fill('seg').join('/**/') + '/**/file.md';
    const nonMatchingPath = Array(40).fill('seg').join('/') + '/nomatch.txt';
    const matchingPath = Array(15).fill('seg').join('/sub/') + '/sub/file.md';

    const start = Date.now();
    assert.strictEqual(matchesPattern(nonMatchingPath, multiBand), false);
    assert.strictEqual(matchesPattern(matchingPath, multiBand), true);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `Expected multi-band match to execute in <100ms, took ${elapsed}ms`);
  });
});

describe('Frontmatter Tag Matcher', () => {
  test('extracts tags from array, string, and null with # normalization', () => {
    assert.deepStrictEqual(extractTags(['#type/concept', 'category/module']), ['type/concept', 'category/module']);
    assert.deepStrictEqual(extractTags('#type/concept, #category/module'), ['type/concept', 'category/module']);
    assert.deepStrictEqual(extractTags(null), []);
    assert.deepStrictEqual(extractTags(undefined), []);
  });

  test('matches exact and normalized tag names', () => {
    const tags = ['type/concept', 'domain/security'];
    assert.strictEqual(matchesTags(tags, 'type/concept'), true);
    assert.strictEqual(matchesTags(tags, '#domain/security'), true);
    assert.strictEqual(matchesTags(tags, 'domain/containers'), false);
  });

  test('matches hierarchical tag segments (prefix, suffix, and middle infix)', () => {
    const tags = ['type/concept', 'domain/cloud/aws'];
    // Suffix match
    assert.strictEqual(matchesTags(tags, 'concept'), true);
    // Prefix match
    assert.strictEqual(matchesTags(tags, 'type'), true);
    // Middle segment (infix) match in 3-tier hierarchy
    assert.strictEqual(matchesTags(tags, 'cloud'), true);
    assert.strictEqual(matchesTags(tags, 'aws'), true);
    assert.strictEqual(matchesTags(tags, 'domain/cloud'), true);
    assert.strictEqual(matchesTags(tags, 'azure'), false);
  });

  test('matches comma-separated target tags', () => {
    const tags = ['type/lab'];
    assert.strictEqual(matchesTags(tags, 'concept, deep-dive, lab'), true);
    assert.strictEqual(matchesTags(tags, 'rubric, template'), false);
  });
});

describe('Pattern Validation', () => {
  test('validatePattern accepts valid globs without throwing', () => {
    assert.doesNotThrow(() => validatePattern('**/*.md, 01-*, [0-9]-*'));
  });
});
