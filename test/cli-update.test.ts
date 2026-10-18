/**
 * `palee update` and the new-version notice (issue #253)
 *
 * Three groups, all fully offline: pure helpers unit-tested in process, the
 * notifier driven through a stubbed `spawnSync`, and the real CLI driven through
 * a PATH shim that stands in for npm. No test in this file — and none in the
 * rest of the suite, which pipes stdio and so trips the TTY gate — ever reaches
 * a registry. The boundary this file encodes is INV-29; ADR-0032 records why
 * the registry is asked through a child process rather than a socket.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'child_process';
import { spawnSync } from 'child_process';
import packageJson from '../package.json';
import { PALEE_ARGV } from './palee-cli';
import {
  compareVersions,
  evaluateUpdate,
  formatNotice,
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
  type UpdateCheckRecord,
} from '../src/cli/update-check';

const REPO_ROOT = path.resolve(__dirname, '..');

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

function stubOk(stdout: string): (...args: unknown[]) => unknown {
  return () => ({ status: 0, signal: null, output: [], pid: 0, stdout, stderr: '' });
}

function stubEnoent(): (...args: unknown[]) => unknown {
  const error = new Error('spawnSync npm ENOENT') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return () => ({ status: null, signal: null, output: [], pid: 0, stdout: '', stderr: '', error });
}

function captureConsoleError(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
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

describe('update: pure helpers', () => {
  test('npm on win32 is npm.cmd through a shell; on POSIX it is npm directly', () => {
    // The CVE-2024-27980 rule: a .cmd cannot be spawned without a shell on modern Node.
    const win = npmInvocationFor('win32', viewArgs());
    assert.strictEqual(win.command, 'npm.cmd');
    assert.strictEqual(win.shell, true);
    assert.deepStrictEqual(win.args, ['view', '@kuldeep2822k/palee', 'version']);
    const posix = npmInvocationFor('linux', installArgs());
    assert.strictEqual(posix.command, 'npm');
    assert.strictEqual(posix.shell, false);
    assert.deepStrictEqual(posix.args, ['install', '-g', '@kuldeep2822k/palee@latest']);
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
    // npm's own upgrade notices must not be read as the package version.
    assert.strictEqual(parseVersionLine('npm notice 10.8.2 -> 10.9.0\n1.2.3'), '1.2.3');
    assert.strictEqual(parseVersionLine('hello world'), null);
    assert.strictEqual(parseVersionLine(''), null);
  });

  test('a cache record is trusted only fresh and written by this same version', () => {
    const record: UpdateCheckRecord = { checkedAt: 1000, currentVersion: '1.0.0', latestVersion: '1.1.0' };
    assert.strictEqual(isCacheFresh(record, 1000 + UPDATE_CHECK_TTL_MS - 1, '1.0.0', UPDATE_CHECK_TTL_MS), true);
    assert.strictEqual(isCacheFresh(record, 1000 + UPDATE_CHECK_TTL_MS, '1.0.0', UPDATE_CHECK_TTL_MS), false);
    assert.strictEqual(isCacheFresh(record, 1001, '1.2.0', UPDATE_CHECK_TTL_MS), false);
  });

  test('every notice gate holds the line, and only the human case lets it through', () => {
    assert.strictEqual(notificationSuppressed({}, true, 'next', false), false);
    assert.strictEqual(notificationSuppressed({}, false, 'next', false), true);
    assert.strictEqual(notificationSuppressed({}, undefined, 'next', false), true);
    assert.strictEqual(notificationSuppressed({}, true, 'next', true), true);
    assert.strictEqual(notificationSuppressed({}, true, 'update', false), true);
    assert.strictEqual(notificationSuppressed({ PALEE_NO_UPDATE_CHECK: '1' }, true, 'next', false), true);
    // Read the opt-out the way PALEE_DEBUG reads its opt-in: 0 and empty are not "set".
    assert.strictEqual(notificationSuppressed({ PALEE_NO_UPDATE_CHECK: '0' }, true, 'next', false), false);
    assert.strictEqual(notificationSuppressed({ PALEE_NO_UPDATE_CHECK: '' }, true, 'next', false), false);
  });

  test('the notice names the invoked bin, not the published one', () => {
    assert.strictEqual(
      formatNotice('1.0.0', '1.1.0', 'palee-test'),
      '⚠ A new version of palee is available: 1.1.0 (you have 1.0.0). Run palee-test update'
    );
  });

  test('the cache file lives in the config dir PALEE_CONFIG_DIR isolates', () => {
    const dir = mkTempDir('palee-update-path-');
    const original = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = dir;
    try {
      assert.strictEqual(updateCheckPath(), path.join(dir, 'update-check.json'));
    } finally {
      if (original === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt or foreign-shaped cache reads as absent, never throws', () => {
    const dir = mkTempDir('palee-update-corrupt-');
    const original = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = dir;
    try {
      const file = updateCheckPath();
      fs.writeFileSync(file, 'not json at all', 'utf8');
      assert.strictEqual(readUpdateCheckRecord(), null);
      fs.writeFileSync(file, '[1, 2]', 'utf8');
      assert.strictEqual(readUpdateCheckRecord(), null);
      fs.writeFileSync(file, '{"checkedAt": "soon", "currentVersion": "1", "latestVersion": null}', 'utf8');
      assert.strictEqual(readUpdateCheckRecord(), null);
      fs.writeFileSync(file, '{"checkedAt": 5, "currentVersion": "1.0.0", "latestVersion": "1.1.0"}', 'utf8');
      assert.deepStrictEqual(readUpdateCheckRecord(), { checkedAt: 5, currentVersion: '1.0.0', latestVersion: '1.1.0' });
    } finally {
      if (original === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('update: notifier in process', () => {
  function withTempConfigDir<T>(fn: (dir: string) => T): T {
    const dir = mkTempDir('palee-update-notify-');
    const original = process.env.PALEE_CONFIG_DIR;
    // The README tells users to export PALEE_NO_UPDATE_CHECK=1 to silence the
    // notice. A contributor who has done that would otherwise see these two
    // tests fail, because maybeNotifyUpdate reads process.env directly and
    // returns before any spawn.
    const originalOptOut = process.env.PALEE_NO_UPDATE_CHECK;
    process.env.PALEE_CONFIG_DIR = dir;
    delete process.env.PALEE_NO_UPDATE_CHECK;
    try {
      return fn(dir);
    } finally {
      if (original === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = original;
      if (originalOptOut === undefined) delete process.env.PALEE_NO_UPDATE_CHECK;
      else process.env.PALEE_NO_UPDATE_CHECK = originalOptOut;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a newer cached version prints exactly one stderr line and never touches exitCode', () => {
    withTempConfigDir(() => {
      const before = process.exitCode;
      let calls = 0;
      withSpawnStub(() => {
        calls++;
        return stubOk('99.0.0\n')();
      }, () => {
        withTtyStdout(true, () => {
          const lines = captureConsoleError(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.strictEqual(lines.length, 1, lines.join('\n'));
          const notice = lines[0];
          assert.ok(notice !== undefined, 'the single notice line is present');
          assert.match(notice, /^⚠ A new version of palee is available: 99\.0\.0 \(you have 1\.0\.0\)\. Run palee update$/);
        });
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(process.exitCode, before, 'a notice never sets an exit code');
      const record = readUpdateCheckRecord();
      assert.ok(record !== null && record.latestVersion === '99.0.0');

      // The load-bearing TTL assertion: the second run inside 24 hours must
      // not re-spawn npm — it reads the cache the first run wrote.
      withSpawnStub(() => {
        calls++;
        return stubOk('99.0.0\n')();
      }, () => {
        withTtyStdout(true, () => {
          const lines = captureConsoleError(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.strictEqual(lines.length, 1);
        });
      });
      assert.strictEqual(calls, 1, 'a fresh cache must not cost a second npm spawn');
    });
  });

  test('equal or older cached versions print nothing', () => {
    withTempConfigDir(() => {
      writeUpdateCheckRecord({ checkedAt: Date.now(), currentVersion: '1.0.0', latestVersion: '1.0.0' });
      withSpawnStub(() => assert.fail('a fresh cache must not spawn npm'), () => {
        withTtyStdout(true, () => {
          const lines = captureConsoleError(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.strictEqual(lines.length, 0);
        });
      });
    });
  });

  test('an unresolvable npm is silent, and the failure is cached so it is not re-paid', () => {
    withTempConfigDir(() => {
      let calls = 0;
      const counting = (): unknown => {
        calls++;
        return stubEnoent()();
      };
      withSpawnStub(counting, () => {
        withTtyStdout(true, () => {
          const first = captureConsoleError(() => maybeNotifyUpdate('1.0.0', 'next', false));
          const second = captureConsoleError(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.strictEqual(first.length, 0);
          assert.strictEqual(second.length, 0);
        });
      });
      assert.strictEqual(calls, 1, 'the cached failure is fresh; no second probe');
      const record = readUpdateCheckRecord();
      assert.ok(record !== null && record.latestVersion === null);
    });
  });

  test('a throwing spawnSync cannot throw out of the notice or fail the command', () => {
    withTempConfigDir(() => {
      const before = process.exitCode;
      withSpawnStub(() => {
        throw new Error('simulated spawnSync explosion');
      }, () => {
        withTtyStdout(true, () => {
          const lines = captureConsoleError(() => maybeNotifyUpdate('1.0.0', 'next', false));
          assert.strictEqual(lines.length, 0);
        });
      });
      assert.strictEqual(process.exitCode, before);
    });
  });

  test('non-TTY stdout and PALEE_NO_UPDATE_CHECK never reach npm', () => {
    withTempConfigDir(() => {
      const original = process.env.PALEE_NO_UPDATE_CHECK;
      try {
        withSpawnStub(() => assert.fail('the gate must close before any spawn'), () => {
          withTtyStdout(false, () => maybeNotifyUpdate('1.0.0', 'next', false));
          process.env.PALEE_NO_UPDATE_CHECK = '1';
          withTtyStdout(true, () => maybeNotifyUpdate('1.0.0', 'next', false));
        });
      } finally {
        if (original === undefined) delete process.env.PALEE_NO_UPDATE_CHECK;
        else process.env.PALEE_NO_UPDATE_CHECK = original;
      }
    });
  });

  test('evaluateUpdate reports the cache and probe paths without printing anything', () => {
    withTempConfigDir(() => {
      writeUpdateCheckRecord({ checkedAt: Date.now(), currentVersion: '9.9.9', latestVersion: '1.0.0' });
      // The foreign record must be disbelieved without being printed for: the
      // report answers from a fresh probe, not from the cache.
      withSpawnStub(stubOk('2.0.0'), () => {
        const report = evaluateUpdate('1.0.0', { force: false, timeoutMs: 5000 });
        assert.strictEqual(report.state, 'update-available');
        assert.ok(report.state === 'update-available' && report.source === 'npm', 'the foreign-version record was believed');
      });
      const fromCache = evaluateUpdate('1.0.0', { force: false, timeoutMs: 5000 });
      assert.ok(fromCache.state === 'update-available' && fromCache.source === 'cache', 'the fresh own-version record is now used');
      withSpawnStub(stubEnoent(), () => {
        const report = evaluateUpdate('1.0.0', { force: true, timeoutMs: 5000 });
        assert.strictEqual(report.state, 'unknown');
      });
    });
  });
});

describe('update: the CLI through a PATH-shim npm', () => {
  let tempDir: string;
  let shimDir: string;
  let emptyBinDir: string;
  let logPath: string;

  function setup(): string {
    tempDir = mkTempDir('palee-update-cli-');
    shimDir = path.join(tempDir, 'shim');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(
      path.join(shimDir, 'npm'),
      [
        '#!/bin/sh',
        'if [ "$1" = "view" ]; then',
        '  echo "$SHIM_VERSION"',
        '  exit 0',
        'fi',
        'if [ -n "$SHIM_LOG" ]; then',
        '  echo "$*" >> "$SHIM_LOG"',
        'fi',
        'exit "${SHIM_EXIT:-0}"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(shimDir, 'npm.cmd'),
      '@echo off\r\nif "%1"=="view" (\r\n  echo %SHIM_VERSION%\r\n  exit /b 0\r\n)\r\necho %* >> "%SHIM_LOG%"\r\nexit /b %SHIM_EXIT%\r\n',
      'utf8'
    );
    emptyBinDir = path.join(tempDir, 'empty-bin');
    fs.mkdirSync(emptyBinDir);
    logPath = path.join(tempDir, 'npm-install.log');
    return tempDir;
  }

  interface RunOptions {
    args: string[];
    configDir: string;
    version?: string;
    exitCode?: string;
    withShim: boolean;
    /** Where `palee` itself is started from; defaults to the repository root. */
    cwd?: string;
  }

  function run({ args, configDir, version, exitCode, withShim, cwd }: RunOptions): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PALEE_CONFIG_DIR: configDir,
      PATH: withShim ? shimDir + path.delimiter + (process.env.PATH ?? '') : emptyBinDir,
    };
    if (version !== undefined) env.SHIM_VERSION = version;
    if (exitCode !== undefined) env.SHIM_EXIT = exitCode;
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

  test('update --dry-run reports the pair and installs nothing', () => {
    setup();
    try {
      const configDir = freshConfigDir();
      const r = run({ args: ['update', '--dry-run'], configDir, version: '99.0.0', withShim: true });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /⚠ palee 99\.0\.0 is available \(you have /);
      assert.match(r.stdout, /• Would run: npm install -g @kuldeep2822k\/palee@latest/);
      assert.ok(!fs.existsSync(logPath), 'a dry run must never reach npm install');
      const record = JSON.parse(fs.readFileSync(path.join(configDir, 'update-check.json'), 'utf8')) as UpdateCheckRecord;
      assert.strictEqual(record.latestVersion, '99.0.0');
      assert.strictEqual(record.currentVersion, packageJson.version);
      assert.ok(typeof record.checkedAt === 'number');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('update --dry-run says up to date when the registry agrees', () => {
    setup();
    try {
      const r = run({
        args: ['update', '--dry-run'],
        configDir: freshConfigDir(),
        version: packageJson.version,
        withShim: true,
      });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /✓ palee is up to date/);
      assert.ok(!fs.existsSync(logPath));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('update on the current version succeeds without installing', () => {
    setup();
    try {
      const r = run({ args: ['update'], configDir: freshConfigDir(), version: packageJson.version, exitCode: '0', withShim: true });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /✓ palee is up to date/);
      assert.ok(!fs.existsSync(logPath), 'an up-to-date run must not shell out to install');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('update runs the real install with the exact argv through the shell path', () => {
    setup();
    try {
      const r = run({ args: ['update'], configDir: freshConfigDir(), version: '99.0.0', exitCode: '0', withShim: true });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /✓ Updated palee to 99\.0\.0/);
      const log = fs.readFileSync(logPath, 'utf8');
      // The single highest-value integration assertion: the argv shape survives
      // cmd.exe/shell resolution on Windows and direct spawn on POSIX alike.
      assert.match(log, /install -g @kuldeep2822k\/palee@latest/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('a failing npm install exits 5 naming npm code', () => {
    setup();
    try {
      const r = run({ args: ['update'], configDir: freshConfigDir(), version: '99.0.0', exitCode: '1', withShim: true });
      assert.strictEqual(r.status, 5);
      assert.match(r.stderr, /npm install -g exited with code 1/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('an unparseable registry answer and an unfindable npm both exit 5, silently-degraded', () => {
    setup();
    try {
      const junk = run({ args: ['update'], configDir: freshConfigDir(), version: 'not-a-version', withShim: true });
      assert.strictEqual(junk.status, 5);
      assert.match(junk.stderr, /could not determine the latest published version/);

      const noNpm = run({ args: ['update'], configDir: freshConfigDir(), withShim: false });
      assert.strictEqual(noNpm.status, 5);
      assert.match(noNpm.stderr, /could not determine the latest published version/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('a usage error exits 2 through the Commander path', () => {
    setup();
    try {
      const r = run({ args: ['update', '--bogus-flag'], configDir: freshConfigDir(), withShim: true });
      assert.strictEqual(r.status, 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('a piped reading command spawns no npm and writes no cache (suite-wide guard)', () => {
    // This is the assertion that keeps the other 100+ spawn tests honest: the
    // TTY gate closes the notice path before anything reaches PATH, so the
    // suite cannot touch a registry even with an npm-shaped shim waiting.
    setup();
    try {
      const configDir = freshConfigDir();
      const vaultDir = path.join(tempDir, 'vault');
      fs.mkdirSync(vaultDir);
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ vaultPath: vaultDir }), 'utf8');
      const r = run({ args: ['next'], configDir, version: '99.0.0', withShim: true });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(!fs.existsSync(path.join(configDir, 'update-check.json')));
      assert.ok(!fs.existsSync(logPath));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('update --help states the npm delegation and the notice opt-out', () => {
    setup();
    try {
      const r = run({ args: ['update', '--help'], configDir: freshConfigDir(), withShim: true });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /npm install -g @kuldeep2822k\/palee@latest/);
      assert.match(r.stdout, /PALEE_NO_UPDATE_CHECK/);
      assert.match(r.stdout, /PALEE_CONFIG_DIR/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('an npm planted in the working directory is never executed (ADR-0032)', () => {
    // cmd.exe searches the current directory before PATH for a `.cmd`, so an
    // inherited working directory turns `palee` in a cloned tree into execution
    // of whatever `npm.cmd` that tree ships. The shim supplies the honest
    // answer; the planted file must not run at all.
    setup();
    try {
      const plantedDir = path.join(tempDir, 'clone');
      fs.mkdirSync(plantedDir);
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
      });

      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.ok(!fs.existsSync(marker), 'the planted npm.cmd must not have run');
      assert.match(r.stdout, /99\.0\.0/, 'the PATH shim answered instead of the planted file');
      assert.doesNotMatch(r.stdout, /66\.0\.0/, 'the planted version never reaches the report');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('update: the network boundary is unchanged (INV-29)', () => {
  test('update-check reaches npm only through child_process, never a socket primitive', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'update-check.ts'), 'utf8');
    assert.ok(/from 'child_process'/.test(text));
    assert.ok(!/(^|[^.\w])fetch\s*\(/.test(text), 'no fetch in the update surface');
    assert.ok(!/from ['"](?:node:)?(?:net|tls|dns|http|https)['"]/.test(text), 'no socket-module import');
    assert.ok(!/\bhttps?\s*\.\s*(?:request|get)\s*\(/.test(text));
    assert.ok(!/\b(?:net|tls)\s*\.\s*connect\s*\(/.test(text));
    assert.ok(!/\bdns\s*\.\s*(?:lookup|resolve)/.test(text));
  });

  test('the boundary test still allows exactly one network file', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'ai-network-boundary.test.ts'), 'utf8');
    const allowed = /const ALLOWED = '([^']+)';/.exec(text);
    assert.ok(allowed, 'the ALLOWED constant moved shape; update this census');
    assert.strictEqual(allowed[1], 'src/ai/provider.ts');
  });

  test('every npm spawn pins its working directory rather than inheriting it', () => {
    const seen: unknown[] = [];
    withSpawnStub((...args: unknown[]) => {
      seen.push(args[2]);
      return stubOk('99.0.0\n')();
    }, () => {
      evaluateUpdate('1.0.0', { force: true, timeoutMs: 5000 });
    });
    assert.strictEqual(seen.length, 1, 'the forced probe spawns npm exactly once');
    const options = seen[0] as { cwd?: string };
    assert.strictEqual(options.cwd, os.homedir(), 'npm runs from home, never from the caller directory');
  });
});
