/**
 * The containment check is re-asserted when the filesystem is actually touched (#264 review)
 *
 * `atomicWrite` certified the destination once, as its first statement, and then
 * `await`ed `lock.acquire()` before writing. Between those two points the vault is
 * not frozen: an actor who replaces a component of the certified path with a link
 * to somewhere outside moves the *bytes* the guard never looked at, while every
 * string the write uses still reads as inside the vault. The window is the await
 * itself — with a contended lock it is a retry loop with sleeps, not a microtask.
 *
 * This is a narrower claim than the one #264 closed. There the destination
 * *already* resolved outside the vault and a single canonicalising check refuted
 * it; here the destination is genuinely inside when certified, and only becomes
 * outside afterwards. So the guard runs again immediately before the temp file is
 * opened and the destination renamed: what is certified is the location the write
 * is about to use, not the one that was true when the call started.
 *
 * The window is opened deterministically rather than raced: `atomicWrite` is an
 * `async function`, so everything after its first `await lock.acquire()` runs as a
 * continuation of the call, not during it. The test calls it, then swaps the real
 * in-vault directory under the destination for a junction to outside **in the same
 * synchronous block** — no continuation of the write can have run yet, so the
 * write is guaranteed to see the swapped ancestry and the assertion cannot be a
 * flake on scheduling.
 *
 * What remains, stated plainly: between the re-assertion and `openSync` there is
 * still a syscall-length gap, and closing it needs `openat`-style relative,
 * no-follow opens of each ancestor, which Node does not expose. Shrinking a window
 * that spans a retry loop to one that spans a single syscall is the whole of what
 * this layer can do without a native helper.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

describe('a destination re-linked while the write waits is refused before the bytes move', () => {
  let baseDir: string;
  let vault: string;
  let outside: string;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-containment-window-'));
    vault = path.join(baseDir, 'vault');
    outside = path.join(baseDir, 'outside');
    fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
    fs.mkdirSync(outside);
  });

  after(() => {
    removeLink(path.join(vault, 'notes'));
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('an ancestor swapped for a link during the write cannot carry the bytes out', async () => {
    const notes = path.join(vault, 'notes');
    const stored = path.join(baseDir, 'notes-aside');
    const target = path.join(notes, 'note.md');

    // Certified while `notes` is still the real in-vault directory.
    const write = atomicWrite(vault, target, '# Written after the swap\n');

    // Same synchronous block, so this runs before any continuation of `write`:
    // the destination's ancestry now resolves outside the vault.
    fs.renameSync(notes, stored);
    fs.symlinkSync(outside, notes, LINK_TYPE);

    await assert.rejects(
      () => write,
      (err: unknown) => {
        assert.strictEqual(
          isContainmentError(err),
          true,
          'a destination whose ancestry moved outside the vault is a security refusal, not a conflict'
        );
        return true;
      }
    );

    assert.deepStrictEqual(
      fs.readdirSync(outside),
      [],
      'the bytes must not reach the directory the ancestor now points at'
    );
    assert.strictEqual(
      fs.existsSync(path.join(stored, 'note.md')),
      false,
      'the real in-vault directory must not gain the note either'
    );

    // Restore, so the vault is left as the next test would expect it.
    removeLink(notes);
    fs.renameSync(stored, notes);
  });
});
