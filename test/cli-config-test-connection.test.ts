import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

/**
 * `palee config test-connection` is the first command in PALEE that opens a socket, so its
 * exit contract is asserted end to end here. The refusal cases need no server: they resolve
 * before anything is sent, which is the point of validating at the boundary. The success
 * case runs the real CLI against a loopback server started in this process, because the
 * formatting of a live reply — and whether the credential survives it — is not reachable
 * from a unit test of the adapter.
 */
describe('CLI config test-connection (#24)', () => {
  let tempDir: string;
  let server: http.Server;
  let base = '';
  const seen: string[] = [];

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-test-conn-'));
    server = http.createServer((req, res) => {
      seen.push(String(req.url));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // undici and Node both keep sockets: without this the file lingers until the
    // keep-alive timeout expires.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function freshConfigDir(): string {
    return fs.mkdtempSync(path.join(tempDir, 'cfg-'));
  }

  /**
   * Spawned asynchronously on purpose. `execSync` blocks this process's event loop, so the
   * server above cannot answer the very request the child is waiting on — the pair
   * deadlocks and the child only escapes when its own 30 s deadline fires. Measured here,
   * not theorised: awaiting the spawn is the difference between testing the client and
   * testing a timeout.
   */
  async function run(args: string[], configDir: string): Promise<{ status: number; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const child = spawn('npx', ['tsx', 'bin/palee.ts', 'config', ...args], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: configDir },
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill(), 90_000);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code ?? 1, stdout, stderr });
      });
      child.stdin.end();
    });
  }

  test('an unconfigured endpoint is usage error 2, before any request', async () => {
    const result = await run(['test-connection'], freshConfigDir());
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /set-base-url/);
  });

  test('a stored endpoint the provider will not use is refused with the reason, not a stack', async () => {
    const configDir = freshConfigDir();
    // Written by hand, because `set-base-url` now refuses it at the same gate.
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ baseUrl: 'http://public.example/v1', apiKey: 'testkey-abc' })
    );
    const result = await run(['test-connection'], configDir);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /clear text/);
    assert.ok(!result.stderr.includes('testkey-abc'), result.stderr);
  });

  test('a provider this build cannot speak to is named as deferred, not as a bad key', async () => {
    const configDir = freshConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://api.anthropic.com', aiProvider: 'anthropic', apiKey: 'testkey-abc' })
    );
    const result = await run(['test-connection'], configDir);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Phase 3/);
  });

  test('a live loopback reply is printed with its endpoint, key source and token counts', async () => {
    const configDir = freshConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ baseUrl: `${base}/v1`, apiKey: 'testkey-loopback-secret', model: 'test-model' })
    );
    const result = await run(['test-connection'], configDir);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Provider reachable/);
    assert.ok(result.stdout.includes(`${base}/v1/chat/completions`), `the URL actually called is shown:\n${result.stdout}`);
    assert.match(result.stdout, /Key:\s+from the config file/);
    assert.match(result.stdout, /Reply:\s+OK/);
    assert.match(result.stdout, /Tokens:\s+4 in \/ 1 out/);
    assert.ok(!result.stdout.includes('testkey-loopback-secret'), result.stdout);
    assert.deepStrictEqual(seen, ['/v1/chat/completions']);
  });

  test('the environment key is reported as the source when it is the one used', async () => {
    const configDir = freshConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ baseUrl: `${base}/v1`, apiKey: 'testkey-stored-not-used' })
    );
    const previous = process.env.PALEE_API_KEY;
    process.env.PALEE_API_KEY = 'testkey-from-env-used';
    try {
      const result = await run(['test-connection'], configDir);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /PALEE_API_KEY/);
      assert.ok(!result.stdout.includes('testkey-from-env-used'), result.stdout);
      assert.ok(!result.stdout.includes('testkey-stored-not-used'), result.stdout);
    } finally {
      if (previous === undefined) delete process.env.PALEE_API_KEY;
      else process.env.PALEE_API_KEY = previous;
    }
  });
});
