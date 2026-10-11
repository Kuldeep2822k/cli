import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { nextCommand } from '../src/cli/next';
import { planCommand } from '../src/cli/plan';
import { progressCommand } from '../src/cli/progress';
import { dashboardCommand } from '../src/cli/dashboard';
import { validateCommand } from '../src/cli/validate';
import { validateVaultPath } from '../src/cli/onboarding';

/**
 * #325 — a runtime exception in a reading command must stay machine-readable.
 *
 * Before the fix every handler catch did `console.error(`Error: ${err.message}`)`
 * unconditionally, so a caller that parsed `stderr` as JSON under `--json` broke
 * on any exit-5 condition, while the docs and the exit-2 vault path both promise
 * a `{"error": ...}` payload.
 *
 * The forced failure is a real one, not a test seam: `config.json` exists as a
 * *directory*, so `loadConfig`'s `readFileSync` throws `EISDIR` (a code that is
 * neither `ENOENT` nor a `SyntaxError`, so it propagates) on the first statement
 * of every handler `try` block. Nothing here needs the defect to be present in
 * order to reach the catch — the same fixture on the unfixed tree produces plain
 * text, which is exactly what the assertions below reject.
 */

type Handler = (options?: { json?: boolean }) => Promise<void>;

const READING_COMMANDS: ReadonlyArray<{ name: string; handler: Handler }> = [
  { name: 'next', handler: nextCommand as Handler },
  { name: 'plan', handler: planCommand as Handler },
  { name: 'progress', handler: progressCommand as Handler },
  { name: 'dashboard', handler: dashboardCommand as Handler },
  { name: 'validate', handler: validateCommand as Handler },
];

describe('Reading-command runtime errors keep the machine-readable contract (#325)', () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let prevIsTTY: boolean | undefined;
  let loggedOut: string[];
  let loggedErr: string[];
  const originalLog = console.log;
  const originalError = console.error;

  /** A config dir whose `config.json` is a directory: `loadConfig` throws EISDIR. */
  function installUnreadableConfig(configDir: string): void {
    fs.mkdirSync(path.join(configDir, 'config.json'), { recursive: true });
  }

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    prevIsTTY = process.stdout.isTTY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-runtime-error-'));
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    installUnreadableConfig(configDir);
    process.env.PALEE_CONFIG_DIR = configDir;

    loggedOut = [];
    loggedErr = [];
    console.log = (...args: unknown[]) => {
      loggedOut.push(args.map((a) => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      loggedErr.push(args.map((a) => String(a)).join(' '));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTTY, configurable: true });
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** stderr must be exactly one JSON object; a text line fails the parse. */
  function parsedStderr(): { error: string } {
    const raw = loggedErr.join('\n').trim();
    assert.ok(raw, 'expected the failure to be reported on stderr');
    assert.match(
      raw,
      /^\{.*\}$/s,
      `stderr must be a JSON object in machine mode, got: ${raw}`
    );
    return JSON.parse(raw) as { error: string };
  }

  for (const { name, handler } of READING_COMMANDS) {
    test(`${name} --json emits a parseable JSON error object on stderr at exit 5`, async () => {
      await handler({ json: true });

      const payload = parsedStderr();
      assert.strictEqual(typeof payload.error, 'string');
      assert.ok(payload.error.length > 0, 'the error message must survive into the payload');
      assert.match(payload.error, /EISDIR/, `the caught message is reported verbatim: ${payload.error}`);
      assert.deepStrictEqual(
        Object.keys(payload),
        ['error'],
        'the runtime payload carries the same single key the exit-2 path emits'
      );
      assert.strictEqual(loggedOut.length, 0, 'an error payload never rides on stdout');
      assert.strictEqual(process.exitCode, 5, 'exit code 5 is unchanged by the formatting fix');
    });

    test(`${name} on a piped stdout also emits JSON (non-TTY auto-detection)`, async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      await handler({});
      assert.match(parsedStderr().error, /EISDIR/);
      assert.strictEqual(process.exitCode, 5);
    });

    test(`${name} in a terminal keeps the plain-text line`, async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      await handler({});

      const raw = loggedErr.join('\n').trim();
      assert.ok(/^Error: /u.test(raw), `human mode stays text, got: ${raw}`);
      assert.match(raw, /EISDIR/);
      assert.ok(
        !raw.includes('{') && !raw.includes('}'),
        'no JSON braces in the human-readable line'
      );
      assert.strictEqual(loggedOut.length, 0);
      assert.strictEqual(process.exitCode, 5);
    });
  }

  test('the exit-5 payload and the exit-2 payload are the same shape', async () => {
    // The point of #325 is one contract, not a second one: the vault path that
    // already emitted JSON and the runtime catch must not diverge in keys.
    validateVaultPath(undefined, { json: true });
    const configPayload = parsedStderr();
    loggedErr.length = 0;

    await validateCommand({ json: true });
    const runtimePayload = parsedStderr();

    assert.deepStrictEqual(
      Object.keys(runtimePayload).sort(),
      Object.keys(configPayload).sort(),
      'both classes emit exactly { error }'
    );
    assert.strictEqual(process.exitCode, 5, 'the runtime class still exits 5');
  });
});
