import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PALEE_ARGV, CLI_SPAWN_TIMEOUT_MS } from './palee-cli';
import configCommand, { withConfigLock } from '../src/cli/config';

/**
 * Serializes the config read-modify-write (#565 P3-01).
 *
 * Every mutating `config` action loads the whole JSON, changes one field and
 * saves the whole object back. `saveConfig`'s temp+rename makes each write
 * atomic, but not the cycle: two concurrent commands both load the same
 * snapshot and the second rename silently drops the first one's field. The fix
 * is a lock file (`<config dir>/config.lock`) held from the load to the save.
 *
 * The deciding predicate is the lock around the read-modify-write. The
 * concurrent-children test below fails without it: all children load the same
 * initial state and only the last writer's field survives. The in-process tests
 * pin the lock's own semantics — blocking on a foreign holder, stealing a stale
 * one by quarantine, the acquisition timeout, and a release that never deletes
 * a lock that was stolen from its owner.
 */

/** The child environment for one run against one config directory. */
function childEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // An inherited PALEE_JSON would flip the child's output shape; the tests
  // assert on disk state and exit codes, but keep the runs human-shaped anyway.
  delete env.PALEE_JSON;
  // The temp config dir on a Windows runner sits outside the user profile, which
  // the #316 guard refuses for key storage; no child here stores a key, but the
  // opt-out keeps the suite's position consistent with the other config suites.
  env.PALEE_CONFIG_DIR = configDir;
  env.PALEE_ALLOW_INSECURE_CONFIG_DIR = '1';
  return env;
}

/**
 * Spawns the real CLI for one `palee config <args>` run, concurrently with any
 * other spawn the caller started. Resolves with the exit code and captured
 * output once the child closes.
 */
function spawnConfig(
  args: string[],
  configDir: string
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...PALEE_ARGV, 'config', ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: childEnv(configDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const killed = signal ? `\n(child killed by ${signal})` : '';
      resolve({ status: code ?? -1, stdout, stderr: stderr + killed });
    });
  });
}

/** Reads and parses the config.json in the given directory. */
function readStored(configDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
}

