import { describe, it } from 'node:test';
import assert from 'node:assert';
import { planAutoChainWithHygiene } from '../src/engine/auto-chain';
import {
  extractTocLinks,
  foldTocDestination,
  planTocChain,
  assertBackwardEdges,
  assertAcyclicPlan,
  isInNumberedTree,
  composeTieredChain,
  parseAutoChainTier,
} from '../src/engine/toc-chain';

describe('TOC tier engine (PAL-205-C3)', () => {
  describe('extractTocLinks', () => {
    it('keeps document order across a typical module README', () => {
      const md = [
        '# Module 01',
        '- [Slide 1](slides.md)',
        '- [Note](../02-core/readme.md)',
        'Done? [Quiz](quiz.md)',
      ].join('\n');
      const targets = extractTocLinks(md)
        .map((l) => l.destination)
        .filter((d): d is string => d !== null);
      assert.deepStrictEqual(targets, ['slides.md', '../02-core/readme.md', 'quiz.md']);
    });

    it('parses <angle bracket paths> — the prototype gap this tier must close', () => {
      const links = extractTocLinks('[start](<01-getting started/setup.md>)');
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].destination, '01-getting started/setup.md');
    });

    it('strips #anchors and tolerates titles', () => {
      assert.strictEqual(
        extractTocLinks('[a](path.md#section "The Title")')[0].destination,
        'path.md'
      );
      assert.strictEqual(extractTocLinks('[a](<with space.md#h1>)')[0].destination, 'with space.md');
    });

    it('decodes %20 but never falls back to the raw form', () => {
      assert.strictEqual(extractTocLinks('[a](01%20Get%20Started.md)')[0].destination, '01 Get Started.md');
    });

    it('skips malformed percent escapes fail-closed', () => {
      const links = extractTocLinks('[a](bad%zzname.md)');
      assert.strictEqual(links[0].destination, null);
      assert.strictEqual(links[0].skip, 'malformed');
    });

    it('skips images, self-anchors and external schemes', () => {
      const links = extractTocLinks(
        '![diagram](assets/d.png) [go](#top) [site](https://example.com/x.md) [mail](mailto:a@b.c) [ref][1]'
      );
      // Images and reference-style tails never parse as links at all; the
      // three real inline links parse but carry skip reasons.
      assert.strictEqual(links.length, 3);
      assert.deepStrictEqual(links.map((l) => l.skip), ['self-anchor', 'external', 'external']);
      assert.strictEqual(
        links.filter((l) => l.destination !== null).length,
        0
      );
      assert.strictEqual(extractTocLinks('![i](x.md)').length, 0);
    });

    it('ignores a stray unterminated bracket without aborting later links', () => {
      const links = extractTocLinks('[oops [nested](a.md)\n[ok](b.md)');
      const targets = links.map((l) => l.destination).filter(Boolean);
      assert.ok(targets.includes('a.md'));
      assert.ok(targets.includes('b.md'));
    });

    // The label and destination scanners walk forward until they find a closer,
    // so a README full of stray brackets used to re-scan the whole remainder for
    // every candidate: 200 KB of `[` stalled `adopt --auto-chain` for close to
    // two minutes at 100 % CPU. `deriveTocEnumeration` reads every README in the
    // vault unattended, so one pathological file was enough. The bound is loose
    // on purpose — the defect it detects costs seconds, not milliseconds.
    it('stays linear on a pathological run of stray brackets', () => {
      for (const [label, junk] of [
        ['unopened labels', '['.repeat(100000)],
        ['unclosed destinations', '[x]('.repeat(50000)],
      ] as const) {
        const started = performance.now();
        const targets = extractTocLinks(`[L](d/l.md)\n${junk}`)
          .map((l) => l.destination)
          .filter(Boolean);
        const elapsed = performance.now() - started;
        assert.ok(targets.includes('d/l.md'), `${label}: the real link must still be found`);
        assert.ok(elapsed < 2000, `${label}: took ${Math.round(elapsed)}ms, expected under 2000ms`);
      }
    });

    // Issue #263: the bail above fires only when NO `]` follows at all, so a
    // single stray `]` — the closing bracket of a mangled list item, a pasted
    // diff — defeated it and put every `[` back on the quadratic path, each
    // paying a full `findLabelEnd` walk to end-of-text. Measured on the unfixed
    // scanner with `'['.repeat(N) + ']'`: 20 000 brackets 0.6 s, 40 000 2.8 s,
    // 80 000 20 s, 160 000 82 s. This 100 000-bracket case took 17.8 s there and
    // ~2 ms linearised, so the bound below is ~70x under the defect and ~100x
    // over the fix: red on any return of the rescan, green on a loaded host.
    it('does not rescan every label when one stray ] defeats the no-closer bail', () => {
      for (const [label, junk] of [
        ['run of opens closed once', `${'['.repeat(100000)}]`],
        ['real links on both sides of the junk', `[L](d/l.md)\n${'['.repeat(100000)}]\n[ok](b.md)`],
      ] as const) {
        const started = performance.now();
        const targets = extractTocLinks(junk)
          .map((l) => l.destination)
          .filter((d): d is string => d !== null);
        const elapsed = performance.now() - started;
        assert.ok(
          elapsed < 250,
          `${label}: took ${Math.round(elapsed)}ms, expected under 250ms — a label scan is being repeated`
        );
        if (label === 'run of opens closed once') {
          assert.deepStrictEqual(targets, [], 'a run of stray brackets enumerates nothing');
        } else {
          assert.deepStrictEqual(targets, ['d/l.md', 'b.md'], `${label}: the real links survive the junk`);
        }
      }
    });

    // Issue #263's sibling: the destination scan is the same shape one function
    // over. `readDestination` walks forward until the paren balances and returns
    // `null` only at end-of-text, so a document whose destinations never balance —
    // `[a](b(c) ` repeated, where every `)` is consumed at depth > 0 so a depth-0
    // closer never exists — puts every remaining `[` on a full walk of the rest of
    // the file. Measured on the branch that fixed only the label scan: 90 KB 1.4 s,
    // 180 KB 5.8 s, 360 KB 20 s, 720 KB 79 s. `TOC_MAX_SOURCE_BYTES` caps a
    // document at 512 KiB, which still leaves ~40 s for one pathological README and
    // an unbounded aggregate over a vault, because `deriveTocEnumeration` reads
    // every one of them. Bound chosen the same way as the label case above: ~8x
    // under the defect at this size, ~1000x over the linearised scan.
    it('does not rescan every destination when none of them balances', () => {
      const junk = '[a](b(c) '.repeat(40000);
      for (const [label, text] of [
        ['run of unbalanced destinations', junk],
        ['real links on both sides of the junk', `[L](d/l.md)\n${junk}\n[ok](b.md)`],
      ] as const) {
        const started = performance.now();
        const targets = extractTocLinks(text)
          .map((l) => l.destination)
          .filter((d): d is string => d !== null);
        const elapsed = performance.now() - started;
        assert.ok(
          elapsed < 250,
          `${label}: took ${Math.round(elapsed)}ms, expected under 250ms — a destination scan is being repeated`
        );
        if (label === 'run of unbalanced destinations') {
          assert.deepStrictEqual(targets, [], 'a run of unbalanced destinations enumerates nothing');
        } else {
          assert.deepStrictEqual(targets, ['d/l.md', 'b.md'], `${label}: the real links survive the junk`);
        }
      }
    });

    // Issue #287: the third walk #263 left standing. `destinationCannotClose` says so
    // in its own docstring — the `<angle bracket>` branch closes on a `>` plus a plain
    // `)`, so paren depth answers nothing about it and it stayed on the full walk. A
    // README of stray angle brackets therefore restarts a scan of the rest of the file
    // for every preceding `[`. Measured on the unfixed scanner, over
    // `'[a](<b'.repeat(N) + ')'`: 2 500 → 119 ms, 5 000 → 444 ms, 10 000 → 4 746 ms.
    // The bound is the same shape as the two above: far under the defect, far over the
    // linearised scan. Note the second case holds both delimiters — the walk is
    // unbounded when a `>` exists but no `)` follows it, which no single-character
    // bail can see.
    it('does not rescan every angle destination when none of them closes', () => {
      for (const [label, text, expected] of [
        ['no unescaped > at all', `${'[a](<b'.repeat(10000)})`, []],
        ['a > with no ) after it', `${'[a](<b'.repeat(10000)})>`, []],
        [
          'real links on both sides of the junk',
          `[L](d/l.md)\n${'[a](<b'.repeat(10000)}\n[ok](b.md)`,
          ['d/l.md', 'b.md'],
        ],
      ] as const) {
        const started = performance.now();
        const targets = extractTocLinks(text)
          .map((l) => l.destination)
          .filter((d): d is string => d !== null);
        const elapsed = performance.now() - started;
        assert.ok(
          elapsed < 250,
          `${label}: took ${Math.round(elapsed)}ms, expected under 250ms — an angle destination scan is being repeated`
        );
        assert.deepStrictEqual(targets, expected, `${label}: enumeration changed by the bound`);
      }
    });

    // The bound above is a claim about a walk, and a claim about a walk can be wrong in
    // the direction that silently changes which links exist. Pinned against the outputs
    // captured from the unbounded scanner before any table was written, so a regression
    // here is a semantic change wearing a performance fix.
    it('answers angle closure from the table without changing what an angle destination means', () => {
      const cases: Array<[string, Array<{ raw: string; dest: string | null; skip: string | null }>]> =
        [
          ['[a](<notes/b.md>)', [{ raw: 'notes/b.md', dest: 'notes/b.md', skip: null }]],
          ['[a](<notes/my note.md>)', [{ raw: 'notes/my note.md', dest: 'notes/my note.md', skip: null }]],
          ['[a](<notes/intro(v2).md>)', [{ raw: 'notes/intro(v2).md', dest: 'notes/intro(v2).md', skip: null }]],
          ['[a](<notes/esc\\>right.md>)', [{ raw: 'notes/esc>right.md', dest: 'notes/esc>right.md', skip: null }]],
          ['[a](<notes/a%20b.md>)', [{ raw: 'notes/a%20b.md', dest: 'notes/a b.md', skip: null }]],
          ['[a](<notes/a.md#section>)', [{ raw: 'notes/a.md#section', dest: 'notes/a.md', skip: null }]],
          ['[a](<>)', [{ raw: '', dest: null, skip: 'empty' }]],
          ['[a](<b) [c](d.md)', [{ raw: 'd.md', dest: 'd.md', skip: null }]],
          ['[a](<unterminated [b](c.md)', [{ raw: 'c.md', dest: 'c.md', skip: null }]],
          ['[a](<b>', []],
          ['[a](<b', []],
          ['[a](<b)', []],
          // The escaped `>` is data, so this destination never closes at all.
          ['[a](<b\\>)', []],
          ['[a](<<b.md>)', [{ raw: '<b.md', dest: '<b.md', skip: null }]],
          ['[a](<b>.md)', [{ raw: 'b', dest: 'b', skip: null }]],
          // Spaces the author wrote inside the brackets are data; the trim that
          // removes them is `normalizeTocLink`'s, not the walk's.
          ['[a](<  spaced.md  >)', [{ raw: '  spaced.md  ', dest: 'spaced.md', skip: null }]],
        ];
      for (const [text, expected] of cases) {
        const got = extractTocLinks(text).map((l) => ({
          raw: l.raw,
          dest: l.destination,
          skip: l.skip ?? null,
        }));
        assert.deepStrictEqual(got, expected, `${text} must resolve exactly as the unbounded walk did`);
      }
    });

    // The lineariser answers "can this label still close?" from one balance
    // pass instead of a walk per `[`, so the shapes that could fool such a
    // shortcut are pinned by output rather than by a clock. The first three are
    // the escape and imbalance cases a balance test can get wrong: the loop
    // finds brackets with `indexOf`, which knows nothing about escapes, so a
    // scan always starts AT a `[` even when the pass escaping it called that
    // bracket a literal.
    it('answers label closure from the brackets the scanner actually sees', () => {
      const destinations = (text: string): (string | null)[] =>
        extractTocLinks(text).map((l) => l.destination);
      assert.deepStrictEqual(destinations('\\[x](a.md) [b](c.md)'), ['a.md', 'c.md']);
      assert.deepStrictEqual(destinations('] [a](b.md)'), ['b.md']);
      assert.deepStrictEqual(destinations('[a\\]b](d.md)'), ['d.md']);
      assert.deepStrictEqual(destinations(`${'['.repeat(30)}\\]`), []);
      assert.deepStrictEqual(destinations(`${']'.repeat(5)}${'['.repeat(5)}]`), []);
      assert.deepStrictEqual(
        destinations(`[first](a.md)\n${'['.repeat(5000)}]\n[last](z.md)`),
        ['a.md', 'z.md']
      );
    });

    // The destination lineariser answers "can this paren still balance?" from one
    // pass too, so the shapes that could fool such a shortcut are pinned by output
    // rather than by a clock. An escaped paren must not count toward the depth, a
    // `"title"` must not stop it from tracking, and the `<angle bracket>` form must
    // keep its own rules: that branch closes on a `>` plus a plain `)`, so paren
    // depth answers nothing about it and the balance may never be consulted for it.
    it('answers destination closure from the parens the scanner actually sees', () => {
      const destinations = (text: string): (string | null)[] =>
        extractTocLinks(text).map((l) => l.destination);
      // `[a](b(c) d.md)` reaches its closing `)` only if the depth scan pairs the
      // `(` with the first `)`. #262 then refuses the whole destination for the
      // raw space rather than truncating it to `b(c)`, so the depth answer is
      // still what this case pins while the destination is now `null`.
      assert.deepStrictEqual(destinations('[a](b(c) d.md)'), [null]);
      assert.deepStrictEqual(
        extractTocLinks('[a](b(c) d.md)').map((l) => l.skip),
        ['unescaped-space']
      );
      assert.deepStrictEqual(destinations('[a](b\\)c)'), ['b)c']);
      assert.deepStrictEqual(destinations('[a](b\\(c) [d](e.md)'), ['b(c', 'e.md']);
      assert.deepStrictEqual(destinations('[a](b(c)'), []);
      assert.deepStrictEqual(destinations('[a](b(c) [d](e.md)'), ['e.md']);
      assert.deepStrictEqual(destinations('[a](b(c) [d](e(f) [g](h.md)'), ['h.md']);
      assert.deepStrictEqual(destinations('[a](<b(c) [d](e.md)'), ['e.md']);
      assert.deepStrictEqual(destinations('[a](<b) [d](e.md)'), ['e.md']);
      assert.deepStrictEqual(destinations('[a](<x> [b](c)'), ['x']);
      assert.deepStrictEqual(destinations('[a](f.md "t(1) x") [b](g.md)'), ['f.md', 'g.md']);
      assert.deepStrictEqual(destinations('[a](f.md "t(1) [b](g.md)'), ['g.md']);
      assert.deepStrictEqual(destinations(`${'[a](b(c) '.repeat(50)}[z](last.md)`), ['last.md']);
      assert.deepStrictEqual(
        destinations(`- [A](a.md)\n${'[x](y(z) '.repeat(4000)}\n- [C](c.md)`),
        ['a.md', 'c.md']
      );
    });

    // A README documenting link syntax is not enumerating the curriculum. The
    // extractor used to scan raw text, so an example naming a note that really
    // exists put that note into the enumeration and gave it a written
    // prerequisite no author asked for.
    it('ignores links inside a fenced example', () => {
      const md = [
        '# Course',
        '- [Intro](guide/intro.md)',
        '',
        'Write entries like this:',
        '',
        '```md',
        '- [example](guide/old.md)',
        '```',
        '',
        '- [Core](guide/core.md)',
      ].join('\n');
      const targets = extractTocLinks(md)
        .map((l) => l.destination)
        .filter((d): d is string => d !== null);
      assert.deepStrictEqual(targets, ['guide/intro.md', 'guide/core.md']);
    });

    it('ignores links inside an unclosed fence to the end of the file', () => {
      const links = extractTocLinks('- [Real](a.md)\n```md\n- [Ghost](b.md)\n');
      assert.deepStrictEqual(
        links.map((l) => l.destination),
        ['a.md']
      );
    });

    // Issue #284: the reasoning that blanks a fenced example — a link written to be
    // read is not a link written to be followed — has never been applied to an HTML
    // comment or an inline code span. Commenting an entry out of a Contents is a
    // ordinary thing for an author to do, and the note it names really exists, so the
    // chain kept collecting the edge the author had just withdrawn.
    it('ignores a link inside an HTML comment, across lines too', () => {
      assert.deepStrictEqual(
        extractTocLinks('<!-- [a](notes/x.md) -->').map((l) => l.destination),
        []
      );
      assert.deepStrictEqual(
        extractTocLinks('<!--\n- [gone](notes/gone.md)\n-->\n- [live](notes/live.md)').map(
          (l) => l.destination
        ),
        ['notes/live.md']
      );
      // A live entry sharing its line with a commented one still enumerates: the
      // blank takes the comment's characters, not the line.
      assert.deepStrictEqual(
        extractTocLinks('- live [a](notes/a.md) <!-- old [b](notes/b.md) -->').map(
          (l) => l.destination
        ),
        ['notes/a.md']
      );
    });

    it('ignores a link inside an inline code span', () => {
      assert.deepStrictEqual(
        extractTocLinks('`[code](notes/c.md)`').map((l) => l.destination),
        []
      );
      // The double-run form is the escape hatch for a name holding a backtick.
      assert.deepStrictEqual(
        extractTocLinks('``[code](notes/c.md)``').map((l) => l.destination),
        []
      );
      // One *unterminated* delimiter blanks nothing, in either form. Over-reaching is
      // the costlier failure: a pasted diff with a stray backtick would otherwise
      // withdraw every real link after it, and a comment that is never closed is a
      // document that stops mid-sentence, not an author's removal.
      assert.deepStrictEqual(
        extractTocLinks('unpaired ` tick\n- [live](notes/live.md)').map((l) => l.destination),
        ['notes/live.md']
      );
      assert.deepStrictEqual(
        extractTocLinks('<!-- [a](notes/x.md)').map((l) => l.destination),
        ['notes/x.md']
      );
    });

    // CommonMark allows balanced parentheses in a bare destination, and study
    // vaults really do have files like `intro(v2).md`. The first `)` ended the
    // destination, so the link resolved as missing (or onto the truncated
    // namesake) and the author's ordering edge was silently never written.
    it('keeps balanced parentheses inside a bare destination', () => {
      const links = extractTocLinks('- [Lesson](notes/intro(v2).md)');
      assert.strictEqual(links[0].destination, 'notes/intro(v2).md');
    });

    it('keeps balanced parentheses in a destination carrying a title', () => {
      const links = extractTocLinks('- [Lesson](notes/intro(v2).md "The (best) intro")');
      assert.strictEqual(links[0].destination, 'notes/intro(v2).md');
    });

    it('still ends a bare destination at the unbalanced close paren', () => {
      const links = extractTocLinks('- [a](x.md) then [b](y.md)');
      assert.deepStrictEqual(
        links.map((l) => l.destination),
        ['x.md', 'y.md']
      );
    });

    // Issue #262 — three destination forms that, split or cleaned in the wrong
    // order, resolved onto a DIFFERENT real note. Pinned at the engine level here
    // and again against real decoy notes in `test/storage-toc.test.ts`.
    it('splits the anchor before percent-decoding so %23 stays a literal # in the path', () => {
      // The fragment separator is a LITERAL `#` in the destination; `%23` is an
      // encoded `#` inside the path. Decoding first turned `notes/c%23.md` into
      // `notes/c#.md`, then split it at `#` -> `notes/c` -> a different note.
      assert.strictEqual(extractTocLinks('[sharp](notes/c%23.md)')[0].destination, 'notes/c#.md');
      assert.strictEqual(extractTocLinks('[both](notes/c%23.md#section)')[0].destination, 'notes/c#.md');
      // One decode pass only: `%2523` is a literal `%23` in the filename, not a `#`.
      assert.strictEqual(extractTocLinks('[dbl](x%2523.md)')[0].destination, 'x%23.md');
    });

    it('records a bare destination with an unescaped space as unparseable, never truncated', () => {
      // Obsidian accepts this spelling, so `notes/my` silently linked a real
      // `notes/my.md`. CommonMark requires <angle brackets> or a %XX/backslash
      // escape for a space in a bare destination; failing to parse it is a skip.
      const links = extractTocLinks('[my](notes/my note.md)');
      assert.strictEqual(links[0].destination, null);
      assert.strictEqual(links[0].skip, 'unescaped-space');
      // The documented supported forms must keep resolving onto the spaced note:
      assert.strictEqual(extractTocLinks('[a](<notes/my note.md>)')[0].destination, 'notes/my note.md');
      assert.strictEqual(extractTocLinks('[a](notes/my%20note.md)')[0].destination, 'notes/my note.md');
      // A real `path + "title"` is still a title, not an unescaped space.
      assert.strictEqual(extractTocLinks('[a](path.md "A Title")')[0].destination, 'path.md');
    });

    it('keeps a backslash literal unless it escapes a destination character, so it cannot collapse onto a sibling', () => {
      // `\0` is not escapable, so deleting it produced `01-a02-b.md` — a real
      // sibling note. Digits and letters are not ASCII punctuation, so their
      // backslash survives; every escapable character is unpinned by the sweep
      // below.
      assert.strictEqual(extractTocLinks('[x](01-a\\02-b.md)')[0].destination, '01-a\\02-b.md');
      assert.strictEqual(extractTocLinks('[x](notes/v1\\b2.md)')[0].destination, 'notes/v1\\b2.md');
      // Genuine destination escapes still work (unchanged behaviour):
      assert.strictEqual(extractTocLinks('[a](intro\\(v2\\).md)')[0].destination, 'intro(v2).md');
      assert.strictEqual(extractTocLinks('[a](a\\\\b.md)')[0].destination, 'a\\b.md');
    });

    // CommonMark 2.4: "Any ASCII punctuation character may be backslash-escaped",
    // and punctuation is exactly U+0021-2F, U+003A-40, U+005B-60, U+007B-7E. A
    // hand-maintained subset silently loses the edge of any note whose real name
    // was written with an escape the list forgot — `[a](notes/v1\.2.md)` is
    // `notes/v1.2.md`, not a file named `v1\.2.md`, so the lookup missed.
    // `#` and `%` are swept separately below: their escape is consumed the same
    // way, but `normalizeTocLink` then treats `#` as the anchor separator and
    // `%2` as a percent-escape, so `destination` cannot show the unescaping.
    const ASCII_PUNCTUATION = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'];
    const SWEEPABLE = ASCII_PUNCTUATION.filter((p) => p !== '#' && p !== '%');

    it('unescapes every ASCII punctuation character in a bare destination', () => {
      assert.strictEqual(SWEEPABLE.length, 30);
      for (const p of SWEEPABLE) {
        const links = extractTocLinks('[a](notes/v1\\' + p + '2.md)');
        assert.strictEqual(links[0].destination, 'notes/v1' + p + '2.md', `\\${p} must lose its backslash`);
      }
      // The headline form: an escaped dot is the note `v1.2.md`, not `v1\.2.md`.
      assert.strictEqual(extractTocLinks('[a](notes/v1\\.2.md)')[0].destination, 'notes/v1.2.md');
      // `#` and `%` are no longer blind spots: their escape survives long enough
      // for `normalizeTocLink` to split the fragment and decode the percents, so
      // `destination` shows the unescaping the same way it does for the rest.
      assert.strictEqual(extractTocLinks('[a](notes/v1\\#2.md)')[0].destination, 'notes/v1#2.md');
      assert.strictEqual(extractTocLinks('[a](notes/v1\\%2.md)')[0].destination, 'notes/v1%2.md');
    });

    // Review follow-ups on the same three forms. Each one is the PR's own defect
    // class — a destination that resolves onto a note the author did not name —
    // reached by a step the first pass ordered wrongly.
    it('keeps an escaped # out of the anchor split, in either destination form', () => {
      // `\#` is a literal hash in the filename. Cutting at it sent the lookup to
      // `notes/c`, and a note by that name is a real, unrelated file.
      assert.strictEqual(extractTocLinks('[a](notes/c\\#2.md#section)')[0].destination, 'notes/c#2.md');
      assert.strictEqual(extractTocLinks('[a](<notes/c\\#2.md>)')[0].destination, 'notes/c#2.md');
      // A literal hash still begins a fragment when nothing escaped it.
      assert.strictEqual(extractTocLinks('[a](notes/c#2.md)')[0].destination, 'notes/c');
      // …and a doubled backslash before one is a literal backslash *and* a real
      // fragment: `\\` resolves to data first, so the `#` that follows is syntax.
      // Without the marks surviving the scan these two spellings are identical.
      assert.strictEqual(extractTocLinks('[a](x\\\\#y.md)')[0].destination, 'x\\');
      assert.strictEqual(extractTocLinks('[a](x\\\\\\#y.md)')[0].destination, 'x\\#y.md');
    });

    it('keeps an escaped % out of the percent decode', () => {
      // `\%20` is a literal percent, not an encoded space: decoding it looked up
      // `notes/a b.md` while the author named `notes/a%20b.md`.
      assert.strictEqual(extractTocLinks('[a](notes/a\\%20b.md)')[0].destination, 'notes/a%20b.md');
      assert.strictEqual(extractTocLinks('[a](<notes/a\\%20b.md>)')[0].destination, 'notes/a%20b.md');
      // An unescaped percent still decodes, and a malformed one is still refused.
      assert.strictEqual(extractTocLinks('[a](notes/a%20b.md)')[0].destination, 'notes/a b.md');
      assert.strictEqual(extractTocLinks('[a](notes/a%zz.md)')[0].skip, 'malformed');
    });

    it('does not trim a space the destination itself encoded', () => {
      // `%20` decodes to a space, and `decoded.trim()` then removed it, turning a
      // lookup for `notes/file.md ` into one for `notes/file.md` — the truncation
      // `unescaped-space` refuses in the raw form, re-added in the decoded one.
      assert.strictEqual(extractTocLinks('[a](notes/file.md%20)')[0].destination, 'notes/file.md ');
      assert.strictEqual(extractTocLinks('[a](%20notes/file.md)')[0].destination, ' notes/file.md');
      // Whitespace the author typed around the destination is still not data, and
      // a destination that is only whitespace is still `empty`.
      assert.strictEqual(extractTocLinks('[a](%20%20)')[0].skip, 'empty');
    });

    it('refuses trailing text after a title instead of reading it as one title', () => {
      // `"one" "two"` begins and ends with a quote, which is all `looksLikeTitle`
      // checked. CommonMark allows exactly one delimited title, so this is not a
      // link at all — and accepting the prefix authored an edge onto `notes/my`.
      const links = extractTocLinks('[a](notes/my "one" "two")');
      assert.strictEqual(links[0].destination, null);
      assert.strictEqual(links[0].skip, 'unescaped-space');
      // One title, with or without inner spaces, stays a title.
      assert.strictEqual(extractTocLinks('[a](path.md "A Title")')[0].destination, 'path.md');
      assert.strictEqual(extractTocLinks('[a](path.md "it (works)")')[0].destination, 'path.md');
      assert.strictEqual(extractTocLinks('[a](path.md (parens))')[0].destination, 'path.md');
      assert.strictEqual(extractTocLinks('[a](path.md \'single\')')[0].destination, 'path.md');
    });

    // The angle-bracket form shares the bare form's escape grammar; only its
    // delimiters differ (it ends at `>` and lets spaces and parens through as
    // data). Verified against commonmark.js and markdown-it: `<foo\.bar>` is
    // `foo.bar` in both. A narrower set here silently dropped the edge of every
    // escaped name written in the one form authors reach for when a path holds
    // a space.
    it('unescapes every ASCII punctuation character in an angle-bracket destination', () => {
      for (const p of SWEEPABLE) {
        const links = extractTocLinks('[a](<notes/v1\\' + p + '2.md>)');
        assert.strictEqual(
          links[0].destination,
          'notes/v1' + p + '2.md',
          `\\${p} must lose its backslash inside <…>`
        );
      }
      assert.strictEqual(extractTocLinks('[a](<01-a\\02-b.md>)')[0].destination, '01-a\\02-b.md');
      // An escaped `>` stays data — it must not close the destination.
      assert.strictEqual(extractTocLinks('[a](<notes/a\\>b.md>)')[0].destination, 'notes/a>b.md');
    });

    it('reports the whole destination as written when a bare one is refused for a space', () => {
      // `TocLink.raw` is documented as the destination exactly as written, and it
      // is what a skip report line is built from. Handing back the truncated
      // prefix showed the author a path they never typed.
      const links = extractTocLinks('[my](notes/my note.md)');
      assert.strictEqual(links[0].destination, null);
      assert.strictEqual(links[0].skip, 'unescaped-space');
      assert.strictEqual(links[0].raw, 'notes/my note.md');
      assert.strictEqual(
        extractTocLinks('[my](notes/my note with several words.md)')[0].raw,
        'notes/my note with several words.md'
      );
      assert.strictEqual(extractTocLinks('[a](x\\ y.md)')[0].raw, 'x\\ y.md');
      // A real title is not a refusal: `raw` stays the destination, not the slice.
      assert.strictEqual(extractTocLinks('[a](path.md "A Title")')[0].raw, 'path.md');
    });
  });

  describe('foldTocDestination', () => {
    it('resolves folder links to <dir>/README.md, trailing slash tolerated', () => {
      assert.deepStrictEqual(foldTocDestination('01-x/', '.'), {
        relativePath: '01-x/README.md',
        escapedRoot: false,
      });
    });

    it('appends .md to extensionless note targets only', () => {
      assert.strictEqual(foldTocDestination('02-lab', '.').relativePath, '02-lab.md');
      assert.strictEqual(foldTocDestination('assets/diagram.pdf', '.').relativePath, 'assets/diagram.pdf');
    });

    it('resolves relative to the TOC file directory and folds .. lexically', () => {
      assert.strictEqual(foldTocDestination('../02-b.md', '01-a').relativePath, '02-b.md');
      assert.strictEqual(foldTocDestination('./notes/lecture 1.md', 'mod').relativePath, 'mod/notes/lecture 1.md');
    });

    it('flags escapes above the vault root', () => {
      assert.deepStrictEqual(foldTocDestination('../../outside/secret.md', '.'), {
        relativePath: '',
        escapedRoot: true,
      });
    });

    it('treats a leading slash as vault-root relative', () => {
      assert.strictEqual(foldTocDestination('/01-x/intro.md', '09-y').relativePath, '01-x/intro.md');
    });

    it('keeps backslashes literal (never a separator)', () => {
      assert.strictEqual(foldTocDestination('weird\\name.md', '.').relativePath, 'weird\\name.md');
    });
  });

  describe('planTocChain', () => {
    it('dedups first appearance (folded folder + explicit README collapse)', () => {
      // Storage folds `m/` to `m/README.md` before planning; the planner's job
      // is first-appearance dedup of the folded paths.
      const folded = ['m/', 'm/README.md', 'm/01-a.md', 'm/README.md'].map(
        (p) => foldTocDestination(p, '.').relativePath
      );
      const plan = planTocChain(folded);
      assert.deepStrictEqual(plan.orderedPaths, ['m/README.md', 'm/01-a.md']);
    });

    it('resorts a phase-inverted module dir: README first, assignment/quiz/solution last', () => {
      const plan = planTocChain([
        'mod/assignment.md',
        'mod/README.md',
        'mod/02-b.md',
        'mod/01-a.md',
        'mod/quiz.md',
        'mod/solution.md',
        'mod/deep-dive-x.md',
      ]);
      assert.deepStrictEqual(plan.orderedPaths, [
        'mod/README.md',
        'mod/01-a.md',
        'mod/02-b.md',
        'mod/deep-dive-x.md',
        'mod/assignment.md',
        'mod/quiz.md',
        'mod/solution.md',
      ]);
    });

    it('keeps the author document order within equal intent classes', () => {
      const plan = planTocChain(['d/notes.md', 'd/extra.md', 'd/alpha.md']);
      assert.deepStrictEqual(plan.orderedPaths, ['d/notes.md', 'd/extra.md', 'd/alpha.md']);
    });

    // `deep-dive → lab → exam` is an intent order the numbered tier already
    // states, and this resort was documented as mirroring it exactly — but the
    // three shared one rank and tied back to document order, so a README that
    // listed the lab first produced a chain where the deep dive depended on the
    // lab that follows it.
    it('orders phase docs pedagogically regardless of README listing order', () => {
      const plan = planTocChain(['m/lab-01.md', 'm/deep-dive.md', 'm/exam.md']);
      assert.deepStrictEqual(plan.orderedPaths, [
        'm/deep-dive.md',
        'm/lab-01.md',
        'm/exam.md',
      ]);
      assert.strictEqual(plan.predecessorOf.get('m/lab-01.md'), 'm/deep-dive.md');
      assert.strictEqual(plan.predecessorOf.get('m/exam.md'), 'm/lab-01.md');
    });

    it('keeps document order among phase docs of the same kind', () => {
      const plan = planTocChain(['m/lab-second.md', 'm/lab-first.md']);
      assert.deepStrictEqual(plan.orderedPaths, ['m/lab-second.md', 'm/lab-first.md']);
    });

    it('groups by directory in first-appearance order', () => {
      const plan = planTocChain(['a/1.md', 'b/1.md', 'a/2.md']);
      assert.deepStrictEqual(plan.orderedPaths, ['a/1.md', 'a/2.md', 'b/1.md']);
    });

    it('produces a single head and strictly backward edges', () => {
      const plan = planTocChain(['r.md', 'a/README.md', 'a/x.md']);
      assert.strictEqual(plan.predecessorOf.get('r.md'), null);
      assert.strictEqual(plan.predecessorOf.get('a/README.md'), 'r.md');
      assert.strictEqual(plan.predecessorOf.get('a/x.md'), 'a/README.md');
      assertBackwardEdges(plan.orderedPaths, plan.predecessorOf);
    });

    it('assertBackwardEdges rejects a hand-crafted forward edge', () => {
      assert.throws(
        () => assertBackwardEdges(['a.md', 'b.md'], new Map([['a.md', 'b.md'], ['b.md', 'a.md']])),
        /invariant violated/
      );
    });
  });

  describe('isInNumberedTree (C2 gate)', () => {
    it('covers numbered dirs and basenames only', () => {
      assert.strictEqual(isInNumberedTree('01-x/a.md'), true);
      assert.strictEqual(isInNumberedTree('01-x/y/02-z.md'), true);
      assert.strictEqual(isInNumberedTree('notes/03-lab.md'), true);
      assert.strictEqual(isInNumberedTree('notes/intro.md'), false);
      assert.strictEqual(isInNumberedTree('3d-printing/x.md'), false); // tightened parser still applies
    });
  });

  describe('composeTieredChain', () => {
    const numberedInput = ['01-a/README.md', '01-a/01-x.md', 'unnum/intro.md', 'unnum/notes.md'];

    it('strict returns numbered edges only and labels them numbered', () => {
      const numbered = planAutoChainWithHygiene(numberedInput);
      const out = composeTieredChain({ tier: 'strict', numbered, tocPaths: ['unnum/intro.md'] });
      assert.strictEqual(out.tocEdgeCount, 0);
      assert.strictEqual(out.sourceOf.get('01-a/01-x.md'), 'numbered');
      assert.strictEqual(out.hasNumberedLayout, true);
    });

    it('numbering dominance: TOC never reorders numbered-tree endpoints', () => {
      const numbered = planAutoChainWithHygiene(numberedInput);
      const before = numbered.predecessorOf.get('01-a/01-x.md');
      // A (sloppy) README that enumerates the numbered tree backwards must not
      // flip the numbering-derived edge.
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['01-a/01-x.md', '01-a/README.md'],
      });
      assert.strictEqual(out.predecessorOf.get('01-a/01-x.md'), before);
    });

    it('numbering dominance holds against an enumeration that leads with an unnumbered note', () => {
      // The case above is identity-weak on its own: both of its paths live in
      // the numbered tree, so the C2 filter drops them before planning and the
      // assertion compares the numbered plan with itself. This shape gives the
      // enumeration a chance to win — it puts an unnumbered note directly in
      // front of a numbered one, which is the re-parenting dominance forbids.
      const numbered = planAutoChainWithHygiene([
        '01-a/01-x.md',
        '01-a/02-y.md',
        'zz-reference/intro.md',
      ]);
      assert.strictEqual(numbered.predecessorOf.get('01-a/02-y.md'), '01-a/01-x.md');

      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['zz-reference/intro.md', '01-a/02-y.md'],
      });

      assert.strictEqual(out.predecessorOf.get('01-a/02-y.md'), '01-a/01-x.md');
      assert.strictEqual(out.sourceOf.get('01-a/02-y.md'), 'numbered');
      assert.notStrictEqual(
        out.predecessorOf.get('01-a/02-y.md'),
        'zz-reference/intro.md',
        'a README that lists a reference note first must not make it a lesson prerequisite'
      );
      assert.strictEqual(out.tocEdgeCount, 0, 'the unnumbered note alone cannot form an edge');
    });

    it('TOC edges replace the alphabetical fallback for the unnumbered remainder', () => {
      const numbered = planAutoChainWithHygiene(numberedInput);
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['unnum/notes.md', 'unnum/intro.md'],
      });
      // The TOC head carries no edge at all (it no longer inherits the
      // numbered spine's alphabetical predecessor), and the second note's
      // edge is authored by the TOC tier.
      assert.strictEqual(out.predecessorOf.get('unnum/notes.md'), null);
      assert.ok(!out.sourceOf.has('unnum/notes.md'));
      assert.strictEqual(out.sourceOf.get('unnum/intro.md'), 'toc');
      assert.strictEqual(out.predecessorOf.get('unnum/intro.md'), 'unnum/notes.md');
      assert.strictEqual(out.tocEdgeCount, 1);
      assert.ok(out.hasTocLayout);
    });

    it('a same-rank tie is labelled apart from the numbering that decided everything else', () => {
      // `02-a` and `02-b` carry the same number, so the tree said nothing about
      // their order and the filenames did. The label is what lets the gate rule
      // tell those two claims apart, and the edge still counts as written — the
      // honest-refusal signal asks whether any order exists, not whether it gates.
      const numbered = planAutoChainWithHygiene([
        'm/02-a.md',
        'm/02-b.md',
        'm/03-c.md',
      ]);
      const out = composeTieredChain({ tier: 'strict', numbered, tocPaths: [] });
      assert.strictEqual(out.sourceOf.get('m/02-b.md'), 'tie');
      assert.strictEqual(out.sourceOf.get('m/03-c.md'), 'numbered');
      assert.strictEqual(out.numberedEdgeCount, 2, 'a tie is still an edge the planner wrote');
    });

    // The hygiene plan derives its two alphabetical claims before composition
    // runs. Carrying them through unchanged made the CLI tell a learner that
    // notes their own README had just sequenced "chain in alphabetical order"
    // and might need `--exclude`, two lines above a plan showing every one of
    // those edges authored by `toc`.
    it('the alphabetical claims survive only for notes the enumeration did not order', () => {
      const numbered = planAutoChainWithHygiene([
        'README.md',
        'guide/alpha.md',
        'guide/middle.md',
        'guide/zeta.md',
        'notes/loose.md',
      ]);
      assert.deepStrictEqual(
        numbered.alphabeticalNotes,
        ['guide/alpha.md', 'guide/middle.md', 'guide/zeta.md', 'notes/loose.md'],
        'precondition: the numbered plan really does order all four by name'
      );
      assert.strictEqual(numbered.directoryOrderAlphabetical, true);

      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['guide/zeta.md', 'guide/alpha.md', 'guide/middle.md'],
      });
      assert.deepStrictEqual(
        out.alphabeticalNotes,
        ['notes/loose.md'],
        'the three enumerated notes drop out; the note the README never mentioned stays'
      );
      assert.strictEqual(
        out.directoryOrderAlphabetical,
        false,
        'with `guide/` enumerated, no unnumbered directory pair is left to order by name'
      );
      assert.strictEqual(out.tocEdgeCount, 2);
    });

    it('an enumeration covering nothing leaves the numbered claims untouched', () => {
      const numbered = planAutoChainWithHygiene(['alpha/01-x.md', 'beta/01-y.md', 'loose.md']);
      const out = composeTieredChain({ tier: 'full', numbered, tocPaths: [] });
      assert.deepStrictEqual(out.alphabeticalNotes, numbered.alphabeticalNotes);
      assert.strictEqual(out.directoryOrderAlphabetical, numbered.directoryOrderAlphabetical);
    });

    it('hygiene still applies inside the TOC tier', () => {
      const numbered = planAutoChainWithHygiene(['x']);
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['translations/guide.es.md', 'LICENSE.md', 'guide/intro.md', 'guide/run.md'],
      });
      assert.deepStrictEqual(
        out.orderedPaths.filter((p) => out.sourceOf.get(p) === 'toc'),
        ['guide/run.md']
      );
    });

    // A partial enumeration: the README lists `lab-03` before `lab-01` and
    // never mentions `lab-02`. `lab-03` is a TOC head keeping its numbered edge
    // to `lab-02`, while `lab-01` is re-parented onto `lab-03` — and `lab-02`
    // still points at `lab-01`, so the kept edge closes a cycle. Guarding only
    // "is the kept predecessor itself a TOC candidate" cannot see it, because
    // the loop back runs through a note the TOC never listed; the earlier
    // version of this threw the invariant error and aborted the whole batch.
    it('a partial TOC enumeration cannot close a cycle through an unlisted note', () => {
      const numbered = planAutoChainWithHygiene([
        'm/lab-01.md',
        'm/lab-02.md',
        'm/lab-03.md',
      ]);
      assert.strictEqual(numbered.predecessorOf.get('m/lab-03.md'), 'm/lab-02.md');
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['m/lab-03.md', 'm/lab-01.md'],
      });
      assertAcyclicPlan(out.predecessorOf);
      // The head that would have closed the cycle opens the chain instead.
      assert.strictEqual(out.predecessorOf.get('m/lab-03.md'), null);
      assert.ok(!out.sourceOf.has('m/lab-03.md'));
      assert.strictEqual(out.predecessorOf.get('m/lab-01.md'), 'm/lab-03.md');
      assert.strictEqual(out.predecessorOf.get('m/lab-02.md'), 'm/lab-01.md');
      assert.strictEqual(out.tocEdgeCount, 1);
      assert.strictEqual(out.numberedEdgeCount, 1);
    });

    it('a TOC head keeps a justified numbered edge the enumeration cannot reach', () => {
      // The same shape with nothing looping back: the keep must survive, which
      // is what distinguishes this from the cycle case above.
      const numbered = planAutoChainWithHygiene(['m/01-a.md', 'm/02-b.md', 'm/03-c.md']);
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['m/03-c.md'],
      });
      assert.strictEqual(out.predecessorOf.get('m/03-c.md'), 'm/02-b.md');
      assert.strictEqual(out.sourceOf.get('m/03-c.md'), 'numbered');
    });

    it('C-defect-1: a singleton TOC head keeps its justified numbered edge (ciu shape)', () => {
      // Root README enumerating exactly one adoptable note. B's plan gates
      // the note on the README; the TOC pass must not silently null it.
      const numbered = planAutoChainWithHygiene(['README.md', 'programming-language-resources.md']);
      assert.strictEqual(numbered.predecessorOf.get('programming-language-resources.md'), 'README.md');
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['programming-language-resources.md'],
      });
      assert.strictEqual(out.predecessorOf.get('programming-language-resources.md'), 'README.md');
      assert.strictEqual(out.sourceOf.get('programming-language-resources.md'), 'numbered');
      assert.strictEqual(out.tocEdgeCount, 0);
      assert.ok(out.numberedEdgeCount >= 1, 'the kept edge counts as numbered provenance');
      assertAcyclicPlan(out.predecessorOf);
    });

    it('C-defect-1: TOC heads over justified preds keep B coverage on the three scored shapes', () => {
      // ciu/math/Web-Dev shapes: root README + one out-of-tree note (ciu),
      // numbered module + one README-named unnumbered remainder (math),
      // numbered modules with the README bridging mid-list (Web-Dev).
      const shapes: { paths: string[]; toc: string[] }[] = [
        { paths: ['README.md', 'notes-only.md'], toc: ['notes-only.md'] },
        {
          paths: ['README.md', '01-setup/01-install.md', '01-setup/02-config.md', 'extras/cheatsheet.md'],
          toc: ['01-setup/01-install.md', '01-setup/02-config.md', 'extras/cheatsheet.md'],
        },
        {
          paths: ['README.md', '01-mod/README.md', '01-mod/01-lesson.md', '02-mod/README.md', '02-mod/01-lesson.md', 'out-of-tree/intro.md'],
          toc: ['01-mod/01-lesson.md', 'out-of-tree/intro.md', '02-mod/01-lesson.md'],
        },
      ];
      for (const shape of shapes) {
        const numbered = planAutoChainWithHygiene(shape.paths);
        const bEdges = [...numbered.predecessorOf.values()].filter((p) => p !== null).length;
        const out = composeTieredChain({ tier: 'full', numbered, tocPaths: shape.toc });
        const cEdges = [...out.predecessorOf.values()].filter((p) => p !== null).length;
        assert.ok(
          cEdges >= bEdges,
          `final edges ${cEdges} must be >= B edges ${bEdges} for shape ${shape.paths[0]}…`
        );
        assertAcyclicPlan(out.predecessorOf);
      }
    });

    it('C-defect-1 guard: a kept pred that the TOC chain itself runs through does NOT cycle', () => {
      // Two numbered siblings (both TOC candidates, so the numbered-tree
      // filter does not apply inside dir `m`... they ARE numbered-tree — the
      // guard is exercised on the unnumbered-dir analogue instead): `02-b`
      // has a justified numbered pred on `01-a`, and the enumeration lists
      // `02-b` first. Keeping `02-b -> 01-a` while TOC says
      // `01-a -> 02-b` would close a cycle, so the head must open the chain.
      const numbered = planAutoChainWithHygiene(['m/01-a.md', 'm/02-b.md']);
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['m/02-b.md', 'm/01-a.md'],
      });
      // Both paths are in the numbered tree, so the TOC pass changes nothing
      // at all here (C2): B's justified edge survives untouched.
      assert.strictEqual(out.predecessorOf.get('m/02-b.md'), 'm/01-a.md');
      assert.strictEqual(out.sourceOf.get('m/02-b.md'), 'numbered');
      assert.strictEqual(out.tocEdgeCount, 0);
      assertAcyclicPlan(out.predecessorOf);

      // The real guard shape: same-dir backbone siblings named lab-01/02 —
      // content docs (so B chains lab-02 -> lab-01) yet NOT in the numbered
      // tree (so both stay TOC candidates). Enumerating them backwards makes
      // the head's kept pred a downstream candidate: the guard must null it
      // instead of closing a cycle.
      const numbered2 = planAutoChainWithHygiene(['m/lab-01.md', 'm/lab-02.md']);
      assert.strictEqual(numbered2.predecessorOf.get('m/lab-02.md'), 'm/lab-01.md');
      const out2 = composeTieredChain({
        tier: 'full',
        numbered: numbered2,
        tocPaths: ['m/lab-02.md', 'm/lab-01.md'],
      });
      assert.strictEqual(out2.predecessorOf.get('m/lab-02.md'), null);
      assert.ok(!out2.sourceOf.has('m/lab-02.md'));
      assert.strictEqual(out2.predecessorOf.get('m/lab-01.md'), 'm/lab-02.md');
      assert.strictEqual(out2.sourceOf.get('m/lab-01.md'), 'toc');
      assert.strictEqual(out2.tocEdgeCount, 1);
      assertAcyclicPlan(out2.predecessorOf); // must not throw
    });

    it('keeps the merged plan acyclic through composition', () => {
      const numbered = planAutoChainWithHygiene(numberedInput);
      const out = composeTieredChain({
        tier: 'full',
        numbered,
        tocPaths: ['unnum/notes.md', 'unnum/intro.md'],
      });
      // composeTieredChain itself throws on a violated invariant; re-check
      // explicitly and confirm the TOC-taken notes moved to the TOC section.
      assertAcyclicPlan(out.predecessorOf);
      assert.deepStrictEqual(out.orderedPaths, ['01-a/README.md', '01-a/01-x.md', 'unnum/notes.md', 'unnum/intro.md']);
    });
  });

  describe('parseAutoChainTier', () => {
    it('rejects a bare flag, because a valueless tier is not the widest one', () => {
      // #223 made `--auto-chain` a plain boolean whose default tier is `strict`, and
      // `test/cli-adopt-autochain.test.ts` already asserts a bare run is not the full
      // tier. Reading `true` as `full` here was the residue of the optional-value form
      // that change withdrew: two exported rules, opposite answers, picked by whether the
      // caller passed `undefined` or `true`.
      assert.strictEqual(parseAutoChainTier(true), null);
      assert.strictEqual(parseAutoChainTier('TOC'), 'toc');
      assert.strictEqual(parseAutoChainTier(' strict '), 'strict');
    });
    it('rejects unknown values, undefined and false', () => {
      assert.strictEqual(parseAutoChainTier('half'), null);
      assert.strictEqual(parseAutoChainTier(undefined), null);
      assert.strictEqual(parseAutoChainTier(false), null);
      assert.strictEqual(parseAutoChainTier(42), null);
    });
  });

  // Every other call site in this file asserts `assertAcyclicPlan` does not
  // throw. That proves it is not over-eager and proves nothing about whether it
  // can catch the one thing it exists to catch: neutralising its throw left the
  // whole suite green.
  describe('assertAcyclicPlan detects the cycles it claims to detect', () => {
    it('throws on a two-node predecessor loop and names the node', () => {
      const cyclic = new Map<string, string | null>([
        ['m/01-a.md', 'm/02-b.md'],
        ['m/02-b.md', 'm/01-a.md'],
      ]);
      assert.throws(
        () => assertAcyclicPlan(cyclic),
        /toc-chain invariant violated: predecessor cycle through/
      );
    });

    it('throws on a loop the walk only reaches after a chain head', () => {
      // Starting from `head` terminates cleanly; the loop is downstream. A check
      // that only walked from null-predecessor roots would miss this entirely.
      const cyclic = new Map<string, string | null>([
        ['m/00-intro.md', null],
        ['m/01-a.md', 'm/02-b.md'],
        ['m/02-b.md', 'm/03-c.md'],
        ['m/03-c.md', 'm/01-a.md'],
      ]);
      assert.throws(() => assertAcyclicPlan(cyclic), /predecessor cycle through/);
    });

    it('throws on a self-loop', () => {
      const self = new Map<string, string | null>([['m/01-a.md', 'm/01-a.md']]);
      assert.throws(() => assertAcyclicPlan(self), /predecessor cycle through m\/01-a\.md/);
    });

    it('accepts two notes sharing one predecessor, which is fan-in and not a cycle', () => {
      // The `done` memo is what keeps this linear. Without it the shared
      // predecessor is re-walked from every dependent, and a legitimate plan is
      // reported as a violation.
      const fanIn = new Map<string, string | null>([
        ['m/README.md', null],
        ['m/01-a.md', 'm/README.md'],
        ['m/02-b.md', 'm/README.md'],
        ['m/03-c.md', 'm/README.md'],
      ]);
      assert.doesNotThrow(() => assertAcyclicPlan(fanIn));
    });

    it('stays linear as the spine grows, judged against itself rather than a clock', () => {
      // 200 passes over a 1000-node spine and 10 passes over a 20000-node spine
      // visit the same 2e5 nodes, so equal work must cost about the same. Without
      // the `done` memo the walk restarts at every node, per-pass cost goes with
      // the square of the length, and the large case costs about 20x — a shape
      // comparison a busy test host cannot fake, unlike a fixed deadline that
      // fails for reasons unrelated to the algorithm.
      const build = (n: number): Map<string, string | null> => {
        const spine = new Map<string, string | null>();
        for (let i = 0; i < n; i++) spine.set(`n/${i}.md`, i === 0 ? null : `n/${i - 1}.md`);
        return spine;
      };
      const cost = (spine: Map<string, string | null>, reps: number): number => {
        const started = Date.now();
        for (let i = 0; i < reps; i++) assertAcyclicPlan(spine);
        return Math.max(1, Date.now() - started);
      };

      const small = cost(build(1000), 200);
      const large = cost(build(20000), 10);

      assert.ok(
        large < small * 5,
        `equal work over different spine lengths cost ${small}ms and ${large}ms`
      );
    });
  });
});
