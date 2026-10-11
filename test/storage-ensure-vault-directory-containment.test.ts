/**
 * `ensureVaultDirectory` asserts containment before it creates (#335)
 *
 * The guard used to be create-then-verify: it canonicalised the first *existing*
 * ancestor, ran `fs.mkdirSync(…, { recursive: true })`, and only then re-canonicalised
 * the result and refused. Any refusal therefore spoke a bespoke error — a plain
 * `Error` with no `code` and a message `isContainmentError` does not recognise — so
 * the same planted link that `atomicWrite` refuses with `ECONTAINMENT` (and the CLI
 * maps to exit 3, vault integrity) read here as an unclassified exception, and the
 * two containment checks (`startsWith(resolvedVault + path.sep)`, twice) were a second
 * predicate that could disagree with `isWithinVault`.
 *
 * It now runs the shared `assertContainedInVault` on the path it is about to create —
 * existing prefix resolved, missing leaf re-attached — before any `mkdir`, and
 * re-asserts the same predicate on what was created. So:
 * - the refusal is the layer's one refusal surface: `ECONTAINMENT`, the
 *   `Security error: refusing to write outside the vault:` message family, and
 *   never an `ECONFLICT` (nothing about an escaping path is retryable);
 * - a planted link the guard can see is refused with nothing created anywhere
 *   outside the vault, and no `mkdirSync` call issued at all;
 * - the lexical traversal refusal (`Path escapes vault boundary`) is unchanged,
 *   because `palee roadmap` / `adopt` print it verbatim.
 *
 * What this does NOT close, stated plainly: between the certification's last
 * `realpathSync` and the `mkdirSync` there is still a TOCTOU window, and it is not
 * closable from JS — the same limit `src/storage/atomic-write.ts` records for the
 * write path. A link that appears inside that window still gets its directory
 * materialised outside the vault by the recursive create; what the re-assertion
 * guarantees is that the call then refuses instead of returning the escaping path.
 * The last test in this file opens that window deterministically (the technique
 * `test/storage-atomic-write-containment-window.test.ts` uses) and pins exactly that
 * narrower claim — refusal, not prevention.
 *
 * Fixtures use `'junction'` on win32 and `'dir'` elsewhere, the way
 * `test/cli-session-containment.test.ts:27` does, because unprivileged Windows
 * cannot create real symlinks.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ensureVaultDirectory } from '../src/storage/vault-walker';
import { isContainmentError } from '../src/storage/containment';
import { isConflictError } from '../src/storage/atomic-write';

/** Symlink type that works on both POSIX and Windows without elevated rights. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Removes a link to a directory portably (`unlink` on POSIX, `rmdir` on win32). */
function removeLink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    try {
      fs.rmdirSync(linkPath);
    } catch {
      // Already gone.
    }
  }
}

/** Every entry under `dir`, sorted and root-relative, for a before/after diff. */
function treeOf(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((d) => {
      const parent = (d as { parentPath?: string }).parentPath ?? dir;
      return path.relative(dir, path.join(parent, d.name)).replace(/\\/g, '/');
    })
    .sort();
}

