import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';
import { deleteSessionNote, deleteTopicDrafts, Lock } from '../src/storage';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * #565 (P3-02) — draft cleanup is session-scoped and lock-aware.
 *
 * `session end` used to call `deleteTopicDrafts(vaultPath, topicId)`, which
 * re-scanned `.palee/sessions/` at delete time and unlinked every same-topic
 * draft without taking the target's lock. Two consequences: a draft created
 * after the session's Tier-1 scan — a concurrent `session draft` on the same
 * topic — was destroyed although the ending session never recorded it, and the
 * unlink raced a concurrent `atomicWrite` on the same draft mid-rename.
 *
 * The fix passes the ending session's recorded draft list to `deleteTopicDrafts`
 * (only consumed checkpoints are deleted) and takes each target's lock before
 * the unlink, yielding like `clearActiveSession` when a live writer holds it.
 *
 * The deciding predicates are pinned at two levels: `deleteTopicDrafts` must
 * delete only the caller-supplied consumed list (removing the scoping param or
 * ignoring it deletes the untouched same-topic draft below), and `session end`
 * must leave a draft that appeared after its scan — and a draft whose target
 * lock is held — in place.
 */
describe('Draft cleanup session scoping and lock awareness (#565 P3-02)', () => {
  let tempDir: string;
  let vaultDir: string;
  let prevConfigDir: string | undefined;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-draft-scoped-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;
    saveConfig({ vaultPath: vaultDir });

    // `session` resolves an explicit `--topic` against the vault, so every id the
    // actions below pass has to be a real adopted note.
    for (const id of ['T-scoped', 'T-race', 'T-locky']) {
      seedTopic(id);
    }
  });

  after(() => {
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.exitCode = undefined;
    const paleeDir = path.join(vaultDir, '.palee');
    if (fs.existsSync(paleeDir)) {
      fs.rmSync(paleeDir, { recursive: true, force: true });
    }
    fs.mkdirSync(paleeDir, { recursive: true });
  });

  /** Writes one minimal adopted topic note into the fixture vault. */
  function seedTopic(id: string): void {
    fs.writeFileSync(
      path.join(vaultDir, `${id}.md`),
      [
        '---',
        'palee_schema: 1',
        `palee_id: ${id}`,
        `title: ${id}`,
        'depends_on: []',
        'topic_mastery: 0',
        '---',
        '',
        `# ${id}`,
        '',
      ].join('\n'),
      'utf8'
    );
  }

  /** Absolute path of a draft checkpoint file with the supplied id. */
  function draftPath(draftId: string): string {
    return path.join(vaultDir, '.palee', 'sessions', `${draftId}.md`);
  }

  /** Writes one draft checkpoint file, returning its absolute path. */
  function writeDraft(draftId: string, topicId: string, startedAt: string): string {
    const target = draftPath(draftId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `---\npalee_schema: 1\nsession_id: ${draftId}\ntopic_id: ${topicId}\nstarted_at: "${startedAt}"\nended_at: null\nstatus: draft\n---\n# Draft Session: ${draftId}\n\nDraft body\n`,
      'utf8'
    );
    return target;
  }

  function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60 * 1000).toISOString();
  }

  /** Confirmed session notes currently in `.palee/sessions/` (drafts excluded). */
  function completedSessionPaths(): string[] {
    const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];
    return fs
      .readdirSync(sessionsDir)
      .sort()
      .filter((f) => f.startsWith('S-') && !f.startsWith('DRAFT-S-') && f.endsWith('.md'))
      .map((f) => path.join(sessionsDir, f));
  }

  test('deleteTopicDrafts deletes only the drafts the caller marks consumed', () => {
    const consumed = writeDraft('DRAFT-S-aaaa0001', 'T-scoped', minutesAgo(30));
    const untouchedSameTopic = writeDraft('DRAFT-S-bbbb0002', 'T-scoped', minutesAgo(20));
    const otherTopic = writeDraft('DRAFT-S-cccc0003', 'T-scoped-not', minutesAgo(30));

    const result = deleteTopicDrafts(vaultDir, 'T-scoped', [consumed]);

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.deleted, [consumed]);
    assert.strictEqual(fs.existsSync(consumed), false);
    // The deciding assertions: a same-topic draft outside the consumed list, and a
    // draft of another topic, both survive. Reverting `deleteTopicDrafts` to the
    // historical re-scan (ignoring the list, deleting every same-topic draft)
    // deletes `untouchedSameTopic` and fails here.
    assert.strictEqual(fs.existsSync(untouchedSameTopic), true, 'a same-topic draft outside the consumed list must survive');
    assert.strictEqual(fs.existsSync(otherTopic), true, 'a different-topic draft must survive');
  });

  test('deleteSessionNote yields a draft whose target lock a live process holds', async () => {
    const draft = writeDraft('DRAFT-S-dddd0004', 'T-scoped', minutesAgo(10));
    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      const deleted = deleteSessionNote(vaultDir, draft);
      // The deciding assertions: while a live lock is held the unlink is skipped
      // and reported as not-deleted. Removing the lock from `deleteSessionNote`
      // lets the unlink through and fails here.
      assert.strictEqual(deleted, false, 'a locked target must be reported as not-deleted');
      assert.strictEqual(fs.existsSync(draft), true, 'a locked draft must survive the unlink');
    } finally {
      lock.release();
    }
    // Once released, the same unlink succeeds.
    assert.strictEqual(deleteSessionNote(vaultDir, draft), true);
    assert.strictEqual(fs.existsSync(draft), false);
  });

  test('session end deletes exactly the drafts its note records; a draft created after the scan survives', async () => {
    const consumedEarly = writeDraft('DRAFT-S-11110005', 'T-race', minutesAgo(10));
    const consumedLate = writeDraft('DRAFT-S-22220006', 'T-race', minutesAgo(5));

    // Inject a same-topic draft at the moment the session note is renamed into
    // place: after the end handler's Tier-1 scan (which therefore never recorded
    // it) and before cleanup runs. `fs` is the fault-injection surface the suite
    // already uses; the injection must ride the first confirmed-session rename,
    // which in this flow is `writeSessionNote`'s `atomicWrite`.
    const injectedId = 'DRAFT-S-33330007';
    const injectedPath = draftPath(injectedId);
    const realRenameSync = fs.renameSync;
    const realWriteFileSync = fs.writeFileSync;
    let injected = false;
    (fs as unknown as { renameSync: (src: string, dest: string) => void }).renameSync = (src: string, dest: string) => {
      realRenameSync(src, dest);
      const base = path.basename(dest);
      if (!injected && base.startsWith('S-') && base.endsWith('.md') && dest.includes(path.join('.palee', 'sessions'))) {
        injected = true;
        realWriteFileSync(
          injectedPath,
          `---\npalee_schema: 1\nsession_id: ${injectedId}\ntopic_id: T-race\nstarted_at: "${minutesAgo(1)}"\nended_at: null\nstatus: draft\n---\n# Draft Session: ${injectedId}\n\nConcurrent draft body\n`,
          'utf8'
        );
      }
    };

    try {
      await sessionCommand('end', { topic: 'T-race' });
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.strictEqual(injected, true, 'the injection must have fired on the session-note rename');
    assert.deepStrictEqual(completedSessionPaths().length, 1, 'the end writes one confirmed session');

    const notePath = completedSessionPaths()[0];
    assert.ok(notePath !== undefined);
    const noteBody = parseFrontmatter(fs.readFileSync(notePath, 'utf8')).body;
    assert.ok(noteBody.includes(`Draft checkpoint: ${path.basename(consumedEarly)}`), 'the note records the scanned draft');
    assert.ok(noteBody.includes(`Draft checkpoint: ${path.basename(consumedLate)}`), 'the note records the scanned draft');
    assert.ok(!noteBody.includes(`Draft checkpoint: ${injectedId}.md`), 'the note never records the post-scan draft');

    // The deciding assertion: cleanup deletes the two drafts the session consumed,
    // and leaves the post-scan draft — which a concurrent `session draft` holds —
    // for the session that owns it. Reverting session.ts to the historical
    // `deleteTopicDrafts(vaultPath, topicId)` re-scan deletes it and fails here.
    assert.strictEqual(fs.existsSync(consumedEarly), false);
    assert.strictEqual(fs.existsSync(consumedLate), false);
    assert.strictEqual(fs.existsSync(injectedPath), true, 'a draft created after the session scan must survive cleanup');
  });

  test('session end leaves a scanned draft in place while its target lock is held', async () => {
    const unlocked = writeDraft('DRAFT-S-eeee0008', 'T-locky', minutesAgo(10));
    const locked = writeDraft('DRAFT-S-ffff0009', 'T-locky', minutesAgo(5));

    const lock = new Lock(vaultDir, locked);
    try {
      await lock.acquire();
      await sessionCommand('end', { topic: 'T-locky' });

      assert.strictEqual(fs.existsSync(unlocked), false, 'the unlocked draft is consumed as recorded');
      // The deciding assertion: the locked draft is yielded, not deleted. Removing
      // the target lock from `deleteSessionNote` unlinks it and fails here.
      assert.strictEqual(fs.existsSync(locked), true, 'a draft whose target lock is held must survive cleanup');
      // The yield is not a cleanup failure: the session still ends cleanly.
      assert.strictEqual(process.exitCode, undefined);
    } finally {
      lock.release();
    }

    // The session note was written before cleanup, so both scanned drafts stay
    // recorded as consumed markers there — the yield retires the file only.
    const notePath = completedSessionPaths()[0];
    assert.ok(notePath !== undefined);
    const noteBody = parseFrontmatter(fs.readFileSync(notePath, 'utf8')).body;
    assert.ok(noteBody.includes(`Draft checkpoint: ${path.basename(unlocked)}`));
    assert.ok(noteBody.includes(`Draft checkpoint: ${path.basename(locked)}`));
  });
});
