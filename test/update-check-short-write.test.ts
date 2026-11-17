/**
 * P3-03 review — the update-check cache must never be replaced by a torn file.
 *
 * `writeUpdateCheckRecord` lands the payload in an exclusive temp file and
 * renames it over the cache. The earlier writer called `fs.writeSync` once and
 * ignored the byte count, so a short write published truncated JSON as the
 * cache and silently dropped every other install's saved entry with it.
 *
 * These tests fault-inject at the real `fs.writeSync` primitive the writer
 * calls — the same module-object patching `cli-update.test.ts` uses for
 * `spawnSync` — and assert on the bytes that actually land. The patch is
 * restored in `finally` so no other test in this process inherits it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateCheckPath, writeUpdateCheckRecord } from '../src/cli/update-check';

const SHORT_WRITE_BYTES = 7;

/** An entry that reads as fresh, so the cache is the only thing under test. */
function entry(checkedAt: number, latestVersion: string | null) {
  return { checkedAt, latestVersion, notifiedVersion: null };
}

describe('update-check cache survives short writes (P3-03)', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-update-short-write-'));
    originalConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
    else process.env.PALEE_CONFIG_DIR = originalConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function cachePath(): string {
    return updateCheckPath();
  }

  function seedCache(): string {
    const seeded = JSON.stringify({ '0.9.0': entry(1, '1.0.0') }, null, 2);
    fs.writeFileSync(cachePath(), seeded, 'utf8');
    return seeded;
  }

  function tempFiles(): string[] {
    return fs
      .readdirSync(tempDir)
      .filter((name) => name.startsWith('update-check.json.tmp.'));
  }

  /**
   * Replaces `fs.writeSync` for the duration of `fn`, reporting every call.
   * A string call is the pre-fix shape; a Buffer call is the loop.
   */
  function withShortWrites<T>(
    plan: (call: number) => { kind: 'write'; maxBytes: number } | { kind: 'throw' } | { kind: 'zero' },
    fn: () => T
  ): { result: T; calls: number } {
    const realWriteSync = fs.writeSync;
    let calls = 0;
    (fs as any).writeSync = (fd: number, data: unknown, ...rest: unknown[]): number => {
      calls += 1;
      const step = plan(calls);
      if (step.kind === 'throw') {
        const error = new Error('simulated EIO after partial progress') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      if (step.kind === 'zero') return 0;
      if (typeof data === 'string') {
        const encoding = typeof rest[1] === 'string' ? rest[1] : 'utf8';
        const position = typeof rest[0] === 'number' ? rest[0] : 0;
        const bytes = Buffer.from(data, encoding as BufferEncoding).subarray(0, step.maxBytes);
        return realWriteSync(fd, bytes, 0, bytes.length, position);
      }
      const offset = rest[0] as number;
      const length = rest[1] as number;
      return realWriteSync(fd, data as Buffer, offset, Math.min(step.maxBytes, length), null);
    };
    try {
      return { result: fn(), calls };
    } finally {
      (fs as any).writeSync = realWriteSync;
    }
  }

  test('a short-writing filesystem still yields the complete payload, other entries intact', () => {
    seedCache();
    const { calls } = withShortWrites(() => ({ kind: 'write', maxBytes: SHORT_WRITE_BYTES }), () => {
      writeUpdateCheckRecord('1.0.0', entry(5, '1.1.0'));
    });

    assert.ok(calls > 1, `a ${SHORT_WRITE_BYTES}-byte ceiling must take several writes, saw ${calls}`);
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Record<string, unknown>;
    assert.deepStrictEqual(parsed['0.9.0'], entry(1, '1.0.0'), 'the other install\'s entry must survive');
    assert.deepStrictEqual(parsed['1.0.0'], entry(5, '1.1.0'), 'the new entry must land complete');
    assert.deepStrictEqual(tempFiles(), [], 'no temp file is left behind');
  });

  test('a write that fails after partial progress leaves the prior cache intact', () => {
    const seeded = seedCache();
    const { calls } = withShortWrites(
      (call) => (call === 1 ? { kind: 'write', maxBytes: SHORT_WRITE_BYTES } : { kind: 'throw' }),
      () => {
        writeUpdateCheckRecord('1.0.0', entry(5, '1.1.0'));
      }
    );

    assert.equal(calls, 2, `expected one partial write then the failure, saw ${calls} call(s)`);
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), seeded, 'the prior cache must be byte-for-byte intact');
    assert.deepStrictEqual(tempFiles(), [], "this call's own temp file must be cleaned up");
  });

  test('zero progress stops bounded instead of spinning, leaving the prior cache intact', () => {
    const seeded = seedCache();
    const { calls } = withShortWrites(() => ({ kind: 'zero' }), () => {
      writeUpdateCheckRecord('1.0.0', entry(5, '1.1.0'));
    });

    assert.equal(calls, 1, 'a zero-byte write must abort the loop immediately, not retry forever');
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), seeded, 'the prior cache must be byte-for-byte intact');
    assert.deepStrictEqual(tempFiles(), [], "this call's own temp file must be cleaned up");
  });
});
