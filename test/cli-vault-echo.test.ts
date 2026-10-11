import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';

/**
 * #311: `PALEE_CONFIG_DIR` was the only per-run config override and it appeared in no
 * help text, so a scripted run that omitted the export silently read and wrote the
 * machine-global config — and a mutating command then exited 0 having never named the
 * vault it touched. Two parallel automation runs, one un-scoped block, sixteen adopted
 * notes in the other run's tree.
 *
 * These tests pin both halves of the fix: every mutating command says which vault and
 * which config file it resolved (in JSON mode as payload fields, so stdout stays
 * parseable), and the override is discoverable from `--help`.
 */
const ROOT = path.resolve(__dirname, '..');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real CLI with a controlled config resolution.
 *
 * @param env - Variables for the child; `PALEE_CONFIG_DIR` is dropped first, so a run
 * that does not put it back is the incident itself.
 * @param args - CLI argv.
 * @returns The exit status and both streams.
 */
function runCLI(env: Record<string, string>, args: string[]): RunResult {
  const childEnv: Record<string, string> = { ...process.env, ...env } as Record<string, string>;
  delete childEnv.PALEE_CONFIG_DIR;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * The config path the CLI resolves when `PALEE_CONFIG_DIR` is unset — the
 * machine-global one, which is where the incident's writes went.
 */
function globalConfigPath(fakeLocalAppData: string, fakeHome: string): string {
  return process.platform === 'win32'
    ? path.join(fakeLocalAppData, 'palee', 'config.json')
    : path.join(fakeHome, '.config', 'palee', 'config.json');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Vault target echo and PALEE_CONFIG_DIR discoverability (#311)', () => {
  let base: string;
  let vaultX: string;
  let vaultY: string;
  let configA: string;
  let fakeLocalAppData: string;
  let fakeHome: string;
  /** Env that makes a run resolve the machine-global config: no override at all. */
  let fallbackEnv: Record<string, string>;

  const NOTE = '---\ntitle: Echo Topic\n---\n\n# Echo Topic body\n';
  const TOPIC_NOTE = `---
palee_schema: 1
palee_id: T-echo
title: Echo Topic
difficulty: beginner
topic_mastery: 0.5
ease_factor: 2.5
interval_days: 1
repetition: 1
lapses: 0
due_at: 2020-01-01
depends_on: []
---
# Echo Topic
`;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-vault-echo-'));
    vaultX = path.join(base, 'vaultX');
    vaultY = path.join(base, 'vaultY');
    configA = path.join(base, 'configA');
    fakeLocalAppData = path.join(base, 'fake-local-appdata');
    fakeHome = path.join(base, 'fake-home');
    for (const dir of [vaultX, vaultY, configA, fakeLocalAppData, fakeHome]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(vaultX, 'topic.md'), NOTE, 'utf8');
    fs.writeFileSync(path.join(vaultY, 'topic.md'), NOTE, 'utf8');

    // Windows reads %LOCALAPPDATA%, POSIX reads $HOME. Redirecting both pins the
    // fallback to a temp root instead of the developer's real global config.
    fallbackEnv = { LOCALAPPDATA: fakeLocalAppData, USERPROFILE: fakeHome, HOME: fakeHome };
  });

  after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Runs a command scoped to config dir A, whose vault is vault X. */
  function scoped(args: string[]): RunResult {
    return runCLI({ ...fallbackEnv, PALEE_CONFIG_DIR: configA }, args);
  }

  describe('Setup: each config dir points at its own vault', () => {
    test('config dir A resolves to vault X', () => {
      const result = scoped(['config', 'set-vault', vaultX]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Vault path set to:/);
    });

    test('the machine-global config resolves to vault Y', () => {
      const result = runCLI(fallbackEnv, ['config', 'set-vault', vaultY]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(globalConfigPath(fakeLocalAppData, fakeHome)));
    });
  });

  describe('Mutating commands name the vault they act on', () => {
    test('adopt prints the resolved vault and config path', () => {
      const result = scoped(['adopt', 'topic.md', '--yes', '--difficulty', 'beginner']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`• Vault:\\s+${escapeRegExp(path.resolve(vaultX))}`));
      assert.match(result.stdout, new RegExp(`• Config:\\s+${escapeRegExp(path.join(configA, 'config.json'))}`));
    });

    test('roadmap names the vault it imports into', () => {
      const yamlPath = path.join(base, 'roadmap.yaml');
      fs.writeFileSync(
        yamlPath,
        ['topics:', '  - id: T-rm', '    title: Roadmap Topic', '    path: rm.md', '    depends_on: []', ''].join('\n'),
        'utf8'
      );
      const result = scoped(['roadmap', '--from', yamlPath, '--yes']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`• Vault:\\s+${escapeRegExp(path.resolve(vaultX))}`));
    });

    test('review names the vault it rewrote', () => {
      fs.writeFileSync(path.join(vaultX, 'reviewed.md'), TOPIC_NOTE, 'utf8');
      const result = scoped(['review', 'T-echo', '4']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`• Vault:\\s+${escapeRegExp(path.resolve(vaultX))}`));
    });

    test('assess names the vault it rewrote', () => {
      // Its own topic id: `reviewed.md` already carries T-echo, and a duplicate id
      // makes the query ambiguous (exit 2) instead of exercising the write.
      fs.writeFileSync(path.join(vaultX, 'assessed.md'), TOPIC_NOTE.replace('T-echo', 'T-assess'), 'utf8');
      const result = scoped(['assess', 'T-assess', '--conceptual', '0.8']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`• Vault:\\s+${escapeRegExp(path.resolve(vaultX))}`));
    });

    test('a writing migrate names the vault; a read-only migrate does not', () => {
      const writes = scoped(['migrate', '--fix']);
      assert.strictEqual(writes.status, 0, writes.stdout + writes.stderr);
      assert.match(writes.stdout, new RegExp(`• Vault:\\s+${escapeRegExp(path.resolve(vaultX))}`));

      const scans = scoped(['migrate']);
      assert.strictEqual(scans.status, 0, scans.stdout + scans.stderr);
      assert.ok(!/• Vault:/.test(scans.stdout), 'a read-only scan has no write to account for');
    });
  });

  describe('The incident: an un-scoped run says which vault it wrote', () => {
    before(() => {
      // Reset both notes so the on-disk assertions below are unambiguous.
      fs.writeFileSync(path.join(vaultX, 'topic.md'), NOTE, 'utf8');
      fs.writeFileSync(path.join(vaultY, 'topic.md'), NOTE, 'utf8');
    });

    test('adopt with PALEE_CONFIG_DIR unset prints the machine-global vault and config', () => {
      const result = runCLI(fallbackEnv, ['adopt', 'topic.md', '--yes', '--difficulty', 'beginner']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);

      assert.match(
        result.stdout,
        new RegExp(`• Vault:\\s+${escapeRegExp(path.resolve(vaultY))}`),
        'the run must name the vault it adopted into even when it came from the global config'
      );
      assert.match(
        result.stdout,
        new RegExp(`• Config:\\s+${escapeRegExp(globalConfigPath(fakeLocalAppData, fakeHome))}`)
      );
    });

    test('the un-scoped write landed in vault Y and left vault X untouched', () => {
      const inY = fs.readFileSync(path.join(vaultY, 'topic.md'), 'utf8');
      const inX = fs.readFileSync(path.join(vaultX, 'topic.md'), 'utf8');
      assert.match(inY, /^palee_id/m, 'the adopted note carries an id in the global config vault');
      assert.ok(!inX.includes('palee_id'), 'the scoped vault was never written by the un-scoped run');
    });

    test('the echo does not refuse the write: a global-config vault is the normal case', () => {
      // Rejecting a write just because the vault came from the machine-global config
      // would break every single-vault user, so the echo stays informational —
      // visibility, not a gate (#311 expected #3, considered and rejected).
      fs.writeFileSync(path.join(vaultY, 'another.md'), NOTE.replace('Echo Topic', 'Another Topic'), 'utf8');
      const result = runCLI(fallbackEnv, ['adopt', 'another.md', '--yes', '--difficulty', 'beginner']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /• Vault:/);
      assert.ok(!/refus|abort/i.test(result.stdout + result.stderr));
      assert.match(fs.readFileSync(path.join(vaultY, 'another.md'), 'utf8'), /^palee_id/m);
    });
  });

  describe('JSON payloads carry the target', () => {
    test('session start --json reports vault_path and config_path', () => {
      const draftResult = scoped(['session', 'draft', '--topic', 'T-echo']);
      assert.strictEqual(draftResult.status, 0, draftResult.stdout + draftResult.stderr);

      const result = scoped(['session', 'start', '--json']);
      assert.strictEqual(result.status, 2, result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.strictEqual(parsed.status, 'drafts_pending');
      assert.strictEqual(parsed.vault_path, path.resolve(vaultX));
      assert.strictEqual(parsed.config_path, path.join(configA, 'config.json'));
    });

    test('session list --json stays one parseable object with no echo line', () => {
      const result = scoped(['session', 'list', '--json']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      assert.ok(Array.isArray(parsed.confirmed), 'stdout is the payload alone');
    });
  });

  describe('PALEE_CONFIG_DIR is discoverable from --help', () => {
    test('palee --help documents the override', () => {
      const result = runCLI({}, ['--help']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /PALEE_CONFIG_DIR/);
    });

    test('config --help documents the override', () => {
      const result = runCLI({}, ['config', '--help']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /PALEE_CONFIG_DIR/);
    });

    test('adopt --help documents the override', () => {
      const result = runCLI({}, ['adopt', '--help']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /PALEE_CONFIG_DIR/);
    });
  });

  describe('No secret reaches the new output', () => {
    test('config show still masks the key and the echo never prints it', () => {
      const secretDir = path.join(base, 'configSecret');
      fs.mkdirSync(secretDir, { recursive: true });
      const secret = 'sk-DO-NOT-PRINT-1234567890';
      fs.writeFileSync(
        path.join(secretDir, 'config.json'),
        JSON.stringify({ vaultPath: vaultX, apiKey: secret }, null, 2),
        'utf8'
      );
      const env = { ...fallbackEnv, PALEE_CONFIG_DIR: secretDir };

      const show = runCLI(env, ['config', 'show']);
      assert.strictEqual(show.status, 0, show.stderr);
      assert.match(show.stdout, /API Key:\s+•{8}/);
      assert.ok(!show.stdout.includes(secret), 'config show never prints the stored key');

      const showJson = runCLI(env, ['config', 'show', '--json']);
      const parsed = JSON.parse(showJson.stdout) as Record<string, unknown>;
      assert.strictEqual(parsed.api_key_set, true);
      assert.ok(!showJson.stdout.includes(secret));

      const adopt = runCLI(env, ['adopt', 'topic.md', '--yes']);
      assert.strictEqual(adopt.status, 0, adopt.stdout + adopt.stderr);
      assert.match(adopt.stdout, /• Vault:/, 'the echo still fires with a key in the config');
      assert.ok(!adopt.stdout.includes(secret), 'the echo prints paths, never the credential');
      assert.ok(!adopt.stderr.includes(secret));
    });
  });
});
