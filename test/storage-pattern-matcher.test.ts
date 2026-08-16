import { test, describe } from 'node:test';
import assert from 'node:assert';
import { matchesPattern, matchesTags, extractTags } from '../src/storage/pattern-matcher';

describe('Pattern and Glob Matcher', () => {
  test('matches simple file basenames and wildcards', () => {
    assert.strictEqual(matchesPattern('note.md', '*.md'), true);
    assert.strictEqual(matchesPattern('note.txt', '*.md'), false);
    assert.strictEqual(matchesPattern('MODULES/05-containers/runbook-template.md', '*template*'), true);
    assert.strictEqual(matchesPattern('MODULES/05-containers/01-mental-model.md', '*template*'), false);
  });

  test('matches character classes and prefixes', () => {
    assert.strictEqual(matchesPattern('01-concept.md', '0[1-4]-*'), true);
    assert.strictEqual(matchesPattern('05-concept.md', '0[1-4]-*'), false);
    assert.strictEqual(matchesPattern('MODULES/02-linux/03-perf.md', '0[1-4]-*'), true);
  });

  test('matches comma-separated patterns', () => {
    const patterns = '01-*, deep-dive*, lab-*';
    assert.strictEqual(matchesPattern('01-intro.md', patterns), true);
    assert.strictEqual(matchesPattern('deep-dive-01.md', patterns), true);
    assert.strictEqual(matchesPattern('lab-01.md', patterns), true);
    assert.strictEqual(matchesPattern('exam.md', patterns), false);
    assert.strictEqual(matchesPattern('checklist.md', patterns), false);
  });

  test('matches across relative directory paths', () => {
    assert.strictEqual(matchesPattern('MODULES/05-containers/01-docker.md', 'MODULES/**'), true);
    assert.strictEqual(matchesPattern('PROJECTS/proj-01/readme.md', 'MODULES/**'), false);
  });
});

describe('Frontmatter Tag Matcher', () => {
  test('extracts tags from array, string, and null', () => {
    assert.deepStrictEqual(extractTags(['type/concept', 'category/module']), ['type/concept', 'category/module']);
    assert.deepStrictEqual(extractTags('type/concept, category/module'), ['type/concept', 'category/module']);
    assert.deepStrictEqual(extractTags(null), []);
    assert.deepStrictEqual(extractTags(undefined), []);
  });

  test('matches exact tag names', () => {
    const tags = ['type/concept', 'domain/security'];
    assert.strictEqual(matchesTags(tags, 'type/concept'), true);
    assert.strictEqual(matchesTags(tags, 'domain/security'), true);
    assert.strictEqual(matchesTags(tags, 'domain/containers'), false);
  });

  test('matches hierarchical tag segments', () => {
    const tags = ['type/concept', 'category/module'];
    // Target "concept" should match "type/concept"
    assert.strictEqual(matchesTags(tags, 'concept'), true);
    // Target "module" should match "category/module"
    assert.strictEqual(matchesTags(tags, 'module'), true);
    assert.strictEqual(matchesTags(tags, 'lab'), false);
  });

  test('matches comma-separated target tags', () => {
    const tags = ['type/lab'];
    assert.strictEqual(matchesTags(tags, 'concept, deep-dive, lab'), true);
    assert.strictEqual(matchesTags(tags, 'rubric, template'), false);
  });
});
