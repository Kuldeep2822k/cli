/**
 * Containment of the `atomicWrite` destination (#264)
 *
 * `atomicWrite` validated only that the *final* path component was not a link.
 * A link planted higher up in the path redirected the whole write: the issue's
 * repro is `vault\.palee\sessions` as a junction to a directory outside the
 * vault, and `palee session end` reported success (exit 0) with the note filed
 * outside. `.palee` is invisible to `walkVault`, so `validate` never notices and
 * the junction survives. The lock tree has the same shape: `getLockDir` joins
 * `.palee/locks` onto the vault lexically, so a junctioned `.palee` puts the
 * `.lockdir` outside.
 *
 * The guard belongs in `atomicWrite` rather than at each call site, so the
 * roadmap / adopt / migrate / review / session paths inherit it. It reuses the
 * repo's existing containment mechanism — canonicalise both endpoints with
 * `fs.realpathSync` (the existing portion of the path, because the destination
 * file usually does not exist yet) and apply {@link isWithinVault} from
 * `src/storage/wikilink.ts`, the authoritative guard. A second, disagreeing
 * containment primitive would be worse than none.
 *
 * Fixtures use `'junction'` on win32 and `'dir'` elsewhere — the prior art in
 * `test/storage-relative-path.test.ts:27` — so the mid-path escape runs on
 * Windows, Linux and macOS rather than being skipped on one of them. The
 * counter-cases below are what keeps the guard from being too strict: a
 * symlinked vault root, a link that stays inside the vault, a `..` spelling
 * that resolves back inside, a not-yet-existing leaf, a trailing separator, and
 * a relative vault path.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, isConflictError, isContainmentError } from '../src/storage/atomic-write';

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

describe('atomicWrite refuses a destination that resolves outside the vault', () => {
  let baseDir: string;
  let vault: string;
  let outside: string;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-containment-'));
    vault = path.join(baseDir, 'vault');
    outside = path.join(baseDir, 'outside');
    fs.mkdirSync(vault);
    fs.mkdirSync(outside);
  });

  after(() => {
    for (const entry of fs.readdirSync(vault, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        removeLink(path.join(vault, entry.name));
      }
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /**
   * Creates `<outside>/<name>` and a link to it at `<vault>/<name>-link` — the
   * planted mid-path escape, with the link and its target directory returned so
   * a test can assert both stayed untouched.
   */
  function plantedEscapeDir(name: string): { link: string; outsideDir: string } {
    const outsideDir = path.join(outside, name);
    fs.mkdirSync(outsideDir, { recursive: true });
    const link = path.join(vault, `${name}-link`);
    fs.symlinkSync(outsideDir, link, LINK_TYPE);
    return { link, outsideDir };
  }

  /**
   * Asserts a rejection is the containment refusal: it names the path and the
   * reason, carries its own error code, and is never classified as a conflict.
   * A refusal misclassified as `ECONFLICT` would surface as exit 4 (a retryable
   * mid-air collision) instead of a security refusal.
   */
  function assertContainmentRefusal(err: unknown, namedPath: string): true {
    const e = err as { message?: string; code?: string };
    const message = e.message ?? '';
    assert.match(message, /Security error: refusing to write outside the vault/, 'the refusal must name the reason');
    assert.ok(message.includes(namedPath), `the refusal must name the path it refused: ${message}`);
    assert.strictEqual(e.code, 'ECONTAINMENT', 'a security refusal carries its own code, not ECONFLICT');
    assert.strictEqual(isConflictError(e), false, 'the refusal must not read as an OCC/lock conflict');
    assert.strictEqual(
      typeof isContainmentError === 'function' ? isContainmentError(e) : false,
      true,
      'the classifier must recognise the refusal so handlers exit 3 rather than 5'
    );
    return true;
  }

  test('a link planted mid-path is refused and nothing lands outside', async () => {
    const { link, outsideDir } = plantedEscapeDir('mid-path');
    const target = path.join(link, 'note.md');

    await assert.rejects(
      () => atomicWrite(vault, target, '# REDIRECTED CONTENT\n'),
      (err: unknown) => assertContainmentRefusal(err, target)
    );

    assert.deepStrictEqual(fs.readdirSync(outsideDir), [], 'no note may be filed outside the vault');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link must survive untouched');
  });

  test('the refusal happens before the lock is created', async () => {
    // A vault with no `.palee` at all: `getLockDir` creates `.palee/locks` the
    // moment a `Lock` is constructed, so an existing `.palee` after the refusal
    // would mean the lock tree was written before the guard had said no.
    const isolatedVault = path.join(baseDir, 'isolated-vault');
    const isolatedOutside = path.join(baseDir, 'isolated-outside');
    fs.mkdirSync(isolatedVault);
    fs.mkdirSync(isolatedOutside);
    const link = path.join(isolatedVault, 'escape');
    fs.symlinkSync(isolatedOutside, link, LINK_TYPE);

    await assert.rejects(
      () => atomicWrite(isolatedVault, path.join(link, 'note.md'), '# REDIRECTED CONTENT\n'),
      (err: unknown) => assertContainmentRefusal(err, path.join(link, 'note.md'))
    );

    assert.strictEqual(
      fs.existsSync(path.join(isolatedVault, '.palee')),
      false,
      'a refused write must not create the lock tree, let alone a .lockdir in it'
    );
    assert.deepStrictEqual(fs.readdirSync(isolatedOutside), [], 'no lock file or note may land outside');
  });

  test('a junctioned .palee directory cannot move the lock tree outside the vault', async () => {
    // `getLockDir` joins `.palee/locks` onto the vault lexically, so this escape
    // is not covered by the destination guard: an in-vault note would still
    // write its `.lockdir` through the junction. Fail closed on the lock tree.
    const paleeOutside = path.join(outside, 'palee-target');
    fs.mkdirSync(paleeOutside, { recursive: true });
    const nestedVault = path.join(baseDir, 'palee-junction-vault');
    fs.mkdirSync(nestedVault);
    fs.symlinkSync(paleeOutside, path.join(nestedVault, '.palee'), LINK_TYPE);

    const target = path.join(nestedVault, 'legit-note.md');
    await assert.rejects(
      () => atomicWrite(nestedVault, target, '# Content\n'),
      (err: unknown) => assertContainmentRefusal(err, path.join(nestedVault, '.palee'))
    );

    assert.deepStrictEqual(fs.readdirSync(paleeOutside), [], 'the lock tree must not be created outside');
    assert.strictEqual(fs.existsSync(target), false, 'the refused note must not have been written');
    removeLink(path.join(nestedVault, '.palee'));
  });

  test('a destination outside the vault with no link involved is refused', async () => {
    const target = path.join(outside, 'plain-outside.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    await assert.rejects(
      () => atomicWrite(vault, target, '# Outside\n'),
      (err: unknown) => assertContainmentRefusal(err, target)
    );

    assert.strictEqual(fs.existsSync(target), false, 'the outside file must not exist');
  });

  test('a refused write leaves the in-vault tree untouched', async () => {
    const before = fs.readdirSync(vault).sort().join('|');
    await assert.rejects(
      () => atomicWrite(vault, path.join(outside, 'plain-outside-2.md'), '# Outside\n'),
      (err: unknown) => assertContainmentRefusal(err, path.join(outside, 'plain-outside-2.md'))
    );
    assert.strictEqual(fs.readdirSync(vault).sort().join('|'), before, 'the refusal must not mutate the vault');
  });

  test('a .. spelling that leaves the vault is refused, prefix and all', async () => {    // The string starts with the vault path, so a lexical prefix check accepts
    // it; the canonical path does not sit under the vault, so containment rejects.
    const target = `${vault}${path.sep}..${path.sep}outside${path.sep}escaped.md`;

    await assert.rejects(
      () => atomicWrite(vault, target, '# Escaped\n'),
      (err: unknown) => assertContainmentRefusal(err, target)
    );

    assert.strictEqual(fs.existsSync(path.resolve(target)), false, 'the escaping file must not exist');
  });

  test('a final-component link that leaves the vault is refused', async (t) => {
    const canary = '# OUTSIDE-CANARY-DO-NOT-TOUCH\n';
    const outsideFile = path.join(outside, 'final-canary.md');
    fs.writeFileSync(outsideFile, canary);
    const link = path.join(vault, 'final-link.md');
    try {
      fs.symlinkSync(outsideFile, link, 'file');
    } catch {
      t.skip('file symlink creation is not permitted on this platform');
      return;
    }

    await assert.rejects(
      () => atomicWrite(vault, link, '# Overwrite attempt\n'),
      (err: unknown) => assertContainmentRefusal(err, link)
    );

    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), canary, 'the outside file must not be rewritten');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link itself must not be replaced');
    removeLink(link);
  });

  test('a junctioned sessions directory cannot receive the session note', async () => {
    // The issue's repro, at the storage layer: `writeSessionNote` builds
    // `.palee/sessions/S-*.md` and `getSessionsDir` gates on `existsSync`,
    // which follows links — the note's own write is what has to refuse.
    const sessionsOutside = path.join(outside, 'sessions-target');
    fs.mkdirSync(sessionsOutside, { recursive: true });
    const sessionVault = path.join(baseDir, 'session-vault');
    fs.mkdirSync(path.join(sessionVault, '.palee'), { recursive: true });
    fs.symlinkSync(sessionsOutside, path.join(sessionVault, '.palee', 'sessions'), LINK_TYPE);
    const target = path.join(sessionVault, '.palee', 'sessions', 'S-20261004T000000-abcd.md');

    await assert.rejects(
      () => atomicWrite(sessionVault, target, '# Session\n'),
      (err: unknown) => assertContainmentRefusal(err, target)
    );

    assert.deepStrictEqual(fs.readdirSync(sessionsOutside), [], 'no session note may land outside the vault');
    assert.strictEqual(
      fs.existsSync(path.join(sessionVault, '.palee', 'locks')),
      false,
      'the refusal must precede lock creation'
    );
  });
});

