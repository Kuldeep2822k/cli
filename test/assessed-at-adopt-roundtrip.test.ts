/**
 * assessed_at adopt + validate round-trip (issue #171 finding 4 / #179)
 *
 * Full integration: adopt a note with numeric epoch assessed_at, then validate
 * the adopted result — the round-tripped value must pass isValidAssessedAt
 * and `palee validate` must report zero errors.
 *
 * Before the fix, adopt.ts String()-ified assessed_at, producing
 * assessed_at: "1771075200000" in the written YAML, which the rule rejects.
 *
 * After the fix, adopt.ts normalizes via normalizeAssessedAt, so a numeric
 * epoch-ms becomes an ISO 8601 string in the persisted frontmatter.
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
import { validateCommand } from '../src/cli/validate';

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

/**
 * Runs `palee validate --json` in-process against the given vault and returns
 * the parsed JSON result.
 *
 * @remarks Captures stdout via a temporary listener so the test can assert
 * on the exact `valid` / `error_count` contract keys without spawning a
 * subprocess. The caller must point `PALEE_CONFIG_DIR` at a config whose
 * `vaultPath` is set before calling.
 *
 * @returns Parsed JSON output from `validateCommand({ json: true })`
 */
async function runValidateJson(): Promise<{
  valid: boolean;
  error_count: number;
  errors: unknown[];
}> {
  const chunks: Buffer[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  return new Promise((resolve) => {
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    void validateCommand({ json: true }).then(() => {
      process.stdout.write = originalWrite;
      const output = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(output);
      resolve({
        valid: parsed.valid,
        error_count: parsed.error_count,
        errors: parsed.errors ?? [],
      });
    });
  });
}

describe('assessed_at adopt round-trip (#171 finding 4 / #179)', () => {
  const epochMs = 1771075200000;
  const expectedIso = new Date(epochMs).toISOString();
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

  it('adopted note with numeric assessed_at normalizes to ISO 8601', async () => {
    // Write a note with a numeric assessed_at that adopt should normalize.
    const preContent = `---\nassessed_at: ${epochMs}\n---\n# Epoch Topic\n`;
    fs.writeFileSync(path.join(vaultDir, 'pre-epoch.md'), preContent, 'utf8');

    const { default: adoptCommand } = await import('../src/cli/adopt');
    await adoptCommand('pre-epoch.md', { yes: true });

    // Read back the adopted file
    const adopted = fs.readFileSync(path.join(vaultDir, 'pre-epoch.md'), 'utf8');
    const { frontmatter } = parseFrontmatter(adopted);
    assert.ok(frontmatter, 'adopted note must have frontmatter');
    assert.ok(frontmatter.palee_id, 'adopted note must have palee_id');

    // The persisted assessed_at must be the normalized ISO string and pass the rule.
    assert.strictEqual(frontmatter.assessed_at, expectedIso,
      'numeric epoch must be normalized to ISO 8601 in persisted frontmatter');
    assert.strictEqual(isValidAssessedAt(frontmatter.assessed_at), true,
      `frontmatter assessed_at=${frontmatter.assessed_at} must pass rule`);

    // Also verify through the loader
    const topics = loadTopics(vaultDir);
    const topic = topics.find((t) => t.palee_id === frontmatter.palee_id);
    assert.ok(topic, 'adopted topic should load');
    assert.strictEqual(isValidAssessedAt(topic.assessed_at), true,
      `loaded assessed_at=${topic.assessed_at} must pass rule`);

    // Run the actual `palee validate` flow on the adopted vault and assert
    // zero validation errors — this catches writer/validator contract breaks
    // (issue #179) that the frontmatter-only checks above would miss.
    const validateResult = await runValidateJson();
    assert.strictEqual(validateResult.valid, true,
      `validate must pass on adopted vault; errors: ${JSON.stringify(validateResult.errors)}`);
    assert.strictEqual(validateResult.error_count, 0,
      'adopted vault must produce zero validation errors');
  });
});
