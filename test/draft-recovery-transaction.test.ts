import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { recoverDraft, writeDraftCheckpoint } from '../src/storage/memory';

/**
 * #328 — draft recovery is not a single transaction.
 *
 * Saving a draft is three separately-locked operations: write the canonical session
 * note, retire the draft, rebuild the derived views (`hot.md` / `index.md`). Base
 * ran them as write -> delete -> rebuild, so a throw between them left the vault in
 * a state the next run could not reason about — either a session note plus an
 * undeleted draft (the next pass mints a second session for the same notes) or a
 * session that no derived view mentions while the draft that proves recovery is
 * pending is already gone.
 *
 * The two injected faults below are the suite's existing technique: `.palee/hot.md`
 * as a directory makes the rebuild's fingerprint read throw `EISDIR`, and a stubbed
 * `fs.unlinkSync` makes the retire step throw `EACCES`
 * (see test/storage-memory.test.ts, deleteTopicDrafts EACCES test).
 */
describe('Draft recovery transaction ordering (#328)', () => {
  function freshVault(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `palee-328-${tag}-`));
  }

  function sessionFiles(vaultPath: string): string[] {
    const sessionsDir = path.join(vaultPath, '.palee', 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];
    return fs
      .readdirSync(sessionsDir)
      .sort()
      .filter((f) => f.startsWith('S-') && !f.startsWith('DRAFT-S-') && f.endsWith('.md'));
  }

  function draftFiles(vaultPath: string): string[] {
    const sessionsDir = path.join(vaultPath, '.palee', 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];
    return fs.readdirSync(sessionsDir).sort().filter((f) => f.startsWith('DRAFT-S-') && f.endsWith('.md'));
  }

  test('a rebuild failure leaves the draft intact and the retry is re-runnable', async () => {
    const vaultPath = freshVault('rebuild-fault');
    try {
      const startedAt = new Date().toISOString();
      const draftPath = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-aaaa1111',
        { topic_id: 'T-crash', started_at: startedAt },
        'Crash-draft body for the ordering proof.'
      );

      // Fault: the rebuild cannot read/replace `.palee/hot.md`.
      const hotPath = path.join(vaultPath, '.palee', 'hot.md');
      fs.mkdirSync(hotPath, { recursive: true });

      await assert.rejects(() => recoverDraft(vaultPath, draftPath, 'save'), /EISDIR/);

      const sessions = sessionFiles(vaultPath);
      assert.strictEqual(sessions.length, 1, 'the canonical session note must survive the failed pass');
      assert.strictEqual(
        draftFiles(vaultPath).length,
        1,
        'the draft is the only record that recovery is pending, so a failed rebuild must not retire it'
      );
      assert.strictEqual(fs.existsSync(path.join(vaultPath, '.palee', 'index.md')), false);

      // Clear the fault and hand the same draft back to recovery.
      fs.rmdirSync(hotPath);
      await recoverDraft(vaultPath, draftPath, 'save');

      assert.deepStrictEqual(sessionFiles(vaultPath), sessions, 'retry must reuse the session the first pass wrote');
      assert.deepStrictEqual(draftFiles(vaultPath), [], 'retry must retire the draft once the views are rebuilt');
      assert.ok(fs.existsSync(path.join(vaultPath, '.palee', 'index.md')), 'derived index must exist after the retry');

      const indexRaw = fs.readFileSync(path.join(vaultPath, '.palee', 'index.md'), 'utf8');
      assert.ok(indexRaw.includes('Total Sessions: 1'), `index must count the one session:\n${indexRaw}`);

      const hotRaw = fs.readFileSync(hotPath, 'utf8');
      const hot = parseFrontmatter(hotRaw).frontmatter;
      assert.ok(hot);
      const [recoveredSession] = sessions;
      assert.ok(recoveredSession !== undefined);
      assert.strictEqual(hot.last_session, recoveredSession.replace(/\.md$/, ''), 'hot memory must name the recovered session');
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('a failed draft retire does not double-save on the next recovery pass', async () => {
    const vaultPath = freshVault('delete-fault');
    const originalUnlinkSync = fs.unlinkSync;
    try {
      const startedAt = new Date(Date.now() - 45 * 60000).toISOString();
      const draftPath = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-bbbb2222',
        { topic_id: 'T-double', started_at: startedAt },
        'Draft body that must never become two sessions.'
      );

      fs.unlinkSync = ((target: fs.PathLike | string) => {
        if (String(target).includes('DRAFT-S-bbbb2222')) {
          const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, unlink '${target}'`);
          err.code = 'EACCES';
          throw err;
        }
        return originalUnlinkSync(target);
      }) as typeof fs.unlinkSync;

      await assert.rejects(() => recoverDraft(vaultPath, draftPath, 'save'), /EACCES/);

      const firstPass = sessionFiles(vaultPath);
      assert.strictEqual(firstPass.length, 1);
      assert.strictEqual(draftFiles(vaultPath).length, 1, 'the undeleted draft is what makes the next pass idempotent');

      // Fault cleared: recovery is offered the very same draft again.
      fs.unlinkSync = originalUnlinkSync;
      await recoverDraft(vaultPath, draftPath, 'save');

      const secondPass = sessionFiles(vaultPath);
      assert.deepStrictEqual(
        secondPass,
        firstPass,
        `second recovery pass must not mint a duplicate session for the same draft (got ${secondPass.join(', ')})`
      );
      assert.deepStrictEqual(draftFiles(vaultPath), [], 'the duplicate-free pass must still retire the draft');

      const indexRaw = fs.readFileSync(path.join(vaultPath, '.palee', 'index.md'), 'utf8');
      assert.ok(indexRaw.includes('Total Sessions: 1'), `index must list exactly one session:\n${indexRaw}`);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('recovery keeps the "already saved" match narrow enough to save a later draft again', async () => {
    const vaultPath = freshVault('not-a-duplicate');
    try {
      // Two checkpoints of the same topic carry the same canned notes body and, by
      // the documented inheritance rule, the same `started_at`. Deduping on topic and
      // time alone would silently drop the second session, so the write ordering
      // (a session can only stand for a draft that predates it) is part of the match.
      const startedAt = new Date(Date.now() - 10 * 60000).toISOString();
      const firstDraft = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-cccc3333',
        { topic_id: 'T-same-topic', started_at: startedAt },
        'Draft learning notes for T-same-topic.'
      );
      await recoverDraft(vaultPath, firstDraft, 'save');
      const firstSession = sessionFiles(vaultPath);
      assert.strictEqual(firstSession.length, 1);

      const secondDraft = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-dddd4444',
        { topic_id: 'T-same-topic', started_at: startedAt },
        'Draft learning notes for T-same-topic.'
      );
      // Pin the ordering deterministically instead of trusting sub-millisecond clocks.
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(secondDraft, later, later);

      await recoverDraft(vaultPath, secondDraft, 'save');

      assert.strictEqual(sessionFiles(vaultPath).length, 2, 'a draft checkpointed after the session must be saved as its own session');
      assert.deepStrictEqual(draftFiles(vaultPath), []);
      const indexRaw = fs.readFileSync(path.join(vaultPath, '.palee', 'index.md'), 'utf8');
      assert.ok(indexRaw.includes('Total Sessions: 2'), `index must count both sessions:\n${indexRaw}`);
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('a note-less draft is not dropped by another note-less draft of the same topic (#329)', async () => {
    const vaultPath = freshVault('empty-notes-not-dropped');
    try {
      // Two drafts of one topic, both with EMPTY notes bodies. The weak
      // "already saved" match keys on the notes body, so an empty body used to
      // match any no-notes session of the topic — and with drafts scanned in
      // filename order (not creation order) the older draft could be read as
      // already saved by the newer draft's session and silently dropped.
      const startedAt = new Date(Date.now() - 10 * 60000).toISOString();
      const firstDraft = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-aaaa1111',
        { topic_id: 'T-no-notes', started_at: startedAt },
        ''
      );
      await recoverDraft(vaultPath, firstDraft, 'save');
      assert.strictEqual(sessionFiles(vaultPath).length, 1);

      const secondDraft = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-bbbb2222',
        { topic_id: 'T-no-notes', started_at: startedAt },
        ''
      );
      // Make the second draft OLDER than the first draft's session so the buggy
      // weak match (session mtime >= draft mtime) would have fired.
      const earlier = new Date(Date.now() - 30000);
      fs.utimesSync(secondDraft, earlier, earlier);

      await recoverDraft(vaultPath, secondDraft, 'save');

      assert.strictEqual(
        sessionFiles(vaultPath).length,
        2,
        'a note-less draft must still become its own session, not be absorbed by another draft'
      );
      assert.deepStrictEqual(draftFiles(vaultPath), []);
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('recovery still retires the draft when a stale one is re-run after the 24h clamp', async (t) => {
    const vaultPath = freshVault('stale-retry');
    try {
      // A draft older than 24h clamps its start to `now - 24h`, i.e. to a value that
      // moves with the clock, so a retry has to accept the earlier clamp.
      //
      // The draft is deliberately parked just SHORT of the 24h rule, so the clock
      // advance below — not the fixture — is what makes it stale. A draft that is
      // already days stale is clamped no matter what the clock says, and its start
      // then becomes the window's own lower anchor
      // (`min(draftStart, parsedStart, draftMtime) - 60s`), which spans days: every
      // tick value, 0 and 50 included, lands inside it and the advance proves nothing.
      const clampEpoch = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const STALE_MARGIN_MS = 800;
      const draftStartedAt = new Date(clampEpoch - DAY_MS + STALE_MARGIN_MS).toISOString();
      const staleDraft = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-eeee5555',
        { topic_id: 'T-stale-retry', started_at: draftStartedAt },
        'Stale draft that has to survive one clamped save.'
      );

      // Only `Date` is mocked, and only for the recovery passes: the clamp is the
      // clock this test moves, while filesystem mtimes and the unlink fault stay
      // real. `apis: ['Date']` mocks the constructor and `Date.now()` together —
      // mocking `Date.now` alone would leave `new Date().toISOString()` on the real
      // clock.
      t.mock.timers.enable({ apis: ['Date'], now: clampEpoch });
      // 1100ms > the 800ms the draft is short of the rule, so this is the advance
      // that pushes it over 24h and makes the first pass clamp at all.
      t.mock.timers.tick(1100);

      const originalUnlinkSync = fs.unlinkSync;
      try {
        fs.unlinkSync = ((target: fs.PathLike | string) => {
          if (String(target).includes('DRAFT-S-eeee5555')) {
            const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, unlink '${target}'`);
            err.code = 'EACCES';
            throw err;
          }
          return originalUnlinkSync(target);
        }) as typeof fs.unlinkSync;
        await assert.rejects(() => recoverDraft(vaultPath, staleDraft, 'save'), /EACCES/);
      } finally {
        fs.unlinkSync = originalUnlinkSync;
      }

      const firstSession = sessionFiles(vaultPath);
      assert.strictEqual(firstSession.length, 1);
      // The first pass clamped to `mockNow - 24h`; pin that it did, so the retry is
      // proven to accept a clamp that moved rather than an identical one.
      const [firstSessionFile] = firstSession;
      assert.ok(firstSessionFile !== undefined);
      const firstFrontmatter = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, '.palee', 'sessions', firstSessionFile), 'utf8')
      ).frontmatter;
      // Read off the same mocked clock the pass ran on: the recovery clamp is
      // `now - 24h`, and a `now` past the draft's staleness margin is only reachable
      // through the tick above.
      const expectedClamp = new Date(Date.now() - DAY_MS).toISOString();
      assert.strictEqual(
        firstFrontmatter?.started_at,
        expectedClamp,
        `the clock advance must make the draft stale enough for the recovery clamp: the first pass must save started_at = now - 24h (draft started_at ${draftStartedAt}, saved ${String(firstFrontmatter?.started_at)})`
      );

      // Advance the mocked clock past the first clamp without sleeping, so the retry
      // has to accept a clamp that moved rather than an identical one.
      t.mock.timers.tick(1100);
      await recoverDraft(vaultPath, staleDraft, 'save');

      assert.deepStrictEqual(sessionFiles(vaultPath), firstSession, 'a clamped retry must recognise the session the first clamp wrote');
      assert.deepStrictEqual(draftFiles(vaultPath), []);
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('recovery retires a long-stale draft (3 days old) after the 24h clamp', async (t) => {
    const vaultPath = freshVault('long-stale');
    try {
      // The original #328 fixture, kept as its own case: a draft checkpointed days
      // ago, stale by a margin no clock jitter can explain. Recovery clamps its start
      // to `now - 24h`, so the clamp moves with the clock — and a retry a day or more
      // later lands outside the ±60s skew band around the previous clamp. Only a
      // window that also reaches back to the draft's own start can recognise it.
      //
      // The advance is deliberately NOT what makes this draft stale — it is already
      // past the rule on its own. Proving that the clock crosses the 24h rule stays
      // the near-threshold case's job; what this case owns is the multi-day gap that
      // case traded away, which is what anchors `acceptedStartLow` on the draft start.
      const DAY_MS = 24 * 60 * 60 * 1000;
      const baseEpoch = Date.now();
      const draftStartedAt = new Date(baseEpoch - 3 * DAY_MS).toISOString();
      const staleDraft = await writeDraftCheckpoint(
        vaultPath,
        'DRAFT-S-ffff6666',
        { topic_id: 'T-long-stale', started_at: draftStartedAt },
        'Long-stale draft that has to survive one clamped save.'
      );

      t.mock.timers.enable({ apis: ['Date'], now: baseEpoch });

      // Same injected retire fault as the other passes: the canonical note lands, the
      // draft survives, and only the retry can tell that the note stands for it.
      const originalUnlinkSync = fs.unlinkSync;
      try {
        fs.unlinkSync = ((target: fs.PathLike | string) => {
          if (String(target).includes('DRAFT-S-ffff6666')) {
            const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, unlink '${target}'`);
            err.code = 'EACCES';
            throw err;
          }
          return originalUnlinkSync(target);
        }) as typeof fs.unlinkSync;
        await assert.rejects(() => recoverDraft(vaultPath, staleDraft, 'save'), /EACCES/);
      } finally {
        fs.unlinkSync = originalUnlinkSync;
      }

      const firstSession = sessionFiles(vaultPath);
      assert.strictEqual(firstSession.length, 1);
      const [firstSessionFile] = firstSession;
      assert.ok(firstSessionFile !== undefined);
      const firstFrontmatter = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, '.palee', 'sessions', firstSessionFile), 'utf8')
      ).frontmatter;
      // `now - 24h`, not the draft's 3-day-old start: the clamp has to overwrite the
      // fixture's own timestamp, otherwise nothing stale was recovered at all.
      const expectedClamp = new Date(Date.now() - DAY_MS).toISOString();
      assert.strictEqual(
        firstFrontmatter?.started_at,
        expectedClamp,
        `a 3-day-old draft must save started_at = now - 24h (draft started_at ${draftStartedAt}, saved ${String(firstFrontmatter?.started_at)})`
      );

      // Advance a whole day without sleeping: the retry's clamp is now ~74h past the
      // draft's start and a day past the first clamp, i.e. far outside any skew band.
      // A retry that rejects the earlier clamp would mint a second session here.
      t.mock.timers.tick(DAY_MS);
      await recoverDraft(vaultPath, staleDraft, 'save');

      assert.deepStrictEqual(
        sessionFiles(vaultPath),
        firstSession,
        'the long-stale retry must reuse the session the first clamp wrote'
      );
      assert.deepStrictEqual(draftFiles(vaultPath), [], 'the long-stale retry must retire the draft');
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
