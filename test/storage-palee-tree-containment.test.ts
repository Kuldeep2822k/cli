/**
 * Containment of the `.palee` tree, not only of the note written into it (#264)
 *
 * `assertContainedInVault` guards `atomicWrite`, but the session path reaches the
 * disk before it ever gets there. `getPaleeDir` and `getSessionsDir`
 * (`src/storage/memory.ts`) gate on `fs.existsSync` — which follows links — and
 * then call `fs.mkdirSync(…, { recursive: true })`. With `vault\.palee` planted as
 * a junction to a directory outside the vault, `existsSync('.palee')` is true so
 * there is nothing to create *there*, and `getSessionsDir` then walked straight
 * through the junction and created `<outside>\sessions`: a real directory outside
 * the vault, made before `atomicWrite` refused the note. `palee session end` exits
 * 3 and files no note, yet the planted link still gained a directory.
 *
 * So the same guard runs on the `.palee` tree before it is created or used:
 * `getPaleeDir` asserts `.palee`, `getSessionsDir` asserts `.palee/sessions`
 * (whose canonicalisation resolves *through* `.palee`, so a planted intermediate
 * component is covered by either call), and `getLockDir` already asserts
 * `.palee/locks`. One predicate — `isWithinVault` — and one refusal surface:
 * `ECONTAINMENT`, the same message prefix and therefore the same exit 3 as the
 * write refusal. The failure is the same in kind, not a different one: a planted
 * link that would put a directory outside the vault is the identical vault
 * integrity defect as one that would put a note there, nothing about it is
 * retryable, and a second error surface would only invite callers to handle the
 * tree case and forget the note case.
 *
 * Fixtures use `'junction'` on win32 and `'dir'` elsewhere — the prior art in
 * `test/storage-relative-path.test.ts` — so the escape runs on Windows, Linux and
 * macOS. The counter-cases are what keeps the guard from being too strict: a
 * sessions link that stays inside the vault, a fresh vault with no `.palee` yet,
 * and the ordinary session write.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  writeSessionNote,
  updateHotMemory,
  regenerateIndex,
  writeDraftCheckpoint,
  deleteSessionNote,
} from '../src/storage/memory';
import { isConflictError } from '../src/storage/atomic-write';
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

describe('the .palee tree is contained before it is created or used', () => {
  let baseDir: string;
  /** Vaults whose `.palee` is a link to `<outside>/<name>`; links tracked for cleanup. */
  const planted: Array<{ vault: string; outside: string; link: string }> = [];

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-tree-containment-'));
  });

  after(() => {
    for (const { link } of planted) {
      removeLink(link);
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /**
   * Builds `<base>/<name>/vault` whose `.palee` is a junction onto the existing
   * `<base>/<name>/outside-palee` — the issue's planted link, one level up from
   * the sessions dir, so every `.palee` child is reached through it.
   */
  function junctionedPaleeVault(name: string): { vault: string; outside: string; palee: string } {
    const root = path.join(baseDir, name);
    const vault = path.join(root, 'vault');
    const outside = path.join(root, 'outside-palee');
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const palee = path.join(vault, '.palee');
    fs.symlinkSync(outside, palee, LINK_TYPE);
    planted.push({ vault, outside, link: palee });
    return { vault, outside, palee };
  }

  /**
   * Asserts a rejection is the containment refusal and not a crash or a conflict:
   * same code, same message family and the same classifier the write path uses, so
   * `exitCodeFor` maps it to exit 3 rather than 5 or 4.
   */
  function assertContainmentRefusal(err: unknown, namedPath: string): true {
    const e = err as { message?: string; code?: string };
    const message = e.message ?? '';
    assert.match(message, /Security error: refusing to write outside the vault/, 'the refusal must name the reason');
    assert.ok(message.includes(namedPath), `the refusal must name the path it refused: ${message}`);
    assert.strictEqual(e.code, 'ECONTAINMENT', 'the tree refusal carries the same code as the write refusal');
    assert.strictEqual(isConflictError(e), false, 'the refusal must not read as an OCC/lock conflict');
    assert.strictEqual(isContainmentError(e), true, 'the classifier must recognise it so the CLI exits 3, not 5');
    return true;
  }

  /** Asserts the planted link survived and its outside directory is still empty. */
  function assertNothingOutside(outside: string, link: string): void {
    assert.deepStrictEqual(
      fs.readdirSync(outside),
      [],
      'the refusal must create no directory outside the vault — not even `.palee/sessions`'
    );
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link must survive untouched');
  }

  test('a junctioned .palee gains no sessions directory before the note is refused', async () => {
    const { vault, outside, palee } = junctionedPaleeVault('junction-session-note');

    await assert.rejects(
      () => writeSessionNote(vault, sessionRecord('S-20261004T000000-aaaa'), 'Body'),
      (err: unknown) => assertContainmentRefusal(err, path.join(palee, 'sessions'))
    );

    assertNothingOutside(outside, palee);
  });

  test('the index rebuild refuses the junctioned tree instead of materialising it', async () => {
    const { vault, outside, palee } = junctionedPaleeVault('junction-index');

    await assert.rejects(
      () => regenerateIndex(vault),
      (err: unknown) => assertContainmentRefusal(err, palee)
    );

    assertNothingOutside(outside, palee);
  });

  test('a draft checkpoint refuses the junctioned tree instead of materialising it', async () => {
    const { vault, outside, palee } = junctionedPaleeVault('junction-draft');

    await assert.rejects(
      () => writeDraftCheckpoint(vault, 'DRAFT-S-aaaaaaaa', { topic_id: 'T-264', started_at: '2026-10-04T10:00:00.000Z' }, 'Draft body'),
      (err: unknown) => assertContainmentRefusal(err, path.join(palee, 'sessions'))
    );

    assertNothingOutside(outside, palee);
  });

  test('hot memory refuses the junctioned tree at .palee itself', async () => {
    const { vault, outside, palee } = junctionedPaleeVault('junction-hot');

    await assert.rejects(
      () => updateHotMemory(vault, null, 'T-264', 'Active topic'),
      (err: unknown) => assertContainmentRefusal(err, palee)
    );

    assertNothingOutside(outside, palee);
  });

  test('deleting a session note refuses the junctioned tree instead of creating it', () => {
    // `deleteSessionNote` resolves the sessions dir to compare against, so this
    // site never wrote a note anywhere — but it created `<outside>\sessions` on
    // the way to the comparison, and then reported success on a file it had not
    // deleted. Fail closed before the `mkdirSync`.
    const { vault, outside, palee } = junctionedPaleeVault('junction-delete');

    assert.throws(
      () => deleteSessionNote(vault, path.join(palee, 'sessions', 'S-20261004T000000-aaaa.md')),
      (err: unknown) => assertContainmentRefusal(err, path.join(palee, 'sessions'))
    );

    assertNothingOutside(outside, palee);
  });

  test('a sessions link that stays inside the vault still records the session', async () => {
    // The guard refuses *escapes*, not links: a `.palee/sessions` that resolves
    // to another directory in the same vault is a legitimate layout.
    const root = path.join(baseDir, 'inside-link');
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '.palee'), { recursive: true });
    const realSessions = path.join(root, 'vault', 'elsewhere', 'sessions');
    fs.mkdirSync(realSessions, { recursive: true });
    const link = path.join(vault, '.palee', 'sessions');
    fs.symlinkSync(realSessions, link, LINK_TYPE);

    const written = await writeSessionNote(vault, sessionRecord('S-20261004T000000-bbbb'), 'Body');
    assert.ok(fs.existsSync(path.join(realSessions, 'S-20261004T000000-bbbb.md')), 'the note belongs in the linked in-vault dir');
    assert.match(fs.readFileSync(written, 'utf8'), /session_id: S-20261004T000000-bbbb/);

    removeLink(link);
  });

  test('a vault with no .palee yet still gets one, inside the vault', async () => {
    // The assertion runs *before* the `mkdirSync`, so it must accept the tree that
    // does not exist yet — the canonicalisation resolves the nearest existing
    // ancestor and re-attaches the missing tail.
    const root = path.join(baseDir, 'fresh-vault');
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });

    const written = await writeSessionNote(vault, sessionRecord('S-20261004T000000-cccc'), 'Body');
    assert.strictEqual(
      written,
      path.join(vault, '.palee', 'sessions', 'S-20261004T000000-cccc.md'),
      'a fresh vault still gets its sessions tree created inside itself'
    );
    assert.ok(fs.existsSync(written));

    const hotPath = await updateHotMemory(vault, 'S-20261004T000000-cccc', 'T-264', 'Active topic');
    assert.ok(fs.existsSync(hotPath), 'hot.md is still created under the real .palee');
  });
});
