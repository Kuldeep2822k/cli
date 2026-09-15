/**
 * assessed_at adopt CLI round-trip (issue #171 finding 4)
 *
 * Full integration: adopt a note with numeric epoch assessed_at,
 * then validate the adopted result — the round-tripped value must
 * pass isValidAssessedAt.
 *
 * Before the fix, adopt.ts String()-ified assessed_at, producing
 * assessed_at: "1771075200000" in the written YAML, which the rule rejects.
 *
 * @remarks On Windows, config lives in %LOCALAPPDATA%/palee; we override
 * via PALEE_CONFIG_DIR so the test is platform-independent.
 */
import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { loadTopics } from '../src/storage/loader';
import { isValidAssessedAt } from '../src/validation/rules/assessed-at';

let origConfigDir: string | undefined;
let origHome: string | undefined;

before(() => {
  origConfigDir = process.env.PALEE_CONFIG_DIR;
  origHome = process.env.HOME;
});

after(() => {
  if (origConfigDir !== undefined) process.env.PALEE_CONFIG_DIR = origConfigDir;
  else delete process.env.PALEE_CONFIG_DIR;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
});

describe('assessed_at adopt round-trip (#171 finding 4)', () => {
  const epochMs = 1771075200000;
  let vaultDir: string;
  let configDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-vault-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-'));
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }),
      'utf8'
    );
    process.env.PALEE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('adopted note with numeric assessed_at round-trips as a valid date', async () => {
    // Write a note with a numeric assessed_at that adopt should preserve
    const preContent = `---\nassessed_at: ${epochMs}\n---\n# Epoch Topic\n`;
    fs.writeFileSync(path.join(vaultDir, 'pre-epoch.md'), preContent, 'utf8');

    const { default: adoptCommand } = await import('../src/cli/adopt');
    await adoptCommand('pre-epoch.md', { yes: true });

    // Read back the adopted file
    const adopted = fs.readFileSync(path.join(vaultDir, 'pre-epoch.md'), 'utf8');
    const { frontmatter } = parseFrontmatter(adopted);
    assert.ok(frontmatter, 'adopted note must have frontmatter');
    assert.ok(frontmatter.palee_id, 'adopted note must have palee_id');

    // The persisted assessed_at must pass the rule (not stringified digits).
    assert.strictEqual(isValidAssessedAt(frontmatter.assessed_at), true,
      `frontmatter assessed_at=${frontmatter.assessed_at} (${typeof frontmatter.assessed_at}) must pass rule`);

    // Also verify through the loader
    const topics = loadTopics(vaultDir);
    const topic = topics.find(t => t.palee_id === frontmatter.palee_id);
    assert.ok(topic, 'adopted topic should load');
    assert.strictEqual(isValidAssessedAt(topic.assessed_at), true,
      `loaded assessed_at=${topic.assessed_at} (${typeof topic.assessed_at}) must pass rule`);
  });
});
