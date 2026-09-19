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

  describe('Unclosed-fence heuristic gap (#171.11)', () => {
    test('valid note with unquoted keys containing spaces (e.g. display name) is parsed successfully', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'spaces-in-keys.md'),
        '---\npalee_id: T-valid\ntitle: Valid\ndisplay name: Mathematics\ncreated date: 2026-01-01\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.ok(notes[0].frontmatter);
      const fm = notes[0].frontmatter as Record<string, unknown>;
      assert.strictEqual(fm['display name'], 'Mathematics');
      assert.strictEqual(fm['created date'], '2026-01-01');
    });

    test('valid note with unquoted keys containing slashes, non-ASCII, and long names is parsed successfully', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'custom-keys.md'),
        '---\npalee_id: T-valid\nschema/url: https://example.test\npré-requis: T-1\nchapter one: Introduction\nmy custom long property name from plugin configuration: custom-value\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.ok(notes[0].frontmatter);
      const fm = notes[0].frontmatter as Record<string, unknown>;
      assert.strictEqual(fm['schema/url'], 'https://example.test');
      assert.strictEqual(fm['pré-requis'], 'T-1');
      assert.strictEqual(fm['chapter one'], 'Introduction');
      assert.strictEqual(
        fm['my custom long property name from plugin configuration'],
        'custom-value'
      );
    });

    test('valid note with key such as Chapter 1 in a closed block is parsed successfully', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'chapter-key.md'),
        '---\npalee_id: T-valid\ntitle: Valid\nChapter 1: Introduction\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.ok(notes[0].frontmatter);
      const fm = notes[0].frontmatter as Record<string, unknown>;
      assert.strictEqual(fm['Chapter 1'], 'Introduction');
    });

    test('unclosed fence followed by body thematic break with non-mapping colons (e.g. URLs) is reported as parse error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'body-break-url.md'),
        '---\npalee_id: T-unclosed\ntitle: Unclosed\n\nhttp://example.com/page\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].frontmatter, null);
      assert.ok(notes[0].parseError, 'expected a parse error');
      assert.match(notes[0].parseError!, /(unclosed|implicit map keys)/i);
    });

    test('unclosed fence followed by body thematic break with markdown subheadings is reported as parse error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'body-break-headings.md'),
        '---\npalee_id: T-unclosed\ntitle: Unclosed\n\n## Subheading\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].frontmatter, null);
      assert.ok(notes[0].parseError, 'expected a parse error');
      assert.match(notes[0].parseError!, /unclosed/i);
    });

    test('unclosed fence followed by body thematic break with blockquotes is reported as parse error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'body-break-quotes.md'),
        '---\npalee_id: T-unclosed\ntitle: Unclosed\n\n> Blockquote text\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].frontmatter, null);
      assert.ok(notes[0].parseError, 'expected a parse error');
    });

    test('unclosed fence with body containing non-fence \\n--- is still reported as parse error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'unclosed-with-dashes.md'),
        '---\npalee_id: T-unclosed\ntitle: Unclosed\n\nSome body text\n---not-a-closing-fence\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].frontmatter, null);
      assert.ok(notes[0].parseError, 'expected a parse error');
      assert.match(notes[0].parseError!, /(unclosed|implicit map keys|invalid frontmatter key)/i);
    });

    test('valid note with frontmatter and body thematic break is parsed successfully without parse error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'valid-with-hr.md'),
        '---\npalee_id: T-valid\ntitle: Valid\n---\n# Real Body\n---\nMore body text\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.ok(notes[0].frontmatter);
      assert.strictEqual((notes[0].frontmatter as Record<string, unknown>).palee_id, 'T-valid');
      assert.strictEqual((notes[0].frontmatter as Record<string, unknown>).title, 'Valid');
    });

    test('valid note with quoted keys containing colons is parsed successfully', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'quoted-colon-keys.md'),
        '---\n"custom: property": double-quoted\n\'other: property\': single-quoted\n"nested: \\"quote\\": key": value\n\'single: \'\'quote\'\': key\': value2\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.ok(notes[0].frontmatter);
      const fm = notes[0].frontmatter as Record<string, unknown>;
      assert.strictEqual(fm['custom: property'], 'double-quoted');
      assert.strictEqual(fm['other: property'], 'single-quoted');
      assert.strictEqual(fm['nested: "quote": key'], 'value');
      assert.strictEqual(fm["single: 'quote': key"], 'value2');
    });

    test('unclosed fence with body containing quoted string without colon separator reports parse error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'quoted-prose.md'),
        '---\npalee_id: T-unclosed\ntitle: Unclosed\n\n"Chapter 1: The Beginning" is a great chapter\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].frontmatter, null);
      assert.ok(notes[0].parseError, 'expected a parse error');
      assert.match(notes[0].parseError!, /(unclosed|implicit map keys)/i);
    });
  });
});
