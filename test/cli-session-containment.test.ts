/**
 * `palee session end` against a junctioned `.palee/sessions` directory (#264)
 *
 * The issue's repro, end to end: with `vault\.palee\sessions` planted as a link
 * to a directory outside the vault, `palee session end` printed
 * `✓ Session recorded … Path: .palee\sessions\S-…md`, exited 0, and filed the
 * note outside the vault. `getSessionsDir` gates on `existsSync`, which follows
 * links, so nothing on the path between the command and the disk ever asked
 * where the bytes were going.
 *
 * The guard lives in `atomicWrite`, which the session, roadmap, adopt and
 * migrate paths all funnel through; these tests pin the CLI-observable contract
 * of that guard — a refusal on stderr, the vault-integrity exit code, the
 * `✓ Session recorded` line never printed, and nothing written outside — plus
 * the ordinary session end that must keep working.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';

/** Symlink type that works on both POSIX and Windows without elevated rights. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Removes a link to a directory portably (`unlink` on POSIX, `rmdir` on win32). */
function removeLink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    try {
      fs.rmdirSync(linkPath);
    } catch {
      // Already gone.
    }
  }
}

describe('palee session end containment', () => {
  let baseDir: string;
  const createdLinks: string[] = [];

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-session-containment-'));
  });

  after(() => {
    for (const linkPath of createdLinks) {
      removeLink(linkPath);
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /**
   * Builds a fresh vault + config dir. With `junctionSessions`, the vault's
   * `.palee/sessions` is a link to a directory that sits outside the vault.
   */
  function makeFixture(name: string, junctionSessions: boolean): {
    configDir: string;
    vault: string;
    sessionsDir: string;
    outsideDir: string;
  } {
    const root = fs.mkdtempSync(path.join(baseDir, `${name}-`));
    const configDir = path.join(root, 'config');
    const vault = path.join(root, 'vault');
    const outsideDir = path.join(root, 'outside-sessions');
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(vault, '.palee'), { recursive: true });
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ vaultPath: vault }, null, 2),
      'utf8'
    );

    const sessionsDir = path.join(vault, '.palee', 'sessions');
    if (junctionSessions) {
      fs.symlinkSync(outsideDir, sessionsDir, LINK_TYPE);
      createdLinks.push(sessionsDir);
    } else {
      fs.mkdirSync(sessionsDir);
    }
    return { configDir, vault, sessionsDir, outsideDir };
  }

  /** Runs the CLI in a child process against the given config dir. */
  function runCLI(
    configDir: string,
    args: string[]
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [...PALEE_ARGV, ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: configDir },
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  test('refuses a junctioned sessions dir, exits nonzero, writes nothing outside', () => {
    const { configDir, vault, sessionsDir, outsideDir } = makeFixture('junction', true);

    const result = runCLI(configDir, ['session', 'end', '--topic', 'T-264']);

    assert.notStrictEqual(result.status, 0, `the escaping write must not report success: ${result.stdout}`);
    // Vault integrity, not an unexpected crash: this is the code `palee roadmap`
    // already returns for a topic path that escapes the vault.
    assert.strictEqual(result.status, 3, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.match(result.stderr, /Security error: refusing to write outside the vault/);
    assert.ok(
      result.stderr.includes(sessionsDir),
      `the refusal must name the path it refused: ${result.stderr}`
    );
    assert.doesNotMatch(result.stdout, /Session recorded/, 'the success line must not be printed');
    assert.deepStrictEqual(fs.readdirSync(outsideDir), [], 'no session note may land outside the vault');
    assert.ok(fs.lstatSync(sessionsDir).isSymbolicLink(), 'the planted link must survive untouched');
    assert.strictEqual(
      fs.existsSync(path.join(vault, '.palee', 'locks')),
      false,
      'the refusal must precede lock creation'
    );
  });

  test('records the session normally when .palee/sessions is a real directory', () => {
    const { configDir, vault, sessionsDir, outsideDir } = makeFixture('plain', false);

    const result = runCLI(configDir, ['session', 'end', '--topic', 'T-264']);

    assert.strictEqual(result.status, 0, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.match(result.stdout, /Session recorded/);
    const written = fs.readdirSync(sessionsDir).filter((f) => f.startsWith('S-'));
    assert.strictEqual(written.length, 1, 'exactly one session note must be filed inside the vault');
    assert.deepStrictEqual(fs.readdirSync(outsideDir), [], 'nothing may be filed outside the vault');
    assert.ok(fs.existsSync(path.join(vault, '.palee', 'index.md')), 'the derived views must still rebuild');
  });

  test('a junctioned .palee itself creates no directory outside the vault', () => {
    // The residual the write guard left open: `getSessionsDir` gates on
    // `existsSync`, which follows links, so it walked *through* a junctioned
    // `.palee` and `mkdirSync(…, { recursive: true })` created `<outside>\sessions`
    // before `atomicWrite` ever saw a path it had to refuse. Exit 3 with a
    // directory made outside the vault is still a planted link winning.
    const root = fs.mkdtempSync(path.join(baseDir, 'junction-palee-'));
    const configDir = path.join(root, 'config');
    const vault = path.join(root, 'vault');
    const outsidePalee = path.join(root, 'outside-palee');
    fs.mkdirSync(configDir);
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(outsidePalee);
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ vaultPath: vault }, null, 2),
      'utf8'
    );
    const paleeDir = path.join(vault, '.palee');
    fs.symlinkSync(outsidePalee, paleeDir, LINK_TYPE);
    createdLinks.push(paleeDir);

    const result = runCLI(configDir, ['session', 'end', '--topic', 'T-264']);

    assert.strictEqual(result.status, 3, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.match(result.stderr, /Security error: refusing to write outside the vault/);
    assert.ok(
      result.stderr.includes(paleeDir),
      `the refusal must name the .palee tree it refused: ${result.stderr}`
    );
    assert.doesNotMatch(result.stdout, /Session recorded/, 'the success line must not be printed');
    assert.deepStrictEqual(
      fs.readdirSync(outsidePalee),
      [],
      'the refusal must create nothing outside the vault, not even .palee/sessions'
    );
    assert.deepStrictEqual(fs.readdirSync(vault), ['.palee'], 'the vault gains no directory either');
  });
});
