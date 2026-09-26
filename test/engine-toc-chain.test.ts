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
    it('accepts a bare flag as full and each tier case-insensitively', () => {
      assert.strictEqual(parseAutoChainTier(true), 'full');
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
});
