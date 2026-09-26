import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseNumericPrefix,
  compareLessonOrder,
  planAutoChain,
  parseWikilink,
  extractWikilinks,
  stripFencedCodeBlocks,
} from '../src/engine/auto-chain';

describe('Auto-Chain Engine (Issue #73, INV-46)', () => {
  describe('parseNumericPrefix', () => {
    it('parses dash, underscore, dot, and space separators', () => {
      assert.deepStrictEqual(parseNumericPrefix('01-foundations'), { n: 1, rest: 'foundations' });
      assert.deepStrictEqual(parseNumericPrefix('1_foo'), { n: 1, rest: 'foo' });
      assert.deepStrictEqual(parseNumericPrefix('10.foo'), { n: 10, rest: 'foo' });
      assert.deepStrictEqual(parseNumericPrefix('02 - spaced'), { n: 2, rest: '- spaced' });
    });

    it('returns null for non-numeric leading names', () => {
      assert.strictEqual(parseNumericPrefix('lab-01'), null);
      assert.strictEqual(parseNumericPrefix('v2-foo'), null);
      assert.strictEqual(parseNumericPrefix('notes'), null);
      assert.strictEqual(parseNumericPrefix(''), null);
    });

    // #73 review item 4: the original `/^(\d+)[-_.\s]?(.*)$/` made the separator
    // optional, so a digit leading a *word* silently claimed a lesson number.
    // Neither case raised `hasUnnumbered`, so a misplaced lesson was invisible.
    it('accepts every separator form and a bare number', () => {
      assert.deepStrictEqual(parseNumericPrefix('01-foundations'), { n: 1, rest: 'foundations' });
      assert.deepStrictEqual(parseNumericPrefix('01_foundations'), { n: 1, rest: 'foundations' });
      assert.deepStrictEqual(parseNumericPrefix('01.findations'), { n: 1, rest: 'findations' });
      assert.deepStrictEqual(parseNumericPrefix('01 foundations'), { n: 1, rest: 'foundations' });
      assert.deepStrictEqual(parseNumericPrefix('7.md'), { n: 7, rest: 'md' });
      assert.deepStrictEqual(parseNumericPrefix('01'), { n: 1, rest: '' });
      assert.deepStrictEqual(parseNumericPrefix('100-modules'), { n: 100, rest: 'modules' });
    });

    it('requires a separator when the digits run into a word', () => {
      assert.strictEqual(parseNumericPrefix('3d-printing'), null);
      assert.strictEqual(parseNumericPrefix('3d-printing.md'), null);
      assert.strictEqual(parseNumericPrefix('01foundations'), null);
      assert.strictEqual(parseNumericPrefix('42answer'), null);
    });

    it('does not read a year as a lesson number', () => {
      assert.strictEqual(parseNumericPrefix('2024-recap'), null);
      assert.strictEqual(parseNumericPrefix('2024-recap.md'), null);
      assert.strictEqual(parseNumericPrefix('1999.md'), null);
    });
  });

  describe('compareLessonOrder', () => {
    it('orders numeric prefixes ascending, then phases, then alphabetical', () => {
      const files = [
        'notes.md',
        'exam-01.md',
        '03-c.md',
        'lab-01.md',
        '01-a.md',
        'deep-dive-x.md',
        '02-b.md',
        'appendix.md',
      ];
      const sorted = [...files].sort(compareLessonOrder);
      assert.deepStrictEqual(sorted, [
        '01-a.md',
        '02-b.md',
        '03-c.md',
        'deep-dive-x.md',
        'lab-01.md',
        'exam-01.md',
        'appendix.md',
        'notes.md',
      ]);
    });

    it('breaks numeric ties alphabetically and is deterministic', () => {
      assert.ok(compareLessonOrder('01-b.md', '01-a.md') > 0);
      assert.ok(compareLessonOrder('B.md', 'a.md') > 0);
      assert.strictEqual(compareLessonOrder('same.md', 'same.md'), 0);
    });
  });

  describe('planAutoChain', () => {
    it('chains within and across numbered modules with a bridge edge', () => {
      const plan = planAutoChain([
        'MODULES/02-linux/01-processes.md',
        'MODULES/01-foundations/02-networking.md',
        'MODULES/01-foundations/01-systems.md',
        'MODULES/02-linux/lab-01-triage.md',
      ]);
      assert.deepStrictEqual(plan.orderedPaths, [
        'MODULES/01-foundations/01-systems.md',
        'MODULES/01-foundations/02-networking.md',
        'MODULES/02-linux/01-processes.md',
        'MODULES/02-linux/lab-01-triage.md',
      ]);
      // Cross-module bridge: module 02 entry depends on module 01 exit
      assert.strictEqual(
        plan.predecessorOf.get('MODULES/02-linux/01-processes.md'),
        'MODULES/01-foundations/02-networking.md'
      );
      assert.strictEqual(
        plan.predecessorOf.get('MODULES/01-foundations/01-systems.md'),
        null
      );
      assert.strictEqual(plan.hasUnnumbered, false);
    });

    it('sorts unnumbered dirs/files after numbered ones and flags them', () => {
      const plan = planAutoChain(['notes.md', '01-a.md', 'extras/z.md']);
      // Root group '.' sorts alphabetically among unnumbered dirs, before 'extras'
      assert.deepStrictEqual(plan.orderedPaths, ['01-a.md', 'notes.md', 'extras/z.md']);
      assert.strictEqual(plan.hasUnnumbered, true);
    });

    // #73 review item 4, seen through the planner. `3d-printing.md` used to
    // parse as lesson 3, so it chained *between* `02-b` and `04-c` and
    // `hasUnnumbered` stayed false — the misplacement was silent. Now it is an
    // ordinary unnumbered sibling: rank-2 alphabetical, and flagged.
    it('demotes a digit-leading word to alphabetical and flags it', () => {
      const plan = planAutoChain(['01-a.md', '02-b.md', '04-c.md', '3d-printing.md']);
      assert.deepStrictEqual(plan.orderedPaths, ['01-a.md', '02-b.md', '04-c.md', '3d-printing.md']);
      assert.strictEqual(
        plan.predecessorOf.get('3d-printing.md'),
        '04-c.md',
        'a digit-leading word must chain last, not between lessons 2 and 4'
      );
      assert.strictEqual(plan.hasUnnumbered, true);
    });

    it('demotes a year-prefixed note below the numbered modules and flags it', () => {
      const plan = planAutoChain(['01-a.md', '2024-recap.md', '02-b.md']);
      assert.deepStrictEqual(plan.orderedPaths, ['01-a.md', '02-b.md', '2024-recap.md']);
      assert.strictEqual(plan.hasUnnumbered, true);
    });

    it('handles single-note modules and empty input', () => {
      const single = planAutoChain(['01-only.md']);
      assert.deepStrictEqual(single.orderedPaths, ['01-only.md']);
      assert.strictEqual(single.predecessorOf.get('01-only.md'), null);

      const empty = planAutoChain([]);
      assert.deepStrictEqual(empty.orderedPaths, []);
      assert.strictEqual(empty.predecessorOf.size, 0);
    });

    it('keeps a nested group inside its ancestor module', () => {
      const plan = planAutoChain([
        'MODULES/02-linux/01-kernel.md',
        'MODULES/01-foundations/09-labs/01-first.md',
        'MODULES/01-foundations/01-systems.md',
      ]);
      assert.deepStrictEqual(plan.orderedPaths, [
        'MODULES/01-foundations/01-systems.md',
        'MODULES/01-foundations/09-labs/01-first.md',
        'MODULES/02-linux/01-kernel.md',
      ]);
      // 09-labs chains off its own ancestor module, not module 02's note
      assert.strictEqual(
        plan.predecessorOf.get('MODULES/01-foundations/09-labs/01-first.md'),
        'MODULES/01-foundations/01-systems.md'
      );
    });

    it('sorts a parent group before its own child, even when the child is unnumbered', () => {
      const plan = planAutoChain([
        'MODULES/01-foundations/01-a.md',
        'MODULES/01-foundations/deep-dive/01-b.md',
        'MODULES/02-linux/01-c.md',
      ]);
      assert.deepStrictEqual(plan.orderedPaths, [
        'MODULES/01-foundations/01-a.md',
        'MODULES/01-foundations/deep-dive/01-b.md',
        'MODULES/02-linux/01-c.md',
      ]);
    });

    // `hasUnnumbered` feeds the CLI's "these entries fell back to alphabetical
    // order" warning, so it must be true exactly when alphabetical order
    // *decided* something — i.e. only at a segment level where two group
    // directories actually differ. Flagging every unnumbered segment instead
    // would warn on the canonical `MODULES/` container from issue #73's own
    // example and turn the warning into noise.
    it('does not flag the canonical unnumbered MODULES container (#73)', () => {
      const plan = planAutoChain(['MODULES/01-foundations/01-x.md']);
      assert.strictEqual(plan.hasUnnumbered, false);
    });

    it('does not flag a single unnumbered top-level dir with nothing to compare', () => {
      const plan = planAutoChain(['guides/01-module/01-n.md']);
      assert.strictEqual(plan.hasUnnumbered, false);
    });

    it('flags an unnumbered ancestor level that actually decided order', () => {
      // Level 0 differs (`MODULES` vs `OTHER`) and neither has a numeric
      // prefix, so alphabetical order decided which module chains first.
      const plan = planAutoChain(['MODULES/01-a/01-x.md', 'OTHER/01-b/01-y.md']);
      assert.strictEqual(plan.hasUnnumbered, true);
      assert.deepStrictEqual(plan.orderedPaths, ['MODULES/01-a/01-x.md', 'OTHER/01-b/01-y.md']);
    });

    it('does not flag fully numbered sibling directories', () => {
      const plan = planAutoChain(['01-a/01-x.md', '02-b/01-y.md']);
      assert.strictEqual(plan.hasUnnumbered, false);
    });
  });

  describe('parseWikilink', () => {
    it('parses target, alias, anchor, and .md suffix forms', () => {
      assert.deepStrictEqual(parseWikilink('[[Note Name]]'), { target: 'Note Name' });
      assert.deepStrictEqual(parseWikilink('[[a/b|c]]'), { target: 'a/b', alias: 'c' });
      assert.deepStrictEqual(parseWikilink('[[note#heading]]'), { target: 'note' });
      assert.deepStrictEqual(parseWikilink('[[note#^block-id|Alias]]'), {
        target: 'note',
        alias: 'Alias',
      });
      assert.deepStrictEqual(parseWikilink('[[note.md]]'), { target: 'note' });
    });

    it('returns null for malformed links', () => {
      assert.strictEqual(parseWikilink('[['), null);
      assert.strictEqual(parseWikilink(']]'), null);
      assert.strictEqual(parseWikilink('[[ ]]'), null);
      assert.strictEqual(parseWikilink('[[a[[b]]'), null);
      assert.strictEqual(parseWikilink('not a link'), null);
      assert.strictEqual(parseWikilink(''), null);
    });
  });

  describe('stripFencedCodeBlocks', () => {
    /** Text that survives masking, with the blanked runs collapsed for legibility. */
    const visible = (text: string): string[] =>
      stripFencedCodeBlocks(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    it('masks a fenced block and keeps the lines around it', () => {
      assert.deepStrictEqual(visible('a\n```\n# hidden\n- [[hidden]]\n```\nb'), ['a', 'b']);
    });

    it('preserves line structure so downstream line scans keep their positions', () => {
      const src = 'a\n```\nx\ny\n```\nb';
      const out = stripFencedCodeBlocks(src);
      assert.strictEqual(out.split('\n').length, src.split('\n').length);
      assert.strictEqual(out.split('\n')[0], 'a');
      assert.strictEqual(out.split('\n')[5], 'b');
      assert.strictEqual(out.split('\n')[2].length, 1);
    });

    // The one regex this replaced let either marker close the other's block, so
    // an example showing both fence styles leaked its contents straight back
    // into the roadmap parser and the title resolver.
    it('never closes a backtick fence on a tilde line', () => {
      assert.deepStrictEqual(visible('a\n```markdown\n# H\n~~~\n- [[Ghost]]\n~~~\n```\nb'), [
        'a',
        'b',
      ]);
    });

    it('never closes a tilde fence on a backtick line', () => {
      // Once the mixed pair is refused the block is unclosed, and an unclosed
      // fence runs to the end of the document — so `b` is masked too.
      assert.deepStrictEqual(visible('a\n~~~\n# H\n```\n- [[Ghost]]\n```\nb'), ['a']);
      // Closed by its own character, everything outside survives.
      assert.deepStrictEqual(visible('a\n~~~\n```\n- [[Ghost]]\n~~~\nb'), ['a', 'b']);
    });

    it('requires the closing run to be at least as long as the opener', () => {
      assert.deepStrictEqual(visible('a\n````\n- [[Ghost]]\n```\nstill inside\n````\nb'), ['a', 'b']);
      assert.deepStrictEqual(visible('a\n```\n- [[Ghost]]\n````\nb'), ['a', 'b']);
    });

    it('rejects a closing fence carrying trailing text', () => {
      assert.deepStrictEqual(visible('a\n```\n# H\n``` js\n- [[Ghost]]\n```\nb'), ['a', 'b']);
    });

    it('runs an unclosed fence to the end of the document', () => {
      assert.deepStrictEqual(visible('a\n```md\n- [[Ghost]]\n## Also ghost'), ['a']);
    });

    it('does not open a backtick fence whose info string carries a backtick', () => {
      const out = visible('a\n``` use `code` here\n- [[Real]]\n```\nb');
      assert.ok(out.includes('- [[Real]]'), 'the line stays real content: ' + out.join(' | '));
    });

    it('ignores a marker indented four or more spaces (indented code, not a fence)', () => {
      assert.deepStrictEqual(visible('a\n    ```\n- [[Real]]\n    ```\nb'), [
        'a',
        '```',
        '- [[Real]]',
        '```',
        'b',
      ]);
    });
  });

  describe('extractWikilinks', () => {
    it('extracts every well-formed link in order and skips malformed ones', () => {
      const links = extractWikilinks('- [[Alpha]] then [[beta/gamma|G]] and [[broken');
      assert.deepStrictEqual(
        links.map((l) => l.target),
        ['Alpha', 'beta/gamma']
      );
      assert.strictEqual(links[1].alias, 'G');
    });

    it('returns an empty array when no links are present', () => {
      assert.deepStrictEqual(extractWikilinks('plain text, no links'), []);
    });

    // Honour the documented contract: a nested `[[` is malformed, not a later
    // link waiting to be reinterpreted. `[[a[[b]]` used to yield { target: 'b' },
    // inventing a chain edge out of a typo.
    it('skips a match that an unterminated [[ precedes', () => {
      assert.deepStrictEqual(extractWikilinks('- [[a[[b]]'), []);
    });

    // `\[[Alpha]]` is Obsidian's way of *showing* a wikilink: the backslash
    // escapes the bracket, so the rendered text is a literal `[[Alpha]]` and no
    // link exists. Reading it as one let a roadmap example rewrite Alpha's
    // `depends_on` for a note the author deliberately switched off.
    it('skips a backslash-escaped wikilink', () => {
      assert.deepStrictEqual(extractWikilinks('- \\[[Alpha]]'), []);
      assert.deepStrictEqual(extractWikilinks('see \\[[Alpha]] and [[Beta]]').map((l) => l.target), [
        'Beta',
      ]);
      // Only an escaping backslash counts: a path segment ending in one is a
      // literal character, and the link after it is real.
      assert.deepStrictEqual(extractWikilinks('[[Alpha]]').map((l) => l.target), ['Alpha']);
    });
  });
});
