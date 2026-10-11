import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';

/**
 * #320 + #338 — the entry point's fatal path, exercised as a real redirected
 * process.
 *
 * Reachability is the interesting part: every command handler owns a try/catch,
 * so a *data*-driven failure (an unreadable config, a bad note) never reaches
 * `bin/palee.ts`. The only code that can throw past those catches is the
 * dispatcher itself, so the probe below registers a commander lifecycle hook —
 * real commander, running inside the promise chain that
 * `program.parseAsync(...).catch(...)` awaits — and throws from it. Nothing in
 * the probe knows about the fix; the same injection reproduces identically on
 * an unfixed tree, where it demonstrates the defects instead of the contract.
 *
 * Contracts pinned here:
 * - the fatal path ends by setting `process.exitCode` and returning, never
 *   `process.exit()`, so writes still queued to a redirected stdout are flushed
 *   before the process ends and a piped caller receives complete JSON (#320);
 * - a human gets the message, not the stack; the stack is opt-in through
 *   `PALEE_DEBUG` (#338);
 * - JSON mode is the command's parsed `--json` option, not a positional sniff
 *   of `process.argv`, which misfires when `--json` is merely a value (#338);
 *   the argv sniff survives only as the fallback for a failure before any
 *   action ran.
 */

const ROOT = path.resolve(__dirname, '..');
const MARKER = 'palee-fatal-probe';

/** Frames in a V8 stack trace; their presence means the raw error was dumped. */
const STACK_FRAME = /^\s+at\s+\S/mu;

function payloadLine(stdout: string): string | undefined {
  return stdout.split('\n').find((line) => line.startsWith('{"status":"error"'));
}

