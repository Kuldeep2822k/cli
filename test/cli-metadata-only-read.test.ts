import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { nextCommand } from '../src/cli/next';
import { planCommand } from '../src/cli/plan';
import { dashboardCommand } from '../src/cli/dashboard';
import { progressCommand } from '../src/cli/progress';
import { saveConfig } from '../src/cli/config';

/**
 * P3-06 — `next`, `plan`, `dashboard` and `progress` never read a note body,
 * so none of them may load topics through the full-body path.
 *
 * Each run below makes every `fs.readFileSync` inside the vault **throw**. The
 * full load would swallow that throw per note (the loader skips unreadable
 * files), so a revert to `loadTopics` does not crash these commands — it
 * silently empties them, which the output assertions reject: the topic the
 * vault carries must still be reported.
 */

describe('read-only commands load metadata only (P3-06)', () => {
  let tmpDir: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let prevPaleeJson: string | undefined;
  let loggedOutputs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    prevPaleeJson = process.env.PALEE_JSON;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-meta-cli-'));
    tmpConfigDir = path.join(tmpDir, '.config');
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tmpConfigDir;
    // This suite pins the read path through flags, not the environment: an
    // ambient PALEE_JSON would flip the human-readable reports into JSON (#357).
    delete process.env.PALEE_JSON;
    saveConfig({ vaultPath: tmpDir });

    // One topic note with a body big enough that reading it would be visible
    // in any IO probe — the assertions below never depend on its size, only
    // on the topic surviving a run in which the body is unreadable.
    fs.writeFileSync(
      path.join(tmpDir, 'topic.md'),
      '---\n' +
      'palee_schema: 1\n' +
      'palee_id: T-meta\n' +
      'title: Metadata Only\n' +
      'difficulty: beginner\n' +
      'topic_mastery: 0\n' +
      'depends_on: []\n' +
      '---\n' +
      `# Metadata Only\n${'x'.repeat(200 * 1024)}\n`,
      'utf8'
    );

    loggedOutputs = [];
    console.log = (...args: unknown[]) => {
      loggedOutputs.push(args.map((a) => String(a)).join(' '));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    if (prevPaleeJson !== undefined) {
      process.env.PALEE_JSON = prevPaleeJson;
    } else {
      delete process.env.PALEE_JSON;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function allOutput(): string {
    return loggedOutputs.join('\n');
  }

  /**
   * Runs `body` with every `fs.readFileSync` under the vault root throwing.
   *
   * @remarks
   * The prefix is `realpathSync(vaultPath)` because `walkVault` resolves the
   * vault root through realpath before joining note paths, so the thrown
   * predicate and the loader's paths always agree. The config file (in the
   * `.config` directory inside the temp root) stays readable: `walkVault`
   * skips dot-dirs, so it is not part of the vault scan, and `loadConfig`
   * must keep working for the handler to reach the loader at all.
   */
  function withVaultReadsForbidden<T>(body: () => T): T {
    const vaultRoot = fs.realpathSync(tmpDir);
    const configRoot = fs.realpathSync(tmpConfigDir) + path.sep;
    const original = fs.readFileSync;
    const holder = fs as unknown as { readFileSync: typeof fs.readFileSync };
    holder.readFileSync = ((filePath: unknown, ...rest: unknown[]): unknown => {
      if (
        typeof filePath === 'string' &&
        !filePath.startsWith(configRoot) &&
        (filePath === vaultRoot || filePath.startsWith(vaultRoot + path.sep))
      ) {
        throw new Error(`full-body readFileSync attempted on ${filePath}`);
      }
      return (original as unknown as (...args: unknown[]) => unknown).apply(fs, [filePath, ...rest]);
    }) as typeof fs.readFileSync;
    try {
      return body();
    } finally {
      holder.readFileSync = original;
    }
  }

  test('next reports the topic without reading the vault\u2019s bodies', async () => {
    await withVaultReadsForbidden(async () => {
      await nextCommand({});
    });
    assert.strictEqual(process.exitCode, 0, 'next must succeed with the body unreadable');
    const text = allOutput();
    assert.match(text, /Next topic due for review:/, 'the never-reviewed topic must be actionable');
    assert.ok(text.includes('T-meta'), 'next must name the topic it loaded metadata for');
  });

  test('plan reports the topic without reading the vault\u2019s bodies', async () => {
    await withVaultReadsForbidden(async () => {
      await planCommand({});
    });
    assert.strictEqual(process.exitCode, 0, 'plan must succeed with the body unreadable');
    assert.ok(allOutput().includes('T-meta'), 'plan must include the topic it loaded metadata for');
  });

  test('dashboard reports the topic without reading the vault\u2019s bodies', async () => {
    await withVaultReadsForbidden(async () => {
      await dashboardCommand({});
    });
    assert.strictEqual(process.exitCode, 0, 'dashboard must succeed with the body unreadable');
    const text = allOutput();
    assert.match(text, /Total Topics:\s+1/, 'exactly the one topic must load');
    assert.ok(text.includes('T-meta'), 'dashboard must name the topic it loaded metadata for');
  });

  test('progress reports the topic without reading the vault\u2019s bodies', async () => {
    await withVaultReadsForbidden(async () => {
      await progressCommand({});
    });
    assert.strictEqual(process.exitCode, 0, 'progress must succeed with the body unreadable');
    const text = allOutput();
    assert.match(text, /Active Topics: 1/, 'exactly the one topic must load');
    // The aggregate report lists no titles; the beginner bucket carrying the
    // note (difficulty: beginner, mastery 0) proves the topic really loaded.
    assert.match(text, /beginner: 1 topics/, 'the by-difficulty rollup must carry the loaded topic');
  });

  test('progress --topic resolves the query against metadata too', async () => {
    await withVaultReadsForbidden(async () => {
      await progressCommand({ topic: 'T-meta' });
    });
    assert.strictEqual(process.exitCode, 0, 'progress --topic must succeed with the body unreadable');
    const text = allOutput();
    assert.match(text, /Progress for: Metadata Only/, 'the query must resolve on metadata');
    assert.ok(text.includes('ID: T-meta'), 'the resolved topic must be the vault\u2019s note');
  });
});
