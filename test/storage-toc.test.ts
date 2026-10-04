import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverTocFiles, deriveTocEnumeration } from '../src/storage/toc';
import { planAutoChainWithHygiene } from '../src/engine/auto-chain';
import { composeTieredChain } from '../src/engine/toc-chain';

/** Write a file creating parent dirs; contents default to a heading. */
function write(root: string, rel: string, contents?: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents ?? `# ${path.basename(rel, '.md')}\n`);
}

/**
 * Whether the temp filesystem folds filename case. `dup/README.md` and
 * `dup/readme.md` cannot coexist there, so the case-fold ambiguity fixture
 * is unconstructible and its test is skipped.
 *
 * @returns True on case-insensitive volumes (Windows NTFS, default macOS APFS)
 *
 * @remarks
 * Probed at runtime rather than by platform: most macOS volumes are
 * case-insensitive while some are not, and the reverse holds on Linux.
 * The vault lives under `os.tmpdir`, so probing there tests the same volume.
 */
function tempFsIgnoresCase(): boolean {
  const upper = path.join(os.tmpdir(), `palee-case-probe-${process.pid}-AA`);
  const lower = upper.toLowerCase();
  fs.writeFileSync(upper, 'x');
  try {
    return fs.existsSync(lower);
  } finally {
    fs.rmSync(upper, { force: true });
    fs.rmSync(lower, { force: true });
  }
}

