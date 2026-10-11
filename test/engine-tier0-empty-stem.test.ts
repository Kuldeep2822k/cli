import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyNoteForChain, stemOf } from '../src/engine/tier0-hygiene';

/**
 * The module's stated failure direction is "demote to leaf", never "chain as a
 * lesson" (`src/engine/tier0-hygiene.ts` header). `stemOf` returns `''` for any
 * non-`.md` basename, and the empty-stem branch used to answer that with
 * `backbone` — promoting a file that can never be a lesson into the set that
 * gates the lessons around it (#330).
 *
 * Reachability, stated honestly: every production caller feeds `.md` paths —
 * the adopt scan walks a `.md`-filtered vault (`src/storage/vault-walker.ts`),
 * and migrate/auto-chain/toc-chain all resolve against that note index. So this
 * is a contract fix for the public barrel surface
 * (`src/engine/index.ts` re-exports `classifyNoteForChain`), not a bug a CLI
 * command can hit today.
 */
describe('Tier-0 hygiene: an empty stem must not reach the backbone (#330)', () => {
  it('stems only .md basenames, so these inputs really do produce an empty stem', () => {
    for (const name of ['notes.txt', 'Makefile', 'no-extension', '.md', 'DATA.CSV']) {
      assert.strictEqual(stemOf(name.split('/').pop() as string), '', name);
    }
  });

  it('demotes every non-markdown basename to a leaf instead of gating as backbone', () => {
    for (const relPath of [
      'notes.txt',
      'Makefile',
      '01-search/notes.txt',
      '01-search/DATA.CSV',
      '01-search/.md',
    ]) {
      const decision = classifyNoteForChain(relPath);
      assert.notStrictEqual(decision.cls, 'backbone', `${relPath} must never gate other notes`);
      assert.strictEqual(decision.cls, 'leaf', relPath);
    }
  });

  it('still classifies real lesson notes as backbone', () => {
    // The guard has to stay narrow: this is the case the old branch was
    // accidentally serving, and a fix that demotes it would be a regression.
    assert.deepStrictEqual(classifyNoteForChain('01-x/02-y.md'), { cls: 'backbone' });
    assert.deepStrictEqual(classifyNoteForChain('01-search/02-es.md'), { cls: 'backbone' });
  });
});
