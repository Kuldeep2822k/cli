import { test, describe, before, after } from 'node:test';
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
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolveSessionTopic returns explicit topic if given', () => {
    const topic = resolveSessionTopic(vaultDir, 'T-kubernetes-basics');
    assert.strictEqual(topic, 'T-kubernetes-basics');
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

  test('resolveSessionTopic exits 2 when active_topic is missing or (none)', () => {
    const paleeDir = path.join(vaultDir, '.palee');
    const hotPath = path.join(paleeDir, 'hot.md');
    fs.writeFileSync(
      hotPath,
      '---\npalee_schema: 1\nactive_topic: "(none)"\n---\n# Working Memory\n',
      'utf8'
    );

    let exitCode: number | undefined;
    const origExit = process.exit;
    const origError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit:${code}`);
    }) as any;

    try {
      assert.throws(() => resolveSessionTopic(vaultDir), /process\.exit:2/);
      assert.strictEqual(exitCode, 2);
    } finally {
      process.exit = origExit;
      console.error = origError;
    }
  });

  test('resolveSessionTopic exits 2 when hot.md has corrupt frontmatter', () => {
    const paleeDir = path.join(vaultDir, '.palee');
    const hotPath = path.join(paleeDir, 'hot.md');
    fs.writeFileSync(hotPath, 'corrupt without frontmatter', 'utf8');

    let exitCode: number | undefined;
    const origExit = process.exit;
    const origError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit:${code}`);
    }) as any;

    try {
      assert.throws(() => resolveSessionTopic(vaultDir), /process\.exit:2/);
      assert.strictEqual(exitCode, 2);
    } finally {
      process.exit = origExit;
      console.error = origError;
    }
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

  test('sessionCommand exits 2 on unknown action', async () => {
    let exitCode: number | undefined;
    const origExit = process.exit;
    const origError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit:${code}`);
    }) as any;

    try {
      await assert.rejects(async () => {
        await sessionCommand('invalid-action');
      }, /process\.exit:2/);
      assert.strictEqual(exitCode, 2);
    } finally {
      process.exit = origExit;
      console.error = origError;
    }
  });
});
