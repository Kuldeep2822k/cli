import { describe, it } from 'node:test';
import assert from 'node:assert';
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
        assert.strictEqual(cls(`01-x/02-lesson.${code}.md`), 'leaf', `02-lesson.${code}.md`);
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

    it('keeps a numbered OS lesson despite os being ISO-639-1 for Ossetian', () => {
      assert.strictEqual(cls('01-x/02-os-basics.md'), 'backbone');
      assert.strictEqual(cls('01-x/03-networking.md'), 'backbone');
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
});
