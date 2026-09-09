/**
 * Validation vault collection tests (#25)
 *
 * Contracts under test:
 * - `collectVault` builds a full `ValidationContext` in one call.
 * - Malformed notes survive collection as parse-error entries — the scan
 *   never aborts (invariant: a bad note is a warning, not a crash).
 * - Valid PALEE topics in the same vault are still collected and checked.
 * - Topic loading honors an injected cache (isolation seam from #129).
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectVault } from '../src/validation/collect-vault';
import { FileCache } from '../src/storage/cache';
import type { LoadedTopic } from '../src/storage/loader';

describe('Validation vault collection', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-collect-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('collects topics, files, and per-file note outcomes into one context', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic.md'),
      '---\npalee_schema: 1\npalee_id: T-a\ntitle: A\n---\n# A\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpVault, 'plain.md'), '# Plain\n', 'utf8');

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    assert.strictEqual(context.vaultPath, tmpVault);
    assert.strictEqual(context.files.length, 2);
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.topics[0].palee_id, 'T-a');
    assert.strictEqual(context.notes.length, 2);
  });

  test('malformed note does not abort collection; valid topics still load', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpVault, 'good.md'),
      '---\npalee_schema: 1\npalee_id: T-good\ntitle: Good\n---\n# Good\n',
      'utf8'
    );

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    const broken = context.notes.find((n) => n.relativePath === 'broken.md');
    assert.ok(broken, 'malformed note must survive collection');
    assert.ok(broken.parseError);
    assert.strictEqual(broken.frontmatter, null);

    // The valid topic next to it is still fully collected.
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.topics[0].palee_id, 'T-good');
  });

  test('malformed non-PALEE note is retained in notes but yields no topic', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'user-note.md'),
      '---\ntags: [broken\n---\n# Personal note\n',
      'utf8'
    );

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    assert.strictEqual(context.notes.length, 1);
    assert.ok(context.notes[0].parseError);
    assert.strictEqual(context.topics.length, 0);
  });

  test('empty vault collects an empty context without error', () => {
    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    assert.deepStrictEqual(context.files, []);
    assert.deepStrictEqual(context.topics, []);
    assert.deepStrictEqual(context.notes, []);
  });

  test('pre-scanned files are accepted to avoid a duplicate walk', () => {
    const topicPath = path.join(tmpVault, 't.md');
    fs.writeFileSync(
      topicPath,
      '---\npalee_schema: 1\npalee_id: T-t\n---\n# T\n',
      'utf8'
    );

    const context = collectVault(tmpVault, {
      files: [topicPath],
      cache: new FileCache<LoadedTopic>(),
    });

    assert.deepStrictEqual(context.files, [topicPath]);
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.notes.length, 1);
  });
});