describe('ensureVaultDirectory containment (#335)', () => {
  let baseDir: string;
  const plantedLinks: string[] = [];

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-ensure-dir-containment-'));
  });

  after(() => {
    for (const link of plantedLinks) {
      removeLink(link);
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /**
   * Builds `<root>/vault` (plus its canonical form, which is what the guard resolves
   * to and therefore what a refusal has to name — a macOS temp dir sits behind
   * `/var`) and an empty `<root>/outside` directory for a planted link to point at.
   */
  function makeFixture(name: string): { vault: string; canonicalVault: string; outside: string } {
    const root = fs.mkdtempSync(path.join(baseDir, `${name}-`));
    const vault = path.join(root, 'vault');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    return { vault, canonicalVault: fs.realpathSync(vault), outside };
  }

  /** Plants `linkPath` as a link onto `target`, and records it for cleanup. */
  function plantLink(linkPath: string, target: string): string {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, LINK_TYPE);
    plantedLinks.push(linkPath);
    return linkPath;
  }

  /**
   * Asserts a refusal is the layer's containment refusal and nothing more: same code,
   * same message family, recognised by the classifier the CLI routes on.
   * This is the assertion that fails at base — the old guard threw a bare `Error`
   * (`code: undefined`) reading `Symlink escape detected: …`, which `exitCodeFor`
   * would have reported as an unexpected exception rather than a vault-integrity 3.
   */
  function assertContainmentRefusal(err: unknown, namedPath: string): true {
    const e = err as { message?: string; code?: string };
    const message = e.message ?? '';
    assert.match(
      message,
      /Security error: refusing to write outside the vault/,
      `the refusal must speak the layer's containment message family, got: ${message}`
    );
    assert.ok(message.includes(namedPath), `the refusal must name the path it refused: ${message}`);
    assert.strictEqual(e.code, 'ECONTAINMENT', 'the same code as the atomicWrite and .palee tree refusals');
    assert.strictEqual(isConflictError(e), false, 'an escaping path must not read as a retryable OCC conflict');
    assert.strictEqual(
      isContainmentError(e),
      true,
      'the classifier that maps vault-integrity refusals to exit 3 must recognise it'
    );
    return true;
  }

  /** Asserts the planted link survived and the outside directory is still untouched. */
  function assertNothingCreatedOutside(outside: string, before: string[], link: string): void {
    assert.deepStrictEqual(
      treeOf(outside),
      before,
      'the refusal must create nothing outside the vault — not even the directory it was about to make'
    );
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link must survive untouched');
  }

  test('a link planted mid-chain is refused before any directory is created', () => {
    const { vault, canonicalVault, outside } = makeFixture('mid-chain');
    const before = treeOf(outside);
    // `vault/a` is a real in-vault directory, `a/b` is the planted escape, and the
    // requested path is deeper still — so a create would have run through the link.
    const link = plantLink(path.join(canonicalVault, 'a', 'b'), outside);
    const targetDir = path.join(canonicalVault, 'a', 'b', 'c', 'd');

    assert.throws(
      () => ensureVaultDirectory(vault, path.join('a', 'b', 'c', 'd')),
      (err: unknown) => assertContainmentRefusal(err, targetDir)
    );

    assertNothingCreatedOutside(outside, before, link);
    assert.strictEqual(fs.existsSync(path.join(canonicalVault, 'a', 'b', 'c')), false, 'no in-vault stub either');
  });

  test('a link planted at the directory being created is refused, creating nothing outside', () => {
    const { vault, canonicalVault, outside } = makeFixture('at-target');
    const before = treeOf(outside);
    const link = plantLink(path.join(canonicalVault, 'a', 'b'), outside);

    assert.throws(
      () => ensureVaultDirectory(vault, path.join('a', 'b')),
      (err: unknown) => assertContainmentRefusal(err, link)
    );

    assertNothingCreatedOutside(outside, before, link);
  });

  test('a note path whose directory is the planted link is refused, creating nothing outside', () => {
    // `palee roadmap` calls this with a note path (`<topic>.md`), so the guarded
    // directory is `dirname` of the argument — the shape that actually reaches disk.
    const { vault, canonicalVault, outside } = makeFixture('note-path');
    const before = treeOf(outside);
    const link = plantLink(path.join(canonicalVault, 'a', 'b'), outside);

    assert.throws(
      () => ensureVaultDirectory(vault, path.join('a', 'b', 'topic.md')),
      (err: unknown) => assertContainmentRefusal(err, link)
    );

    assertNothingCreatedOutside(outside, before, link);
    assert.deepStrictEqual(treeOf(outside), [], 'the outside directory stays exactly as the fixture left it');
  });

  test('a refused path never reaches mkdirSync at all', () => {
    // The ordering property the issue is about: the old shape could only learn the
    // path escaped after creating it. Recording every `mkdirSync` argument pins that
    // no create is issued for a path the guard refuses, independent of the message.
    const { vault, canonicalVault, outside } = makeFixture('no-mkdir');
    const link = plantLink(path.join(canonicalVault, 'a', 'b'), outside);
    const mkdirArgs: string[] = [];
    const realMkdir = fs.mkdirSync;
    type MkDir = typeof fs.mkdirSync;
    (fs as unknown as { mkdirSync: MkDir }).mkdirSync = ((p: string, ...rest: unknown[]): unknown => {
      if (typeof p === 'string') mkdirArgs.push(p);
      return (realMkdir as (a: string, b?: unknown) => unknown)(p, ...rest);
    }) as MkDir;

    try {
      assert.throws(
        () => ensureVaultDirectory(vault, path.join('a', 'b', 'c', 'd')),
        (err: unknown) => assertContainmentRefusal(err, path.join(canonicalVault, 'a', 'b', 'c', 'd'))
      );
      assert.deepStrictEqual(mkdirArgs, [], 'containment must be asserted before the create, never after it');
      assert.deepStrictEqual(treeOf(outside), [], 'and the refusal must leave nothing behind outside the vault');
    } finally {
      (fs as unknown as { mkdirSync: MkDir }).mkdirSync = realMkdir;
      removeLink(link);
    }
  });

  test('the lexical traversal refusal keeps its own message', () => {
    // `src/cli/roadmap.ts` and `src/cli/adopt.ts` print this message verbatim and
    // several CLI tests regex on `escapes vault`; migrating to the shared guard must
    // not swallow it into the containment family.
    const { vault } = makeFixture('traversal');
    assert.throws(
      () => ensureVaultDirectory(vault, '../outside/topic.md'),
      /Path escapes vault boundary: \.\.\/outside\/topic\.md/
    );

    const nested = makeFixture('traversal-nested');
    assert.throws(
      () => ensureVaultDirectory(nested.vault, '../../escaped.md'),
      /Path escapes vault boundary/
    );
  });

  test('a link that stays inside the vault is still created through', () => {
    // The guard refuses escapes, not links: a directory linked to elsewhere in the
    // same vault is a legitimate layout, and the returned path is the canonical one.
    const { vault, canonicalVault } = makeFixture('inside-link');
    const realDir = path.join(canonicalVault, 'elsewhere');
    fs.mkdirSync(realDir, { recursive: true });
    const link = plantLink(path.join(canonicalVault, 'notes'), realDir);

    const created = ensureVaultDirectory(vault, path.join('notes', 'sub'));

    assert.strictEqual(created, path.join(realDir, 'sub'), 'the return stays the canonical in-vault directory');
    assert.ok(fs.existsSync(path.join(realDir, 'sub')), 'the directory is created where the link resolves');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link itself is left alone');
  });

  test('an ordinary nested create still works and returns the canonical path', () => {
    const { vault, canonicalVault } = makeFixture('plain-create');
    const created = ensureVaultDirectory(vault, path.join('nested', 'deeper', 'topic.md'));

    assert.strictEqual(created, path.join(canonicalVault, 'nested', 'deeper'));
    assert.ok(fs.existsSync(created));
  });

  test('an already existing directory is returned unchanged, without a create', () => {
    const { vault, canonicalVault } = makeFixture('existing');
    const existing = path.join(canonicalVault, 'already');
    fs.mkdirSync(existing, { recursive: true });

    assert.strictEqual(ensureVaultDirectory(vault, 'already'), existing);
    assert.strictEqual(ensureVaultDirectory(vault, path.join('already', 'note.md')), existing);
  });

  test('a dot-prefixed traversal-like name stays legal inside the vault', () => {
    // `..custom` is a real directory name, not parent traversal — the boundary check
    // folds through the shared predicate now, and it must stay as permissive as before.
    const { vault, canonicalVault } = makeFixture('dot-name');
    const created = ensureVaultDirectory(vault, path.join('..custom', 'notes'));

    assert.strictEqual(created, path.join(canonicalVault, '..custom', 'notes'));
    assert.ok(fs.existsSync(created));
  });

  test('a link that appears between the certification and the create is still refused', () => {
    // The residual window, opened deterministically instead of raced: the link is
    // planted on the far side of the guard's own read of the position it lands on, so
    // the certification cannot see it. Node exposes no relative, no-follow mkdir, so
    // this is the gap the fix narrows and does NOT close — what is pinned here is that
    // the re-asserted predicate keeps it failing closed with the standard refusal,
    // rather than handing the caller an escaping path. It deliberately does not claim
    // nothing was created outside: in this window the recursive create has already run.
    const { vault, canonicalVault, outside } = makeFixture('window');
    const escape = path.join(canonicalVault, 'a', 'b');
    fs.mkdirSync(path.join(canonicalVault, 'a'), { recursive: true });

    let planted = false;
    const realExists = fs.existsSync;
    const realRealpath = fs.realpathSync;
    type Exists = typeof fs.existsSync;
    type Realpath = typeof fs.realpathSync;
    const fsAny = fs as unknown as { existsSync: Exists; realpathSync: Realpath };

    const afterRead = (p: unknown): void => {
      if (planted || typeof p !== 'string') return;
      if (path.resolve(p) !== escape) return;
      planted = true;
      fs.symlinkSync(outside, escape, LINK_TYPE);
      plantedLinks.push(escape);
    };

    fsAny.existsSync = ((p: fs.PathLike): boolean => {
      const answer = realExists(p);
      afterRead(p);
      return answer;
    }) as Exists;
    fsAny.realpathSync = ((p: fs.PathLike): string => {
      try {
        const canonical = realRealpath(p);
        afterRead(p);
        return canonical;
      } catch (e) {
        afterRead(p);
        throw e;
      }
    }) as Realpath;

    try {
      assert.throws(
        () => ensureVaultDirectory(vault, path.join('a', 'b', 'c')),
        (err: unknown) => assertContainmentRefusal(err, path.join(canonicalVault, 'a', 'b', 'c'))
      );
    } finally {
      fsAny.existsSync = realExists;
      fsAny.realpathSync = realRealpath;
      removeLink(escape);
    }

    assert.strictEqual(planted, true, 'the window must actually have been opened for this test to mean anything');
  });
});
