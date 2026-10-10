import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/cli/config';

/**
 * `palee config set-provider` could store a provider name and nothing else, so the
 * Phase-2 AI layer had nowhere to put the endpoint and credential its own design
 * document names (#82). These run the real CLI: the interesting properties are what
 * reaches disk, what reaches stdout, and what mode the file gets — a unit test on the
 * setter would stay green while `config show` printed the key.
 */
describe('CLI config provider credentials (#82)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-creds-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Returns a fresh, empty config directory under the suite's temp root. */
  function freshConfigDir(): string {
    return fs.mkdtempSync(path.join(tempDir, 'cfg-'));
  }

  /** Reads and parses the config.json written in the given directory. */
  function readStored(configDir: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  }

  /** Like {@link readStored}, but returns `{}` when no config file exists yet. */
  function readStoredOrEmpty(configDir: string): Record<string, unknown> {
    const file = path.join(configDir, 'config.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  /**
   * Runs the real `palee config` CLI against an isolated config directory.
   *
   * @param args - Arguments after `config` (e.g. `['set-api-key', '--from-env', 'VAR']`).
   * @param configDir - Directory bound to `PALEE_CONFIG_DIR` for this run.
   * @param opts - Optional stdin `input` and extra `env` entries.
   * @returns The process exit `status` and captured `stdout` / `stderr`.
   */
  function runConfig(
    args: string[],
    configDir: string,
    opts: { input?: string; env?: Record<string, string> } = {}
  ): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(`npx tsx bin/palee.ts config ${args.join(' ')}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: configDir, ...opts.env },
        encoding: 'utf8',
        stdio: 'pipe',
        // Always a pipe, never a terminal: the interactive branch is the one a test
        // cannot drive, and this keeps `set-api-key` off the prompt path.
        input: opts.input ?? '',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  test('set-base-url persists the endpoint next to the provider name', () => {
    const configDir = freshConfigDir();
    assert.strictEqual(runConfig(['set-provider', 'opencode'], configDir).status, 0);
    const result = runConfig(['set-base-url', 'https://opencode.ai/zen/v1'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(readStored(configDir).baseUrl, 'https://opencode.ai/zen/v1');
    assert.match(runConfig(['show'], configDir).stdout, /Base URL: https:\/\/opencode\.ai\/zen\/v1/);
  });

  test('a value that is not a URL is refused and nothing is written', () => {
    const configDir = freshConfigDir();
    const sloppy = runConfig(['set-base-url', '"not a url"'], configDir);
    assert.strictEqual(sloppy.status, 2, `an unparseable URL must be usage error 2:\n${sloppy.stdout}${sloppy.stderr}`);
    assert.ok(!fs.existsSync(path.join(configDir, 'config.json')), 'a refused value must not create a config');

    // `new URL` accepts these; a provider endpoint that is not HTTP(S) would send a
    // credential to a scheme that cannot carry one.
    for (const value of ['file:///etc/passwd', 'ftp://host/v1', 'data:text/plain,hi']) {
      const wrongScheme = runConfig(['set-base-url', value], configDir);
      assert.strictEqual(wrongScheme.status, 2, `${value} must be refused:\n${wrongScheme.stderr}`);
    }
    assert.ok(!fs.existsSync(path.join(configDir, 'config.json')), 'none of the refusals wrote a config');
  });

  test('a loopback endpoint is accepted: local providers are the point of base_url', () => {
    const configDir = freshConfigDir();
    assert.strictEqual(runConfig(['set-base-url', 'http://127.0.0.1:11434/v1'], configDir).status, 0);
    assert.strictEqual(readStored(configDir).baseUrl, 'http://127.0.0.1:11434/v1');
  });

  test('a base URL that embeds a credential is refused rather than stored', () => {
    const configDir = freshConfigDir();
    // `config show` prints the base URL verbatim, so a key smuggled into the
    // authority (https://user:key@host) would leak the moment someone ran show.
    const result = runConfig(['set-base-url', 'https://user:testkey-in-url-9f2a@opencode.ai/v1'], configDir);
    assert.strictEqual(result.status, 2, `an embedded credential must be refused:\n${result.stdout}${result.stderr}`);
    assert.ok(!result.stdout.includes('testkey-in-url-9f2a') && !result.stderr.includes('testkey-in-url-9f2a'),
      'the rejection must not echo the smuggled credential');
    assert.ok(!fs.existsSync(path.join(configDir, 'config.json')), 'a refused URL must not create a config');
  });

  test('a base URL carrying a key in the query or fragment is refused, not stored', () => {
    const configDir = freshConfigDir();
    // The authority is not the only place a key can hide: a query or fragment is
    // stored verbatim and printed by `config show` just the same.
    for (const value of ['https://opencode.ai/v1?api_key=sk-query-7c1d', 'https://opencode.ai/v1#sk-frag-7c1d']) {
      const result = runConfig(['set-base-url', value], configDir);
      assert.strictEqual(result.status, 2, `a key in the URL must be refused:\n${result.stdout}${result.stderr}`);
      assert.ok(!result.stdout.includes('sk-query-7c1d') && !result.stderr.includes('sk-query-7c1d'),
        'the rejection must not echo the query credential');
      assert.ok(!result.stdout.includes('sk-frag-7c1d') && !result.stderr.includes('sk-frag-7c1d'),
        'the rejection must not echo the fragment credential');
    }
    assert.ok(!fs.existsSync(path.join(configDir, 'config.json')), 'a refused URL must not create a config');
  });

  test('set-api-key --from-env stores the key and never echoes it', () => {
    const configDir = freshConfigDir();
    const result = runConfig(['set-api-key', '--from-env', 'PALEE_TEST_KEY'], configDir, {
      env: { PALEE_TEST_KEY: 'testkey-from-env-9b2c1d' },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(readStored(configDir).apiKey, 'testkey-from-env-9b2c1d');
    assert.ok(
      !result.stdout.includes('testkey-from-env-9b2c1d'),
      `the confirmation must not repeat the secret it read:\n${result.stdout}`
    );
  });

  test('set-api-key --from-env on an unset variable is usage error, not an empty key', () => {
    const configDir = freshConfigDir();
    const result = runConfig(['set-api-key', '--from-env', 'PALEE_TEST_ABSENT_KEY'], configDir);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /PALEE_TEST_ABSENT_KEY/);
    assert.ok(!fs.existsSync(path.join(configDir, 'config.json')), 'no config written for a key that was not there');
  });

  test('a key passed as an argument is refused, because argv is world-readable', () => {
    const configDir = freshConfigDir();
    const result = runConfig(['set-api-key', 'testkey-never-type-this'], configDir);
    assert.strictEqual(result.status, 2, `the positional form must be refused:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /argv|process/i);
    assert.strictEqual(readStoredOrEmpty(configDir).apiKey, undefined, 'the refused key must not be on disk');
  });

  test('a piped key is stored with its trailing newline trimmed', () => {
    const configDir = freshConfigDir();
    const result = runConfig(['set-api-key'], configDir, { input: 'testkey-piped-4f4e\n' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(readStored(configDir).apiKey, 'testkey-piped-4f4e');
  });

  test('an empty pipe is refused rather than storing a blank credential', () => {
    const configDir = freshConfigDir();
    const result = runConfig(['set-api-key'], configDir, { input: '   \n' });
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.strictEqual(readStoredOrEmpty(configDir).apiKey, undefined);
  });

  test('a key with an embedded control character is refused, not stored to fail at call time', () => {
    const configDir = freshConfigDir();
    // A pasted key with a stray tab or DEL cannot go into an Authorization header. The
    // provider refuses it at call time; set-api-key refuses it on the way in so a key that
    // can never work is never stored. The trailing newline is trimmed, so the control
    // character here is embedded in the middle.
    const result = runConfig(['set-api-key'], configDir, { input: 'testkey-\tbroken-9a1f\n' });
    assert.strictEqual(result.status, 2, `an unsendable key must be refused:\n${result.stdout}${result.stderr}`);
    assert.ok(
      !result.stdout.includes('testkey-') && !result.stderr.includes('testkey-'),
      'the rejection must not echo the key'
    );
    assert.strictEqual(readStoredOrEmpty(configDir).apiKey, undefined, 'the unsendable key must not be on disk');
  });

  test('config show redacts the key, and no field of it appears in the output', () => {
    const configDir = freshConfigDir();
    runConfig(['set-api-key', '--from-env', 'PALEE_TEST_KEY'], configDir, {
      env: { PALEE_TEST_KEY: 'testkey-leak-check-77aa' },
    });
    const shown = runConfig(['show'], configDir);
    assert.strictEqual(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /API Key: •+/);
    assert.ok(!shown.stdout.includes('testkey-leak-check-77aa'), `config show leaked the key:\n${shown.stdout}`);
    assert.ok(!shown.stdout.includes('77aa'), `even a suffix of the key must not print:\n${shown.stdout}`);

    // Before #82 the same assertion passed because no key could exist at all. With one
    // storable, this is the invariant README and the spec actually promise.
    const unset = freshConfigDir();
    assert.match(runConfig(['show'], unset).stdout, /API Key: \(not set\)/);
  });

  test('config show --json reports that a key is set without emitting any of it', () => {
    const configDir = freshConfigDir();
    runConfig(['set-base-url', 'https://opencode.ai/zen/v1'], configDir);
    runConfig(['set-api-key', '--from-env', 'PALEE_TEST_KEY'], configDir, {
      env: { PALEE_TEST_KEY: 'testkey-json-leak-check-5c3a' },
    });
    const shown = runConfig(['show', '--json'], configDir);
    assert.strictEqual(shown.status, 0, shown.stderr);

    const parsed = JSON.parse(shown.stdout);
    assert.strictEqual(parsed.api_key_set, true, 'the boolean, not the key, carries the fact a key exists');
    assert.strictEqual(parsed.base_url, 'https://opencode.ai/zen/v1');
    assert.ok(!('api_key' in parsed) && !('apiKey' in parsed), 'the key value has no field at all in JSON');
    assert.ok(!shown.stdout.includes('testkey-json-leak-check-5c3a'), `JSON output leaked the key:\n${shown.stdout}`);
    assert.ok(!shown.stdout.includes('5c3a'), `even a suffix of the key must not print:\n${shown.stdout}`);

    const unset = freshConfigDir();
    assert.strictEqual(JSON.parse(runConfig(['show', '--json'], unset).stdout).api_key_set, false);
  });

  test('unset-api-key removes the secret from disk', () => {
    const configDir = freshConfigDir();
    runConfig(['set-api-key', '--from-env', 'PALEE_TEST_KEY'], configDir, {
      env: { PALEE_TEST_KEY: 'testkey-to-remove' },
    });
    runConfig(['set-base-url', 'https://opencode.ai/zen/v1'], configDir);
    const removed = runConfig(['unset-api-key'], configDir);
    assert.strictEqual(removed.status, 0, removed.stderr);
    assert.ok(!('apiKey' in readStored(configDir)), 'the field is gone, not blanked');
    assert.strictEqual(readStored(configDir).baseUrl, 'https://opencode.ai/zen/v1', 'other settings survive');
    assert.match(runConfig(['show'], configDir).stdout, /API Key: \(not set\)/);
    assert.match(runConfig(['unset-api-key'], configDir).stdout, /[Nn]o API key/);
  });

  test('loadConfig keeps only string values, so a hand-edited number is not a credential', () => {
    const configDir = freshConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ apiKey: 20240115, baseUrl: ['https://a', 'https://b'], vaultPath: '/vault' })
    );
    // `getConfigPath` reads the env var on every call, so an in-process `loadConfig`
    // without it would read the developer's real config instead of this fixture.
    const previous = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = configDir;
    try {
      const loaded = loadConfig();
      assert.strictEqual(loaded.apiKey, undefined);
      assert.strictEqual(loaded.baseUrl, undefined);
      assert.strictEqual(loaded.vaultPath, '/vault');
    } finally {
      if (previous === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = previous;
    }
  });
});

