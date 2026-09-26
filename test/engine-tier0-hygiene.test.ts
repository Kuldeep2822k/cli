import { describe, it } from 'node:test';
import assert from 'node:assert';
import { planAutoChain, planAutoChainWithHygiene } from '../src/engine/auto-chain';
import {
  classifyNoteForChain,
  isContentDocName,
  isPhaseSubtree,
  isValidPaleeId,
  stemOf,
  REPO_META_STEMS,
  PHASE_DIR_SEGMENTS,
  TRANSLATION_LANG_CODES,
} from '../src/engine/tier0-hygiene';

/** Convenience: the class only, for assertions that do not care about the reason. */
function cls(relPath: string, paleeId?: unknown): string {
  return classifyNoteForChain(relPath, paleeId).cls;
}

describe('Tier-0 hygiene predicates (PAL-205-B, INV-46)', () => {
  describe('B1 repo-meta exclusion', () => {
    it('excludes every blocklisted meta name, case-insensitively', () => {
      for (const name of ['LICENSE.md', 'license.md', 'LiCeNsE.MD', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
        assert.deepStrictEqual(classifyNoteForChain(name), { cls: 'excluded', reason: 'repo-meta' }, name);
      }
    });

    it('covers the spellings and aliases the audit flagged as commonly missed', () => {
      const required = [
        'licence', 'code_of_conduct', 'code-of-conduct', 'backers', 'authors', 'support',
        'funding', 'sponsor', '_404', 'agents', 'cname', 'index', 'home', 'toc', 'contents',
        'translations', 'security',
      ];
      for (const stem of required) {
        assert.ok(REPO_META_STEMS.includes(stem), `blocklist must contain '${stem}'`);
        assert.strictEqual(cls(`${stem}.md`), 'excluded', `${stem}.md should be excluded`);
      }
    });

    it('excludes meta names nested in lesson dirs and only for .md', () => {
      assert.strictEqual(cls('01-beginners/LICENSE.md'), 'excluded');
      assert.strictEqual(cls('module/license.md'), 'excluded');
    });

    it('does not fire on a real lesson that merely mentions a meta word', () => {
      assert.strictEqual(cls('01-x/02-security-model.md'), 'backbone');
      assert.strictEqual(cls('01-x/writing-indexers.md'), 'leaf');
    });
  });

  describe('B2 translation-copy exclusion', () => {
    it('matches every shape the work order pins', () => {
      const pinned: Array<[string, string]> = [
        ['README.ko-KR.md', 'readme.ko-KR'],
        ['assignment.es.md', 'assignment.es'],
        ['README-zh-Hans.md', 'readme-zh-Hans'],
        ['README.cn.md', 'readme.cn'],
      ];
      for (const [path] of pinned) {
        assert.deepStrictEqual(
          classifyNoteForChain(path),
          { cls: 'leaf', reason: 'translation' },
          `${path} must demote as a translation copy`
        );
      }
    });

    it('excludes anything under a translations/ segment regardless of name', () => {
      assert.deepStrictEqual(
        classifyNoteForChain('translations/01-intro.md'),
        { cls: 'excluded', reason: 'translation' }
      );
      assert.strictEqual(cls('course/translation/README.md'), 'excluded');
    });

    it('includes the codes a hand-copied list historically missed', () => {
      for (const code of ['ja', 'pt', 'it', 'ko', 'zh', 'es', 'fr', 'de']) {
        assert.ok(TRANSLATION_LANG_CODES.includes(code), `${code} must be a known language`);
        // Probed on an unnumbered doc name: a numbered stem is a stated lesson
        // order and is exempt from the name arm (see the 02-es fixture).
        assert.strictEqual(cls(`01-x/guide.${code}.md`), 'leaf', `guide.${code}.md`);
      }
    });

    it('pins the guide-js false-positive guard in the safe direction', () => {
      // `js` is not a translation code here, so it must not be flagged as one.
      // Bare `guide-js.md` is still an unnumbered ad-hoc sibling, so B5 makes it
      // a leaf — the safe direction. Inside a lesson dir it stays a lesson.
      assert.strictEqual(classifyNoteForChain('guide-js.md').reason, undefined);
      assert.strictEqual(cls('01-x/02-guide-js.md'), 'backbone');
      assert.strictEqual(cls('01-x/lab-js.md'), 'backbone');
    });

    it('keeps a numbered lesson whose name ends in a real ISO-639-1 code', () => {
      assert.strictEqual(cls('01-x/02-os-basics.md'), 'backbone');
      assert.strictEqual(cls('01-x/03-networking.md'), 'backbone');
    });

    // The B2 name arm has to stay falsifiable: this is the shape that would
    // silently cost coverage if a numbered lesson were ever read as a
    // translation. Zero such names exist in the pinned 15-vault corpus, so this
    // fixture is the only thing standing between a regression and a release.
    it('does not read a topic acronym as a locale on a numbered lesson (02-es fixture)', () => {
      assert.deepStrictEqual(classifyNoteForChain('01-search/02-es.md'), { cls: 'backbone' });
      assert.strictEqual(cls('01-search/03-kibana.md'), 'backbone');
      assert.strictEqual(cls('01-stack/02-go-setup.md'), 'backbone');
      // A translated copy of the same lesson is still caught, by structure.
      assert.strictEqual(
        classifyNoteForChain('01-search/translations/02-es.es.md').cls,
        'excluded'
      );
      // Unnumbered generic/assignment docs keep demoting as before.
      assert.deepStrictEqual(classifyNoteForChain('assignment.es.md'), {
        cls: 'leaf',
        reason: 'translation',
      });
      assert.strictEqual(classifyNoteForChain('README.cn.md').reason, 'translation');
    });
  });

  describe('B3 template exclusion', () => {
    it('excludes template basenames and template dirs', () => {
      assert.deepStrictEqual(classifyNoteForChain('TEMPLATE.md'), { cls: 'excluded', reason: 'template' });
      assert.strictEqual(cls('01-x/note-template.md'), 'excluded');
      assert.strictEqual(cls('templates/01-lab.md'), 'excluded');
      assert.strictEqual(cls('01-x/Templates/README.md'), 'excluded');
    });
  });

  describe('B4 phase-dir collapse', () => {
    it('never chains inside a phase directory', () => {
      for (const dir of PHASE_DIR_SEGMENTS) {
        assert.deepStrictEqual(
          classifyNoteForChain(`01-x/${dir}/README.md`),
          { cls: 'leaf', reason: 'phase-subtree' },
          `${dir}/ subtree must collapse to leaf`
        );
        assert.strictEqual(cls(`01-x/${dir}/02-nested.md`), 'leaf');
      }
    });

    it('reproduces the measured Julia/R regression', () => {
      assert.strictEqual(cls('solution/Julia/README.md'), 'leaf');
      assert.strictEqual(cls('solution/R/README.md'), 'leaf');
    });

    it('isPhaseSubtree ignores the file basename itself', () => {
      assert.strictEqual(isPhaseSubtree('01-x/solution.md'), false);
      assert.strictEqual(isPhaseSubtree('01-x/solution/a.md'), true);
      assert.strictEqual(isPhaseSubtree('01-solutions/02-a.md'), false);
    });

    it('matches phase dirs case-insensitively and at depth', () => {
      assert.strictEqual(cls('01-x/Your-Work/task.md'), 'leaf');
      assert.strictEqual(cls('a/b/c/ANSWERS/x.md'), 'leaf');
    });
  });

  describe('B5 sibling-leaf rule', () => {
    it('keeps only content docs on the backbone', () => {
      assert.strictEqual(cls('01-x/02-linux.md'), 'backbone');
      assert.strictEqual(cls('01-x/README.md'), 'backbone');
      assert.strictEqual(cls('01-x/deep-dive-transformers.md'), 'backbone');
      assert.strictEqual(cls('01-x/lab-01.md'), 'backbone');
      assert.strictEqual(cls('01-x/exam.md'), 'backbone');
      assert.strictEqual(cls('01-x/assignment-2.md'), 'backbone');
      assert.strictEqual(cls('01-x/quiz.md'), 'backbone');
    });

    it('demotes ad-hoc unnumbered siblings to leaves', () => {
      for (const name of ['for-teachers.md', 'how-to-run.md', 'notes.md', 'appendix.md', 'cheatsheet.md']) {
        assert.deepStrictEqual(classifyNoteForChain(`01-x/${name}`), { cls: 'leaf' }, name);
      }
    });

    it('isContentDocName requires a word boundary after the phase keyword', () => {
      assert.strictEqual(isContentDocName('lab-01.md'), true);
      assert.strictEqual(isContentDocName('lab.md'), true);
      assert.strictEqual(isContentDocName('labnotes.md'), false);
      assert.strictEqual(isContentDocName('collaborate.md'), false);
      assert.strictEqual(isContentDocName('01-a.md'), true);
      assert.strictEqual(isContentDocName('README.md'), true);
      assert.strictEqual(isContentDocName('summary.md'), true);
    });
  });

  describe('B7 palee_id type hole', () => {
    it('accepts only a non-empty string id', () => {
      assert.strictEqual(isValidPaleeId('T-abc'), true);
      assert.strictEqual(isValidPaleeId(' x '), true);
      assert.strictEqual(isValidPaleeId(12345), false);
      assert.strictEqual(isValidPaleeId(true), false);
      assert.strictEqual(isValidPaleeId(''), false);
      assert.strictEqual(isValidPaleeId('   '), false);
      assert.strictEqual(isValidPaleeId(null), false);
      assert.strictEqual(isValidPaleeId(undefined), false);
    });

    it('demotes a truthy non-string id instead of making it a predecessor', () => {
      assert.deepStrictEqual(
        classifyNoteForChain('01-x/02-a.md', 12345),
        { cls: 'leaf', reason: 'invalid-palee-id' }
      );
      assert.deepStrictEqual(classifyNoteForChain('01-x/02-a.md', ''), {
        cls: 'leaf',
        reason: 'invalid-palee-id',
      });
      assert.deepStrictEqual(classifyNoteForChain('01-x/02-a.md', 'T-9'), { cls: 'backbone' });
    });

    it('lets scope exclusion win over the id demotion so meta notes are never adopted', () => {
      assert.strictEqual(cls('LICENSE.md', 12345), 'excluded');
      assert.strictEqual(cls('01-x/solution/a.md', true), 'leaf');
      assert.strictEqual(classifyNoteForChain('01-x/solution/a.md', true).reason, 'invalid-palee-id');
    });
  });

  describe('helpers', () => {
    it('stemOf only strips .md', () => {
      assert.strictEqual(stemOf('Readme.MD'), 'readme');
      assert.strictEqual(stemOf('notes.txt'), '');
      assert.strictEqual(stemOf('no-extension'), '');
      assert.strictEqual(stemOf('.md'), '');
    });

    it('normalizes Windows separators before classifying', () => {
      assert.strictEqual(cls('01-x\\solution\\a.md'), 'leaf');
      assert.strictEqual(cls('01-x\\02-y.md'), 'backbone');
    });
  });

  describe('planAutoChainWithHygiene — filter application (B1-B5)', () => {
    const vault = [
      'LICENSE.md',
      'README.md',
      '01-beginners/01-setup.md',
      '01-beginners/02-first-app.md',
      '01-beginners/for-teachers.md',
      '01-beginners/README.md',
      '01-beginners/solutions/01-solution.md',
      'translations/01-setup.es.md',
      '02-mid/01-a.md',
    ];
    const plan = planAutoChainWithHygiene(vault);

    it('removes excluded notes from the plan entirely', () => {
      assert.ok(!plan.orderedPaths.includes('LICENSE.md'));
      assert.ok(!plan.orderedPaths.includes('translations/01-setup.es.md'));
      assert.strictEqual(plan.excluded.get('LICENSE.md'), 'repo-meta');
      assert.strictEqual(plan.excluded.get('translations/01-setup.es.md'), 'translation');
      assert.strictEqual(plan.counts.backbone + plan.counts.leaf, plan.orderedPaths.length);
      assert.strictEqual(plan.orderedPaths.length, vault.length - plan.excluded.size);
    });

    it('never lets repo meta gate a real lesson', () => {
      // Evidence of the false edge being removed: unfiltered, the root README
      // depends on LICENSE.md, and LICENSE.md is itself a chain node.
      const ungated = planAutoChain(vault);
      assert.strictEqual(ungated.predecessorOf.get('README.md'), 'LICENSE.md');
      // Hygiene takes meta out of the plan, so that edge cannot be written.
      assert.ok(!plan.orderedPaths.includes('LICENSE.md'));
      assert.notStrictEqual(plan.predecessorOf.get('README.md'), 'LICENSE.md');
      assert.strictEqual(plan.predecessorOf.get('01-beginners/01-setup.md'), '01-beginners/README.md');
    });

    it('leads each directory with its README so homework never gates the lesson', () => {
      // Class 2: alphabetically `assignment.md` beat `README.md`, so the module
      // lesson depended on its own assignment.
      const homework = planAutoChainWithHygiene([
        '1-Introduction/01-defining-data-science/README.md',
        '1-Introduction/01-defining-data-science/assignment.md',
        '1-Introduction/01-defining-data-science/quiz.md',
        '1-Introduction/01-defining-data-science/solution.md',
      ]);
      assert.strictEqual(
        homework.predecessorOf.get('1-Introduction/01-defining-data-science/README.md'),
        null,
        'the README opens the module'
      );
      assert.strictEqual(
        homework.predecessorOf.get('1-Introduction/01-defining-data-science/assignment.md'),
        '1-Introduction/01-defining-data-science/README.md'
      );
      assert.strictEqual(
        homework.predecessorOf.get('1-Introduction/01-defining-data-science/quiz.md'),
        '1-Introduction/01-defining-data-science/assignment.md'
      );
      assert.strictEqual(
        homework.predecessorOf.get('1-Introduction/01-defining-data-science/solution.md'),
        '1-Introduction/01-defining-data-science/quiz.md'
      );
    });

    it('starts a fresh chain per unnumbered sibling dir instead of gating alphabetically', () => {
      // Class 1: a reference collection enumerated alphabetically is not a
      // prerequisite sequence, so no README may take its predecessor from
      // another unnumbered sibling directory.
      const reference = planAutoChainWithHygiene([
        'src/algorithms/cryptography/caesar-cipher/README.md',
        'src/algorithms/cryptography/hill-cipher/README.md',
        'src/algorithms/cryptography/rail-fence-cipher/README.md',
      ]);
      const gated = [...reference.predecessorOf.values()].filter((v) => v !== null);
      assert.strictEqual(gated.length, 0, 'no alphabetical cross-dir edge may be written');
      for (const p of reference.backbonePaths) {
        assert.strictEqual(reference.predecessorOf.get(p), null, `${p} must open its own chain`);
      }
    });

    it('keeps the numbered cross-module bridge that numbering actually justifies', () => {
      const numbered = planAutoChainWithHygiene([
        '01-beginners/02-last.md',
        '02-intermediate/01-first.md',
      ]);
      assert.strictEqual(
        numbered.predecessorOf.get('02-intermediate/01-first.md'),
        '01-beginners/02-last.md',
        'numbered module N still bridges from module N-1'
      );
    });

    // Owner ruling PAL-205-G2: README -> module-01 is a real prerequisite edge.
    describe('vault-root README bridge (owner ruling PAL-205-G2)', () => {
      it('gates the first numbered module on the vault-root README', () => {
        const bridged = planAutoChainWithHygiene([
          'README.md',
          '01-a/01-x.md',
          '02-b/01-y.md',
        ]);
        assert.strictEqual(bridged.predecessorOf.get('README.md'), null, 'root README opens the chain');
        assert.strictEqual(
          bridged.predecessorOf.get('01-a/01-x.md'),
          'README.md',
          'module 01 depends on the vault README'
        );
        // The rest of the spine is unchanged: module 02 still bridges from 01.
        assert.strictEqual(bridged.predecessorOf.get('02-b/01-y.md'), '01-a/01-x.md');
        assert.strictEqual(bridged.backbonePaths[0], 'README.md', 'the root README leads the spine');
      });

      it('still refuses a root note reaching an UNNUMBERED directory', () => {
        // The exception is specifically root -> numbered. Nothing ordered the
        // pair root -> `foo/`, so that transition stays a refusal.
        const unnumbered = planAutoChainWithHygiene(['README.md', 'foo/01-x.md']);
        assert.strictEqual(unnumbered.predecessorOf.get('foo/01-x.md'), null);
      });

      it('cannot be reached by a root note that is not a content doc', () => {
        // `guide.md` is an ad-hoc sibling, so it is a leaf and leaves never
        // gate: the bridge cannot be abused to hang a lesson off a stray note.
        const stray = planAutoChainWithHygiene(['guide.md', '01-a/01-x.md']);
        assert.strictEqual(stray.decisions.get('guide.md')?.cls, 'leaf');
        assert.strictEqual(stray.predecessorOf.get('01-a/01-x.md'), null);
      });

      it('keeps sibling README-to-README gating forbidden in a vault that also has a root README', () => {
        // Both rules in one fixture: exactly one bridge edge exists (root ->
        // first module); no sibling README gates another sibling README.
        const mixed = planAutoChainWithHygiene([
          'README.md',
          'src/algorithms/caesar/README.md',
          'src/algorithms/hill/README.md',
          '01-first/01-a.md',
          '02-second/01-b.md',
        ]);
        assert.strictEqual(mixed.predecessorOf.get('01-first/01-a.md'), 'README.md');
        assert.strictEqual(mixed.predecessorOf.get('02-second/01-b.md'), '01-first/01-a.md');
        assert.strictEqual(mixed.predecessorOf.get('src/algorithms/caesar/README.md'), null);
        assert.strictEqual(mixed.predecessorOf.get('src/algorithms/hill/README.md'), null);
        const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
        const numberedDir = (d: string): boolean => /^\d{1,3}(?:[-_.\s]|$)/.test(d.split('/')[0]);
        const crossDirSiblingGates = [...mixed.predecessorOf].filter(
          ([child, parent]) =>
            parent !== null &&
            parent !== 'README.md' &&
            dirOf(parent) !== dirOf(child) &&
            dirOf(parent) !== '.' &&
            !numberedDir(dirOf(parent)) &&
            !numberedDir(dirOf(child))
        );
        assert.deepStrictEqual(
          crossDirSiblingGates,
          [],
          'no unnumbered sibling dir may gate another'
        );
      });

      it('adds exactly one edge over the pre-ruling graph', () => {
        const paths = ['README.md', '01-a/01-x.md', '02-b/01-y.md', '03-c/01-z.md'];
        const p = planAutoChainWithHygiene(paths);
        const edges = [...p.predecessorOf.values()].filter((v) => v !== null).length;
        assert.strictEqual(edges, 3, 'one head + three edges across four notes');
      });
    });

    it('still bridges a parent dir into its own nested subdir (nesting is the signal)', () => {
      assert.strictEqual(
        plan.predecessorOf.get('01-beginners/solutions/01-solution.md'),
        '01-beginners/02-first-app.md'
      );
    });

    it('bridges the backbone over leaves instead of chaining through them', () => {
      // README now leads the directory, so the spine inside 01-beginners is
      // README -> 01-setup -> 02-first-app, and the ad-hoc sibling that sorts
      // after it is attached rather than gating. The directory's own README is
      // no longer the chain head because the vault-root README gates into it
      // (owner ruling PAL-205-G2, pinned separately below).
      assert.strictEqual(plan.predecessorOf.get('01-beginners/README.md'), 'README.md');
      assert.strictEqual(plan.predecessorOf.get('01-beginners/01-setup.md'), '01-beginners/README.md');
      assert.strictEqual(
        plan.predecessorOf.get('01-beginners/for-teachers.md'),
        '01-beginners/02-first-app.md'
      );
      assert.ok(plan.leafPaths.includes('01-beginners/for-teachers.md'));
      assert.ok(plan.backbonePaths.includes('01-beginners/README.md'));
    });

    it('collapses a phase subtree to leaves that never gate each other', () => {
      const phase = planAutoChainWithHygiene([
        '01-mod/solution/Julia/README.md',
        '01-mod/solution/R/README.md',
        '01-mod/01-lesson.md',
      ]);
      assert.strictEqual(phase.predecessorOf.get('01-mod/solution/Julia/README.md'), '01-mod/01-lesson.md');
      // The measured regression: solution/R used to depend on solution/Julia.
      assert.notStrictEqual(phase.predecessorOf.get('01-mod/solution/R/README.md'), '01-mod/solution/Julia/README.md');
      assert.ok(!phase.backbonePaths.some((p) => p.includes('/solution/')));
    });

    it('attaches leaves to the nearest preceding backbone node', () => {
      assert.strictEqual(
        plan.predecessorOf.get('01-beginners/solutions/01-solution.md'),
        '01-beginners/02-first-app.md'
      );
    });

    it('keeps a same-dir lesson spine intact when the dir is nested under unnumbered parents', () => {
      // The Class-1 rule must not damage real within-dir ordering.
      const collection = planAutoChainWithHygiene([
        'src/data-structures/linked-list/README.md',
        'src/data-structures/linked-list/01-singly.ts',
        'src/data-structures/linked-list/02-doubly.ts',
      ]);
      assert.strictEqual(collection.predecessorOf.get('src/data-structures/linked-list/README.md'), null);
      assert.strictEqual(
        collection.predecessorOf.get('src/data-structures/linked-list/01-singly.ts'),
        'src/data-structures/linked-list/README.md'
      );
      assert.strictEqual(
        collection.predecessorOf.get('src/data-structures/linked-list/02-doubly.ts'),
        'src/data-structures/linked-list/01-singly.ts'
      );
    });

    it('keeps every edge strictly backward, so the plan stays acyclic', () => {
      const index = new Map(plan.orderedPaths.map((p, i) => [p, i]));
      for (const [path, pred] of plan.predecessorOf) {
        if (pred === null) {
          continue;
        }
        assert.ok(index.get(pred)! < index.get(path)!, `${pred} must precede ${path}`);
      }
    });

    it('reports per-rule counts for the B6 screen', () => {
      assert.strictEqual(plan.counts.byReason['repo-meta'], 1);
      assert.strictEqual(plan.counts.byReason.translation, 1);
      assert.strictEqual(plan.counts.byReason['phase-subtree'], 1);
      assert.strictEqual(plan.counts.backbone, 5);
      assert.strictEqual(plan.counts.leaf, 2);
    });

    it('matches ungated planAutoChain order when nothing is filtered', () => {
      const clean = ['01-a/01-x.md', '01-a/02-y.md', '02-b/01-z.md'];
      const base = planAutoChain(clean);
      const hygienic = planAutoChainWithHygiene(clean);
      assert.deepStrictEqual(hygienic.orderedPaths, base.orderedPaths);
      assert.deepStrictEqual([...hygienic.predecessorOf], [...base.predecessorOf]);
      assert.strictEqual(hygienic.excluded.size, 0);
    });

    it('demotes an unsatisfiable predecessor instead of chaining onto it (B7)', () => {
      const withBadId = planAutoChainWithHygiene(
        ['01-a/01-x.md', '01-a/02-y.md', '01-a/03-z.md'],
        (p) => (p === '01-a/02-y.md' ? 12345 : 'T-ok')
      );
      assert.strictEqual(withBadId.decisions.get('01-a/02-y.md')?.cls, 'leaf');
      assert.strictEqual(withBadId.decisions.get('01-a/02-y.md')?.reason, 'invalid-palee-id');
      // 03-z must bridge over the broken note rather than depend on it.
      assert.strictEqual(withBadId.predecessorOf.get('01-a/03-z.md'), '01-a/01-x.md');
      assert.strictEqual(withBadId.counts.byReason['invalid-palee-id'], 1);
    });
  });
});
