import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * `palee roadmap --from` reads a topic path that already exists as a note, and
 * it is routinely pointed at cloned study repositories. Until the write path
 * checked the final component, a repository that shipped `linked.md` as a
 * symlink to a file outside the vault had that file read as the note's existing
 * content and then replaced: outside content absorbed into the vault, link
 * destroyed.
 */
describe('roadmap import refuses a symlinked note path', () => {
  const NL = String.fromCharCode(10);
  let tempDir: string;
  let vaultDir: string;
  let outsideDir: string;
  let origConfigDir: string | undefined;

  before(() => {
    origConfigDir = process.env.PALEE_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-symlink-vault-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-symlink-outside-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir);
    process.env.PALEE_CONFIG_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }, null, 2),
      'utf8'
    );
  });

  after(() => {
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  /** Runs the CLI in a child process against this suite's vault. */
  function runCLI(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve(__dirname, '../bin/palee.ts'), ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /** Writes a roadmap YAML importing `path` as a single topic. */
  function roadmapWith(pathValue: string): string {
    const file = path.join(tempDir, `roadmap-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(
      file,
      ['topics:', '  - id: T-link', '    title: Linked', `    path: ${pathValue}`, ''].join(NL)
    );
    return file;
  }

  test('a symlinked target is not imported, and the outside file survives', (t) => {
    const canary = ['---', 'title: Outside', '---', '', '# OUTSIDE-CANARY-DO-NOT-TOUCH', ''].join(NL);
    const outsideFile = path.join(outsideDir, 'canary.md');
    fs.writeFileSync(outsideFile, canary);

    const linkPath = path.join(vaultDir, 'linked.md');
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      t.skip('file symlink creation is not permitted on this platform');
      return;
    }

    const result = runCLI(['roadmap', '--from', roadmapWith('linked.md'), '--yes']);

    // Pre-fix this reported `Created: 1` and rewrote the outside file into the
    // vault, so the import had to fail for the guard to be observable.
    assert.notStrictEqual(result.status, 0, 'a symlinked note path must not import successfully');
    assert.match(result.stdout + result.stderr, /not a regular file/, 'the skip must be reported');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), canary, 'the outside file must not be rewritten');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'the symlink itself must not be replaced');
  });

  test('a regular note inside the vault still imports normally', () => {
    const result = runCLI(['roadmap', '--from', roadmapWith('plain.md'), '--yes']);
    assert.strictEqual(result.status, 0, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(vaultDir, 'plain.md')), 'the ordinary path must still import');
  });
});
