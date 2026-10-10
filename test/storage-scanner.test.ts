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
import { MAX_NOTE_SOURCE_BYTES } from '../src/storage/source-cap';
import type { ScannedNote } from '../src/types';

/**
 * Counts `fs.readFileSync` calls for one path while `body` runs.
 *
 * @remarks
 * The storage readers reach the filesystem through the shared `fs` module
 * object, so replacing the method for the duration of the callback observes
 * their IO without changing it. Restored in a `finally`, so a failing assertion
 * cannot leak the patch into the next test. Used to prove the #332 guard is
 * stat-first: a declined document is never read, not read-then-rejected.
 *
 * @param target - Absolute path whose reads are counted
 * @param body - Code under observation
 * @returns Number of `readFileSync` calls made for `target`
 */
function countReadsOf(target: string, body: () => void): number {
  const original = fs.readFileSync;
  const callOriginal = original as unknown as (...args: unknown[]) => unknown;
  const holder = fs as unknown as { readFileSync: typeof fs.readFileSync };
  let count = 0;
  holder.readFileSync = ((...args: unknown[]): unknown => {
    if (args[0] === target) count++;
    return callOriginal.apply(fs, args);
  }) as typeof fs.readFileSync;
  try {
    body();
  } finally {
    holder.readFileSync = original;
  }
  return count;
}

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
      // Load-bearing shape: the blank line before `## Subheading`. In YAML that
      // heading would be an ordinary comment (#319), so the scanner keeps it
      // fatal by position — a heading-shaped line that is separated from the
      // mapping by a blank line AND has no data line after it sits in the
      // trailing paragraph against the `---`, which only a missing closing
      // fence can produce. Its mirror pair, where the same heading is adjacent
      // to the entries, is asserted legal in the `#319` block below.
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

  // Issue #319: in YAML a `#` starts a comment no matter how many hashes
  // follow it, so a `## key points` line inside a frontmatter block parses
  // cleanly. Classifying it as Markdown body text discarded the successfully
  // parsed metadata and raised a fatal "unclosed frontmatter block" for a note
  // that was never unclosed — the note silently stopped being a topic.
  describe('YAML comment lines inside a frontmatter block (#319)', () => {
    test('a hash-run comment between mapping entries keeps the metadata and reports no error', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'comment-between-keys.md'),
        '---\npalee_id: T-319-between\ntitle: Comments are YAML\n## key points\ndifficulty: beginner\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined, 'a YAML comment is not leaked body text');
      assert.ok(notes[0].frontmatter, 'the parsed frontmatter must survive');
      const fm = notes[0].frontmatter as Record<string, unknown>;
      assert.strictEqual(fm.palee_id, 'T-319-between');
      assert.strictEqual(fm.difficulty, 'beginner');
    });

    test('a hash-run comment as the last entry of a closed block is a comment too', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'comment-last-entry.md'),
        '---\npalee_id: T-319-last\ntitle: Trailing comment\n#### reviewed 2026-01-01\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.strictEqual((notes[0].frontmatter as Record<string, unknown>).palee_id, 'T-319-last');
    });

    test('a comment after a blank line while the mapping continues is legal', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'comment-after-blank-then-keys.md'),
        '---\npalee_id: T-319-blank\n\n## key points\ndifficulty: advanced\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined, 'the entries after it keep the mapping open');
      const fm = notes[0].frontmatter as Record<string, unknown>;
      assert.strictEqual(fm['## key points'], undefined, 'the comment must not become a key');
      assert.strictEqual(fm.difficulty, 'advanced');
    });

    test('a comment with no space after the hashes is a comment, not a heading', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'comment-no-space.md'),
        '---\npalee_id: T-319-nospace\n##tagged\n#plain-hash\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].parseError, undefined);
      assert.strictEqual((notes[0].frontmatter as Record<string, unknown>).palee_id, 'T-319-nospace');
    });

    test('the heading shape is fatal only in the trailing paragraph, not adjacent to the entries', () => {
      // The pair that pins the #319 / #171.11 distinction: identical heading
      // text, different position. The blank-line-separated trailing heading is
      // the swallowed-body signature the heuristic exists for (see the
      // `body-break-headings` case above); the adjacent one is YAML syntax.
      fs.writeFileSync(
        path.join(tmpVault, 'heading-adjacent.md'),
        '---\npalee_id: T-heading-legal\ntitle: Legal\n## Subheading\n---\n# Real Body\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpVault, 'heading-trailing.md'),
        '---\npalee_id: T-heading-leaked\ntitle: Leaked\n\n## Subheading\n---\n# Real Body\n',
        'utf8'
      );

      const notes = scanNotes(tmpVault);
      assert.strictEqual(notes.length, 2);
      const legal = notes.find((n) => n.relativePath === 'heading-adjacent.md');
      const leaked = notes.find((n) => n.relativePath === 'heading-trailing.md');
      assert.ok(legal && leaked);

      assert.strictEqual(legal.parseError, undefined, 'a comment among the entries is legal YAML');
      assert.strictEqual(
        (legal.frontmatter as Record<string, unknown>).palee_id,
        'T-heading-legal'
      );

      assert.strictEqual(leaked.frontmatter, null);
      assert.ok(leaked.parseError, 'a trailing paragraph before the fence is leaked body text');
      assert.match(leaked.parseError!, /unclosed/i);
    });
  });

  // Issue #332: the note readers used to hand readFileSync an unbounded path,
  // so one multi-megabyte document (exported log, pasted diff, generated index)
  // was read whole and line-scanned on every scan. The guard is stat-first,
  // exactly like the TOC reader's `oversized` decline (src/storage/toc.ts,
  // issue #263): the cap covers the IO, not only the parse.
  describe('Note read size guard (#332)', () => {
    test('a document above the cap is declined without being read, and reported', () => {
      const bigPath = path.join(tmpVault, 'exported-log.md');
      fs.writeFileSync(bigPath, `${'x'.repeat(MAX_NOTE_SOURCE_BYTES)}y`, 'utf8');

      let notes: ScannedNote[] = [];
      const reads = countReadsOf(bigPath, () => {
        notes = scanNotes(tmpVault);
      });

      assert.strictEqual(reads, 0, 'the file must never be read — the guard stats first');
      assert.strictEqual(notes.length, 1, 'the declined file still gets one entry');
      assert.strictEqual(notes[0].frontmatter, null);
      assert.match(notes[0].readError ?? '', /Oversized/);
      assert.ok(
        (notes[0].readError ?? '').includes(String(MAX_NOTE_SOURCE_BYTES)),
        'the diagnostic names the ceiling the reader applied'
      );
      assert.strictEqual(notes[0].parseError, undefined, 'a declined read is not a parse failure');

      // `includeContent` must not smuggle the bytes back into the snapshot.
      const snapshot = scanNotes(tmpVault, { includeContent: true });
      assert.strictEqual(snapshot[0].content, undefined);
    });

    test('a note at exactly the cap is still read and parsed', () => {
      const edgePath = path.join(tmpVault, 'edge.md');
      const body = 'x'.repeat(MAX_NOTE_SOURCE_BYTES - '# Note\n'.length - '\n'.length);
      fs.writeFileSync(edgePath, `# Note\n${body}\n`, 'utf8');
      assert.strictEqual(fs.statSync(edgePath).size, MAX_NOTE_SOURCE_BYTES, 'edge is exactly the cap');

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].readError, undefined, 'the cap is inclusive, not exclusive');
      assert.strictEqual(notes[0].frontmatter, null, 'a large note without frontmatter is simply not a topic');
    });

    test('a legal topic note below the cap is unaffected by the guard', () => {
      fs.writeFileSync(
        path.join(tmpVault, 'long-topic.md'),
        `---\npalee_id: T-long\n---\n${'# Body\n'.repeat(1024)}`,
        'utf8'
      );

      const notes = scanNotes(tmpVault);

      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].readError, undefined);
      assert.strictEqual((notes[0].frontmatter as Record<string, unknown>).palee_id, 'T-long');
    });
  });
});