/**
 * A file that can hold a provider credential must not be readable by the rest of the
 * account's processes. Windows resolves access through the directory ACL and ignores
 * the mode, so this is asserted where the mode means something.
 */
describe('config file mode (#82)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-mode-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs `palee config` for the mode suite, with a key available in the env. */
  function runConfig(args: string[], configDir: string): void {
    execSync(`npx tsx bin/palee.ts config ${args.join(' ')}`, {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: configDir, PALEE_TEST_KEY: 'testkey-mode-check' },
      encoding: 'utf8',
      stdio: 'pipe',
      input: '',
    });
  }

  test('a written config grants access to nobody but the owner', () => {
    if (process.platform === 'win32') return; // NTFS resolves access through the directory ACL
    const configDir = fs.mkdtempSync(path.join(tempDir, 'cfg-'));
    runConfig(['set-api-key', '--from-env', 'PALEE_TEST_KEY'], configDir);
    const mode = fs.statSync(path.join(configDir, 'config.json')).mode;
    assert.strictEqual(mode & 0o077, 0, `group and other bits must be clear, got 0o${(mode & 0o777).toString(8)}`);
  });

  test('re-saving tightens a config file that predates the credential field', () => {
    if (process.platform === 'win32') return;
    const configDir = fs.mkdtempSync(path.join(tempDir, 'cfg-'));
    runConfig(['set-vault', configDir], configDir);
    const file = path.join(configDir, 'config.json');
    // The upgrade path: a vault configured before #82 has a 0644 file, and the first
    // write that lands a key must replace it wholesale rather than keep the old mode.
    fs.chmodSync(file, 0o644);
    assert.notStrictEqual(fs.statSync(file).mode & 0o077, 0, 'the fixture is world-readable first');
    runConfig(['set-api-key', '--from-env', 'PALEE_TEST_KEY'], configDir);
    assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  });
});