describe('Entry-point fatal output contract (#320, #338)', () => {
  let tmpDir: string;
  let configDir: string;
  let probePath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-fatal-probe-'));
    configDir = path.join(tmpDir, 'config');
    const vault = path.join(configDir, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ vaultPath: vault }),
      'utf8'
    );

    // Registered against the very commander instance `bin/palee.ts` uses, so the
    // hook joins the CLI's own dispatch chain rather than a parallel fake CLI.
    probePath = path.join(tmpDir, 'fatal-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "const path = require('path');",
        "const { createRequire } = require('module');",
        "const req = createRequire(path.join(process.env.PALEE_PROBE_ROOT, 'package.json'));",
        "const { program } = req('commander');",
        "const stage = process.env.PALEE_FATAL_PROBE_STAGE || 'postAction';",
        "const repeat = Number(process.env.PALEE_FATAL_PROBE_REPEAT || 0);",
        'program.hook(stage, () => {',
        `  throw new Error('${MARKER} ' + 'x'.repeat(repeat));`,
        '});',
      ].join('\n'),
      'utf8'
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  interface Run {
    status: number | null;
    stdout: string;
    stderr: string;
  }

  function runFatal(
    args: string[],
    opts: { repeat?: number; stage?: string; debug?: string } = {}
  ): Run {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PALEE_CONFIG_DIR: configDir,
      PALEE_PROBE_ROOT: ROOT,
      PALEE_FATAL_PROBE_REPEAT: String(opts.repeat ?? 0),
    };
    delete env.PALEE_DEBUG;
    if (opts.stage !== undefined) env.PALEE_FATAL_PROBE_STAGE = opts.stage;
    if (opts.debug !== undefined) env.PALEE_DEBUG = opts.debug;

    const result = spawnSync(
      process.execPath,
      ['--require', probePath, ...PALEE_ARGV, ...args],
      { cwd: ROOT, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 128 * 1024 * 1024 }
    );
    assert.ok(!result.error, `the CLI must spawn, got ${result.error?.message}`);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('a redirected --json caller receives the complete fatal payload (#320)', () => {
    // Big enough to overrun any OS pipe buffer, so a payload written and then
    // abandoned by `process.exit()` shows up as a short, unparseable tail. On
    // platforms where a piped stdout write blocks until drained (Windows) this
    // passes before the fix as well; the source-level test below is the part
    // that is red everywhere.
    const run = runFatal(['dashboard', '--json'], { repeat: 2_000_000 });
    assert.strictEqual(run.status, 5);

    const line = payloadLine(run.stdout);
    assert.ok(line, `the JSON payload must reach stdout, got ${run.stdout.length} bytes`);
    assert.ok(
      run.stdout.endsWith('}\n'),
      `stdout must end with the closed payload, got ...${JSON.stringify(run.stdout.slice(-40))}`
    );

    const parsed = JSON.parse(line) as { status: string; code: number; error: string };
    assert.strictEqual(parsed.status, 'error');
    assert.strictEqual(parsed.code, 5);
    assert.strictEqual(
      parsed.error.length,
      `${MARKER} `.length + 2_000_000,
      'no byte of the message may be lost to an unflushed write'
    );
  });

  test('the fatal path sets the exit code and returns; it never calls process.exit (#320)', () => {
    const dispatcher = fs.readFileSync(path.join(ROOT, 'bin', 'palee.ts'), 'utf8');
    const start = dispatcher.indexOf('.parseAsync(process.argv)');
    assert.ok(start >= 0, 'the entry point parses through parseAsync so rejections reach the catch');
    const fatalBranch = dispatcher.slice(start);
    assert.ok(
      !/process\.exit\s*\(/u.test(fatalBranch),
      '#320: process.exit discards queued stdout writes; the fatal path must set process.exitCode'
    );
    assert.match(
      fatalBranch,
      /process\.exitCode\s*=\s*ExitCode\.Unexpected/u,
      'the documented exit code 5 is still the fatal outcome'
    );
  });

  test('a human sees the message, not the stack (#338)', () => {
    const run = runFatal(['dashboard']);
    assert.strictEqual(run.status, 5);
    assert.match(run.stderr, new RegExp(MARKER, 'u'), 'the message is still reported');
    assert.ok(
      !STACK_FRAME.test(run.stderr),
      `the raw stack must stay off the user's screen, got: ${JSON.stringify(run.stderr)}`
    );
    assert.strictEqual(payloadLine(run.stdout), undefined, 'plain mode writes no JSON payload');
  });

  test('PALEE_DEBUG=1 opts into the stack (#338)', () => {
    const run = runFatal(['dashboard'], { debug: '1' });
    assert.strictEqual(run.status, 5);
    assert.match(run.stderr, new RegExp(MARKER, 'u'));
    assert.ok(
      STACK_FRAME.test(run.stderr),
      'the opt-in must surface the trace that is hidden by default'
    );
  });

  test('PALEE_DEBUG=0 and the empty string keep the stack hidden', () => {
    for (const debug of ['0', '']) {
      const run = runFatal(['dashboard'], { debug });
      assert.strictEqual(run.status, 5);
      assert.ok(
        !STACK_FRAME.test(run.stderr),
        `PALEE_DEBUG=${JSON.stringify(debug)} is not an opt-in, got: ${JSON.stringify(run.stderr)}`
      );
    }
  });

  test('JSON mode is the parsed option, not a --json value in argv (#338)', () => {
    // `palee config -- --json` passes the literal token `--json` as the command
    // argument, so argv contains it while the parsed `json` option is unset. The
    // old `process.argv.includes('--json')` sniff answered JSON to a caller that
    // asked for text.
    const run = runFatal(['config', '--', '--json']);
    assert.strictEqual(run.status, 5);
    assert.ok(
      payloadLine(run.stdout) === undefined,
      `a positional --json value must not switch the fatal path to JSON, got: ${JSON.stringify(run.stdout.slice(-200))}`
    );
    assert.match(run.stderr, new RegExp(MARKER, 'u'), 'it stays a plain-text message on stderr');
    assert.ok(!STACK_FRAME.test(run.stderr));
  });

  test('the argv sniff remains the fallback when no action ran (#338)', () => {
    // A preAction throw happens before the capture hook records any parsed
    // options, so the catch has nothing parsed to consult and must still answer
    // a `--json` caller in JSON.
    const json = runFatal(['dashboard', '--json'], { stage: 'preAction', repeat: 32 });
    assert.strictEqual(json.status, 5);
    const line = payloadLine(json.stdout);
    assert.ok(line, 'with no parsed options the argv sniff still emits JSON');
    assert.strictEqual((JSON.parse(line) as { code: number }).code, 5);

    const text = runFatal(['dashboard'], { stage: 'preAction', repeat: 32 });
    assert.strictEqual(text.status, 5);
    assert.strictEqual(payloadLine(text.stdout), undefined);
    assert.match(text.stderr, new RegExp(MARKER, 'u'));
  });
});
