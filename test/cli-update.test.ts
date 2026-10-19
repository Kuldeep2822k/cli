/**
 * `palee update` and the new-version notice (issue #253)
 *
 * Four groups, all fully offline: pure helpers unit-tested in process, the
 * cache and notifier driven through a stubbed `spawnSync`, the real CLI driven
 * through a PATH shim that stands in for npm, and two source-shape guards. No
 * test in this file — and none in the rest of the suite, which pipes stdio and
 * so trips the TTY gate — ever reaches a registry. The boundary this file
 * encodes is INV-29; ADR-0033 records why the registry is asked through a
 * child process rather than a socket.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'child_process';
import { spawnSync } from 'child_process';
import packageJson from '../package.json';
import { PALEE_ARGV, underCoverage } from './palee-cli';
import {
  compareVersions,
  evaluateUpdate,
  installArgs,
  isCacheFresh,
  maybeNotifyUpdate,
  notificationSuppressed,
  npmInvocationFor,
  parseVersionLine,
  readUpdateCheckRecord,
  updateCheckPath,
  viewArgs,
  writeUpdateCheckRecord,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheckEntry,
} from '../src/cli/update-check';

const REPO_ROOT = path.resolve(__dirname, '..');
const TTL_24H = 24 * 60 * 60 * 1000;

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Runs a function with `child_process.spawnSync` replaced by a stub. The CLI
 * modules reach `spawnSync` through the module object at call time — the same
 * mechanism `storage-atomic-write.test.ts` exploits for `fs` — so the patch is
 * observed by the real code paths without touching them.
 */
function withSpawnStub<T>(stub: (...args: unknown[]) => unknown, fn: () => T): T {
  const original = childProcess.spawnSync;
  Object.defineProperty(childProcess, 'spawnSync', {
    configurable: true,
    writable: true,
    value: stub as unknown as typeof childProcess.spawnSync,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(childProcess, 'spawnSync', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

/** The `SpawnSyncReturns` shape the stubs answer with. */
function spawnResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null, ...overrides };
}

/** Captures both console streams so "stderr-only" and "stdout stays clean" are assertable. */
function captureOutput(fn: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]): void => {
    stdout.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]): void => {
    stderr.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout, stderr };
}

function withTtyStdout<T>(isTTY: boolean, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY });
  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(process.stdout, 'isTTY', original);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  }
}

/**
 * Runs a function with an isolated config directory and without the notice
 * opt-out, either of which a contributor's environment could otherwise set.
 */
