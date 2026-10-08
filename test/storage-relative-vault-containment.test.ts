/**
 * A relative `vaultPath` must not give the `.palee` tree two readings (#264 review)
 *
 * `getPaleeDir`, `getSessionsDir` (`src/storage/memory.ts`) and `getLockDir`
 * (`src/storage/lock.ts`) built their paths with `path.join(vaultPath, …)`. When
 * `vaultPath` itself is relative those strings stay relative, and
 * `assertContainedInVault` resolves a *relative* destination against the vault root
 * — so the guard certified `<cwd>/vault/vault/.palee` while `mkdirSync` created
 * `<cwd>/vault/.palee`. The path that was checked and the path that was made were
 * two different paths, which is the same disagreement #264 closed for note writes.
 *
 * Two consequences, both reproducible here before any fix:
 * - an ordinary session write lands one directory deeper than the vault it was
 *   told about, creating a stray `vault/vault/.palee` tree;
 * - with `.palee` planted as a junction, the check inspects a path that does not
 *   exist, passes, and `mkdirSync` then makes a real directory *outside* the
 *   vault — the escape the tree assertion exists to refuse.
 *
 * The CLI never produces a relative vault path (`validateVaultPath` returns
 * `path.resolve(…)`), so this is the package's library surface. A write primitive
 * should still not depend on which of its callers bothered to absolutise.
 *
 * Fixtures chdir into a directory that is not the vault, the way
 * `test/storage-atomic-write-resolved-destination.test.ts` does, and reuse the
 * `'junction'`-on-win32 / `'dir'`-elsewhere link type so the escape runs on every
 * platform.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeSessionNote } from '../src/storage/memory';
import { atomicWrite } from '../src/storage/atomic-write';
import { isContainmentError } from '../src/storage/containment';

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

/** The session record shape `writeSessionNote` takes, without the noise. */
function sessionRecord(sessionId: string) {
  return {
    session_id: sessionId,
    topic_id: 'T-264',
    started_at: '2026-10-04T10:00:00.000Z',
    ended_at: '2026-10-04T10:30:00.000Z',
  };
}

describe('a relative vault path keeps one reading of the .palee tree', () => {
  let savedCwd: string;
  let baseDir: string;
  /** The process working directory for every test below — never a vault. */
  let cwdDir: string;
  let sessionSeq = 0;

  /**
   * Builds `<cwdDir>/<name>/vault` and returns the vault path *as configured* —
   * relative to the cwd, which is what a caller with a relative `vault_path` in
   * its config hands down.
   */
  function relativeVault(name: string): { relative: string; absolute: string } {
    const absolute = path.join(cwdDir, name, 'vault');
    fs.mkdirSync(absolute, { recursive: true });
    return { relative: path.join(name, 'vault'), absolute };
  }

  before(() => {
    savedCwd = process.cwd();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-relative-vault-'));
    cwdDir = path.join(baseDir, 'cwd');
    fs.mkdirSync(cwdDir, { recursive: true });
    process.chdir(cwdDir);
  });

  after(() => {
    process.chdir(savedCwd);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /** Next session id in this file; ids must be unique per write. */
  function nextId(): string {
    sessionSeq += 1;
    return `S-20261004T000000-000${sessionSeq}`;
  }

  beforeEach(() => {
    for (const entry of fs.readdirSync(cwdDir)) {
      if (entry === '.' || entry === '..') continue;
      fs.rmSync(path.join(cwdDir, entry), { recursive: true, force: true });
    }
  });

  test('a relative vault path writes its session note into that vault', async () => {
    const { relative, absolute } = relativeVault('plain');
    const id = nextId();

    const written = await writeSessionNote(relative, sessionRecord(id), 'Body');

    const expected = path.join(absolute, '.palee', 'sessions', `${id}.md`);
    assert.strictEqual(
      path.resolve(written),
      expected,
      'the returned path must name the note inside the vault the caller pointed at'
    );
    assert.ok(fs.existsSync(expected), 'the session note belongs inside the vault');
    assert.strictEqual(
      fs.existsSync(path.join(absolute, 'vault')),
      false,
      'a relative vault path must not be re-resolved against itself'
    );
  });

  test('a relative vault path refuses a planted .palee junction rather than creating outside', async () => {
    const { relative, absolute } = relativeVault('planted');
    const outside = path.join(cwdDir, 'planted', 'outside-palee');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(absolute, '.palee'), LINK_TYPE);

    await assert.rejects(
      () => writeSessionNote(relative, sessionRecord(nextId()), 'Body'),
      (err: unknown) => {
        assert.strictEqual(isContainmentError(err), true, 'a directory outside the vault is a security refusal');
        return true;
      }
    );

    assert.deepStrictEqual(
      fs.readdirSync(outside),
      [],
      'the guard certified a different path than mkdirSync created, so a real directory landed outside the vault'
    );
    removeLink(path.join(absolute, '.palee'));
  });

  test('a relative vault path refuses a planted .palee junction on the lock tree too', async () => {
    // `getLockDir` builds `.palee/locks` off the vault root, so it shares the
    // double-resolution: the refusal has to cover the lock directory as well as
    // the sessions one, or a note write still files `.lockdir` through the link.
    const { relative, absolute } = relativeVault('planted-lock');
    const outside = path.join(cwdDir, 'planted-lock', 'outside-palee');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(absolute, '.palee'), LINK_TYPE);

    await assert.rejects(
      () => atomicWrite(relative, path.join(absolute, 'note.md'), '# Note\n'),
      (err: unknown) => {
        assert.strictEqual(isContainmentError(err), true, 'the lock tree gets the same refusal surface');
        return true;
      }
    );

    assert.deepStrictEqual(
      fs.readdirSync(outside),
      [],
      'no `.lockdir` may be created outside the vault'
    );
    removeLink(path.join(absolute, '.palee'));
  });
});
