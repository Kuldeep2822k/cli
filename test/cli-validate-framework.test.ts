/**
 * validate command: framework-wired behavior tests (#25)
 *
 * Contracts under test:
 * - Malformed frontmatter produces a warning, never an abort — and valid
 *   topics in the same vault are still checked (invariant invariants.md:17).
 * - Warnings alone exit 0; errors exit 3 (adopted severity policy).
 * - JSON mode emits the documented contract with additive warnings[].
 * - --fix stays a non-mutating stub.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateCommand } from '../src/cli/validate';
import { saveConfig } from '../src/cli/config';

describe('validate command: framework wiring (#25)', () => {
  let tmpVault: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let loggedOutputs: string[] = [];
  let loggedErrors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-validate-fw-'));
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

  test('malformed frontmatter yields a warning, not a crash; other topics still validated', async () => {
    writeTopic('good.md', 'T-good');
    fs.writeFileSync(
      path.join(tmpVault, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );

    await validateCommand({});

    const out = loggedOutputs.join('\n');
    assert.match(out, /parse-frontmatter|Malformed frontmatter/);
    assert.match(out, /broken\.md/);
    // The valid topic was still collected and reported.
    assert.match(out, /Found 1 PALEE topics in 2 files/);
    // A warning alone never sets exit 3.
    assert.notStrictEqual(process.exitCode, 3);
    assert.strictEqual(process.exitCode, 0);
  });

  test('warnings-only vault exits 0 in JSON mode', async () => {
    fs.writeFileSync(
      path.join(tmpVault, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );

    await validateCommand({ json: true });

    const data = JSON.parse(loggedOutputs[loggedOutputs.length - 1]);
    assert.strictEqual(data.valid, true);
    assert.strictEqual(data.error_count, 0);
    assert.strictEqual(data.warning_count, 1);
    assert.strictEqual(data.warnings[0].rule_id, 'parse-frontmatter');
    assert.strictEqual(process.exitCode, 0);
  });

  test('error vault exits 3 in JSON mode; errors keep legacy type keys', async () => {
    writeTopic('broken-dep.md', 'T-broken', ['T-does-not-exist']);

    await validateCommand({ json: true });

    const data = JSON.parse(loggedOutputs[loggedOutputs.length - 1]);
    assert.strictEqual(data.valid, false);
    assert.strictEqual(data.error_count, 1);
    assert.strictEqual(data.errors[0].type, 'missing_dependency');
    assert.strictEqual(data.errors[0].rule_id, 'no-missing-dependency');
    assert.strictEqual(process.exitCode, 3);
  });

  test('duplicate IDs report one error per ID with all files (human mode)', async () => {
    writeTopic('a.md', 'T-dup');
    writeTopic('b.md', 'T-dup');

    await validateCommand({});

    const out = loggedOutputs.join('\n');
    assert.match(out, /✗ Found 1 validation error\(s\)/);
    assert.match(out, /Duplicate topic ID: T-dup/);
    assert.match(out, /a\.md, b\.md/);
    assert.strictEqual(process.exitCode, 3);
  });

  test('mixed errors and warnings: exit 3, errors print before warnings', async () => {
    writeTopic('broken-dep.md', 'T-broken', ['T-x']);
    fs.writeFileSync(
      path.join(tmpVault, 'bad-yaml.md'),
      '---\ntags: [broken\n---\n# Personal\n',
      'utf8'
    );

    await validateCommand({});

    const out = loggedOutputs.join('\n');
    assert.match(out, /✗ Found 1 validation error\(s\)/);
    assert.match(out, /⚠ Found 1 validation warning\(s\)/);
    const errIdx = out.indexOf('✗');
    const warnIdx = out.indexOf('⚠');
    assert.ok(errIdx < warnIdx, 'errors must print before warnings');
    assert.strictEqual(process.exitCode, 3);
  });

  test('--fix stays a non-mutating stub', async () => {
    writeTopic('broken-dep.md', 'T-broken', ['T-x']);

    const before = fs.readFileSync(path.join(tmpVault, 'broken-dep.md'), 'utf8');
    await validateCommand({ fix: true });
    const after = fs.readFileSync(path.join(tmpVault, 'broken-dep.md'), 'utf8');

    assert.strictEqual(before, after);
    assert.match(loggedOutputs.join('\n'), /--fix is not implemented/);
    assert.strictEqual(process.exitCode, 3);
  });

  test('clean vault exits 0 and prints the pass line (human mode)', async () => {
    writeTopic('clean.md', 'T-clean');

    await validateCommand({});

    assert.match(loggedOutputs.join('\n'), /✓ Vault validation passed - no errors found/);
    assert.strictEqual(process.exitCode, 0);
  });

  test('unsupported palee_schema is an error and exits 3 (wave 4 #28)', async () => {
    fs.writeFileSync(
      path.join(tmpVault, 'future.md'),
      '---\npalee_schema: 999\npalee_id: T-future\ntitle: Future\n---\n# Future\n',
      'utf8'
    );

    await validateCommand({});

    const out = loggedOutputs.join('\n');
    assert.match(out, /valid-palee-schema/);
    assert.match(out, /palee_schema/);
    assert.strictEqual(process.exitCode, 3);
  });

  test('pseudo-status completed is an error and exits 3 (wave 4 #31)', async () => {
    fs.writeFileSync(
      path.join(tmpVault, 'done.md'),
      '---\npalee_schema: 1\npalee_id: T-done\ntitle: Done\nstatus: completed\n---\n# Done\n',
      'utf8'
    );

    await validateCommand({});

    const out = loggedOutputs.join('\n');
    assert.match(out, /valid-topic-status/);
    assert.match(out, /completed/);
    assert.strictEqual(process.exitCode, 3);
  });

  test('adopt-style topic note with no status stays clean (default policy)', async () => {
    // adopt writes no status key; missing status is the documented default,
    // not a defect — the vault must still validate fully clean.
    fs.writeFileSync(
      path.join(tmpVault, 'fresh.md'),
      '---\npalee_schema: 1\npalee_id: T-fresh\ntitle: Fresh\n---\n# Fresh\n',
      'utf8'
    );

    await validateCommand({});

    assert.match(loggedOutputs.join('\n'), /✓ Vault validation passed - no errors found/);
    assert.strictEqual(process.exitCode, 0);
  });
});
