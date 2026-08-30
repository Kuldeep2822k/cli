import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSessionTopic, sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';

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
  });

  afterEach(() => {
    process.exitCode = undefined;
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
});
