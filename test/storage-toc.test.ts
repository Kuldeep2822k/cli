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

    it(
      'a case-fold matching several real files is ambiguous and skipped',
      { skip: process.platform === 'win32' },
      () => {
        // Only constructible on case-sensitive filesystems: `dup/README.md`
        // and `dup/readme.md` cannot coexist on NTFS.
        write(vault, 'README.md', '- [y](dup/README.md)');
        write(vault, 'dup/README.md');
        write(vault, 'dup/readme.md');
        const enum_ = deriveTocEnumeration(vault);
        assert.deepStrictEqual(enum_.documentOrder, []);
        assert.strictEqual(enum_.skipped[0].reason, 'ambiguous');
      }
    );

    it('backslashes are literal characters, never separators', () => {
      write(vault, 'README.md', '- [w](01-a\\README.md)');
      write(vault, '01-a/README.md');
      const enum_ = deriveTocEnumeration(vault);
      assert.deepStrictEqual(enum_.documentOrder, []);
      assert.strictEqual(enum_.skipped[0].reason, 'missing');
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
