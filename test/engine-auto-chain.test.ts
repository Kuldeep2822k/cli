import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseNumericPrefix,
  compareLessonOrder,
  planAutoChain,
  planAutoChainWithHygiene,
  directoriesOrderedAlphabetically,
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
      assert.strictEqual(plan.directoryOrderAlphabetical, false);
      assert.strictEqual(plan.hasUnnumbered, false);
    });

    // The vault-root group is hoisted to the front of the hygiene plan on
    // purpose (the owner-ruled README bridge), so its position is never decided
    // by name. Counting the `'.'` sentinel made the flag true for every vault
    // with a root note and any directory at all — nearly all of them — and the
    // CLI warned learners to `--exclude` a layout that numbers correctly.
    it('never flags the vault-root group, which is hoisted rather than sorted', () => {
      const withRoot = planAutoChain(['README.md', '01-a/01-x.md', '02-b/01-y.md']);
      assert.strictEqual(withRoot.directoryOrderAlphabetical, false);

      const rootVsUnnumbered = planAutoChain(['README.md', 'guide/01-x.md']);
      assert.strictEqual(rootVsUnnumbered.directoryOrderAlphabetical, false);

      const hygiene = planAutoChainWithHygiene(['README.md', '01-a/01-x.md', '01-a/02-y.md']);
      assert.strictEqual(hygiene.directoryOrderAlphabetical, false);
      assert.deepStrictEqual(hygiene.alphabeticalNotes, []);
    });

    // A pair like `02-a` / `02-b` states the same number twice, so
    // `compareLessonOrderTier0` falls through to the filenames while still
    // looking fully numbered to the learner. `alphabeticalNotes` cannot see it
    // (both names carry a number) and neither can
    // `directoryOrderAlphabetical` (there is one directory), so before this
    // field the CLI reported nothing about an edge it went on to gate with.
    it('names a same-number tie whose order came from the filenames', () => {
      const tie = planAutoChainWithHygiene(['m/02-a.md', 'm/02-b.md']);
      assert.deepStrictEqual(tie.alphabeticalTieNotes, ['m/02-b.md']);
      assert.strictEqual(tie.predecessorOf.get('m/02-b.md'), 'm/02-a.md', 'the tie still decides the edge');

      const phaseTie = planAutoChainWithHygiene(['m/lab-a.md', 'm/lab-b.md']);
      assert.deepStrictEqual(phaseTie.alphabeticalTieNotes, ['m/lab-b.md']);

      const three = planAutoChainWithHygiene(['m/02-a.md', 'm/02-b.md', 'm/02-c.md']);
      assert.deepStrictEqual(three.alphabeticalTieNotes, ['m/02-b.md', 'm/02-c.md']);
    });

    it('reports no tie where numbering, phases or ranks already decide', () => {
      assert.deepStrictEqual(
        planAutoChainWithHygiene(['m/01-a.md', 'm/02-b.md']).alphabeticalTieNotes,
        [],
        'different numbers are an author-stated order'
      );
      assert.deepStrictEqual(
        planAutoChainWithHygiene(['m/README.md', 'm/01-a.md']).alphabeticalTieNotes,
        [],
        'different ranks are ordered by rule, not by name'
      );
      assert.deepStrictEqual(
        planAutoChainWithHygiene(['a/01-x.md', 'b/01-y.md']).alphabeticalTieNotes,
        [],
        'a cross-directory pair is not a within-directory tie'
      );
    });

    it('leaves genuinely unnumbered names to alphabeticalNotes, without double reporting', () => {
      const unnumbered = planAutoChainWithHygiene(['m/alpha.md', 'm/beta.md']);
      assert.deepStrictEqual(unnumbered.alphabeticalTieNotes, [], 'rank 3 is already reported');
      assert.deepStrictEqual(unnumbered.alphabeticalNotes, ['m/alpha.md', 'm/beta.md']);
    });

    // R4: demoting homework to last inside its own directory also made it the
    // note the next directory followed, because the bridge used the previous
    // group's final backbone. Solving a quiz is not a prerequisite for the next
    // module's first lesson.
    it('bridges to the next module from its last lesson, not from its homework', () => {
      const plan = planAutoChainWithHygiene([
        '01-foundations/README.md',
        '01-foundations/01-a.md',
        '01-foundations/assignment.md',
        '02-search/01-b.md',
      ]);
      assert.strictEqual(
        plan.predecessorOf.get('02-search/01-b.md'),
        '01-foundations/01-a.md',
        'the cross-directory bridge must skip the assignment'
      );
      assert.strictEqual(
        plan.predecessorOf.get('01-foundations/assignment.md'),
        '01-foundations/01-a.md',
        'homework still follows the lesson it assesses'
      );
    });

    it('opens a new chain when a module\'s only backbone is homework', () => {
      const plan = planAutoChainWithHygiene([
        '01-only/assignment.md',
        '02-next/01-a.md',
      ]);
      assert.strictEqual(plan.predecessorOf.get('01-only/assignment.md'), null);
      assert.strictEqual(
        plan.predecessorOf.get('02-next/01-a.md'),
        null,
        'a group with no lesson of its own exports nothing to the next one'
      );
    });

    it('still bridges across a directory that holds only leaves', () => {
      // The carry-forward is what `lastBackbone` did before homework was
      // demoted: a `your-work/` subtree collapses to leaves and must not break
      // the chain between the modules around it.
      const plan = planAutoChainWithHygiene([
        '01-a/01-x.md',
        '02-b/your-work/notes.md',
        '03-c/01-y.md',
      ]);
      assert.strictEqual(plan.predecessorOf.get('02-b/your-work/notes.md'), '01-a/01-x.md');
      assert.strictEqual(plan.predecessorOf.get('03-c/01-y.md'), '01-a/01-x.md');
    });

    it('a homework-only module in the middle ends the chain instead of skipping ahead', () => {
      // The leaf-only case above carries the bridge forward; a homework-only
      // module must not, because it is a module the learner has to pass through
      // and inheriting a lesson from two modules back hands out an edge that
      // skips it. Measured shape: `01-a/01-x → 01-a/assignment → 02-b/quiz →
      // 03-c/01-y`, where the quiz legitimately follows the lesson.
      const plan = planAutoChainWithHygiene([
        '01-a/01-x.md',
        '01-a/assignment.md',
        '02-b/quiz.md',
        '03-c/01-y.md',
      ]);
      assert.strictEqual(plan.predecessorOf.get('01-a/assignment.md'), '01-a/01-x.md');
      assert.strictEqual(plan.predecessorOf.get('02-b/quiz.md'), '01-a/01-x.md');
      assert.strictEqual(
        plan.predecessorOf.get('03-c/01-y.md'),
        null,
        'the module after a homework-only one opens its own chain'
      );
      for (const p of plan.orderedPaths) {
        const pred = plan.predecessorOf.get(p);
        assert.ok(
          !pred || !/assignment|quiz|solution/.test(pred),
          `nothing may gate on homework, but ${p} gates on ${pred}`
        );
      }
    });

    it('still flags two genuinely unnumbered sibling directories', () => {
      assert.strictEqual(
        directoriesOrderedAlphabetically(['alpha/01-x.md', 'beta/01-y.md']),
        true
      );
      // Root files must not mask a real fallback between two named dirs.
      assert.strictEqual(
        directoriesOrderedAlphabetically(['README.md', 'alpha/01-x.md', 'beta/01-y.md']),
        true
      );
      assert.strictEqual(
        directoriesOrderedAlphabetically(['01-a/01-x.md', '02-b/01-y.md']),
        false
      );
      assert.strictEqual(directoriesOrderedAlphabetically(['01-a/01-x.md']), false);
    });

    // A level scan that looks at every group independently conflates depths:
    // `deep-dive` and `lab` really are unnumbered siblings, but they are not
    // siblings of each other — `01-a` and `02-b` already decided which module
    // comes first, so nothing at the deeper level chose anything.
    it('does not let a deeper level contradict an order the top level decided', () => {
      assert.strictEqual(
        directoriesOrderedAlphabetically(['01-a/deep-dive/01-x.md', '02-b/lab/01-y.md']),
        false
      );
      const plan = planAutoChain(['01-a/deep-dive/01-x.md', '02-b/lab/01-y.md']);
      assert.strictEqual(plan.directoryOrderAlphabetical, false);
      assert.deepStrictEqual(plan.orderedPaths, [
        '01-a/deep-dive/01-x.md',
        '02-b/lab/01-y.md',
      ]);
    });

    it('still flags unnumbered siblings that share a decided-prefix parent', () => {
      // Same nesting, but the choice genuinely is alphabetical this time: the
      // two groups sit under one shared parent and differ only by name.
      assert.strictEqual(
        directoriesOrderedAlphabetically(['01-a/deep-dive/01-x.md', '01-a/lab/01-y.md']),
        true
      );
      assert.strictEqual(
        directoriesOrderedAlphabetically(['src/algorithms/caesar/README.md', 'src/algorithms/hill/README.md']),
        true
      );
    });

    it('flags an alphabetical choice deeper down when the top level also split numerically', () => {
      // The two cases above are the easy halves. Here the top level really is
      // decided — `01-a` before `02-b` — but that only settles pairs this level
      // separated. `deep-dive` and `lab` are siblings under `02-b` and nothing
      // numbered ever ordered them, so the flag has to say so as plainly as it
      // does when `02-b` is the only group present.
      const mixed = ['01-a/01-x.md', '02-b/deep-dive/y.md', '02-b/lab/z.md'];
      assert.strictEqual(directoriesOrderedAlphabetically(mixed), true);
      assert.strictEqual(planAutoChain(mixed).directoryOrderAlphabetical, true);

      // Same nesting, nothing alphabetical anywhere: the flag must not start
      // firing on a curriculum that numbers every directory.
      const numbered = ['01-a/01-x.md', '02-b/01-y.md', '02-b/02-z.md'];
      assert.strictEqual(directoriesOrderedAlphabetically(numbered), false);
      assert.strictEqual(planAutoChain(numbered).directoryOrderAlphabetical, false);
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

    // `\\[[Alpha]]` carries two backslashes, which escape each other — so the
    // link is live. Judging escapement by the single preceding character read
    // this as escaped and dropped a real chain entry silently.
    it('keeps a wikilink preceded by an even run of backslashes', () => {
      assert.deepStrictEqual(extractWikilinks('- \\\\[[Alpha]]').map((l) => l.target), ['Alpha']);
      assert.deepStrictEqual(
        extractWikilinks('- \\\\\\\\[[Alpha]]').map((l) => l.target),
        ['Alpha'],
        'four backslashes also leave the link active'
      );
      assert.deepStrictEqual(
        extractWikilinks('- \\\\\\[[Alpha]]'),
        [],
        'three backslashes escape the bracket'
      );
      assert.deepStrictEqual(
        extractWikilinks('- \\\\[[Alpha]] and \\[[Beta]]').map((l) => l.target),
        ['Alpha'],
        'both forms in one line, each judged on its own parity'
      );
    });
  });
});
