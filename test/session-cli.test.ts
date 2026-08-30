import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSessionTopic, sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';
import { parseFrontmatter } from '../src/storage';

describe('Session CLI In-Process Coverage', () => {
  let tempDir: string;
  let vaultDir: string;
  let prevConfigDir: string | undefined;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-session-cov-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;

    // Set config vaultPath
    saveConfig({ vaultPath: vaultDir });
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

  afterEach(() => {
    process.exitCode = undefined;
    const paleeDir = path.join(vaultDir, '.palee');
    if (fs.existsSync(paleeDir)) {
      fs.rmSync(paleeDir, { recursive: true, force: true });
    }
  });

  test('resolveSessionTopic returns explicit topic if given', () => {
    const topic = resolveSessionTopic(vaultDir, 'T-kubernetes-basics');
    assert.strictEqual(topic, 'T-kubernetes-basics');
  });

  test('resolveSessionTopic returns null for explicit (none) or whitespace (none)', () => {
    assert.strictEqual(resolveSessionTopic(vaultDir, '(none)'), null);
    assert.strictEqual(resolveSessionTopic(vaultDir, '  (none)  '), null);
  });

  test('resolveSessionTopic resolves active_topic from .palee/hot.md', () => {
    const paleeDir = path.join(vaultDir, '.palee');
    fs.mkdirSync(paleeDir, { recursive: true });
    const hotPath = path.join(paleeDir, 'hot.md');
    fs.writeFileSync(
      hotPath,
      '---\npalee_schema: 1\nactive_topic: T-active-memory\n---\n# Working Memory\n',
      'utf8'
    );

    const topic = resolveSessionTopic(vaultDir);
    assert.strictEqual(topic, 'T-active-memory');
  });

  test('resolveSessionTopic returns null when active_topic is missing, whitespace or (none)', () => {
    const paleeDir = path.join(vaultDir, '.palee');
    const hotPath = path.join(paleeDir, 'hot.md');

    fs.writeFileSync(hotPath, '---\npalee_schema: 1\nactive_topic: " (none) "\n---\n# Working Memory\n', 'utf8');
    assert.strictEqual(resolveSessionTopic(vaultDir), null);

    fs.writeFileSync(hotPath, '---\npalee_schema: 1\nactive_topic: "   "\n---\n# Working Memory\n', 'utf8');
    assert.strictEqual(resolveSessionTopic(vaultDir), null);
  });

  test('resolveSessionTopic returns null when hot.md has corrupt frontmatter or is missing', () => {
    const paleeDir = path.join(vaultDir, '.palee');
    const hotPath = path.join(paleeDir, 'hot.md');
    fs.writeFileSync(hotPath, 'corrupt without frontmatter', 'utf8');
    assert.strictEqual(resolveSessionTopic(vaultDir), null);

    fs.unlinkSync(hotPath);
    assert.strictEqual(resolveSessionTopic(vaultDir), null);
  });

  test('sessionCommand sets exitCode 2 when draft or end called without topic', async () => {
    await sessionCommand('draft');
    assert.strictEqual(process.exitCode, 2);

    process.exitCode = undefined;
    await sessionCommand('end');
    assert.strictEqual(process.exitCode, 2);
  });

  test('sessionCommand handles start, draft, end, and list actions', async () => {
    // 1. session start
    await sessionCommand('start');

    // 2. session draft
    await sessionCommand('draft', { topic: 'T-draft-test' });
    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    assert.ok(fs.existsSync(draftsDir));
    const draftFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('DRAFT-S-'));
    assert.strictEqual(draftFiles.length, 1);

    // 3. session list (with draft)
    await sessionCommand('list');

    // 4. session end (cleans up draft and writes confirmed session)
    await sessionCommand('end', { topic: 'T-draft-test' });
    const remainingDrafts = fs.readdirSync(draftsDir).filter(f => f.startsWith('DRAFT-S-'));
    assert.strictEqual(remainingDrafts.length, 0);
    const confirmedSessions = fs.readdirSync(draftsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(confirmedSessions.length, 1);

    // 5. session list (with confirmed session)
    await sessionCommand('list');
  });

  test('sessionCommand sets exitCode 2 on unknown action', async () => {
    await sessionCommand('invalid-action');
    assert.strictEqual(process.exitCode, 2);
  });

  test('sessionCommand start with pending drafts sets exitCode 2 in non-interactive mode and outputs JSON', async () => {
    // Create a draft
    await sessionCommand('draft', { topic: 'T-pending-draft' });
    process.exitCode = undefined;

    // Test non-interactive start sets exitCode 2
    await sessionCommand('start', { interactive: false });
    assert.strictEqual(process.exitCode, 2);

    // Test JSON mode start with pending drafts sets exitCode 2 and outputs structured JSON
    process.exitCode = undefined;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    try {
      await sessionCommand('start', { json: true });
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(process.exitCode, 2);
    const jsonOutput = logs.find(l => {
      try {
        const p = JSON.parse(l);
        return p.status === 'drafts_pending';
      } catch { return false; }
    });
    assert.ok(jsonOutput, 'Expected structured drafts_pending JSON output');
    const parsedJson = JSON.parse(jsonOutput);
    assert.strictEqual(parsedJson.status, 'drafts_pending');
    assert.strictEqual(parsedJson.draft_count, 1);
    assert.ok(Array.isArray(parsedJson.drafts));
    assert.strictEqual(parsedJson.drafts.length, 1);

    // Cleanup draft
    await sessionCommand('end', { topic: 'T-pending-draft' });
  });

  test('session start records started_at in hot.md frontmatter for active topic', async () => {
    // Start session with explicit topic
    await sessionCommand('start', { topic: 'T-start-topic' });
    const hotPath = path.join(vaultDir, '.palee', 'hot.md');
    assert.ok(fs.existsSync(hotPath));

    const content = fs.readFileSync(hotPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.strictEqual(frontmatter?.active_topic, 'T-start-topic');
    assert.ok(frontmatter?.started_at, 'started_at must be populated in hot.md');
    const startMs = new Date(frontmatter?.started_at as string).getTime();
    assert.ok(!Number.isNaN(startMs), 'started_at must be a valid timestamp');
  });

  test('session draft inherits started_at from active hot.md', async () => {
    // Set a known past timestamp in hot.md
    const pastTimestamp = new Date(Date.now() - 300000).toISOString(); // 5 minutes ago
    const hotPath = path.join(vaultDir, '.palee', 'hot.md');
    fs.writeFileSync(
      hotPath,
      `---\npalee_schema: 1\nmemory_id: H-active\nlast_session: null\nactive_topic: T-inherited-topic\nstarted_at: "${pastTimestamp}"\nupdated_at: 2026-08-30\n---\n# Working Memory\n`,
      'utf8'
    );

    // Call session draft without explicit timestamp
    await sessionCommand('draft', { topic: 'T-inherited-topic' });

    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    const draftFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('DRAFT-S-'));
    assert.strictEqual(draftFiles.length, 1);

    const draftContent = fs.readFileSync(path.join(draftsDir, draftFiles[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(draftContent);
    assert.strictEqual(frontmatter?.topic_id, 'T-inherited-topic');
    assert.strictEqual(frontmatter?.started_at, pastTimestamp, 'Draft should inherit started_at from hot.md');

    // Cleanup draft
    await sessionCommand('end', { topic: 'T-inherited-topic' });
  });

  test('session end recovers earliest started_at across multiple draft checkpoints (Tier 1)', async () => {
    const t0 = new Date(Date.now() - 600000).toISOString(); // 10 minutes ago
    const t1 = new Date(Date.now() - 300000).toISOString(); // 5 minutes ago

    // Create 2 draft checkpoints with different timestamps
    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    fs.mkdirSync(draftsDir, { recursive: true });

    fs.writeFileSync(
      path.join(draftsDir, 'DRAFT-S-0001.md'),
      `---\npalee_schema: 1\nsession_id: DRAFT-S-0001\ntopic_id: T-multi-draft\nstarted_at: "${t1}"\nstatus: draft\n---\n# Draft 1\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(draftsDir, 'DRAFT-S-0002.md'),
      `---\npalee_schema: 1\nsession_id: DRAFT-S-0002\ntopic_id: T-multi-draft\nstarted_at: "${t0}"\nstatus: draft\n---\n# Draft 2\n`,
      'utf8'
    );

    await sessionCommand('end', { topic: 'T-multi-draft' });

    // Verify all drafts for T-multi-draft are deleted
    const remainingDrafts = fs.readdirSync(draftsDir).filter(f => f.startsWith('DRAFT-S-'));
    assert.strictEqual(remainingDrafts.length, 0);

    // Verify confirmed session picked up earliest timestamp t0
    const confirmedFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(confirmedFiles.length, 1);

    const sessionContent = fs.readFileSync(path.join(draftsDir, confirmedFiles[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(sessionContent);
    assert.strictEqual(frontmatter?.topic_id, 'T-multi-draft');
    assert.strictEqual(frontmatter?.started_at, t0, 'Must recover earliest started_at');
    assert.ok(frontmatter?.ended_at);
    assert.strictEqual(frontmatter?.duration_minutes, 10, 'duration_minutes should be 10');

    const startMs = new Date(frontmatter!.started_at as string).getTime();
    const endMs = new Date(frontmatter!.ended_at as string).getTime();
    assert.ok(endMs > startMs, 'ended_at must be strictly greater than started_at');
    assert.ok(endMs - startMs >= 600000);

    // Cleanup session file
    fs.unlinkSync(path.join(draftsDir, confirmedFiles[0]));
  });

  test('session end recovers started_at from hot.md when no drafts exist (Tier 2)', async () => {
    const pastTime = new Date(Date.now() - 180000).toISOString(); // 3 minutes ago
    const hotPath = path.join(vaultDir, '.palee', 'hot.md');
    fs.writeFileSync(
      hotPath,
      `---\npalee_schema: 1\nmemory_id: H-active\nlast_session: null\nactive_topic: T-hot-recover\nstarted_at: "${pastTime}"\nupdated_at: 2026-08-30\n---\n# Working Memory\n`,
      'utf8'
    );

    await sessionCommand('end', { topic: 'T-hot-recover' });

    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    const confirmedFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(confirmedFiles.length, 1);

    const sessionContent = fs.readFileSync(path.join(draftsDir, confirmedFiles[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(sessionContent);
    assert.strictEqual(frontmatter?.topic_id, 'T-hot-recover');
    assert.strictEqual(frontmatter?.started_at, pastTime);
    assert.strictEqual(frontmatter?.duration_minutes, 3);

    // Hot memory started_at should now be cleared after session end
    const refreshedHot = fs.readFileSync(hotPath, 'utf8');
    const parsedHot = parseFrontmatter(refreshedHot);
    assert.strictEqual(parsedHot.frontmatter?.started_at, null);

    // Cleanup session file
    fs.unlinkSync(path.join(draftsDir, confirmedFiles[0]));
  });

  test('session end falls back to current instant when neither draft nor hot memory has started_at (Tier 3)', async () => {
    const hotPath = path.join(vaultDir, '.palee', 'hot.md');
    fs.writeFileSync(
      hotPath,
      '---\npalee_schema: 1\nmemory_id: H-active\nlast_session: null\nactive_topic: null\nupdated_at: 2026-08-30\n---\n# Working Memory\n',
      'utf8'
    );

    await sessionCommand('end', { topic: 'T-adhoc-end' });

    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    const confirmedFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(confirmedFiles.length, 1);

    const sessionContent = fs.readFileSync(path.join(draftsDir, confirmedFiles[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(sessionContent);
    assert.strictEqual(frontmatter?.topic_id, 'T-adhoc-end');
    assert.ok(frontmatter?.started_at);
    assert.ok(frontmatter?.ended_at);
    assert.strictEqual(frontmatter?.duration_minutes, 0);

    // Cleanup session file
    fs.unlinkSync(path.join(draftsDir, confirmedFiles[0]));
  });

  test('session end handles corrupt draft frontmatter by falling back to hot.md or current instant', async () => {
    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    fs.mkdirSync(draftsDir, { recursive: true });

    // Write corrupt draft
    fs.writeFileSync(
      path.join(draftsDir, 'DRAFT-S-corrupt.md'),
      '---\npalee_schema: 1\ntopic_id: T-corrupt-draft\nstarted_at: not-a-date\n---\n# Corrupt draft\n',
      'utf8'
    );

    await sessionCommand('end', { topic: 'T-corrupt-draft' });

    const confirmedFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(confirmedFiles.length, 1);

    const sessionContent = fs.readFileSync(path.join(draftsDir, confirmedFiles[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(sessionContent);
    assert.strictEqual(frontmatter?.topic_id, 'T-corrupt-draft');
    assert.strictEqual(frontmatter?.duration_minutes, 0);

    // Cleanup
    const allFiles = fs.readdirSync(draftsDir);
    for (const f of allFiles) {
      try { fs.unlinkSync(path.join(draftsDir, f)); } catch {}
    }
  });

  test('session end handles future clock skew without negative duration', async () => {
    const futureTime = new Date(Date.now() + 120000).toISOString(); // 2 minutes in future
    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    fs.mkdirSync(draftsDir, { recursive: true });

    fs.writeFileSync(
      path.join(draftsDir, 'DRAFT-S-future.md'),
      `---\npalee_schema: 1\nsession_id: DRAFT-S-future\ntopic_id: T-future-test\nstarted_at: "${futureTime}"\nstatus: draft\n---\n# Future Draft\n`,
      'utf8'
    );

    await sessionCommand('end', { topic: 'T-future-test' });

    const confirmedFiles = fs.readdirSync(draftsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(confirmedFiles.length, 1);

    const sessionContent = fs.readFileSync(path.join(draftsDir, confirmedFiles[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(sessionContent);
    assert.strictEqual(frontmatter?.duration_minutes, 0, 'Duration must be clamped to >= 0');

    // Cleanup
    const allFiles = fs.readdirSync(draftsDir);
    for (const f of allFiles) {
      try { fs.unlinkSync(path.join(draftsDir, f)); } catch {}
    }
  });
});
