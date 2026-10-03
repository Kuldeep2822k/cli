/**
 * v0.6.0 audit sweep fixes (issue #269).
 *
 * One group per fix: numeric palee_id, wikilink `#` handling + indented
 * fences, `_meta` exclusion + case-insensitive `.md`, TOC root hoist, and
 * NFC/NFD folding for wikilink/TOC lookups.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadTopics, normalizePaleeId } from '../src/storage/loader';
import { FileCache } from '../src/storage/cache';
import type { LoadedTopic } from '../src/storage/loader';
import { parseWikilink, stripFencedCodeBlocks } from '../src/engine/auto-chain';
import { walkVault } from '../src/storage/vault-walker';
import { planTocChain } from '../src/engine/toc-chain';
import { buildVaultNoteIndex, resolveWikilinkTarget, foldNoteKey } from '../src/storage/wikilink';
import { foldTocKey, deriveTocEnumeration } from '../src/storage/toc';

describe('audit sweep: loader numeric palee_id', () => {
  let vault: string;
  let cache: FileCache<LoadedTopic>;

  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'palee-audit-loader-')));
    cache = new FileCache<LoadedTopic>();
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('normalizePaleeId stringifies finite numbers, rejects other types', () => {
    assert.strictEqual(normalizePaleeId(' T-a '), 'T-a');
    assert.strictEqual(normalizePaleeId(12345), '12345');
    assert.strictEqual(normalizePaleeId(true), null);
    assert.strictEqual(normalizePaleeId('   '), null);
    assert.strictEqual(normalizePaleeId(null), null);
  });

  test('numeric palee_id loads instead of vanishing (no re-mint)', () => {
    fs.writeFileSync(path.join(vault, 'a.md'), '---\npalee_id: 12345\ntitle: Num\n---\n# hi\n', 'utf8');
    const topics = loadTopics(vault, { cache });
    assert.strictEqual(topics.length, 1);
    assert.strictEqual(topics[0].palee_id, '12345');
  });

  test('wikilink roadmap reuses a numeric id and keeps its edge', async () => {
    fs.writeFileSync(path.join(vault, 'a.md'), '---\npalee_id: 12345\ntitle: Num\n---\n# hi\n', 'utf8');
    fs.writeFileSync(
      path.join(vault, 'b.md'),
      '---\npalee_id: T-b\ntitle: B\ndepends_on: ["12345"]\n---\n# b\n',
      'utf8'
    );
    const { resolveWikilinkRoadmap } = await import('../src/storage/wikilink');
    const parsed_a = parseWikilink('[[a]]');
    const parsed_b = parseWikilink('[[b]]');
    assert.ok(parsed_a && parsed_b);
    const roadmap = resolveWikilinkRoadmap(vault, [{ track: 't', links: [parsed_a, parsed_b] }]);
    assert.strictEqual(roadmap.topics[0].id, '12345');
    assert.deepStrictEqual(roadmap.topics[1].depends_on, ['12345']);
  });
});

describe('audit sweep: wikilink trailing hash + fenced blocks', () => {
  test('a trailing hash belongs to the filename, a heading anchor is stripped', () => {
    assert.deepStrictEqual(parseWikilink('[[C#]]'), { target: 'C#' });
    assert.deepStrictEqual(parseWikilink('[[note#heading]]'), { target: 'note' });
    assert.strictEqual(parseWikilink('[[#heading]]'), null);
    assert.deepStrictEqual(parseWikilink('[[a|b#c]]'), { target: 'a', alias: 'b#c' });
  });

  test('list and quote fences mask links, four-space code does not', () => {
    const visible = (text: string): string[] =>
      stripFencedCodeBlocks(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    assert.deepStrictEqual(visible('a\n```\n- [[hidden]]\n```\nb'), ['a', 'b']);
    assert.deepStrictEqual(visible('a\n  - ```\n  - [[Ghost]]\n  - ```\nb'), ['a', 'b']);
    assert.deepStrictEqual(visible('a\n> ```\n> [[Ghost]]\n> ```\nb'), ['a', 'b']);
    const four = visible('a\n    ```\n- [[Real]]\n    ```\nb');
    assert.ok(four.join(' ').includes('[[Real]]'));
  });
});

describe('audit sweep: vault walker _meta + case-insensitive md', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-audit-walk-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('skips _meta dirs and finds UPPER.MD notes', () => {
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vault, '_meta', 'skip.md'), '# skip\n');
    fs.writeFileSync(path.join(vault, 'UPPER.MD'), '# upper\n');
    fs.writeFileSync(path.join(vault, 'lower.md'), '# lower\n');
    const found = walkVault(vault).map((p) => path.basename(p)).sort();
    assert.ok(!found.includes('skip.md'));
    assert.ok(found.includes('UPPER.MD'));
    assert.ok(found.includes('lower.md'));
  });
});

describe('audit sweep: toc root hoist', () => {
  test('an enumerating root README heads the chain instead of following its lesson', () => {
    const plan = planTocChain(['a/x.md', 'README.md']);
    assert.deepStrictEqual(plan.orderedPaths, ['README.md', 'a/x.md']);
    assert.strictEqual(plan.predecessorOf.get('README.md'), null);
    assert.strictEqual(plan.predecessorOf.get('a/x.md'), 'README.md');
  });

  test('module READMEs still bridge from the root (existing contract)', () => {
    const plan = planTocChain(['r.md', 'a/README.md', 'a/x.md']);
    assert.strictEqual(plan.predecessorOf.get('r.md'), null);
    assert.strictEqual(plan.predecessorOf.get('a/README.md'), 'r.md');
    assert.strictEqual(plan.predecessorOf.get('a/x.md'), 'a/README.md');
  });
});

describe('audit sweep: NFC/NFD folding', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-audit-nfc-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('fold helpers equate NFC and NFD spellings', () => {
    const nfc = 'café';
    const nfd = nfc.normalize('NFD');
    assert.notStrictEqual(nfc, nfd);
    assert.strictEqual(foldNoteKey(nfc), foldNoteKey(nfd));
    assert.strictEqual(foldTocKey(nfc), foldTocKey(nfd));
  });

  test('an NFD filename resolves through an NFC wikilink', () => {
    const nfc = 'café';
    const nfd = nfc.normalize('NFD');
    fs.writeFileSync(path.join(vault, `${nfd}.md`), '# NFD note\n');
    const index = buildVaultNoteIndex(vault);
    const parsed = parseWikilink(`[[${nfc}]]`);
    assert.ok(parsed);
    const resolved = resolveWikilinkTarget(vault, parsed, index);
    assert.ok(resolved.relativePath.endsWith('.md'));
  });

  test('a TOC link in NFC finds an NFD note on disk', () => {
    const nfc = 'café';
    const nfd = nfc.normalize('NFD');
    fs.writeFileSync(path.join(vault, 'README.md'), `- [x](${nfc}.md)\n`);
    fs.writeFileSync(path.join(vault, `${nfd}.md`), '# NFD note\n');
    const enumeration = deriveTocEnumeration(vault);
    assert.ok(enumeration.documentOrder.length >= 1);
    assert.ok(enumeration.skipped.length === 0);
  });
});
