import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  generateSessionId,
  generateDraftId,
  truncateWords,
  countWords,
  formatDateOnly,
  readHotMemory,
  resolveActiveTopic,
  writeSessionNote,
  updateHotMemory,
  resetHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  getTopicDrafts,
  deleteTopicDrafts,
  deleteSessionNote,
  Lock,
  recoverDraft,
  parseFrontmatter,
  MAX_HOT_WORDS,
} from '../src/storage';

describe('Memory System', () => {
  let testVaultPath: string;

  before(() => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-memory-test-'));
  });

  after(() => {
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  });

  test('generateSessionId produces valid S- prefix format', () => {
    const id = generateSessionId();
    assert.ok(id.startsWith('S-'));
    // Four bytes of entropy, not two: the timestamp only carries whole seconds, so
    // this suffix is the only thing separating two sessions started in the same
    // second, and a repeated id silently replaces the earlier session note.
    assert.match(id, /^S-\d{8}T\d{6}-[a-f0-9]{8}$/);
  });

  test('generateDraftId produces valid DRAFT-S- prefix format', () => {
    const id = generateDraftId();
    assert.ok(id.startsWith('DRAFT-S-'));
    assert.match(id, /^DRAFT-S-[a-f0-9]{8}$/);
  });

  // ── readHotMemory / resolveActiveTopic (#130) ────────────────────────

  describe('readHotMemory', () => {
    test('classifies absent file as missing', () => {
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'missing');
      assert.strictEqual(read.frontmatter, null);
      assert.strictEqual(read.body, '');
    });

    test('classifies valid frontmatter with palee_schema as ok', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\npalee_schema: 1\nmemory_id: H-active\nactive_topic: T-git-rebase\nstarted_at: "2026-08-08T18:00:00Z"\nupdated_at: 2026-08-08\n---\n# Working memory\n',
        'utf8'
      );
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'ok');
      assert.strictEqual(read.frontmatter?.active_topic, 'T-git-rebase');
      assert.strictEqual(read.body, '# Working memory\n');
    });

    test('classifies frontmatter without palee_schema as schema-invalid but keeps tolerant fields', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\nmemory_id: H-active\nactive_topic: T-legacy\n---\n# Legacy hot\n',
        'utf8'
      );
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'schema-invalid');
      assert.strictEqual(read.frontmatter?.active_topic, 'T-legacy', 'tolerant fields retained');
    });

    test('classifies unsupported schema version 2 as schema-invalid but keeps tolerant fields', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\npalee_schema: 2\nactive_topic: T-v2\n---\n# Foreign hot\n',
        'utf8'
      );
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'schema-invalid');
      assert.strictEqual(read.frontmatter?.active_topic, 'T-v2', 'tolerant fields retained');
    });

    test('classifies boolean palee_schema true as schema-invalid', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\npalee_schema: true\nactive_topic: T-bool\n---\n# Foreign hot\n',
        'utf8'
      );
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'schema-invalid');
      assert.strictEqual(read.frontmatter?.active_topic, 'T-bool', 'tolerant fields retained');
    });

    test('classifies string palee_schema "1" as schema-invalid', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\npalee_schema: "1"\nactive_topic: T-string\n---\n# Foreign hot\n',
        'utf8'
      );
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'schema-invalid');
      assert.strictEqual(read.frontmatter?.active_topic, 'T-string', 'tolerant fields retained');
    });

    test('classifies malformed YAML as corrupt', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(hotPath, '---\nbroken: [ { invalid yaml\n---\n# Corrupt\n', 'utf8');
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'corrupt');
      assert.strictEqual(read.frontmatter, null);
    });

    test('classifies absent frontmatter (no fences) as no-frontmatter', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(hotPath, 'plain body without fences\n', 'utf8');
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'no-frontmatter');
      assert.strictEqual(read.body, 'plain body without fences\n');
    });

    test('classifies empty fences (--- \\n ---) as no-frontmatter', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(hotPath, '---\n---\nempty fence body\n', 'utf8');
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'no-frontmatter');
    });

    test('ignores unknown keys without rejecting them', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\npalee_schema: 1\nfuture_key: whatever\nanother: { nested: true }\n---\n# Body\n',
        'utf8'
      );
      const read = readHotMemory(testVaultPath);
      assert.strictEqual(read.state, 'ok');
    });

    test('throws non-ENOENT filesystem errors instead of swallowing', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(hotPath, '---\npalee_schema: 1\n---\n# Body\n', 'utf8');
      const origReadFileSync = fs.readFileSync;
      (fs as any).readFileSync = (p: any, ...rest: any[]) => {
        if (typeof p === 'string' && p.includes('hot.md')) {
          const e = new Error(`EACCES: permission denied, open '${p}'`) as NodeJS.ErrnoException;
          e.code = 'EACCES';
          throw e;
        }
        return origReadFileSync(p, ...rest);
      };
      try {
        assert.throws(() => readHotMemory(testVaultPath), (err: unknown) => {
          assert.strictEqual((err as NodeJS.ErrnoException).code, 'EACCES');
          return true;
        });
      } finally {
        (fs as any).readFileSync = origReadFileSync;
      }
    });
  });

  describe('resolveActiveTopic', () => {
    test('returns trimmed active topic from ok read', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(
        hotPath,
        '---\npalee_schema: 1\nactive_topic: " T-spaced "\n---\n# Body\n',
        'utf8'
      );
      assert.strictEqual(resolveActiveTopic(readHotMemory(testVaultPath)), 'T-spaced');
    });

    test('returns null for blank, (none), non-string, and absent values', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      for (const [label, value] of [
        ['whitespace-only', '"   "'],
        ['(none)', '(none)'],
        ['non-string', '42'],
      ] as const) {
        fs.writeFileSync(hotPath, `---\npalee_schema: 1\nactive_topic: ${value}\n---\n# Body\n`, 'utf8');
        assert.strictEqual(resolveActiveTopic(readHotMemory(testVaultPath)), null, `must reject ${label}`);
      }
      fs.writeFileSync(hotPath, '---\npalee_schema: 1\n---\n# Body\n', 'utf8');
      assert.strictEqual(resolveActiveTopic(readHotMemory(testVaultPath)), null, 'must reject absent');
    });

    test('returns null for corrupt and missing reads', () => {
      const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
      fs.mkdirSync(path.dirname(hotPath), { recursive: true });
      fs.writeFileSync(hotPath, '---\nbroken: [ { invalid yaml\n---\n# Corrupt\n', 'utf8');
      assert.strictEqual(resolveActiveTopic(readHotMemory(testVaultPath)), null);
      fs.unlinkSync(hotPath);
      assert.strictEqual(resolveActiveTopic(readHotMemory(testVaultPath)), null);
    });
  });

  test('truncateWords caps string to specified max word count', () => {
    const text = 'one two three four five six seven eight nine ten';
    const truncated = truncateWords(text, 5);
    assert.strictEqual(countWords(truncated), 5); // 5 words including trailing '...'
    assert.ok(truncated.endsWith('...'));
  });

  test('formatDateOnly formats Date object as YYYY-MM-DD', () => {
    const date = new Date('2026-08-08T18:00:00+05:30');
    const formatted = formatDateOnly(date);
    assert.match(formatted, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('writeSessionNote writes canonical session note with frontmatter', async () => {
    const sessionId = generateSessionId();
    const sessionPath = await writeSessionNote(testVaultPath, {
      session_id: sessionId,
      topic_id: 'T-git-rebase',
      started_at: '2026-08-08T18:00:00+05:30',
      ended_at: '2026-08-08T18:45:00+05:30',
    }, 'Covered interactive rebase conflict resolution.');

    assert.ok(fs.existsSync(sessionPath));
    const content = fs.readFileSync(sessionPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);

    assert.ok(frontmatter);
    assert.strictEqual(frontmatter!.session_id, sessionId);
    assert.strictEqual(frontmatter!.topic_id, 'T-git-rebase');
    assert.strictEqual(frontmatter!.status, 'completed');
    assert.ok(body.includes('Covered interactive rebase conflict resolution.'));
  });

  test('updateHotMemory caps body at 250 words and formats updated_at as YYYY-MM-DD', async () => {
    // Create body with 300 words
    const longBody = Array(300).fill('word').join(' ');
    const hotPath = await updateHotMemory(testVaultPath, 'S-123', 'T-git-rebase', longBody);

    assert.ok(fs.existsSync(hotPath));
    const content = fs.readFileSync(hotPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);

    assert.ok(frontmatter);
    assert.strictEqual(frontmatter!.memory_id, 'H-active');
    assert.strictEqual(frontmatter!.last_session, 'S-123');
    assert.match(frontmatter!.updated_at as string, /^\d{4}-\d{2}-\d{2}$/);

    // Body should be truncated to MAX_HOT_WORDS (250) + ellipsis
    const bodyWords = countWords(body);
    assert.ok(bodyWords <= MAX_HOT_WORDS + 1);
  });

  test('regenerateIndex creates .palee/index.md listing confirmed sessions', async () => {
    const indexPath = await regenerateIndex(testVaultPath);

    assert.ok(fs.existsSync(indexPath));
    const content = fs.readFileSync(indexPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);

    assert.ok(frontmatter);
    assert.strictEqual(frontmatter!.type, 'session_index');
    assert.ok(body.includes('Total Sessions:'));
  });

  test('rebuildHotAndIndex rebuilds hot.md and index.md from session files', async () => {
    const sessionId = generateSessionId();
    await writeSessionNote(testVaultPath, {
      session_id: sessionId,
      topic_id: 'T-docker-basics',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    }, 'Rebuilt session summary test.');

    // Delete hot.md and index.md
    const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
    const indexPath = path.join(testVaultPath, '.palee', 'index.md');
    if (fs.existsSync(hotPath)) fs.unlinkSync(hotPath);
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);

    // Rebuild
    await rebuildHotAndIndex(testVaultPath);

    assert.ok(fs.existsSync(hotPath));
    assert.ok(fs.existsSync(indexPath));

    const hotContent = fs.readFileSync(hotPath, 'utf8');
    const { frontmatter } = parseFrontmatter(hotContent);
    assert.strictEqual(frontmatter!.last_session, sessionId);
    assert.strictEqual(frontmatter!.active_topic, 'T-docker-basics');
  });

  test('rebuildHotAndIndex excludes draft sessions from newest selection', async () => {
    // Create a confirmed session and a draft-status session (stored under an
    // S-* file name with status: draft). The draft has a NEWER timestamp.
    // The draft must NOT be selected as newest — matching regenerateIndex
    // behavior. We use fixed future timestamps so this test's sessions are
    // definitively the newest, regardless of other tests running in the same
    // shared vault directory.
    const confirmedId = generateSessionId();
    const confirmedTime = new Date(Date.now() + 86400000).toISOString(); // 1 day future
    const draftSessionId = generateDraftId();
    const draftTime = new Date(Date.now() + 172800000).toISOString(); // 2 days future

    await writeSessionNote(testVaultPath, {
      session_id: confirmedId,
      topic_id: 'T-confirmed',
      started_at: confirmedTime,
      ended_at: confirmedTime,
    }, 'Confirmed session body.');

    // Manually write an S-* file with a DRAFT session_id and status: draft
    const draftSessionFile = `${draftSessionId}.md`.replace('DRAFT-S-', 'S-');
    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    const draftFilePath = path.join(sessionsDir, draftSessionFile);
    const draftContent = `---
palee_schema: 1
session_id: ${draftSessionId}
topic_id: T-draft
started_at: ${draftTime}
ended_at: null
status: draft
---
Draft status session with newer timestamp.
`;
    fs.writeFileSync(draftFilePath, draftContent, 'utf8');

    const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
    if (fs.existsSync(hotPath)) fs.unlinkSync(hotPath);

    await rebuildHotAndIndex(testVaultPath);

    const hotContent = fs.readFileSync(hotPath, 'utf8');
    const { frontmatter } = parseFrontmatter(hotContent);
    // The draft-status session has a NEWER timestamp but must be excluded
    // from selection. Assert the confirmed session is selected directly.
    assert.strictEqual(frontmatter!.last_session, confirmedId,
      'draft-status session must not be selected as newest session');
    assert.strictEqual(frontmatter!.active_topic, 'T-confirmed',
      'active_topic must come from the newest confirmed session');
  });

  // BUG-005: an unparseable `started_at` produced NaN, which never satisfied
  // the `time >= newestTime` test, so every session was disqualified and hot
  // memory was rewritten as empty history. Sessions must survive the rebuild.
  function writeRawSession(vaultPath: string, fileName: string, sessionId: string, topicId: string, startedAt: string, body: string): void {
    const sessionsDir = path.join(vaultPath, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, fileName), `---
palee_schema: 1
session_id: ${sessionId}
topic_id: ${topicId}
started_at: ${startedAt}
ended_at: ${startedAt}
status: completed
---
${body}
`, 'utf8');
  }

  test('rebuildHotAndIndex keeps hot memory when all session timestamps are unparseable', async () => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-bug005-all-nan-'));
    try {
      writeRawSession(vaultPath, 'S-corruptone.md', 'S-corruptone', 'T-corrupt-a', 'not-a-date', 'Linux networking: bridge vs overlay.');
      writeRawSession(vaultPath, 'S-corrupttwo.md', 'S-corrupttwo', 'T-corrupt-b', '2026-13-45T99:99:99Z', 'Kubernetes CNI chapter 4 notes.');

      await rebuildHotAndIndex(vaultPath);

      const hotContent = fs.readFileSync(path.join(vaultPath, '.palee', 'hot.md'), 'utf8');
      const { frontmatter, body } = parseFrontmatter(hotContent);
      assert.ok(frontmatter!.last_session, 'hot memory must select a session even when all timestamps are unparseable');
      assert.ok(!body.includes('No learning history recorded yet.'),
        'hot memory must not be erased while confirmed sessions exist on disk');
      assert.ok(['T-corrupt-a', 'T-corrupt-b'].includes(String(frontmatter!.active_topic)),
        'active_topic must come from a real session, not be null (tie-break order is not contractual)');

      const indexContent = fs.readFileSync(path.join(vaultPath, '.palee', 'index.md'), 'utf8');
      assert.ok(indexContent.includes('Total Sessions: 2'),
        'index and hot memory must agree that sessions exist');

      const sessionsDir = path.join(vaultPath, '.palee', 'sessions');
      assert.deepStrictEqual(fs.readdirSync(sessionsDir).sort(), ['S-corruptone.md', 'S-corrupttwo.md'],
        'rebuild must never mutate canonical session files');
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('rebuildHotAndIndex ranks unparseable timestamps below valid ones', async () => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-bug005-mixed-'));
    try {
      writeRawSession(vaultPath, 'S-invalid.md', 'S-invalid', 'T-invalid', 'not-a-date', 'Corrupt timestamp session body.');
      writeRawSession(vaultPath, 'S-valid.md', 'S-valid', 'T-valid', '2026-01-02T03:04:05.000Z', 'Valid timestamp session body.');

      await rebuildHotAndIndex(vaultPath);

      const hotContent = fs.readFileSync(path.join(vaultPath, '.palee', 'hot.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(hotContent);
      assert.strictEqual(frontmatter!.last_session, 'S-valid',
        'a session with an unparseable timestamp must not displace a validly-timed one');
      assert.strictEqual(frontmatter!.active_topic, 'T-valid');
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('rebuildHotAndIndex ranks a pre-1970 session above an unparseable timestamp', async () => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-bug005-pre1970-'));
    try {
      writeRawSession(vaultPath, 'S-invalid.md', 'S-invalid', 'T-invalid', 'not-a-date', 'Corrupt timestamp session body.');
      writeRawSession(vaultPath, 'S-preepoch.md', 'S-preepoch', 'T-pre1970', '1969-05-01T00:00:00.000Z', 'Pre-epoch session body.');

      await rebuildHotAndIndex(vaultPath);

      const hotContent = fs.readFileSync(path.join(vaultPath, '.palee', 'hot.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(hotContent);
      assert.strictEqual(frontmatter!.last_session, 'S-preepoch',
        'a parseable pre-1970 timestamp must outrank an unparseable one, not be filtered out');
      assert.strictEqual(frontmatter!.active_topic, 'T-pre1970');
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('rebuildHotAndIndex resolves a tie on started_at to the same session every run', async () => {
    // Two confirmed sessions with byte-identical `started_at` — what a bulk import
    // or a restored vault produces. The scan is sorted and stays `>=`, so the last
    // filename in ascending order wins on every OS; under readdir order the winner
    // differs between platforms and between runs.
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-memory-tie-'));
    try {
      writeRawSession(vaultPath, 'S-20260101T000000-aaaa.md', 'S-20260101T000000-aaaa', 'T-earlier', '2026-01-01T00:00:00.000Z', 'First of the tie.');
      writeRawSession(vaultPath, 'S-20260101T000000-zzzz.md', 'S-20260101T000000-zzzz', 'T-later', '2026-01-01T00:00:00.000Z', 'Second of the tie.');

      await rebuildHotAndIndex(vaultPath);
      const first = parseFrontmatter(fs.readFileSync(path.join(vaultPath, '.palee', 'hot.md'), 'utf8')).frontmatter;
      const indexAfterFirst = fs.readFileSync(path.join(vaultPath, '.palee', 'index.md'), 'utf8');

      await rebuildHotAndIndex(vaultPath);
      const second = parseFrontmatter(fs.readFileSync(path.join(vaultPath, '.palee', 'hot.md'), 'utf8')).frontmatter;

      assert.strictEqual(first!.last_session, 'S-20260101T000000-zzzz',
        'the ascending scan leaves the greatest filename as the newest');
      assert.strictEqual(first!.active_topic, 'T-later');
      assert.strictEqual(second!.last_session, first!.last_session, 'two rebuilds of the same data agree');
      assert.strictEqual(
        fs.readFileSync(path.join(vaultPath, '.palee', 'index.md'), 'utf8'),
        indexAfterFirst,
        'index.md is rebuilt from the same order hot.md used'
      );
    } finally {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('writeDraftCheckpoint writes DRAFT-S-*.md file', async () => {
    const draftId = generateDraftId();
    const draftPath = await writeDraftCheckpoint(testVaultPath, draftId, {
      topic_id: 'T-docker-basics',
      started_at: new Date().toISOString(),
    }, 'In-progress draft checkpoint.');

    assert.ok(fs.existsSync(draftPath));
    const content = fs.readFileSync(draftPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.strictEqual(frontmatter!.ended_at, null);
    assert.strictEqual(frontmatter!.status, 'draft');

    const drafts = getDrafts(testVaultPath);
    assert.ok(drafts.includes(draftPath));
  });

  test('recoverDraft handles discard action', async () => {
    const draftId = generateDraftId();
    const draftPath = await writeDraftCheckpoint(testVaultPath, draftId, {
      topic_id: 'T-test',
      started_at: new Date().toISOString(),
    }, 'Draft to discard.');

    await recoverDraft(testVaultPath, draftPath, 'discard');
    assert.ok(!fs.existsSync(draftPath));
  });

  test('recoverDraft handles save action', async () => {
    const draftId = generateDraftId();
    const draftPath = await writeDraftCheckpoint(testVaultPath, draftId, {
      topic_id: 'T-test',
      started_at: new Date().toISOString(),
    }, 'Draft to save as session.');

    await recoverDraft(testVaultPath, draftPath, 'save');
    assert.ok(!fs.existsSync(draftPath), 'Draft file should be deleted after saving');

    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    const files = fs.readdirSync(sessionsDir);
    const hasConfirmedSession = files.some(f => f.startsWith('S-') && !f.startsWith('DRAFT-S-'));
    assert.ok(hasConfirmedSession, 'Confirmed session should be created');
  });

  test('resetHotMemory removes hot.md safely', async () => {
    await updateHotMemory(testVaultPath, 'S-999', 'T-reset', 'Sample body');
    const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
    assert.ok(fs.existsSync(hotPath));

    await resetHotMemory(testVaultPath);
    assert.strictEqual(fs.existsSync(hotPath), false);

    // Idempotent: resetting when not existing should not throw
    await resetHotMemory(testVaultPath);
  });

  test('resetHotMemory yields to a live lock instead of unlinking under it', async () => {
    // The reset is the recovery step for a corrupt `hot.md`. A held lock means
    // another process is maintaining that file right now, so the reset must neither
    // race its rename nor raise `ECONFLICT` — the caller turns that into exit 4,
    // and a recoverable vault would be reported as a concurrency failure.
    await updateHotMemory(testVaultPath, 'S-under-lock', 'T-lock', 'Body owned elsewhere.');
    const hotPath = path.join(testVaultPath, '.palee', 'hot.md');
    const lock = new Lock(testVaultPath, hotPath);
    await lock.acquire();
    try {
      await resetHotMemory(testVaultPath);
      assert.ok(fs.existsSync(hotPath), 'the file another writer holds must survive the reset');
    } finally {
      lock.release();
    }

    await resetHotMemory(testVaultPath);
    assert.strictEqual(fs.existsSync(hotPath), false, 'once the lock is gone the reset deletes it');
  });

  test('updateHotMemory persists started_at timestamp when provided', async () => {
    const startTime = '2026-08-30T10:00:00.000Z';
    const hotPath = await updateHotMemory(testVaultPath, 'S-100', 'T-start-test', 'Body content', startTime);
    assert.ok(fs.existsSync(hotPath));

    const content = fs.readFileSync(hotPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(frontmatter!.started_at, startTime);
    assert.strictEqual(frontmatter!.active_topic, 'T-start-test');
  });

  test('writeSessionNote persists duration_minutes in frontmatter', async () => {
    const sessionId = generateSessionId();
    const sessionPath = await writeSessionNote(testVaultPath, {
      session_id: sessionId,
      topic_id: 'T-duration-unit',
      started_at: '2026-08-30T10:00:00.000Z',
      ended_at: '2026-08-30T10:45:00.000Z',
      duration_minutes: 45,
    }, 'Session body with duration.');

    assert.ok(fs.existsSync(sessionPath));
    const content = fs.readFileSync(sessionPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(frontmatter!.duration_minutes, 45);
  });

  test('getTopicDrafts and deleteTopicDrafts manage topic drafts', async () => {
    const draftId1 = generateDraftId();
    const draftId2 = generateDraftId();
    const draftIdOther = generateDraftId();

    const start1 = '2026-08-30T09:00:00.000Z';
    const start2 = '2026-08-30T09:30:00.000Z';

    await writeDraftCheckpoint(testVaultPath, draftId1, { topic_id: 'T-multi-draft', started_at: start1 }, 'Draft 1');
    await writeDraftCheckpoint(testVaultPath, draftId2, { topic_id: 'T-multi-draft', started_at: start2 }, 'Draft 2');
    await writeDraftCheckpoint(testVaultPath, draftIdOther, { topic_id: 'T-other', started_at: start1 }, 'Draft other');

    const topicDrafts = getTopicDrafts(testVaultPath, 'T-multi-draft');
    assert.strictEqual(topicDrafts.length, 2);
    assert.ok(topicDrafts.some(d => d.started_at === start1));
    assert.ok(topicDrafts.some(d => d.started_at === start2));

    deleteTopicDrafts(testVaultPath, 'T-multi-draft');

    const remainingTopicDrafts = getTopicDrafts(testVaultPath, 'T-multi-draft');
    assert.strictEqual(remainingTopicDrafts.length, 0);

    const remainingOtherDrafts = getTopicDrafts(testVaultPath, 'T-other');
    assert.strictEqual(remainingOtherDrafts.length, 1);
  });

  test('deleteTopicDrafts returns errors instead of swallowing them when deletion fails', async () => {
    const draftId = generateDraftId();
    const topicId = 'T-eacces-test';
    const draftPath = path.join(testVaultPath, '.palee', 'sessions', `${draftId}.md`);
    fs.writeFileSync(
      draftPath,
      `---\npalee_schema: 1\nsession_id: ${draftId}\ntopic_id: ${topicId}\nstarted_at: 2026-08-30T10:00:00.000Z\nended_at: null\nstatus: draft\n---\n# Draft Session: ${draftId}\n\nDraft body`
    );

    const originalUnlinkSync = fs.unlinkSync;
    try {
      // Stub unlinkSync to throw EACCES only for this specific draft path
      (fs as any).unlinkSync = (p: string) => {
        if (p.includes(draftId)) {
          const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, unlink '${p}'`);
          err.code = 'EACCES';
          throw err;
        }
        return originalUnlinkSync(p);
      };

      const result = deleteTopicDrafts(testVaultPath, topicId);

      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.deleted.length, 0);
      assert.ok(
        (result.errors[0].error as NodeJS.ErrnoException).code === 'EACCES' ||
        result.errors[0].error.message.includes('EACCES')
      );
    } finally {
      (fs as any).unlinkSync = originalUnlinkSync;
      // Cleanup: remove the draft file if still present
      try { fs.unlinkSync(draftPath); } catch { /* already gone */ }
    }
  });

  test('deleteSessionNote unlinks session within sessions dir and throws outside', async () => {
    const sessionId = generateSessionId();
    const sessionPath = await writeSessionNote(testVaultPath, {
      session_id: sessionId,
      topic_id: 'T-del-test',
      started_at: '2026-08-30T10:00:00.000Z',
      ended_at: '2026-08-30T10:10:00.000Z',
    }, 'Session to delete');

    assert.ok(fs.existsSync(sessionPath));
    deleteSessionNote(testVaultPath, sessionPath);
    assert.strictEqual(fs.existsSync(sessionPath), false);

    // Outside boundary security check
    const outsideFile = path.join(testVaultPath, 'outside.md');
    fs.writeFileSync(outsideFile, 'outside');
    assert.throws(() => {
      deleteSessionNote(testVaultPath, outsideFile);
    }, /Security error: Cannot delete session file outside sessions directory/);
  });

  test('recoverDraft with malformed or missing started_at timestamp produces non-NaN duration_minutes', async () => {
    const draftId = generateDraftId();
    const draftPath = path.join(testVaultPath, '.palee', 'sessions', `${draftId}.md`);
    fs.writeFileSync(draftPath, '---\npalee_schema: 1\nsession_id: ' + draftId + '\ntopic_id: T-corrupt-date\nstarted_at: invalid-date-format\n---\nDraft body');

    await recoverDraft(testVaultPath, draftPath, 'save');

    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    const files = fs.readdirSync(sessionsDir);
    const recoveredNote = files.find(f => {
      if (!f.startsWith('S-') || f.startsWith('DRAFT-S-')) return false;
      const content = fs.readFileSync(path.join(sessionsDir, f), 'utf8');
      return content.includes('T-corrupt-date');
    });
    assert.ok(recoveredNote);

    const content = fs.readFileSync(path.join(sessionsDir, recoveredNote), 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(typeof frontmatter!.duration_minutes, 'number');
    assert.strictEqual(Number.isNaN(frontmatter!.duration_minutes), false);
  });

  test('recoverDraft save clamps draft older than 24h to a 24h maximum duration (BUG-004)', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const draftId = generateDraftId();
    const draftPath = await writeDraftCheckpoint(testVaultPath, draftId, {
      topic_id: 'T-stale-draft',
      started_at: tenDaysAgo,
    }, 'Stale draft body.');

    await recoverDraft(testVaultPath, draftPath, 'save');

    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    const files = fs.readdirSync(sessionsDir);
    const recoveredNote = files.find(f => {
      if (!f.startsWith('S-') || f.startsWith('DRAFT-S-')) return false;
      const content = fs.readFileSync(path.join(sessionsDir, f), 'utf8');
      return content.includes('T-stale-draft');
    });
    assert.ok(recoveredNote);

    const content = fs.readFileSync(path.join(sessionsDir, recoveredNote), 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(typeof frontmatter!.duration_minutes, 'number');
    assert.ok(
      (frontmatter!.duration_minutes as number) <= 1440,
      `duration_minutes should be clamped to <=1440, got ${frontmatter!.duration_minutes}`
    );
    assert.ok((frontmatter!.duration_minutes as number) >= 1439);

    const startMs = new Date(frontmatter!.started_at as string).getTime();
    const minAllowed = Date.now() - 24 * 60 * 60 * 1000 - 60000;
    assert.ok(startMs >= minAllowed, 'started_at must not be earlier than 24h before now');

    fs.unlinkSync(path.join(sessionsDir, recoveredNote));
  });

  test('regenerateIndex only indexes confirmed sessions and excludes draft notes', async () => {
    const draftId = generateDraftId();
    await writeDraftCheckpoint(testVaultPath, draftId, {
      topic_id: 'T-draft-index-test',
      started_at: '2026-08-30T10:00:00.000Z',
    }, 'Draft notes');

    // Case A: S-prefixed file carrying explicit status: 'draft' with a normal S- session_id
    const draftStatusNote = path.join(testVaultPath, '.palee', 'sessions', 'S-corrupt-status-draft.md');
    fs.writeFileSync(draftStatusNote, '---\npalee_schema: 1\nsession_id: S-status-only\ntopic_id: T-status-skip\nstatus: draft\nstarted_at: 2026-08-30T10:00:00.000Z\n---\nDraft note body');

    // Case B: S-prefixed file carrying DRAFT- session_id even if status is 'completed'
    const draftIdNote = path.join(testVaultPath, '.palee', 'sessions', 'S-corrupt-id-draft.md');
    fs.writeFileSync(draftIdNote, '---\npalee_schema: 1\nsession_id: DRAFT-S-id-only\ntopic_id: T-id-skip\nstatus: completed\nstarted_at: 2026-08-30T10:00:00.000Z\n---\nDraft note body');

    const sessionId = generateSessionId();
    await writeSessionNote(testVaultPath, {
      session_id: sessionId,
      topic_id: 'T-confirmed-index-test',
      started_at: '2026-08-30T10:00:00.000Z',
      ended_at: '2026-08-30T10:30:00.000Z',
      duration_minutes: 30,
    }, 'Confirmed session');

    const indexPath = await regenerateIndex(testVaultPath);
    const content = fs.readFileSync(indexPath, 'utf8');

    assert.ok(content.includes(sessionId));
    assert.ok(!content.includes(draftId));
    assert.ok(!content.includes('S-status-only'));
    assert.ok(!content.includes('T-status-skip'));
    assert.ok(!content.includes('DRAFT-S-id-only'));
    assert.ok(!content.includes('T-id-skip'));
  });

  test('regenerateIndex preserves 0-byte session files on disk', async () => {
    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Plant a 0-byte session file — a derived-view rebuild must NOT delete it.
    const zeroByteFile = path.join(sessionsDir, 'S-preserve-zero-byte.md');
    fs.writeFileSync(zeroByteFile, '');
    assert.ok(fs.existsSync(zeroByteFile));

    await regenerateIndex(testVaultPath);

    // File must still exist post-rebuild (data safety invariant).
    assert.ok(fs.existsSync(zeroByteFile), '0-byte session file should survive regenerateIndex');
    assert.strictEqual(fs.statSync(zeroByteFile).size, 0);
  });

  test('rebuildHotAndIndex preserves 0-byte session files on disk', async () => {
    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Plant a 0-byte session file — a derived-view rebuild must NOT delete it.
    const zeroByteFile = path.join(sessionsDir, 'S-preserve-rhi-zero.md');
    fs.writeFileSync(zeroByteFile, '');

    await rebuildHotAndIndex(testVaultPath);

    assert.ok(fs.existsSync(zeroByteFile), '0-byte session file should survive rebuildHotAndIndex');
    assert.strictEqual(fs.statSync(zeroByteFile).size, 0);
  });

  test('recoverDraft save clamps a >60s-future start to now but preserves a <60s-future start (#360)', async () => {
    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');

    // Case A: start timestamp 10 minutes in the future (>60s) — must clamp to now.
    const farFutureIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const farDraftId = generateDraftId();
    const farDraftPath = await writeDraftCheckpoint(testVaultPath, farDraftId, {
      topic_id: 'T-far-future',
      started_at: farFutureIso,
    }, 'Far future draft.');
    const beforeFarSave = Date.now();
    await recoverDraft(testVaultPath, farDraftPath, 'save');
    const afterFarSave = Date.now();

    const farNote = fs.readdirSync(sessionsDir).find(f => {
      if (!f.startsWith('S-') || f.startsWith('DRAFT-S-')) return false;
      return fs.readFileSync(path.join(sessionsDir, f), 'utf8').includes('T-far-future');
    });
    assert.ok(farNote, 'recovered far-future session note should exist');
    const farFm = parseFrontmatter(fs.readFileSync(path.join(sessionsDir, farNote!), 'utf8')).frontmatter;
    const farStartMs = new Date(farFm!.started_at as string).getTime();
    assert.ok(farStartMs < new Date(farFutureIso).getTime(), 'far-future start must be clamped below the original future value');
    assert.ok(
      farStartMs >= beforeFarSave - 1000 && farStartMs <= afterFarSave + 1000,
      `far-future start should clamp to ~now, got ${farFm!.started_at}`
    );

    // Case B: start timestamp 30s in the future (<60s skew band) — must be preserved as-is.
    const nearFutureIso = new Date(Date.now() + 30 * 1000).toISOString();
    const nearDraftId = generateDraftId();
    const nearDraftPath = await writeDraftCheckpoint(testVaultPath, nearDraftId, {
      topic_id: 'T-near-future',
      started_at: nearFutureIso,
    }, 'Near future draft.');
    await recoverDraft(testVaultPath, nearDraftPath, 'save');

    const nearNote = fs.readdirSync(sessionsDir).find(f => {
      if (!f.startsWith('S-') || f.startsWith('DRAFT-S-')) return false;
      return fs.readFileSync(path.join(sessionsDir, f), 'utf8').includes('T-near-future');
    });
    assert.ok(nearNote, 'recovered near-future session note should exist');
    const nearFm = parseFrontmatter(fs.readFileSync(path.join(sessionsDir, nearNote!), 'utf8')).frontmatter;
    assert.strictEqual(
      nearFm!.started_at,
      nearFutureIso,
      'a <60s-future start should be preserved as-is, not reset to now'
    );

    fs.unlinkSync(path.join(sessionsDir, farNote!));
    fs.unlinkSync(path.join(sessionsDir, nearNote!));
  });

  test('regenerateIndex skips an unsupported palee_schema session instead of coercing it to 1 (#361)', async () => {
    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const schemaFile = path.join(sessionsDir, 'S-unsupported-schema.md');
    fs.writeFileSync(
      schemaFile,
      '---\npalee_schema: 2\nsession_id: S-unsupported-schema\ntopic_id: T-schema-skip\nstatus: completed\nstarted_at: 2026-08-30T10:00:00.000Z\nended_at: 2026-08-30T10:30:00.000Z\n---\nFuture-schema session body'
    );

    const indexPath = await regenerateIndex(testVaultPath);
    const content = fs.readFileSync(indexPath, 'utf8');

    assert.ok(!content.includes('S-unsupported-schema'), 'unsupported-schema session must not be indexed');
    assert.ok(!content.includes('T-schema-skip'), 'unsupported-schema session must not be indexed');
    assert.match(content, /Skipped \(unreadable or unsupported schema\): \d+/, 'skipped count must be surfaced in the report');

    fs.unlinkSync(schemaFile);
  });

  test('regenerateIndex counts and surfaces an unreadable/corrupt session (#362)', async () => {
    const sessionsDir = path.join(testVaultPath, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Non-empty S- file whose YAML frontmatter fails to parse (unterminated flow collection).
    const corruptFile = path.join(sessionsDir, 'S-corrupt-frontmatter.md');
    fs.writeFileSync(corruptFile, '---\nsession_id: S-corrupt-frontmatter\ntopic_id: [unterminated\n---\nCorrupt body');

    const indexPath = await regenerateIndex(testVaultPath);
    const content = fs.readFileSync(indexPath, 'utf8');

    const match = content.match(/Skipped \(unreadable or unsupported schema\): (\d+)/);
    assert.ok(match, 'skipped count line must be present when a corrupt session is encountered');
    assert.ok(Number(match![1]) >= 1, `skipped count should be at least 1, got ${match && match[1]}`);
    assert.ok(!content.includes('S-corrupt-frontmatter]]'), 'corrupt session must not be listed as an indexed session');

    fs.unlinkSync(corruptFile);
  });
});
