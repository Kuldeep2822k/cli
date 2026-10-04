/**
 * `atomicWrite` writes the destination it certified (#264 residual)
 *
 * `assertContainedInVault` resolves a *relative* destination against the vault
 * root (`path.resolve(resolvedVault, destinationPath)`), while `atomicWrite`'s own
 * `fs` calls passed `targetPath` verbatim — i.e. relative to the process cwd. The
 * guard therefore certified one file and wrote another: a relative `notes/a.md`
 * was cleared as being inside the vault and then landed next to the terminal the
 * user was standing in. Every in-repo caller passes an absolute path today, so the
 * divergence is latent, not live — but a write primitive should not have to be
 * told which of its two readings of the path is the real one.
 *
 * The fix is to resolve once: take the canonical path `assertContainedInVault`
 * already returns and use it for the lock, the OCC read, the temp file and the
 * rename. That is the smaller change (no new error surface, no caller churn) and
 * it removes the whole class of disagreement instead of forbidding half of it.
 *
 * The fixtures `process.chdir` into a directory that is *not* the vault for the
 * whole file, so a write that goes to the cwd instead of the vault is visible as
 * an entry appearing there. Node's test runner gives each file its own process,
 * and `after` restores the original cwd.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite } from '../src/storage/atomic-write';
import { isContainmentError } from '../src/storage/containment';

describe('atomicWrite writes the path it certified', () => {
  let savedCwd: string;
  let baseDir: string;
  let vault: string;
  /** A directory outside the vault, made the process cwd for every test below. */
  let cwdDir: string;
  let outside: string;

  before(() => {
    savedCwd = process.cwd();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-resolved-destination-'));
    vault = path.join(baseDir, 'vault');
    cwdDir = path.join(baseDir, 'cwd');
    outside = path.join(baseDir, 'outside');
    fs.mkdirSync(vault);
    fs.mkdirSync(cwdDir);
    fs.mkdirSync(outside);
    process.chdir(cwdDir);
  });

  after(() => {
    process.chdir(savedCwd);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /** Names of the entries sitting in the process cwd — never a write destination. */
  function cwdEntries(): string[] {
    return fs.readdirSync(cwdDir);
  }

  // Keep each test's `cwdEntries()` verdict its own: without this, a file that a
  // failing earlier write dropped in the cwd would be blamed on the next test.
  beforeEach(() => {
    for (const entry of cwdEntries()) {
      fs.rmSync(path.join(cwdDir, entry), { recursive: true, force: true });
    }
  });

  test('a relative destination is written into the vault, not beside the terminal', async () => {
    await atomicWrite(vault, 'relative-note.md', '# Written in the vault\n');

    const inVault = path.join(vault, 'relative-note.md');
    assert.ok(fs.existsSync(inVault), 'a relative destination resolves against the vault, as the guard assumes');
    assert.strictEqual(fs.readFileSync(inVault, 'utf8'), '# Written in the vault\n');
    assert.deepStrictEqual(cwdEntries(), [], 'nothing may be created in the process working directory');
  });

  test('a relative destination in a vault subdirectory keeps that subdirectory', async () => {
    fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });

    await atomicWrite(vault, path.join('notes', 'deep.md'), '# Deep\n');

    const inVault = path.join(vault, 'notes', 'deep.md');
    assert.strictEqual(fs.readFileSync(inVault, 'utf8'), '# Deep\n');
    assert.deepStrictEqual(cwdEntries(), [], 'nothing may be created in the process working directory');
  });

  test('a relative destination that escapes the vault is refused and nothing lands in the cwd', async () => {
    await assert.rejects(
      () => atomicWrite(vault, '../outside.md', '# Escaped\n'),
      (err: unknown) => {
        assert.strictEqual(isContainmentError(err), true, 'an escaping relative destination is a security refusal');
        return true;
      }
    );

    assert.strictEqual(fs.existsSync(path.resolve(baseDir, 'outside.md')), false, 'the escaping file must not exist');
    assert.deepStrictEqual(cwdEntries(), [], 'a refusal must not create anything in the process working directory');
  });

  test('an absolute destination is written exactly where it is spelled', async () => {
    // The counter-case for the resolution change: absolute callers — every
    // in-repo caller — must still get their own path, with no re-spelling that
    // moves the bytes.
    const target = path.join(vault, 'absolute-note.md');
    await atomicWrite(vault, target, '# Absolute\n');

    assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Absolute\n');
    assert.deepStrictEqual(cwdEntries(), [], 'nothing may be created in the process working directory');
  });

  test('the lock and the temp file follow the resolved destination', async () => {
    // `.palee/locks` hangs off the vault root, and the temp file off the
    // destination: both must be built from the resolved path, or a relative
    // caller would leave a `.tmp` file in the terminal's directory.
    await atomicWrite(vault, 'locked-note.md', '# Locked\n');

    assert.deepStrictEqual(
      fs.readdirSync(cwdDir),
      [],
      'no temp file may be created in the process working directory'
    );
    const leftovers = fs.readdirSync(vault).filter((f) => f.includes('.tmp.'));
    assert.deepStrictEqual(leftovers, [], 'the temp file must be renamed away, not left beside the note');
  });

  test('an overwritten relative destination still gets its OCC check', async () => {
    await atomicWrite(vault, 'occ-note.md', '# First\n');
    const inVault = path.join(vault, 'occ-note.md');

    // Any fingerprint that is not the disk state triggers the conflict; the point
    // is that the OCC read happens against the *resolved* file, so a relative
    // caller is compared against the note it is about to overwrite rather than
    // against a same-named file in the terminal's directory.
    await assert.rejects(
      () => atomicWrite(vault, 'occ-note.md', '# Second\n', 'not-the-disk-fingerprint'),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.match(e.message ?? '', /OCC conflict/);
        assert.strictEqual(e.code, 'ECONFLICT');
        return true;
      }
    );

    assert.strictEqual(fs.readFileSync(inVault, 'utf8'), '# First\n', 'a conflicting write must leave the note alone');
    assert.deepStrictEqual(cwdEntries(), [], 'nothing may be created in the process working directory');
  });
});