function withTempConfigDir<T>(fn: (dir: string) => T): T {
  const dir = mkTempDir('palee-update-');
  const originalDir = process.env.PALEE_CONFIG_DIR;
  const originalOptOut = process.env.PALEE_NO_UPDATE_CHECK;
  process.env.PALEE_CONFIG_DIR = dir;
  delete process.env.PALEE_NO_UPDATE_CHECK;
  try {
    return fn(dir);
  } finally {
    if (originalDir === undefined) delete process.env.PALEE_CONFIG_DIR;
    else process.env.PALEE_CONFIG_DIR = originalDir;
    if (originalOptOut === undefined) delete process.env.PALEE_NO_UPDATE_CHECK;
    else process.env.PALEE_NO_UPDATE_CHECK = originalOptOut;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update: pure helpers', () => {
  test('npm on win32 is npm.cmd through a shell; on POSIX it is npm directly', () => {
    // The CVE-2024-27980 rule: a .cmd cannot be spawned without a shell on modern Node.
    assert.deepStrictEqual(npmInvocationFor('win32', ['view', '@kuldeep2822k/palee', 'version']), {
      command: 'npm.cmd',
      args: ['view', '@kuldeep2822k/palee', 'version'],
      shell: true,
    });
    assert.deepStrictEqual(npmInvocationFor('linux', ['install', '-g', '@kuldeep2822k/palee@latest']), {
      command: 'npm',
      args: ['install', '-g', '@kuldeep2822k/palee@latest'],
      shell: false,
    });
    // The two shipped argv shapes, pinned as literals rather than fed back in.
    assert.deepStrictEqual(viewArgs(), ['view', '@kuldeep2822k/palee', 'version']);
    assert.deepStrictEqual(installArgs(), ['install', '-g', '@kuldeep2822k/palee@latest']);
  });

  test('compareVersions compares numerically, not lexically', () => {
    const cases: Array<[string, string, -1 | 0 | 1]> = [
      ['1.0.0', '1.0.0', 0],
      ['1.0.1', '1.0.0', 1],
      ['1.0.0', '1.0.1', -1],
      ['1.10.0', '1.9.0', 1],
      ['2.0.0', '10.0.0', -1],
      ['1.0.0-rc.1', '1.0.0', -1],
      ['1.0.0', '1.0.0-rc.1', 1],
      ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
      ['1.0.0-alpha', '1.0.0-alpha.1', -1],
      ['1.0.0-1', '1.0.0-alpha', -1],
      // Numeric prerelease identifiers stay strings: 2^53-scale identifiers
      // must still order by value instead of comparing equal through Number().
      ['1.0.0-9007199254740993', '1.0.0-9007199254740992', 1],
      ['1.0.0-010', '1.0.0-10', 0],
      ['1.0.0+build.5', '1.0.0', 0],
      ['1.0', '1.0.0', 0],
      ['garbage', '1.0.0', 0],
    ];
    for (const [a, b, want] of cases) {
      assert.strictEqual(compareVersions(a, b), want, `compareVersions('${a}', '${b}')`);
    }
  });

  test('parseVersionLine takes only a line that is nothing but a version', () => {
    assert.strictEqual(parseVersionLine('1.2.3\n'), '1.2.3');
    assert.strictEqual(parseVersionLine('\r\n9.9.9\r\n'), '9.9.9');
    assert.strictEqual(parseVersionLine('1.2.3-rc.1'), '1.2.3-rc.1');
    assert.strictEqual(parseVersionLine(' 1.2.3 '), '1.2.3');
    // npm's own upgrade notices must not be read as the package version.
    assert.strictEqual(parseVersionLine('npm notice 10.8.2 -> 10.9.0\n1.2.3'), '1.2.3');
    assert.strictEqual(parseVersionLine('1.2'), null);
    assert.strictEqual(parseVersionLine('1.2.3.4'), null);
    assert.strictEqual(parseVersionLine('hello world'), null);
    assert.strictEqual(parseVersionLine(''), null);
  });

  test('the TTL is literally 24 hours and freshness ends at the boundary', () => {
    assert.strictEqual(UPDATE_CHECK_TTL_MS, TTL_24H);
    const entry: UpdateCheckEntry = { checkedAt: 1_000, latestVersion: '1.1.0', notifiedVersion: null };
    assert.strictEqual(isCacheFresh(entry, 1_000 + TTL_24H - 1, TTL_24H), true);
    assert.strictEqual(isCacheFresh(entry, 1_000 + TTL_24H, TTL_24H), false);
  });

  test('every notice gate holds the line, and only a successful human run lets it through', () => {
    assert.strictEqual(notificationSuppressed({}, true, 'next', false, 0), false);
    assert.strictEqual(notificationSuppressed({}, true, 'next', false, undefined), false);
    assert.strictEqual(notificationSuppressed({}, true, 'next', false, 2), true);
    assert.strictEqual(notificationSuppressed({}, true, 'next', false, '4'), true);
    assert.strictEqual(notificationSuppressed({}, false, 'next', false, 0), true);
    assert.strictEqual(notificationSuppressed({}, undefined, 'next', false, 0), true);
    assert.strictEqual(notificationSuppressed({}, true, 'next', true, 0), true);
    assert.strictEqual(notificationSuppressed({}, true, 'update', false, 0), true);
    assert.strictEqual(notificationSuppressed({ PALEE_NO_UPDATE_CHECK: '1' }, true, 'next', false, 0), true);
    // Read the opt-out the way PALEE_DEBUG reads its opt-in: 0 and empty are not "set".
    assert.strictEqual(notificationSuppressed({ PALEE_NO_UPDATE_CHECK: '0' }, true, 'next', false, 0), false);
    assert.strictEqual(notificationSuppressed({ PALEE_NO_UPDATE_CHECK: '' }, true, 'next', false, 0), false);
  });

  test('a careless or poisoned cache entry reads as absent, never throws', () => {
    withTempConfigDir((dir) => {
      const file = updateCheckPath();
      assert.strictEqual(file, path.join(dir, 'update-check.json'));
      const write = (raw: string): void => fs.writeFileSync(file, raw, 'utf8');

      write('not json at all');
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      write('[1, 2]');
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      write(JSON.stringify({ '1.0.0': { checkedAt: 'soon', latestVersion: '1.1.0', notifiedVersion: null } }));
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      // JSON.parse('1e999') is Infinity, which would freeze the cache forever.
      write('{"1.0.0":{"checkedAt":1e999,"latestVersion":"1.1.0","notifiedVersion":null}}');
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      // A future timestamp is a clock correction, not a fresh check.
      write(JSON.stringify({ '1.0.0': { checkedAt: Date.now() + 60_000, latestVersion: '1.1.0', notifiedVersion: null } }));
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      write(JSON.stringify({ '1.0.0': { checkedAt: 5, latestVersion: 'garbage', notifiedVersion: null } }));
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      write(JSON.stringify({ '1.0.0': { checkedAt: 5, latestVersion: '1.1.0', notifiedVersion: 'garbage' } }));
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      // Another install's entry never answers for this version (#311).
      write(JSON.stringify({ '0.9.0': { checkedAt: 5, latestVersion: null, notifiedVersion: null } }));
      assert.strictEqual(readUpdateCheckRecord('1.0.0'), null);
      write(JSON.stringify({ '1.0.0': { checkedAt: 5, latestVersion: null, notifiedVersion: null } }));
      assert.deepStrictEqual(readUpdateCheckRecord('1.0.0'), { checkedAt: 5, latestVersion: null, notifiedVersion: null });
    });
  });

  test('writing one version keeps the other installs entries', () => {
    withTempConfigDir(() => {
      writeUpdateCheckRecord('1.0.0', { checkedAt: 5, latestVersion: '1.1.0', notifiedVersion: '1.0.0' });
      writeUpdateCheckRecord('2.0.0', { checkedAt: 6, latestVersion: '2.1.0', notifiedVersion: null });
      assert.deepStrictEqual(readUpdateCheckRecord('1.0.0'), { checkedAt: 5, latestVersion: '1.1.0', notifiedVersion: '1.0.0' });
      assert.deepStrictEqual(readUpdateCheckRecord('2.0.0'), { checkedAt: 6, latestVersion: '2.1.0', notifiedVersion: null });
      writeUpdateCheckRecord('1.0.0', { checkedAt: 7, latestVersion: null, notifiedVersion: null });
      assert.deepStrictEqual(readUpdateCheckRecord('2.0.0'), { checkedAt: 6, latestVersion: '2.1.0', notifiedVersion: null });
    });
  });
});

