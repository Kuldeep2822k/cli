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
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
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
});
