/**
 * Storage Note Scanner tests (#25)
 *
 * Contracts under test:
 * - `scanNotes` reads every file and reports per-file frontmatter outcomes.
 * - Malformed YAML becomes a `parseError` entry — never a throw.
 * - Unclosed frontmatter fences are reported as parse errors.
 * - Output is deterministic, sorted by relative path.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanNotes } from '../src/storage/scanner';

describe('Storage Note Scanner', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-scanner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('returns one entry per scanned file with parsed frontmatter', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic.md'),
      '---\npalee_schema: 1\npalee_id: T-a\ntitle: A\n---\n# A\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpVault, 'plain.md'), '# Just a note\n', 'utf8');

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 2);
    const topicNote = notes.find((n) => n.relativePath === 'topic.md');
    const plainNote = notes.find((n) => n.relativePath === 'plain.md');
    assert.ok(topicNote);
    assert.ok(plainNote);
    assert.strictEqual((topicNote.frontmatter as Record<string, unknown>).palee_id, 'T-a');
    assert.strictEqual(topicNote.parseError, undefined);
    // A plain note without frontmatter is not an error — frontmatter is null.
    assert.strictEqual(plainNote.frontmatter, null);
    assert.strictEqual(plainNote.parseError, undefined);
  });

  test('malformed YAML yields a parseError entry, not a throw', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].frontmatter, null);
    assert.ok(notes[0].parseError, 'expected a parse error message');
    assert.ok(notes[0].parseError!.length > 0);
  });

  test('unclosed frontmatter fence is reported as a parse error', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'unclosed.md'),
      '---\npalee_id: T-never-closed\ntitle: Never closed\n',
      'utf8'
    );

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].frontmatter, null);
    assert.match(notes[0].parseError ?? '', /unclosed/i);
  });

  test('a note opening with a --- thematic break is not flagged (horizontal rule)', () => {
    // Legal Markdown: opens with a horizontal rule, no frontmatter anywhere.
    fs.writeFileSync(
      path.join(tmpVault, 'hr-note.md'),
      '---\n# My day\nsome prose with no YAML at all\n',
      'utf8'
    );

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].parseError, undefined, 'thematic break must not be flagged');
    assert.strictEqual(notes[0].frontmatter, null);
  });

  test('unclosed fence with YAML-like body still reports a parse error', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'yaml-ish.md'),
      '---\ntags: [broken, list\n\n# Note\n',
      'utf8'
    );

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].parseError ?? '', /unclosed/i);
  });

  test('includeContent captures raw bytes for snapshot injection', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic.md'),
      '---\npalee_id: T-a\n---\n# A\n',
      'utf8'
    );

    const [note] = scanNotes(tmpVault, { includeContent: true });

    assert.strictEqual(note.content, '---\npalee_id: T-a\n---\n# A\n');
  });

  test('empty frontmatter fences are not a parse error', () => {
    fs.writeFileSync(path.join(tmpVault, 'empty-fences.md'), '---\n---\n# Body\n', 'utf8');

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].parseError, undefined);
  });

  test('output is sorted by relative path across nested directories', () => {
    fs.mkdirSync(path.join(tmpVault, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, 'zeta.md'), '# Z\n', 'utf8');
    fs.writeFileSync(path.join(tmpVault, 'sub', 'alpha.md'), '# A\n', 'utf8');
    fs.writeFileSync(path.join(tmpVault, 'mid.md'), '# M\n', 'utf8');

    const notes = scanNotes(tmpVault);

    assert.deepStrictEqual(
      notes.map((n) => n.relativePath),
      ['mid.md', 'sub/alpha.md', 'zeta.md']
    );
  });

  test('relative paths use POSIX separators', () => {
    fs.mkdirSync(path.join(tmpVault, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, 'nested', 'deep', 'note.md'), '# N\n', 'utf8');

    const notes = scanNotes(tmpVault);

    assert.ok(notes[0].relativePath.includes('/'), `expected POSIX path, got ${notes[0].relativePath}`);
    assert.ok(!notes[0].relativePath.includes('\\'));
  });

  test('skips unreadable files gracefully', () => {
    fs.writeFileSync(path.join(tmpVault, 'readable.md'), '# R\n', 'utf8');
    const files = [
      path.join(tmpVault, 'readable.md'),
      path.join(tmpVault, 'deleted-in-flight.md'),
    ];

    const notes = scanNotes(tmpVault, { files });

    // Read failures are RETAINED as readError notes (not dropped), so rules
    // can warn that validation ran on an incomplete snapshot.
    assert.strictEqual(notes.length, 2);
    const failed = notes.find((n) => n.relativePath === 'deleted-in-flight.md');
    assert.ok(failed);
    assert.ok(failed.readError);
    assert.strictEqual(failed.frontmatter, null);
    assert.strictEqual(failed.parseError, undefined);
    const ok = notes.find((n) => n.relativePath === 'readable.md');
    assert.ok(ok);
    assert.strictEqual(ok.readError, undefined);
  });

  test('unclosed fence with column-0 YAML sequence still reports a parse error', () => {
    // Kilo review: block sequences at column 0 (`- item`) must be flagged.
    fs.writeFileSync(
      path.join(tmpVault, 'seq-note.md'),
      '---\n- tag1\n- tag2\n# Content\n',
      'utf8'
    );

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].parseError ?? '', /unclosed/i);
  });

  test('unclosed fence with indented YAML mapping still reports a parse error', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'indented-note.md'),
      '---\n  tags: [a, b]\n# Content\n',
      'utf8'
    );

    const notes = scanNotes(tmpVault);

    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].parseError ?? '', /unclosed/i);
  });
});