/** Writes a foreign holder's lock file payload into the given config dir. */
function writeForeignLock(configDir: string, nonce: string): string {
  const lockPath = path.join(configDir, 'config.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, nonce, acquired_at: new Date().toISOString() }), 'utf8');
  return lockPath;
}

/** Polls until `cond` holds or the budget runs out, then asserts it held. */
async function waitFor(cond: () => boolean, budgetMs = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.ok(cond(), `${what} did not hold within ${budgetMs}ms`);
}

describe('config lock semantics (in process)', () => {
  let previousConfigDir: string | undefined;
  let createdDirs: string[];

  before(() => {
    previousConfigDir = process.env.PALEE_CONFIG_DIR;
    createdDirs = [];
  });

  after(() => {
    if (previousConfigDir !== undefined) process.env.PALEE_CONFIG_DIR = previousConfigDir;
    else delete process.env.PALEE_CONFIG_DIR;
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A fresh config directory per test: the lock's state is files on disk, and a
   * leftover lock from one scenario (the timeout test deliberately leaves its
   * foreign holder behind) would make the next scenario wait out the stale
   * window instead of exercising what it names.
   */
  function freshConfigDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-lock-'));
    createdDirs.push(dir);
    process.env.PALEE_CONFIG_DIR = dir;
    return dir;
  }

  test('withConfigLock runs the callback and removes its lock file', async () => {
    const configDir = freshConfigDir();
    const result = await withConfigLock(() => 'ran');
    assert.strictEqual(result, 'ran');
    assert.ok(!fs.existsSync(path.join(configDir, 'config.lock')), 'the lock must not outlive its holder');
  });

  test('a fresh foreign lock blocks acquisition until it disappears', async () => {
    const configDir = freshConfigDir();
    const lockPath = writeForeignLock(configDir, 'blocked-waiter');
    let settled = false;
    const pending = withConfigLock(() => 'ran-after-wait').then((value) => {
      settled = true;
      return value;
    });

    // Long enough that a lock-free implementation (or an immediate steal) has
    // finished many times over; short of the 10s default stale window, so the
    // foreign lock cannot be stolen out from under this assertion.
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    assert.ok(!settled, 'acquisition must still be waiting while the foreign lock is fresh');

    fs.unlinkSync(lockPath);
    assert.strictEqual(await pending, 'ran-after-wait');
    assert.ok(!fs.existsSync(path.join(configDir, 'config.lock')));
  });

  test('a stale foreign lock is stolen, quarantined rather than deleted', async () => {
    const configDir = freshConfigDir();
    const lockPath = writeForeignLock(configDir, 'dead-holder');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    const result = await withConfigLock(() => 'stole-and-ran', { staleMs: 100 });
    assert.strictEqual(result, 'stole-and-ran');
    const quarantined = fs.readdirSync(configDir).filter((name) => name.startsWith('config.lock.stale.'));
    assert.ok(quarantined.length >= 1, 'the stolen lock must be renamed aside, not deleted');
    const quarantinedPayload = JSON.parse(
      fs.readFileSync(path.join(configDir, quarantined[0] as string), 'utf8')
    ) as { pid: number; nonce: string };
    assert.strictEqual(quarantinedPayload.nonce, 'dead-holder', 'the payload stays readable for diagnosis');
    assert.strictEqual(quarantinedPayload.pid, 999999);
    assert.ok(!fs.existsSync(path.join(configDir, 'config.lock')), 'and the winner must have released its own lock');
  });

  test('acquisition times out with an actionable error while a foreign lock is fresh', async () => {
    const configDir = freshConfigDir();
    writeForeignLock(configDir, 'forever-holder');
    await assert.rejects(
      withConfigLock(() => 'never', { timeoutMs: 250 }),
      /timed out waiting for the configuration lock/
    );
  });

  test('release leaves a lock that was stolen from its owner alone', async () => {
    const configDir = freshConfigDir();
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const lockPath = path.join(configDir, 'config.lock');
    const pending = withConfigLock(() => hold.then(() => 'held'));

    // Wait for the holder's payload, not just the file: `openSync` creates the
    // file before `writeSync` fills it, and overwriting in that gap would race
    // the holder's own write.
    await waitFor(() => {
      try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { nonce?: unknown };
        return typeof parsed.nonce === 'string';
      } catch {
        return false;
      }
    }, 2000, 'the holder’s lock payload');
    // Simulate the stale-window theft: someone else now owns the lock file.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234, nonce: 'thief', acquired_at: new Date().toISOString() }), 'utf8');
    releaseHold();
    assert.strictEqual(await pending, 'held');

    assert.ok(fs.existsSync(lockPath), 'release must not delete the thief’s lock');
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { nonce: string };
    assert.strictEqual(current.nonce, 'thief');
    fs.unlinkSync(lockPath);
  });

  test('a load that overlaps a concurrent save cannot drop that save’s field', async () => {
    const configDir = freshConfigDir();
    const realReadFileSync = fs.readFileSync;

    // The interleave a child process cannot be timed into (the same trick
    // test/cli-adopt-concurrency.test.ts uses): the racing command is started
    // from inside the outer command's `loadConfig` read, so its own load
    // happens before the outer command's save — without the lock both write
    // from the same empty snapshot and the last rename drops the other's
    // field, deterministically, whatever the machine's speed. With the lock the
    // racing command cannot even reach its load until the outer one has saved
    // and released, so it reads the field back instead of dropping it.
    let armed = false;
    let racing: Promise<void> | null = null;
    (fs as unknown as { readFileSync: unknown }).readFileSync = ((
      target: fs.PathOrFileDescriptor,
      options?: unknown
    ) => {
      // Disarm before the delegate: on a fresh dir the first config read throws
      // ENOENT (loadConfig treats that as "no config yet"), and the launch has
      // to happen for that path too.
      const isArmedConfigRead = armed && typeof target === 'string' && target.endsWith('config.json');
      if (isArmedConfigRead) armed = false;
      try {
        return Reflect.apply(realReadFileSync, fs, [target, options]);
      } finally {
        if (isArmedConfigRead) {
          racing = configCommand('set-model', 'interleaved-model', {});
        }
      }
    }) as typeof fs.readFileSync;

    try {
      process.exitCode = 0;
      armed = true;
      await configCommand('set-provider', 'interleaved-provider', {});
      assert.ok(racing !== null, 'the racing command must have been started from the outer load');
      await racing;
      assert.strictEqual(process.exitCode, 0, 'neither command may fail');

      const stored = readStored(configDir);
      assert.strictEqual(stored.aiProvider, 'interleaved-provider', 'the outer command’s field must survive');
      assert.strictEqual(stored.model, 'interleaved-model', 'the racing command must keep the field it loaded late');
    } finally {
      (fs as unknown as { readFileSync: unknown }).readFileSync = realReadFileSync;
      process.exitCode = 0;
      assert.ok(!fs.existsSync(path.join(configDir, 'config.lock')), 'no lock may outlive the run');
    }
  });
});

describe('config lock across processes (#565 P3-01)', () => {
  // A direct `node --import tsx --test` run skips the pretest build; these
  // children spawn `dist/bin/palee.js` unless coverage is on, so the build must
  // be current for the lock under test to be in them.
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-lock-cli-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('concurrent config commands keep each other’s fields', async () => {
    const configDir = fs.mkdtempSync(path.join(root, 'cfg-'));
    const vaultDir = fs.mkdtempSync(path.join(root, 'vault-'));

    // Four commands, four distinct fields, started together, as real processes:
    // the end-to-end companion to the deterministic interleave test above. With
    // the lock a pass is guaranteed — every save happens inside the lock, so it
    // sees the fields the earlier commands wrote. Without the lock this race is
    // only *likely* to drop a field (children can boot serially enough to
    // serialize by accident, as it did during falsification), so the
    // must-fail-when-removed proof lives in the in-process interleave test,
    // not here.
    const results = await Promise.all([
      spawnConfig(['set-vault', vaultDir], configDir),
      spawnConfig(['set-provider', 'ollama'], configDir),
      spawnConfig(['set-model', 'concurrency-test-model'], configDir),
      spawnConfig(['set-base-url', 'http://127.0.0.1:11434/v1'], configDir),
    ]);
    for (const [index, result] of results.entries()) {
      assert.strictEqual(result.status, 0, `child ${index} must succeed:\n${result.stdout}\n${result.stderr}`);
    }

    const stored = readStored(configDir);
    assert.strictEqual(stored.vaultPath, vaultDir, 'the vault path must survive the other writers');
    assert.strictEqual(stored.aiProvider, 'ollama', 'the provider must survive the other writers');
    assert.strictEqual(stored.model, 'concurrency-test-model', 'the model must survive the other writers');
    assert.strictEqual(stored.baseUrl, 'http://127.0.0.1:11434/v1', 'the base URL must survive the other writers');
    assert.ok(!fs.existsSync(path.join(configDir, 'config.lock')), 'no lock may outlive the runs');
  });

  test('a lock abandoned by a dead process does not wedge the CLI', async () => {
    const configDir = fs.mkdtempSync(path.join(root, 'stale-'));
    const lockPath = writeForeignLock(configDir, 'crashed-process');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    const result = await spawnConfig(['set-model', 'after-crash-model'], configDir);
    assert.strictEqual(result.status, 0, `the stale lock must be stolen, not waited on:\n${result.stdout}\n${result.stderr}`);
    assert.strictEqual(readStored(configDir).model, 'after-crash-model');
    assert.ok(
      fs.readdirSync(configDir).some((name) => name.startsWith('config.lock.stale.')),
      'the dead holder’s lock is quarantined'
    );
    assert.ok(!fs.existsSync(lockPath), 'and the winning run must not leave its own lock behind');
  });
});
