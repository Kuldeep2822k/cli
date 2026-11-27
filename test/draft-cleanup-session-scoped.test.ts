import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';
import { deleteSessionNote, deleteTopicDrafts, getConsumedDraftPaths, getTopicDrafts, recoverDraft, writeDraftCheckpoint, Lock } from '../src/storage';
import { parseFrontmatter, computeFingerprint } from '../src/storage/frontmatter';

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

  test('deleteTopicDrafts counts an already-gone listed draft as deleted, not an error', () => {
    const survivor = writeDraft('DRAFT-S-jjjj0014', 'T-scoped', minutesAgo(10));
    const gone = draftPath('DRAFT-S-kkkk0015');
    assert.strictEqual(fs.existsSync(gone), false, 'the listed draft is absent before cleanup');

    const result = deleteTopicDrafts(vaultDir, 'T-scoped', [survivor, gone]);

    // The deciding assertion: a draft someone else already removed is the goal
    // state, not a cleanup failure. Reverting the read-side ENOENT branch files
    // it under `errors` and fails here.
    assert.deepStrictEqual(result.errors, [], 'a vanished draft is not a cleanup failure');
    assert.deepStrictEqual(result.deleted, [survivor, gone].sort(), 'both listed drafts are accounted for as deleted');
    assert.strictEqual(fs.existsSync(survivor), false, 'the draft still present is deleted');
    assert.strictEqual(fs.existsSync(gone), false);
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

  test('recoverDraft reports a discard skipped by the target lock', async () => {
    const draft = writeDraft('DRAFT-S-gggg0011', 'T-scoped', minutesAgo(10));

    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      // The deciding assertion: the discard could not take the target's lock,
      // so the choice is reported as not applied. The pre-fix `recoverDraft`
      // resolved void here, and the interactive flow would start a session on
      // top of a draft the user asked to discard.
      assert.strictEqual(await recoverDraft(vaultDir, draft, 'discard'), false);
      assert.strictEqual(fs.existsSync(draft), true, 'a locked draft must survive a skipped discard');
    } finally {
      lock.release();
    }
    // Once the holder is done, the same discard applies.
    assert.strictEqual(await recoverDraft(vaultDir, draft, 'discard'), true);
    assert.strictEqual(fs.existsSync(draft), false);
  });

  test('recoverDraft reports deliberate keeps and a save skipped by the lock', async () => {
    const kept = writeDraft('DRAFT-S-hhhh0012', 'T-scoped', minutesAgo(10));
    assert.strictEqual(await recoverDraft(vaultDir, kept, 'ignore'), true);
    assert.strictEqual(await recoverDraft(vaultDir, kept, 'resume'), true);
    assert.strictEqual(fs.existsSync(kept), true, 'ignore and resume keep the draft by choice');

    const saved = writeDraft('DRAFT-S-iiii0013', 'T-scoped', minutesAgo(10));
    const lock = new Lock(vaultDir, saved);
    try {
      await lock.acquire();
      // The save itself lands (the session note is written before the draft is
      // retired), but the retiring unlink is skipped while the lock is held.
      assert.strictEqual(await recoverDraft(vaultDir, saved, 'save'), false);
      assert.strictEqual(fs.existsSync(saved), true, 'a locked draft must survive a skipped retirement');
    } finally {
      lock.release();
    }
    // The retry is recognized as already saved (#328) and retires the draft.
    assert.strictEqual(await recoverDraft(vaultDir, saved, 'save'), true);
    assert.strictEqual(fs.existsSync(saved), false);
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

  test('cleanup preserves a same-path checkpoint refreshed after the scan', async () => {
    const unchanged = writeDraft('DRAFT-S-abcd0016', 'T-scoped', minutesAgo(10));
    const refreshed = writeDraft('DRAFT-S-abcd0017', 'T-scoped', minutesAgo(5));
    const scanned = getTopicDrafts(vaultDir, 'T-scoped');
    const fingerprints = new Map(scanned.map((draft) => [draft.path, draft.fingerprint]));

    await writeDraftCheckpoint(vaultDir, 'DRAFT-S-abcd0017', {
      topic_id: 'T-scoped',
      started_at: minutesAgo(1),
    }, 'Notes written after the scan');
    const refreshedContent = fs.readFileSync(refreshed, 'utf8');
    const result = deleteTopicDrafts(vaultDir, 'T-scoped', scanned.map((draft) => draft.path), fingerprints);

    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.deleted, [unchanged]);
    assert.strictEqual(fs.existsSync(unchanged), false);
    assert.strictEqual(fs.readFileSync(refreshed, 'utf8'), refreshedContent);
    assert.strictEqual(deleteSessionNote(vaultDir, unchanged, fingerprints.get(unchanged)), true);
  });

  test('cleanup checks the fingerprint after acquiring the target lock', () => {
    const draft = writeDraft('DRAFT-S-abcd0018', 'T-scoped', minutesAgo(10));
    const content = fs.readFileSync(draft, 'utf8');
    const fingerprint = computeFingerprint(content);
    const refreshedContent = content
      .replace('topic_id: T-scoped', 'topic_id: T-race')
      .replace('Draft body', 'Refreshed before lock acquisition');
    const acquireSync = Lock.prototype.acquireSync;
    let refreshed = false;
    Lock.prototype.acquireSync = function () {
      fs.writeFileSync(draft, refreshedContent);
      refreshed = true;
      acquireSync.call(this);
    };

    try {
      const result = deleteTopicDrafts(vaultDir, 'T-scoped', [draft], new Map([[draft, fingerprint]]));
      assert.deepStrictEqual(result, { deleted: [], errors: [] });
    } finally {
      Lock.prototype.acquireSync = acquireSync;
    }
    assert.strictEqual(refreshed, true);
    assert.strictEqual(fs.readFileSync(draft, 'utf8'), refreshedContent);
    const lock = new Lock(vaultDir, draft);
    lock.acquireSync();
    lock.release();
  });

  test('a supplied fingerprint map never authorizes a path without a snapshot', () => {
    const draft = writeDraft('DRAFT-S-abcd0019', 'T-scoped', minutesAgo(10));
    const content = fs.readFileSync(draft, 'utf8');
    const result = deleteTopicDrafts(vaultDir, 'T-scoped', [draft], new Map());

    assert.deepStrictEqual(result, { deleted: [], errors: [] });
    assert.strictEqual(fs.readFileSync(draft, 'utf8'), content);
  });

  for (const refreshedTopicId of ['T-race', 'T-scoped']) {
    test(`session end preserves a scanned checkpoint refreshed onto ${refreshedTopicId}`, async () => {
      const draft = writeDraft('DRAFT-S-abcd0020', 'T-race', minutesAgo(10));
      const content = fs.readFileSync(draft, 'utf8');
      const refreshedContent = content
        .replace('topic_id: T-race', `topic_id: ${refreshedTopicId}`)
        .replace('Draft body', 'New checkpoint notes');
      const renameSync = fs.renameSync;
      let refreshed = false;
      fs.renameSync = (src, dest) => {
        renameSync(src, dest);
        if (!refreshed && path.basename(String(dest)).startsWith('S-') && String(dest).endsWith('.md')) {
          refreshed = true;
          const lock = new Lock(vaultDir, draft);
          lock.acquireSync();
          try {
            fs.writeFileSync(draft, refreshedContent);
          } finally {
            lock.release();
          }
        }
      };

      try {
        await sessionCommand('end', { topic: 'T-race' });
      } finally {
        fs.renameSync = renameSync;
      }
      assert.strictEqual(refreshed, true);
      assert.strictEqual(fs.existsSync(draft), true, 'a refreshed checkpoint must survive cleanup');
      assert.strictEqual(fs.readFileSync(draft, 'utf8'), refreshedContent);
      assert.strictEqual(process.exitCode, undefined);
      const [sessionPath] = completedSessionPaths();
      assert.ok(sessionPath !== undefined);
      assert.ok(fs.readFileSync(sessionPath, 'utf8').includes(`Draft checkpoint: ${path.basename(draft)}`));
    });
  }

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

  test('recoverDraft save preserves a draft refreshed after the snapshot read', async () => {
    const draft = writeDraft('DRAFT-S-jjjj0014', 'T-scoped', minutesAgo(10));
    const originalContent = fs.readFileSync(draft, 'utf8');
    const refreshedContent = originalContent.replace('Draft body', 'Refreshed draft body');

    const renameSync = fs.renameSync;
    let refreshed = false;
    fs.renameSync = (src, dest) => {
      renameSync(src, dest);
      if (!refreshed && path.basename(String(dest)).startsWith('S-') && String(dest).endsWith('.md')) {
        refreshed = true;
        const lock = new Lock(vaultDir, draft);
        lock.acquireSync();
        try {
          fs.writeFileSync(draft, refreshedContent);
        } finally {
          lock.release();
        }
      }
    };

    try {
      let skipReason: string | undefined;
      assert.strictEqual(
        await recoverDraft(vaultDir, draft, 'save', (reason) => {
          skipReason = reason;
        }),
        false
      );
      assert.strictEqual(skipReason, 'fingerprint_mismatch');
    } finally {
      fs.renameSync = renameSync;
    }
    assert.strictEqual(refreshed, true);
    assert.strictEqual(fs.existsSync(draft), true, 'a refreshed draft must survive save retirement');
    assert.strictEqual(fs.readFileSync(draft, 'utf8'), refreshedContent);
    const [sessionPath] = completedSessionPaths();
    assert.ok(sessionPath !== undefined);
    assert.ok(fs.readFileSync(sessionPath, 'utf8').includes('Draft body'));
  });

  test('recoverDraft reports locked when a held target lock skips retirement', async () => {
    const draft = writeDraft('DRAFT-S-oooo0018', 'T-scoped', minutesAgo(10));
    const lock = new Lock(vaultDir, draft);
    let skipReason: string | undefined;
    try {
      await lock.acquire();
      assert.strictEqual(
        await recoverDraft(vaultDir, draft, 'save', (reason) => {
          skipReason = reason;
        }),
        false
      );
    } finally {
      lock.release();
    }
    assert.strictEqual(skipReason, 'locked');
  });

  test('session start --interactive reports fingerprint mismatch separately from lock contention', async () => {
    const draft = writeDraft('DRAFT-S-rrrr0021', 'T-scoped', minutesAgo(10));
    const originalContent = fs.readFileSync(draft, 'utf8');
    const refreshedContent = originalContent.replace('Draft body', 'Refreshed during interactive save');

    const realCreateInterface = readline.createInterface;
    const realRenameSync = fs.renameSync;
    const realConsoleError = console.error;
    const errors: string[] = [];

    const inputStream = new PassThrough();
    inputStream.write('s\n');

    readline.createInterface = (() => realCreateInterface({ input: inputStream, output: new PassThrough() })) as typeof readline.createInterface;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    let refreshed = false;
    fs.renameSync = (src, dest) => {
      realRenameSync(src, dest);
      if (!refreshed && path.basename(String(dest)).startsWith('S-') && String(dest).endsWith('.md')) {
        refreshed = true;
        fs.writeFileSync(draft, refreshedContent, 'utf8');
      }
    };

    try {
      await sessionCommand('start', { interactive: true, json: true, topic: 'T-scoped' });
    } finally {
      readline.createInterface = realCreateInterface;
      fs.renameSync = realRenameSync;
      console.error = realConsoleError;
      inputStream.end();
    }

    assert.strictEqual(process.exitCode, 2);
    const errText = errors.join('\n');
    assert.match(errText, /a draft changed during save and was kept on disk/);
    assert.doesNotMatch(errText, /a locked draft was left for its holder/);
    assert.strictEqual(fs.readFileSync(draft, 'utf8'), refreshedContent);
  });

  test('recoverDraft save retry writes updated notes when the draft changed after a lock-blocked save', async () => {
    const draft = writeDraft('DRAFT-S-kkkk0015', 'T-scoped', minutesAgo(10));
    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), false);
    } finally {
      lock.release();
    }
    assert.strictEqual(completedSessionPaths().length, 1);

    const updatedContent = fs.readFileSync(draft, 'utf8').replace('Draft body', 'Updated draft body after lock');
    fs.writeFileSync(draft, updatedContent, 'utf8');

    assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), true);
    assert.strictEqual(fs.existsSync(draft), false, 'the updated draft must be retired after saving');
    const sessions = completedSessionPaths();
    assert.strictEqual(sessions.length, 2, 'updated notes must be saved as a new session instead of matching the old snapshot');
    assert.ok(sessions.some((p) => fs.readFileSync(p, 'utf8').includes('Updated draft body after lock')));
  });

  test('recoverDraft save retry writes updated notes on a heading-only refresh', async () => {
    const draft = writeDraft('DRAFT-S-pppp0019', 'T-scoped', minutesAgo(10));
    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), false);
    } finally {
      lock.release();
    }
    assert.strictEqual(completedSessionPaths().length, 1);

    const refreshedWithHeading = fs
      .readFileSync(draft, 'utf8')
      .replace('# Draft Session: DRAFT-S-pppp0019', '# Session: Added user heading\n# Draft Session: DRAFT-S-pppp0019');
    fs.writeFileSync(draft, refreshedWithHeading, 'utf8');

    assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), true);
    assert.strictEqual(fs.existsSync(draft), false, 'the refreshed draft must be retired after saving');
    const sessions = completedSessionPaths();
    assert.strictEqual(sessions.length, 2, 'a heading-only refresh must not match the earlier snapshot');
    assert.ok(sessions.some((p) => fs.readFileSync(p, 'utf8').includes('# Session: Added user heading')));
  });

  test('recoverDraft save retry reuses the existing session when unchanged, even with a user-authored # Session: heading', async () => {
    const draft = writeDraft('DRAFT-S-qqqq0020', 'T-scoped', minutesAgo(10));
    const withUserHeading = fs
      .readFileSync(draft, 'utf8')
      .replace('# Draft Session: DRAFT-S-qqqq0020', '# Session: User heading\n# Draft Session: DRAFT-S-qqqq0020');
    fs.writeFileSync(draft, withUserHeading, 'utf8');

    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), false);
    } finally {
      lock.release();
    }
    const firstSessions = completedSessionPaths();
    assert.strictEqual(firstSessions.length, 1);

    assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), true);
    assert.strictEqual(fs.existsSync(draft), false);
    assert.deepStrictEqual(completedSessionPaths(), firstSessions, 'unchanged retry must remain idempotent');
  });

  test('recoverDraft save retry writes a new session on a metadata-only started_at refresh', async () => {
    const oldStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const newStartedAt = new Date(Date.now() - (10 * 60 - 20) * 1000).toISOString();
    const draft = await writeDraftCheckpoint(
      vaultDir,
      'DRAFT-S-ssss0022',
      { topic_id: 'T-scoped', started_at: oldStartedAt },
      'Metadata refresh body'
    );

    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), false);
    } finally {
      lock.release();
    }
    const firstSessions = completedSessionPaths();
    assert.strictEqual(firstSessions.length, 1);

    // Refresh only `started_at` within the ±60s tolerance window, keeping the body identical.
    await writeDraftCheckpoint(
      vaultDir,
      'DRAFT-S-ssss0022',
      { topic_id: 'T-scoped', started_at: newStartedAt },
      'Metadata refresh body'
    );

    assert.strictEqual(await recoverDraft(vaultDir, draft, 'save'), true);
    assert.strictEqual(fs.existsSync(draft), false, 'the refreshed draft must be retired after saving');
    const sessions = completedSessionPaths();
    assert.strictEqual(sessions.length, 2, 'a metadata-only started_at refresh must not reuse the earlier session');
    const newSessionPath = sessions.find((p) => !firstSessions.includes(p));
    assert.ok(newSessionPath !== undefined);
    const { frontmatter } = parseFrontmatter(fs.readFileSync(newSessionPath, 'utf8'));
    assert.strictEqual(frontmatter?.started_at, newStartedAt);
  });

  test('getConsumedDraftPaths matches versioned fingerprints and stays conservative on legacy markers', async () => {
    const draft = writeDraft('DRAFT-S-mmmm0016', 'T-scoped', minutesAgo(10));
    const lock = new Lock(vaultDir, draft);
    try {
      await lock.acquire();
      await sessionCommand('end', { topic: 'T-scoped' });
    } finally {
      lock.release();
    }

    const beforeRefresh = getTopicDrafts(vaultDir, 'T-scoped');
    assert.strictEqual(getConsumedDraftPaths(vaultDir, beforeRefresh).has(draft), true);

    const refreshedContent = fs.readFileSync(draft, 'utf8').replace('Draft body', 'Refreshed at same path');
    fs.writeFileSync(draft, refreshedContent, 'utf8');
    const afterRefresh = getTopicDrafts(vaultDir, 'T-scoped');
    assert.strictEqual(
      getConsumedDraftPaths(vaultDir, afterRefresh).has(draft),
      false,
      'a checkpoint refreshed at the same path must not be treated as already consumed'
    );

    const legacyDraft = writeDraft('DRAFT-S-nnnn0017', 'T-scoped', minutesAgo(8));
    const legacySession = path.join(vaultDir, '.palee', 'sessions', 'S-20260101T000000-00000001.md');
    fs.writeFileSync(
      legacySession,
      `---\npalee_schema: 1\nsession_id: S-20260101T000000-00000001\ntopic_id: T-scoped\nstarted_at: "${minutesAgo(8)}"\nended_at: "${minutesAgo(7)}"\nduration_minutes: 1\nstatus: completed\n---\n# Session: S-20260101T000000-00000001\n\nDraft checkpoint: ${path.basename(legacyDraft)}\n`,
      'utf8'
    );
    const legacyRecords = getTopicDrafts(vaultDir, 'T-scoped').filter((d) => d.path === legacyDraft);
    assert.strictEqual(
      getConsumedDraftPaths(vaultDir, legacyRecords).has(legacyDraft),
      true,
      'legacy path-only markers without a fingerprint remain conservatively consumed'
    );
  });
});