describe('TOC discovery (PAL-205-C3, storage half)', () => {
  let vault: string;
  let outside: string;

  before(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'palee-toc-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'palee-toc-out-')));
    write(outside, 'secret.md', '# Outside\n');
  });

  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.mkdirSync(vault, { recursive: true });
  });

  describe('discoverTocFiles', () => {
    it('finds root README/SUMMARY first, then module READMEs in numbered order', () => {
      write(vault, 'README.md', '# Home\n');
      write(vault, 'SUMMARY.md', '# Summary\n');
      write(vault, '02-b/README.md');
      write(vault, '01-a/README.md');
      write(vault, '10-c/README.md');
      write(vault, 'LICENSE.md', '# License\n');
      assert.deepStrictEqual(discoverTocFiles(vault), [
        'README.md',
        'SUMMARY.md',
        '01-a/README.md',
        '02-b/README.md',
        '10-c/README.md',
      ]);
    });

    it('never treats phase-subtree or translation-dir READMEs as TOC sources', () => {
      write(vault, 'README.md');
      write(vault, 'solution/01-a/README.md');
      write(vault, 'translations/README.md');
      assert.deepStrictEqual(discoverTocFiles(vault), ['README.md']);
    });
  });

  describe('deriveTocEnumeration — the 12 adversarial constructs', () => {
    it('folder links resolve to <dir>/README.md and trailing slashes dedup', () => {
      write(vault, 'README.md', [
        '- [a](01-a/)',
        '- [a again](01-a)',
        '- [explicit](01-a/README.md)',
      ].join('\n'));
      write(vault, '01-a/README.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['01-a/README.md', '01-a/README.md', '01-a/README.md']);
      // The planner collapses the duplicates:
      assert.deepStrictEqual([...new Set(enum_.documentOrder)], ['01-a/README.md']);
    });

    it('strips #anchors and decodes %20 — and never falls back to the raw form', () => {
      write(vault, 'README.md', [
        '- [x](01-intro.md#setup)',
        '- [y](02%20core.md)',
        // A file whose LITERAL name contains %20 must not be reachable by an
        // encoded link: the decoded candidate `03 raw.md` is missing → skip.
        '- [z](03%20raw.md)',
      ].join('\n'));
      write(vault, '01-intro.md');
      write(vault, '02 core.md');
      write(vault, '03%20raw.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['01-intro.md', '02 core.md']);
      assert.deepStrictEqual(enum_.skipped.map((s) => s.reason), ['missing']);
    });

    it('parses <angle bracket paths> — the prototype gap (was under-chaining)', () => {
      write(vault, 'README.md', '- [a](<01-getting started/setup.md>)');
      write(vault, '01-getting started/setup.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['01-getting started/setup.md']);
    });

    it('rejects .. that leaves the vault, even when the target really exists outside', () => {
      const escapeRel = path.relative(vault, outside).split(path.sep).join('/');
      write(vault, 'README.md', `- [leak](../${escapeRel.replace(/^\.\.\//, '')}/secret.md)\n- [ok](notes.md)`);
      write(vault, 'notes.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['notes.md']);
      assert.strictEqual(enum_.skipped[0].reason, 'escaped-vault');
    });

    it('resolves .. hops that stay inside the vault relative to the TOC file', () => {
      write(vault, '01-a/README.md', '- [back](../02-b/topic.md)');
      write(vault, '02-b/topic.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.ok(enum_.documentOrder.includes('02-b/topic.md'));
    });

    it('case-insensitive fallback resolves readme.md -> README.md', () => {
      write(vault, 'README.md', '- [x](02-core/readme.md)');
      write(vault, '02-core/README.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['02-core/README.md']);
      assert.deepStrictEqual(enum_.skipped, []);
    });

    // Computed once: the fixture needs two same-directory names that differ
    // only by case, which a case-folding volume cannot hold.
    const caseBlindFs = tempFsIgnoresCase();
    it(
      'a case-fold matching several real files is ambiguous and skipped',
      { skip: caseBlindFs },
      () => {
        // Only constructible on case-sensitive filesystems: `dup/README.md`
        // and `dup/readme.md` cannot coexist where the volume folds case.
        // Both halves of the rule are
        // asserted here, because the two spellings decide differently: `lookupNote`
        // answers an exact path before it folds at all, so the link spelled like a
        // real file resolves, and only a spelling that matches neither file can be
        // ambiguous. Demanding ambiguity for the exact form would ask the fold to
        // outrank the file on disk.
        write(vault, 'README.md', [
          '- [y](dup/README.md)',
          '- [z](dup/readme.MD)',
        ].join('\n'));
        write(vault, 'dup/README.md');
        write(vault, 'dup/readme.md');
        const enum_ = deriveTocEnumeration(vault);
        assert.deepStrictEqual(enum_.documentOrder, ['dup/README.md'],
          'the exact spelling is the file the author named');
        assert.strictEqual(enum_.skipped.length, 1, 'only the unspellable link is dropped');
        assert.strictEqual(enum_.skipped[0].raw, 'dup/readme.MD');
        assert.strictEqual(enum_.skipped[0].reason, 'ambiguous',
          'a spelling that folds onto two real files decides nothing');
      }
    );

    it('backslashes are literal characters, never separators — and never collapse onto a sibling note', () => {
      // The old fixture (`01-a\README.md`, whose deleted-backslash form
      // `01-aREADME.md` named no note) asserted only the `missing` reason, so it
      // passed whether the backslash was honoured or silently dropped — it pinned
      // nothing. Here `01-a02-b.md` is a REAL sibling: dropping the backslash
      // resolves onto it, authoring an edge for a note the author never named.
      write(vault, 'README.md', '- [x](01-a\\02-b.md)');
      write(vault, '01-a02-b.md'); // the collapse target the fix must refuse
      write(vault, '01-a/02-b.md'); // a separator interpretation must not reach this either
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, [], 'a literal backslash names no real note');
      assert.strictEqual(enum_.skipped[0].reason, 'missing');
    });

    // Issue #262 — a destination whose name carries an encoded `#` and a real
    // decoy sharing the truncated prefix. Percent-decoding BEFORE the anchor
    // split turned `notes/c%23.md` into `notes/c#.md`, then cut it at `#` down to
    // `notes/c`, which resolved onto the unrelated `notes/c.md`.
    it('#262: a %23 destination reaches the note the author named, not the truncated one', () => {
      write(vault, 'README.md', [
        '- [sharp](notes/c%23.md)',
        '- [anchored](notes/c%23.md#section)',
      ].join('\n'));
      write(vault, 'notes/c#.md'); // the genuine note whose name carries a `#`
      write(vault, 'notes/c.md'); // the decoy the decode-then-split resolved onto
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['notes/c#.md', 'notes/c#.md']);
      assert.ok(!enum_.documentOrder.includes('notes/c.md'), 'the truncated wrong note must collect no edge');
    });

    // Issue #262 — a bare destination carrying an unescaped space was truncated at
    // the space (`notes/my`), which resolved onto the real `notes/my.md`. It must
    // instead be refused, while the documented <angle bracket> form still reaches
    // the spaced note.
    it('#262: a bare destination with a raw space is refused; the angle-bracket form still resolves', () => {
      write(vault, 'README.md', [
        '- [bare](notes/my note.md)',
        '- [angle](<notes/my note.md>)',
      ].join('\n'));
      write(vault, 'notes/my.md'); // the decoy the space-truncation resolved onto
      write(vault, 'notes/my note.md'); // the real spaced note (angle form reaches it)
      const enum_ = deriveTocEnumeration(vault);
      // Only the angle-bracket link enumerates; the bare link is skipped at the
      // parser (like `malformed`, an engine skip that names no file), so the
      // spaced note is reached exactly once and `notes/my.md` gains no edge.
      assert.deepStrictEqual(enum_.documentOrder, ['notes/my note.md']);
      assert.ok(!enum_.documentOrder.includes('notes/my.md'), 'the truncated wrong note must collect no edge');
      assert.strictEqual(enum_.skipped.length, 0, 'an engine skip lives on the link, not the storage skip list');
    });

    // Issue #262, review round — the point is the *class* of escapable characters:
    // CommonMark 2.4 lets a backslash escape any ASCII punctuation, and both
    // destination forms apply that rule. `[a](notes/v1\.2.md)` names the real
    // `notes/v1.2.md`; a set that omits the dot looked the file up as
    // `notes/v1\.2.md`, found nothing, and the author's ordering edge silently
    // never formed — the same lost-edge class this ticket exists to kill, pointed
    // the other way. `<` and `>` are unpinned here only because Windows forbids
    // them in a filename; the engine sweep covers them.
    it('#262: an escaped punctuation character names the real note in both destination forms', () => {
      write(vault, 'README.md', [
        '- [dot](notes/v1\\.2.md)',
        '- [plus](notes/v1\\+2.md)',
        '- [angled](<notes/v2\\.3.md>)',
      ].join('\n'));
      write(vault, 'notes/v1.2.md');
      write(vault, 'notes/v1+2.md');
      write(vault, 'notes/v2.3.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, ['notes/v1.2.md', 'notes/v1+2.md', 'notes/v2.3.md']);
      assert.strictEqual(enum_.skipped.length, 0, 'an honoured escape must leave nothing unresolved');
    });

    it('skips missing targets and translation targets, never aborting the run', () => {
      write(vault, 'README.md', [
        '- [gone](nope.md)',
        '- [es](translations/guide.es.md)',
        '- [ok](guide/intro.md)',
      ].join('\n'));
      write(vault, 'translations/guide.es.md');
      write(vault, 'guide/intro.md');
      const enum_ = deriveTocEnumeration(vault);
      // Storage returns what exists; hygiene exclusion happens at composition.
      assert.deepStrictEqual(enum_.documentOrder, ['translations/guide.es.md', 'guide/intro.md']);
      assert.strictEqual(enum_.skipped[0].reason, 'missing');
      const composed = composeTieredChain({
        tier: 'full',
        numbered: planAutoChainWithHygiene(enum_.documentOrder),
        tocPaths: enum_.documentOrder,
      });
      assert.ok(!composed.predecessorOf.has('translations/guide.es.md'));
      assert.ok(composed.orderedPaths.includes('guide/intro.md'));
    });

    it('filters targets outside the adoption scope, counted', () => {
      write(vault, 'README.md', '- [in](sub/a.md)\n- [out](other/b.md)');
      write(vault, 'sub/a.md');
      write(vault, 'other/b.md');
      const enum_ = deriveTocEnumeration(vault, new Set(['sub/a.md']));
      assert.deepStrictEqual(enum_.documentOrder, ['sub/a.md']);
      assert.strictEqual(enum_.skipped[0].reason, 'outside-scope');
    });

    it('end-to-end: phase inversion in an unnumbered repo composes to a clean chain', () => {
      write(vault, 'README.md', [
        '# Course',
        '- [Assignment](mod/assignment.md)',
        '- [Lab](mod/lab-01.md)',
        '- [Slides](mod/README.md)',
        '- [Extra](mod/extra.md)',
      ].join('\n'));
      write(vault, 'mod/README.md');
      write(vault, 'mod/lab-01.md');
      write(vault, 'mod/assignment.md');
      write(vault, 'mod/extra.md');
      const enum_ = deriveTocEnumeration(vault);
      const composed = composeTieredChain({
        tier: 'full',
        numbered: planAutoChainWithHygiene(enum_.documentOrder),
        tocPaths: enum_.documentOrder,
      });
      assert.deepStrictEqual(
        composed.orderedPaths,
        ['mod/README.md', 'mod/lab-01.md', 'mod/extra.md', 'mod/assignment.md']
      );
      assert.strictEqual(composed.tocEdgeCount, 3);
    });
  });
});