describe('update: cache and notifier in process', () => {
  test('a newer version prints one stderr line, is marked delivered, and never repeats inside the TTL', () => {
    withTempConfigDir(() => {
      const beforeExitCode = process.exitCode;
      let calls = 0;
      const stub = (): Record<string, unknown> => {
        calls++;
        return spawnResult({ stdout: '99.0.0\n' });
      };
      withSpawnStub(stub, () => {
        withTtyStdout(true, () => {
          const first = captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.deepStrictEqual(first.stdout, [], 'the notice is stderr-only');
          assert.strictEqual(first.stderr.length, 1, first.stderr.join('\n'));
          assert.match(
            first.stderr[0] ?? '',
            /^⚠ A new version of palee is available: 99\.0\.0 \(you have 1\.0\.0\)\. Run palee update$/
          );

          const second = captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.deepStrictEqual(second, { stdout: [], stderr: [] }, 'the notice is delivered once per published version');
        });
      });
      assert.strictEqual(calls, 1, 'the second run inside the TTL is cache-only');
      assert.strictEqual(process.exitCode, beforeExitCode, 'a notice never sets an exit code');
      const entry = readUpdateCheckRecord('1.0.0');
      assert.ok(entry !== null, 'the check is cached');
      assert.strictEqual(entry.latestVersion, '99.0.0');
      assert.strictEqual(entry.notifiedVersion, '99.0.0');
    });
  });

  test('equal, older, and already-notified entries never spawn npm or print', () => {
    withTempConfigDir(() => {
      let calls = 0;
      withSpawnStub(
        () => {
          calls++;
          return spawnResult({ stdout: '9.9.9\n' });
        },
        () => {
          withTtyStdout(true, () => {
            for (const latest of ['1.0.0', '0.9.0']) {
              writeUpdateCheckRecord('1.0.0', { checkedAt: Date.now(), latestVersion: latest, notifiedVersion: null });
              const lines = captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
              assert.deepStrictEqual(lines, { stdout: [], stderr: [] }, `latest ${latest} must stay silent`);
            }
            writeUpdateCheckRecord('1.0.0', { checkedAt: Date.now(), latestVersion: '9.9.9', notifiedVersion: '9.9.9' });
            const delivered = captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
            assert.deepStrictEqual(delivered, { stdout: [], stderr: [] }, 'a delivered notice is not repeated');
          });
        }
      );
      assert.strictEqual(calls, 0, 'no cached state may cost an npm spawn');
    });
  });

  test('a failed probe is silent, cached as a failure, and not re-paid', () => {
    withTempConfigDir(() => {
      let calls = 0;
      withSpawnStub(
        () => {
          calls++;
          const error = new Error('spawnSync npm ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          return spawnResult({ status: null, error });
        },
        () => {
          withTtyStdout(true, () => {
            captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
            captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
          });
        }
      );
      assert.strictEqual(calls, 1, 'the cached failure is fresh; no second probe');
      const entry = readUpdateCheckRecord('1.0.0');
      assert.ok(entry !== null && entry.latestVersion === null);
      const report = evaluateUpdate('1.0.0', { force: false, timeoutMs: 5000 });
      assert.deepStrictEqual(report, { state: 'unknown', reason: 'a previous update check failed' });
    });
  });

  test('a throwing spawnSync cannot escape the notice and is cached as a failure', () => {
    withTempConfigDir(() => {
      const beforeExitCode = process.exitCode;
      let calls = 0;
      withSpawnStub(
        () => {
          calls++;
          throw new Error('simulated spawnSync explosion');
        },
        () => {
          withTtyStdout(true, () => {
            const lines = captureOutput(() => maybeNotifyUpdate('1.0.0', 'next', false));
            assert.deepStrictEqual(lines, { stdout: [], stderr: [] });
          });
        }
      );
      assert.strictEqual(calls, 1);
      assert.strictEqual(process.exitCode, beforeExitCode);
      const entry = readUpdateCheckRecord('1.0.0');
      assert.ok(entry !== null && entry.latestVersion === null, 'the swallowed explosion is cached as a failed check');
    });
  });

  test('non-TTY, --json, update itself, failed commands, and the opt-out never reach npm', () => {
    withTempConfigDir(() => {
      const beforeExitCode = process.exitCode;
      let calls = 0;
      const stub = (): Record<string, unknown> => {
        calls++;
        return spawnResult({ stdout: '99.0.0\n' });
      };
      try {
        withSpawnStub(stub, () => {
          withTtyStdout(false, () => maybeNotifyUpdate('1.0.0', 'next', false));
          withTtyStdout(true, () => maybeNotifyUpdate('1.0.0', 'next', true));
          withTtyStdout(true, () => maybeNotifyUpdate('1.0.0', 'update', false));
          process.exitCode = 2;
          withTtyStdout(true, () => maybeNotifyUpdate('1.0.0', 'next', false));
          process.exitCode = beforeExitCode;
          process.env.PALEE_NO_UPDATE_CHECK = '1';
          withTtyStdout(true, () => maybeNotifyUpdate('1.0.0', 'next', false));
          delete process.env.PALEE_NO_UPDATE_CHECK;
        });
      } finally {
        process.exitCode = beforeExitCode;
      }
      assert.strictEqual(calls, 0, 'every gate closes before PATH is consulted');
    });
  });

  test('evaluateUpdate answers from a fresh entry and rewrites only when it probes', () => {
    withTempConfigDir(() => {
      writeUpdateCheckRecord('1.0.0', { checkedAt: Date.now(), latestVersion: '1.0.0', notifiedVersion: null });
      let calls = 0;
      withSpawnStub(
        () => {
          calls++;
          return spawnResult({ stdout: '2.0.0\n' });
        },
        () => {
          assert.deepStrictEqual(evaluateUpdate('1.0.0', { force: false, timeoutMs: 5000 }), {
            state: 'up-to-date',
            latestVersion: '1.0.0',
          });
          assert.strictEqual(calls, 0, 'a fresh entry answers without a probe');

          assert.deepStrictEqual(evaluateUpdate('1.0.0', { force: true, timeoutMs: 5000 }), {
            state: 'update-available',
            latestVersion: '2.0.0',
          });
          assert.strictEqual(calls, 1);

          assert.deepStrictEqual(evaluateUpdate('1.0.0', { force: false, timeoutMs: 5000 }), {
            state: 'update-available',
            latestVersion: '2.0.0',
          });
          assert.strictEqual(calls, 1, 'the probe result is what the cache now answers');
        }
      );
    });
  });
});

describe('update: the CLI through a PATH-shim npm', () => {
  let tempDir: string;
  let shimDir: string;
  let emptyBinDir: string;
  let logPath: string;

  before(() => {
    tempDir = mkTempDir('palee-update-cli-');
    shimDir = path.join(tempDir, 'shim');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(
      path.join(shimDir, 'npm'),
      [
        '#!/bin/sh',
        'if [ "$1" = "view" ]; then',
        '  echo "$SHIM_VERSION"',
        '  exit "${SHIM_VIEW_EXIT:-0}"',
        'fi',
        'if [ -n "$SHIM_LOG" ]; then',
        '  echo "$*" >> "$SHIM_LOG"',
        'fi',
        'echo "npm-install-noise" >&2',
        'exit "${SHIM_EXIT:-0}"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(shimDir, 'npm.cmd'),
      '@echo off\r\nif "%1"=="view" (\r\n  echo %SHIM_VERSION%\r\n  exit /b %SHIM_VIEW_EXIT%\r\n)\r\necho %* >> "%SHIM_LOG%"\r\necho npm-install-noise 1>&2\r\nexit /b %SHIM_EXIT%\r\n',
      'utf8'
    );
    emptyBinDir = path.join(tempDir, 'empty-bin');
    fs.mkdirSync(emptyBinDir);
    logPath = path.join(tempDir, 'npm-install.log');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // The install log is the shim's side effect, and every "never reached
  // install" assertion is only meaningful against a clean slate.
  beforeEach(() => {
    fs.rmSync(logPath, { force: true });
  });

  interface RunOptions {
    args: string[];
    configDir: string;
    version?: string;
    exitCode?: string;
    viewExitCode?: string;
    withShim: boolean;
    /** Where `palee` itself is started from; defaults to the repository root. */
    cwd?: string;
    /** Extra environment for the child, merged over the inherited one. */
    env?: NodeJS.ProcessEnv;
  }

  function run({ args, configDir, version, exitCode, viewExitCode, withShim, cwd, env: envExtras }: RunOptions): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PALEE_CONFIG_DIR: configDir,
      PATH: withShim ? shimDir + path.delimiter + (process.env.PATH ?? '') : emptyBinDir,
      ...envExtras,
    };
    // A contributor who exported the opt-out would otherwise turn every
    // notice assertion green for the wrong reason.
    delete env.PALEE_NO_UPDATE_CHECK;
    if (version !== undefined) env.SHIM_VERSION = version;
    if (exitCode !== undefined) env.SHIM_EXIT = exitCode;
    if (viewExitCode !== undefined) env.SHIM_VIEW_EXIT = viewExitCode;
    if (withShim) env.SHIM_LOG = logPath;
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: cwd ?? REPO_ROOT,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  function freshConfigDir(): string {
    return fs.mkdtempSync(path.join(tempDir, 'cfg-'));
  }

  function entryFor(configDir: string, version: string): UpdateCheckEntry {
    const store = JSON.parse(fs.readFileSync(path.join(configDir, 'update-check.json'), 'utf8')) as Record<string, unknown>;
    const entry = store[version];
    assert.ok(entry !== null && entry !== undefined && typeof entry === 'object', `no cache entry for ${version}`);
    return entry as UpdateCheckEntry;
  }

  test('update --dry-run reports the pair, installs nothing, and records the check', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update', '--dry-run'], configDir, version: '99.0.0', withShim: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /• Checking the latest published version…/);
    assert.match(r.stdout, /⚠ palee 99\.0\.0 is available/);
    assert.ok(r.stdout.includes(`(you have ${packageJson.version}).`), r.stdout);
    assert.match(r.stdout, /• Would run: npm install -g @kuldeep2822k\/palee@latest/);
    assert.ok(!fs.existsSync(logPath), 'a dry run must never reach npm install');

    const entry = entryFor(configDir, packageJson.version);
    assert.strictEqual(entry.latestVersion, '99.0.0');
    assert.strictEqual(entry.notifiedVersion, null, 'the update command never notifies itself');
    assert.ok(Number.isFinite(entry.checkedAt));
  });

  test('update on the latest version exits 0 and installs nothing', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update'], configDir, version: packageJson.version, withShim: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`✓ palee is up to date (${packageJson.version})`), r.stdout);
    assert.ok(!fs.existsSync(logPath), 'an up-to-date run must not shell out to install');
  });

  test('update runs the real install with the exact argv, once, then marks the cache up to date', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update'], configDir, version: '99.0.0', exitCode: '0', withShim: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /• Running: npm install -g @kuldeep2822k\/palee@latest/);
    assert.ok(r.stdout.includes('✓ Updated palee to 99.0.0.'), r.stdout);
    assert.ok(r.stdout.includes('• Verify: palee --version'), r.stdout);

    const log = fs.readFileSync(logPath, 'utf8').trim();
    assert.deepStrictEqual(log.split(/\s+/), ['install', '-g', '@kuldeep2822k/palee@latest'], 'argv survives shell resolution exactly once');

    const entry = entryFor(configDir, packageJson.version);
    assert.strictEqual(entry.latestVersion, packageJson.version, 'the outgoing build cannot emit a stale notice');
    assert.strictEqual(entry.notifiedVersion, packageJson.version);
  });

  test('a failing npm install exits 5, shows npm output, and leaves the check unrewritten', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update'], configDir, version: '99.0.0', exitCode: '1', withShim: true });
    assert.strictEqual(r.status, 5);
    assert.match(r.stderr, /npm-install-noise/, 'npm keeps the terminal (stdio inherit)');
    assert.match(r.stderr, /npm install -g exited with code 1/);
    assert.doesNotMatch(r.stdout, /Updated palee/);
    const entry = entryFor(configDir, packageJson.version);
    assert.strictEqual(entry.latestVersion, '99.0.0');
    assert.strictEqual(entry.notifiedVersion, null);
  });

  test('an unparseable registry answer exits 5 and caches the failed check', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update'], configDir, version: 'not-a-version', withShim: true });
    assert.strictEqual(r.status, 5);
    assert.match(r.stderr, /npm view did not print a version/);
    assert.strictEqual(entryFor(configDir, packageJson.version).latestVersion, null);
  });

  test('a missing npm exits 5 with a PATH-or-ENOENT reason and caches the failure', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update'], configDir, withShim: false });
    assert.strictEqual(r.status, 5);
    assert.match(
      r.stderr,
      /could not determine the latest published version \((?:npm could not be found on PATH|npm could not be run \(ENOENT\))\)/
    );
    assert.strictEqual(entryFor(configDir, packageJson.version).latestVersion, null);
  });

  test('a registry query that exits non-zero exits 5 naming the code', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update'], configDir, version: '99.0.0', viewExitCode: '1', withShim: true });
    assert.strictEqual(r.status, 5);
    assert.match(r.stderr, /npm view exited with code 1/);
    assert.ok(!fs.existsSync(logPath), 'a failed query never reaches install');
  });

  test("a usage error exits 2 with Commander's message and writes no cache", () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update', '--bogus-flag'], configDir, withShim: true });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown option '--bogus-flag'/);
    assert.ok(!fs.existsSync(path.join(configDir, 'update-check.json')));
  });

  test('update has no --json surface', () => {
    const configDir = freshConfigDir();
    const r = run({ args: ['update', '--json'], configDir, withShim: true });
    assert.strictEqual(r.status, 2);
    assert.ok(!r.stdout.includes('{'), r.stdout);
  });

  test('a piped reading command spawns no npm and writes no cache', () => {
    // The TTY gate closes the notice path before anything reaches PATH, so the
    // suite cannot touch a registry even with an npm-shaped shim waiting.
    const configDir = freshConfigDir();
    const vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir);
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ vaultPath: vaultDir }), 'utf8');
    const r = run({ args: ['next'], configDir, version: '99.0.0', withShim: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(configDir, 'update-check.json')));
    assert.ok(!fs.existsSync(logPath));
    assert.doesNotMatch(r.stderr, /⚠/);
  });

  test('update --help names the npm delegation, --dry-run, and the opt-out', () => {
    const r = run({ args: ['update', '--help'], configDir: freshConfigDir(), withShim: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /--dry-run/);
    assert.match(r.stdout, /npm install -g @kuldeep2822k\/palee@latest/);
    assert.match(r.stdout, /PALEE_NO_UPDATE_CHECK/);
  });

  test('an npm planted in the working directory is never executed (ADR-0033)', { skip: process.platform !== 'win32' }, () => {
    // cmd.exe searches the current directory before PATH for a `.cmd`, so an
    // inherited working directory turns `palee` in a cloned tree into execution
    // of whatever `npm.cmd` that tree ships. The shim supplies the honest
    // answer; the planted file must not run at all.
    const plantedDir = path.join(tempDir, 'clone');
    fs.mkdirSync(plantedDir);
    // A coverage run launches the child as `node --import tsx bin/palee.ts`.
    // Node resolves a bare `--import` specifier from the child's cwd; without
    // this link the loader fails before the planted file is ever considered.
    // tsx also resolves its tsconfig from that cwd, so the spawn below pins
    // TSX_TSCONFIG_PATH to the repository config: a child compiled against
    // different options is a second transform lineage and poisons the whole
    // run's coverage merge (the failure test/palee-cli.ts documents for dist
    // children). A real clone ships node_modules, and npm's cwd is pinned
    // elsewhere, so neither shim weakens what this test proves.
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(plantedDir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const marker = path.join(plantedDir, 'executed.marker');
    fs.writeFileSync(
      path.join(plantedDir, 'npm.cmd'),
      `@echo off\r\necho ran-from-cwd> "${marker}"\r\necho 66.0.0\r\nexit /b 0\r\n`,
      'utf8'
    );

    const r = run({
      args: ['update', '--dry-run'],
      configDir: freshConfigDir(),
      version: '99.0.0',
      withShim: true,
      cwd: plantedDir,
      // Piggybacks on the node_modules link above, and is inert for the dist
      // child that the non-coverage launch path spawns.
      ...(underCoverage ? { env: { TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'tsconfig.json') } } : {}),
    });

    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(marker), 'the planted npm.cmd must not have run');
    assert.match(r.stdout, /99\.0\.0/, 'the PATH shim answered instead of the planted file');
    assert.doesNotMatch(r.stdout, /66\.0\.0/, 'the planted version never reaches the report');
  });
});

describe('update: the network boundary is unchanged (INV-29)', () => {
  test('update-check reaches npm through child_process and no socket primitive', () => {
    // The suite-wide version of this check is `ai-network-boundary.test.ts`;
    // this one pins the update surface's own import shape.
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'update-check.ts'), 'utf8');
    assert.ok(/from 'child_process'/.test(text));
    assert.ok(!/(^|[^.\w])fetch\s*\(/.test(text), 'no fetch in the update surface');
    assert.ok(!/from ['"](?:node:)?(?:net|tls|dns|http|https)['"]/.test(text), 'no socket-module import');
  });

  test('every npm spawn pins its working directory rather than inheriting it', () => {
    withTempConfigDir(() => {
      const seen: unknown[] = [];
      withSpawnStub(
        (...args: unknown[]) => {
          seen.push(args[2]);
          return spawnResult({ stdout: '99.0.0\n' });
        },
        () => {
          evaluateUpdate('1.0.0', { force: true, timeoutMs: 5000 });
        }
      );
      assert.strictEqual(seen.length, 1, 'the forced probe spawns npm exactly once');
      const options = seen[0] as { cwd?: string };
      assert.strictEqual(options.cwd, os.homedir(), 'npm runs from home, never from the caller directory');
    });
  });
});