describe('atomicWrite keeps every legitimate destination writable', () => {
  let baseDir: string;
  let vault: string;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-containment-ok-'));
    vault = path.join(baseDir, 'vault');
    fs.mkdirSync(vault);
  });

  after(() => {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        removeLink(path.join(baseDir, entry.name));
      }
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('a nested write into existing directories with a new leaf file succeeds', async () => {
    // The destination file does not exist yet — the case the guard must resolve
    // through its nearest existing ancestor rather than refuse.
    const deep = path.join(vault, 'modules', 'week-01');
    fs.mkdirSync(deep, { recursive: true });
    const target = path.join(deep, 'algebra.md');
    await atomicWrite(vault, target, '# Algebra\n');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Algebra\n');
  });

  test('an existing regular note is overwritten', async () => {
    const target = path.join(vault, 'known.md');
    fs.writeFileSync(target, '# First\n', 'utf8');
    await atomicWrite(vault, target, '# Second\n');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Second\n');
  });

  test('a link that stays inside the vault is followed, not refused', async () => {
    const realDir = path.join(vault, 'real-dir');
    fs.mkdirSync(realDir, { recursive: true });
    const insideLink = path.join(vault, 'inside-link');
    fs.symlinkSync(realDir, insideLink, LINK_TYPE);

    const target = path.join(insideLink, 'note.md');
    await atomicWrite(vault, target, '# Inside\n');
    assert.strictEqual(fs.readFileSync(path.join(realDir, 'note.md'), 'utf8'), '# Inside\n');
  });

  test('a .. and . spelling that resolves back inside the vault is written', async () => {
    const notesDir = path.join(vault, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const target = `${notesDir}${path.sep}..${path.sep}notes${path.sep}.${path.sep}dot-segments.md`;

    await atomicWrite(vault, target, '# Still inside\n');

    assert.strictEqual(fs.readFileSync(path.join(notesDir, 'dot-segments.md'), 'utf8'), '# Still inside\n');
  });

  test('a vault root that is itself a symlink accepts writes', async () => {
    // Legitimate and common: macOS temp dirs reach `/var/folders/…` through a
    // `/var` symlink, and a user may well point `vaultPath` at a link to the
    // real vault. The root is canonicalised before the comparison, so this
    // resolves inside itself instead of reading as an escape.
    const realRoot = path.join(baseDir, 'real-root');
    fs.mkdirSync(realRoot);
    const linkedRoot = path.join(baseDir, 'linked-root');
    fs.symlinkSync(realRoot, linkedRoot, LINK_TYPE);

    await atomicWrite(linkedRoot, path.join(linkedRoot, 'note.md'), '# Through the linked root\n');

    assert.strictEqual(fs.readFileSync(path.join(realRoot, 'note.md'), 'utf8'), '# Through the linked root\n');
  });

  test('a vault path with a trailing separator is still the vault', async () => {
    // `path.resolve('vault/')` collapses to 'vault'; the guard must not compare
    // the raw strings and read the caller's own root as an escape.
    const sepVault = path.join(baseDir, 'sep-vault');
    fs.mkdirSync(sepVault);
    const target = path.join(sepVault, 'trailing-sep.md');
    await atomicWrite(`${sepVault}${path.sep}`, target, '# Trailing separator\n');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Trailing separator\n');
  });

  test('a relative vault path is resolved against the vault, not rejected', async () => {
    const relVault = path.relative(process.cwd(), vault);
    const target = path.join(vault, 'relative-root.md');
    await atomicWrite(relVault, target, '# Relative vault path\n');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Relative vault path\n');
  });

  test('a differently-cased vault spelling is inside the vault on Windows', async (t) => {
    // `fs.realpathSync` performs no case conversion, and win32 path comparison
    // is case-insensitive; the guard must not refuse a note the user spelled
    // with the other case. Nothing on a case-sensitive volume.
    if (process.platform !== 'win32') {
      t.skip('case-insensitive volumes only exist on Windows');
      return;
    }
    const cased = vault.charAt(0).toLowerCase() === vault.charAt(0)
      ? vault.charAt(0).toUpperCase() + vault.slice(1)
      : vault.charAt(0).toLowerCase() + vault.slice(1);
    const target = path.join(cased, 'cased-root.md');
    await atomicWrite(cased, target, '# Other case\n');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Other case\n');
  });
});
