import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PALEE_ARGV } from './palee-cli';
import { deriveProgramName, programName } from '../src/cli/program-name';

/**
 * #314: help text, usage lines and "Run: ..." hints must name the binary the
 * learner actually invoked, not the published `palee` bin. The audit that filed
 * the issue installed the CLI as `palee-test` so a worktree build could be
 * exercised next to the published command, and every suggested invocation came
 * back naming a command that was not there.
 */

const ROOT = path.resolve(__dirname, '..');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('program name follows the invoked bin (#314)', () => {
  let tempDir: string;
  let configDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-program-name-'));
    configDir = path.join(tempDir, 'config');
    // No config.json: the reading commands stop at the vault hint, which is one
    // of the strings under test.
    fs.mkdirSync(configDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Runs a copy of the CLI entry under another file name, which is what a
   * renamed install leaves on disk: `argv[1]` carries the invoked name. The copy
   * goes beside the real entry, because the entry resolves `../package.json` and
   * its dependencies relative to its own directory.
   */
  function runAs(invokedName: string, args: string[], env?: Record<string, string>): Run {
    const realEntry = path.resolve(ROOT, PALEE_ARGV[PALEE_ARGV.length - 1]);
    const entry = path.join(path.dirname(realEntry), invokedName);
    fs.copyFileSync(realEntry, entry);
    try {
      const result = spawnSync(process.execPath, [entry, ...args], {
        cwd: ROOT,
        env: { ...process.env, PALEE_CONFIG_DIR: configDir, ...(env || {}) },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    } finally {
      fs.rmSync(entry, { force: true });
    }
  }

  function runPalee(args: string[]): Run {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: ROOT,
      env: { ...process.env, PALEE_CONFIG_DIR: configDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  // The derivation is the single source every string reads from, so it is pinned
  // directly. The two shapes `argv[1]` arrives in are a bin shim (no script
  // extension) and the entry file (stripped the way Commander strips it), and
  // `path.extname` says a dot-file has no extension at all.
  test('deriveProgramName() derives the invoked bin from the entry path', () => {
    assert.equal(deriveProgramName('/usr/local/bin/palee-test'), 'palee-test');
    assert.equal(deriveProgramName('/tmp/palee.js'), 'palee');
    assert.equal(deriveProgramName('/tmp/palee.ts'), 'palee');
    // Only a script extension is stripped — a dotted bin name stays whole.
    assert.equal(deriveProgramName('/tmp/palee.v2'), 'palee.v2');
    // No usable name falls back to the published bin, never to Commander's 'program'.
    assert.equal(deriveProgramName(''), 'palee');
    // Omitting the argument reads this process's own entry, not the fallback.
    assert.equal(deriveProgramName(), deriveProgramName(process.argv[1]));
  });

  // A handler imported without `bin/palee.ts` pinned nothing on Commander, so it
  // prints the published bin rather than the host script's own name. This is why
  // the in-process `palee validate --fix` pin in cli-validate-fix-sm2.test.ts
  // keeps passing unchanged.
  test('programName() falls back to the published bin in-process', () => {
    assert.equal(programName(), 'palee');
  });

  test('the published name is unchanged when invoked as palee', () => {
    const help = runPalee(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: palee \[options\] \[command\]/m);

    const sub = runPalee(['assess', '--help']);
    assert.match(sub.stdout, /^Usage: palee assess \[options\] <topic>/m);
  });

  test('top-level --help reports the invoked bin, not palee', () => {
    const help = runAs('palee-test.js', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: palee-test \[options\] \[command\]/m);
    assert.doesNotMatch(help.stdout, /Usage: palee \[/);
  });

  test('subcommand --help reports the invoked bin too', () => {
    const sub = runAs('palee-test.js', ['assess', '--help']);
    assert.match(sub.stdout, /^Usage: palee-test assess \[options\] <topic>/m);
    assert.doesNotMatch(sub.stdout, /Usage: palee assess/);

    const configSub = runAs('palee-test.js', ['config', '--help']);
    assert.match(configSub.stdout, /^Usage: palee-test config \[options\]/m);
  });

  test('a usage error under a renamed bin names the renamed bin', () => {
    // Commander's own path: a bare invocation prints help on stderr.
    const bare = runAs('palee-test.js', []);
    assert.equal(bare.status, 0);
    assert.match(bare.stderr, /Usage: palee-test \[options\] \[command\]/);
    assert.doesNotMatch(bare.stderr, /Usage: palee \[/);

    // The hand-written usage line in `assess`, which Commander does not render.
    const assess = runAs('palee-test.js', ['assess', 'some-topic']);
    assert.equal(assess.status, 2);
    assert.match(assess.stderr, /Usage: palee-test assess <topic>/);
  });

  test('the onboarding hint and examples name the invoked bin', () => {
    const res = runAs('palee-test.js', ['next']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Run: palee-test config set-vault <path>/);
    assert.doesNotMatch(res.stderr, /Run: palee config/);
  });

  // The repair hint `review` prints from its own catch, beside the block #408
  // adds to the success path: a renamed install has to be told to run
  // `palee-test validate --fix`, because that is the binary it has.
  test('the review repair hint names the invoked bin', () => {
    const vaultDir = path.join(tempDir, 'sm2-vault');
    const vaultConfig = path.join(tempDir, 'sm2-config');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(vaultConfig, { recursive: true });
    // `ease_factor` below the 1.3 floor makes processReview throw `Invalid
    // ease_factor`, the one error class the hint answers.
    fs.writeFileSync(
      path.join(vaultDir, 'zero.md'),
      '---\npalee_id: T-zero\ntopic: "Zero"\ndifficulty: "beginner"\ntopic_mastery: 0.2\n' +
        'ease_factor: 1.0\ninterval_days: 0\nrepetition: 0\n---\n\n# Zero\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(vaultConfig, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }),
      'utf8'
    );

    const res = runAs('palee-test.js', ['review', 'T-zero', '4'], { PALEE_CONFIG_DIR: vaultConfig });
    assert.equal(res.status, 5, `expected the corrupted-state exit 5, got:\n${res.stderr}`);
    assert.match(res.stderr, /Run "palee-test validate --fix"/);
    assert.doesNotMatch(res.stderr, /Run "palee validate --fix"/);
  });

  // Windows npm writes `palee-test.cmd`/`palee-test.ps1` shims that re-exec
  // dist/bin/palee.js, so argv[1] is the real entry there and the invoked name
  // is not recoverable; a POSIX bin dir holds extensionless files and symlinks
  // that do carry it, which is the shape this copy reproduces.
  test('an extensionless bin shim reports the invoked name', () => {
    const res = runAs('palee-test', ['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^Usage: palee-test \[options\] \[command\]/m);
  });
});
