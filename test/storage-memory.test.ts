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
    assert.match(id, /^S-\d{8}T\d{6}-[a-f0-9]{4}$/);
  });

  test('generateDraftId produces valid DRAFT-S- prefix format', () => {
    const id = generateDraftId();
    assert.ok(id.startsWith('DRAFT-S-'));
    assert.match(id, /^DRAFT-S-[a-f0-9]{8}$/);
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
    const recoveredNote = files.find(f => f.startsWith('S-') && !f.startsWith('DRAFT-S-'));
    assert.ok(recoveredNote);

    const content = fs.readFileSync(path.join(sessionsDir, recoveredNote), 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(typeof frontmatter!.duration_minutes, 'number');
    assert.strictEqual(Number.isNaN(frontmatter!.duration_minutes), false);
  });

  test('regenerateIndex only indexes confirmed sessions and excludes draft notes', async () => {
    const draftId = generateDraftId();
    await writeDraftCheckpoint(testVaultPath, draftId, {
      topic_id: 'T-draft-index-test',
      started_at: '2026-08-30T10:00:00.000Z',
    }, 'Draft notes');

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
  });
});
