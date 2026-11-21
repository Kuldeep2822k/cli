import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { saveConfig, withConfigLock, getConfigPath } from '../src/cli/config';
import type { NodeError } from '../src/types';
import type { PaleeConfig } from '../src/types';

/**
 * Configuration write integrity and operation-scoped lock failures (#620 follow-up).
 *
 * Every case injects a fault at a real `fs` primitive the production code calls,
 * restores it in `finally`, and asserts on bytes/exit classification. The two
 * short-write cases follow the complete-write rule: progress is completed, and
 * only zero progress or a throw fails the operation. Disposable config dirs only.
 */

function patch<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): () => void {
  const original = obj[key];
  obj[key] = value;
  return () => {
    obj[key] = original;
  };
}

function eperm(): NodeError {
  const err = new Error('EPERM: operation not permitted') as NodeError;
  err.code = 'EPERM';
  return err;
}

describe('config write integrity (#620 follow-up)', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-integrity-'));
    originalConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
    else process.env.PALEE_CONFIG_DIR = originalConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function configPath(): string {
    return getConfigPath();
  }

  function seedConfig(): string {
    const seeded = JSON.stringify({ vaultPath: '/vault', aiProvider: 'openai' }, null, 2);
    fs.writeFileSync(configPath(), seeded, 'utf8');
    return seeded;
  }

  test('saveConfig completes a progressing short write instead of publishing a torn file', () => {
    seedConfig();
    const realWrite = fs.writeSync;
    const restore = patch(fs as any, 'writeSync', (fd: number, data: unknown, ...rest: unknown[]): number => {
      if (typeof data === 'string') {
        const bytes = Buffer.from(data, 'utf8');
        return (realWrite as (...a: unknown[]) => number)(fd, bytes, 0, Math.min(7, bytes.length), 0);
      }
      const offset = (rest[0] as number) ?? 0;
      const length = (rest[1] as number) ?? 0;
      return (realWrite as (...a: unknown[]) => number)(fd, data, offset, Math.min(7, length), null);
    });
    try {
      saveConfig({ vaultPath: '/vault-two', aiProvider: 'gemini' } as PaleeConfig);
    } finally {
      restore();
    }
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as PaleeConfig;
    assert.strictEqual(parsed.vaultPath, '/vault-two');
    assert.strictEqual(parsed.aiProvider, 'gemini');
  });

  test('saveConfig preserves the prior config when the write makes zero progress', () => {
    const seeded = seedConfig();
    let seededWrites = 0;
    const restore = patch(fs as any, 'writeSync', (_fd: number, _data: unknown, ..._rest: unknown[]): number => {
      // The lock payload is not involved here; only the config temp write is refused.
      seededWrites += 1;
      return 0;
    });
    try {
      assert.throws(() => saveConfig({ vaultPath: '/vault-two', aiProvider: 'gemini' } as PaleeConfig));
    } finally {
      restore();
    }
    assert.ok(seededWrites > 0, 'the fault must have fired');
    assert.strictEqual(fs.readFileSync(configPath(), 'utf8'), seeded, 'the prior config must be byte-for-byte intact');
  });

  test('saveConfig never deletes a pre-existing entry at its temp name when wx fails', () => {
    seedConfig();
    const fixed = Buffer.from('deadbeef', 'hex');
    const realRandom = crypto.randomBytes;
    const restoreRandom = patch(crypto as any, 'randomBytes', ((size: number) =>
      size === 4 ? fixed : (realRandom as (n: number) => Buffer)(size)) as typeof crypto.randomBytes);
    const tempPath = `${configPath()}.tmp.${process.pid}.deadbeef`;
    fs.writeFileSync(tempPath, 'preexisting-entry', 'utf8');
    const realOpen = fs.openSync;
    const restoreOpen = patch(fs as any, 'openSync', (target: unknown, flags?: unknown, mode?: unknown) => {
      if (target === tempPath && flags === 'wx') {
        const err = new Error('EEXIST: file already exists') as NodeError;
        err.code = 'EEXIST';
        throw err;
      }
      return (realOpen as (...a: unknown[]) => number)(target, flags, mode);
    });
    try {
      assert.throws(() => saveConfig({ vaultPath: '/vault-two' } as PaleeConfig));
      assert.ok(fs.existsSync(tempPath), 'a wx collision must never unlink the entry this call did not create');
      assert.strictEqual(fs.readFileSync(tempPath, 'utf8'), 'preexisting-entry');
    } finally {
      restoreOpen();
      restoreRandom();
      fs.rmSync(tempPath, { force: true });
    }
  });

  test('lock: a progressing short payload write acquires with a complete payload and releases', async () => {
    const realWrite = fs.writeSync;
    const restore = patch(fs as any, 'writeSync', (fd: number, data: unknown, ...rest: unknown[]): number => {
      if (typeof data === 'string') {
        const bytes = Buffer.from(data, 'utf8');
        return (realWrite as (...a: unknown[]) => number)(fd, bytes, 0, Math.min(7, bytes.length), 0);
      }
      const offset = (rest[0] as number) ?? 0;
      const length = (rest[1] as number) ?? 0;
      return (realWrite as (...a: unknown[]) => number)(fd, data, offset, Math.min(7, length), null);
    });
    let lockPayload: string | null = null;
    try {
      const result = await withConfigLock(() => {
        lockPayload = fs.readFileSync(path.join(tempDir, 'config.lock'), 'utf8');
        return 'ran';
      }, { timeoutMs: 5000, staleMs: 60000 });
      assert.strictEqual(result, 'ran');
    } finally {
      restore();
    }
    const parsed = JSON.parse(lockPayload ?? '{}') as { nonce?: unknown };
    assert.match(String(parsed.nonce), /^[0-9a-f]{16}$/, 'the callback must see the complete lock payload');
    assert.ok(!fs.existsSync(path.join(tempDir, 'config.lock')), 'release must remove the lock it acquired');
  });

  test('lock: zero-progress payload writes fail acquisition without running the callback', async () => {
    let ran = false;
    const restore = patch(fs as any, 'writeSync', () => 0);
    try {
      await assert.rejects(
        withConfigLock(() => { ran = true; return 'never'; }, { timeoutMs: 2000, staleMs: 60000 }),
        (err: unknown) => /stalled/i.test(String((err as Error).message))
      );
    } finally {
      restore();
    }
    assert.strictEqual(ran, false, 'a failed initialization is never acquisition');
  });

  test('lock: payload EPERM is not retried as creation contention', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    assert.ok(realPlatform !== undefined);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    let ran = false;
    const restore = patch(fs as any, 'writeSync', () => { throw eperm(); });
    const started = Date.now();
    try {
      const err = await withConfigLock(() => { ran = true; return 'never'; }, { timeoutMs: 5000, staleMs: 60000 }).then(
        () => { throw new Error('acquisition must not succeed'); },
        (e: unknown) => e
      );
      const elapsed = Date.now() - started;
      assert.strictEqual((err as NodeError).code, 'EPERM', 'the payload error keeps its own classification');
      assert.ok(elapsed < 2000, `must not wait on this call's own lock, saw ${elapsed}ms`);
    } finally {
      restore();
      Object.defineProperty(process, 'platform', realPlatform);
    }
    assert.strictEqual(ran, false);
  });

  test('lock: a write error is preserved when close also fails', async () => {
    const writeErr = new Error('EWRITE: simulated write failure') as NodeError;
    writeErr.code = 'EWRITE';
    const closeErr = new Error('ECLOSE: simulated close failure') as NodeError;
    closeErr.code = 'ECLOSE';
    const realClose = fs.closeSync;
    const restoreWrite = patch(fs as any, 'writeSync', () => { throw writeErr; });
    const restoreClose = patch(fs as any, 'closeSync', (fd: number) => {
      (realClose as (n: number) => void)(fd);
      throw closeErr;
    });
    try {
      const err = await withConfigLock(() => 'never', { timeoutMs: 2000, staleMs: 60000 }).then(
        () => { throw new Error('acquisition must not succeed'); },
        (e: unknown) => e
      );
      assert.strictEqual((err as NodeError).code, 'EWRITE', 'the original write error must win over a close failure');
    } finally {
      restoreClose();
      restoreWrite();
    }
  });

  test('lock: a persistent creation denial backs off instead of spinning', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    assert.ok(realPlatform !== undefined);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    let attempts = 0;
    const realOpen = fs.openSync;
    const restore = patch(fs as any, 'openSync', (target: unknown, flags?: unknown, mode?: unknown) => {
      if (typeof target === 'string' && target.endsWith('config.lock') && flags === 'wx') {
        attempts += 1;
        throw eperm();
      }
      return (realOpen as (...a: unknown[]) => number)(target, flags, mode);
    });
    try {
      const err = await withConfigLock(() => 'never', { timeoutMs: 400, staleMs: 60000 }).then(
        () => { throw new Error('acquisition must not succeed'); },
        (e: unknown) => e
      );
      assert.strictEqual((err as NodeError).code, 'ECONFLICT');
      assert.ok(attempts < 60, `a persistent denial must back off, saw ${attempts} attempts in 400ms`);
    } finally {
      restore();
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });
});
