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
