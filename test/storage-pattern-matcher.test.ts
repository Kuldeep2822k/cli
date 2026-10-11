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
    assert.ok(elapsed < 500, `Expected multi-band match to execute in <500ms, took ${elapsed}ms`);
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

  // A pattern is typed by a person and a path arrives off the volume, and APFS
  // stores the accented name decomposed while the keyboard produces the composed
  // one. Case was already folded on both sides; Unicode was folded on neither, so
  // `excludeDirs: notes/café` left `notes/cafe` + U+0301 in the scan. Built from
  // code points because the two spellings must be fixed by this source, not by
  // however the file happens to be encoded.
  test('matches a pattern whose accent is spelled the other way round', () => {
    const NFD_ACUTE = String.fromCharCode(0x0301); // `e` + combining acute: what APFS stores
    const NFC_ACUTE = String.fromCharCode(0x00e9); // precomposed `é`: what a keyboard produces
    const stored = 'notes/cafe' + NFD_ACUTE + '/01-intro.md';
    const written = 'notes/caf' + NFC_ACUTE;

    assert.strictEqual(matchesPattern(stored, written), true, 'the decomposed path matches the composed pattern');
    assert.strictEqual(matchesPattern(written + '/01-intro.md', written), true, 'and the matching spelling still matches');
    assert.strictEqual(matchesPattern('notes/tea/01-intro.md', written), false, 'no other directory is excluded');
  });
});

describe('Pattern Validation', () => {
  test('validatePattern accepts valid globs without throwing', () => {
    assert.doesNotThrow(() => validatePattern('**/*.md, 01-*, [0-9]-*'));
  });
});

// #312 — the dialect `palee adopt --help` now documents. These hold at base and are
// pinned so the written rule and the engine cannot drift apart: a `/` in the pattern
// anchors it at the vault root, its absence matches the filename in any directory,
// and folding is case-insensitive.
describe('Glob dialect documented in adopt --help (#312)', () => {
  test('a pattern containing / is anchored at the root and must name the whole path', () => {
    assert.strictEqual(matchesPattern('a/x.md', 'a/*.md'), true);
    assert.strictEqual(matchesPattern('x.md', 'a/*.md'), false, 'the directory the pattern names must exist');
    assert.strictEqual(matchesPattern('b/a/x.md', 'a/*.md'), false, 'and it is not matched at a deeper level');
  });

  test('a pattern without / matches the filename in any directory', () => {
    assert.strictEqual(matchesPattern('x-draft.md', '*draft*'), true);
    assert.strictEqual(matchesPattern('MODULES/01/x-draft.md', '*draft*'), true);
    assert.strictEqual(matchesPattern('MODULES/01/lesson.md', '*draft*'), false);
  });

  test('matching ignores case on both the anchored and the per-name forms', () => {
    assert.strictEqual(matchesPattern('MODULES/01-LESSON.md', 'modules/01-lesson.md'), true);
    assert.strictEqual(matchesPattern('MODULES/01-lesson.md', '*TEMPLATE*'), false);
    assert.strictEqual(matchesPattern('MODULES/runbook-TEMPLATE.md', '*template*'), true);
  });
});
