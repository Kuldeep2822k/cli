/**
 * validate --strict: warning escalation policy (#25)
 *
 * Contracts under test:
 * - Warnings-only vault exits 0 by default (adopted severity policy).
 * - The same vault exits 3 with `strict: true`, in both human and JSON mode.
 * - `--strict` never downgrades errors: errors vault exits 3 with or without
 *   strict, and strict + errors + warnings still exits 3.
 * - A clean vault exits 0 under strict too (strict is an escalation, not a
 *   new failure source).
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateCommand } from '../src/cli/validate';
import { saveConfig } from '../src/cli/config';

describe('validate --strict: warning escalation (#25)', () => {
  let tmpVault: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let loggedOutputs: string[] = [];
  let loggedErrors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-validate-strict-'));
    tmpConfigDir = path.join(tmpVault, '.config');
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tmpConfigDir;
    saveConfig({ vaultPath: tmpVault });
    loggedOutputs = [];
    loggedErrors = [];
    console.log = (...args: unknown[]) => {
      loggedOutputs.push(args.map((a) => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map((a) => String(a)).join(' '));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    try {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Writes a valid topic note. */
  function writeTopic(name: string, paleeId: string, dependsOn: string[] = []): void {
    const deps = dependsOn.length > 0
      ? `depends_on:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}\n`
      : 'depends_on: []\n';
    fs.writeFileSync(
      path.join(tmpVault, name),
      `---\npalee_schema: 1\npalee_id: ${paleeId}\ntitle: ${paleeId}\ndifficulty: beginner\n${deps}---\n# ${paleeId}\n`,
      'utf8'
    );
  }

  /** Writes a note with malformed frontmatter — a warnings-only trigger. */
  function writeMalformedNote(): void {
    fs.writeFileSync(
      path.join(tmpVault, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );
  }

  test('warnings-only vault exits 0 without strict', async () => {
    writeTopic('good.md', 'T-good');
    writeMalformedNote();

    await validateCommand({});

    assert.strictEqual(process.exitCode, 0);
  });

  test('warnings-only vault exits 3 with strict (human mode)', async () => {
    writeTopic('good.md', 'T-good');
    writeMalformedNote();

    await validateCommand({ strict: true });

    assert.strictEqual(process.exitCode, 3);
  });

  test('warnings-only vault exits 3 with strict (JSON mode)', async () => {
    writeTopic('good.md', 'T-good');
    writeMalformedNote();

    await validateCommand({ json: true, strict: true });

    assert.strictEqual(process.exitCode, 3);
    // JSON contract stays intact under strict: warnings[] present, valid true
    // (valid reflects errors only; strict escalates the exit code, not the
    // payload contract).
    const jsonLine = loggedOutputs.find((line) => line.includes('"valid"'));
    assert.ok(jsonLine, 'expected a JSON output line');
    const parsed = JSON.parse(jsonLine) as { valid: boolean; warning_count: number };
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.warning_count, 1);
  });

  test('clean vault exits 0 with strict — escalation adds no failure source', async () => {
    writeTopic('good.md', 'T-good');

    await validateCommand({ strict: true });

    assert.strictEqual(process.exitCode, 0);
    const out = loggedOutputs.join('\n');
    assert.match(out, /Found 1 PALEE topics in 1 files/);
  });

  test('errors vault exits 3 regardless of strict', async () => {
    writeTopic('bad.md', 'T-not-kebab-UPPER'); // invalid topic-id-format (error)
    writeTopic('good.md', 'T-good');

    await validateCommand({});
    assert.strictEqual(process.exitCode, 3);

    process.exitCode = 0;
    loggedOutputs = [];

    await validateCommand({ strict: true });
    assert.strictEqual(process.exitCode, 3);
  });

  test('strict with errors and warnings still exits 3 (no downgrade)', async () => {
    writeTopic('bad.md', 'T-not-kebab-UPPER'); // error
    writeMalformedNote(); // warning

    await validateCommand({ strict: true });

    assert.strictEqual(process.exitCode, 3);
  });
});
