import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { saveConfig, withConfigLock, getConfigPath } from '../src/cli/config';
import type { NodeError, PaleeConfig } from '../src/types';

/**
 * Approved DESIGN-V3 acceptance matrix (#620 follow-up).
 *
 * Every case injects a fault at a real `fs` primitive the production code calls,
 * restores it in `finally`, and records one JSON observation when an observations
 * directory is configured. Timing is driven by a fake clock; nothing here sleeps.
 * A fault seam is scoped by the descriptor this call created, never by a global
 * "fail everything" flag, so cleanup and publication can be asserted exactly.
 *
 * The approved successor-during-failed-initialization case is the one control
 * that the pre-fix revision is also expected to pass; it is labelled as such.
 */

type RealWriteSync = (fd: number, data: Buffer, offset: number, length: number) => number;
type RealCloseSync = (fd: number) => void;

interface ObservationData {
  [key: string]: unknown;
}

let networkCalls = 0;

function observationDirectory(): string | null {
  const configured = process.env.PALEE_V3_OBSERVATIONS_DIR;
  return configured && configured.length > 0 ? configured : null;
}

function writeObservation(id: string, passed: boolean, data: ObservationData): void {
  const directory = observationDirectory();
  if (directory === null) return;
  fs.mkdirSync(directory, { recursive: true });
  const sourcePath = path.join(__dirname, '../src/cli/config.ts');
  const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath) : Buffer.alloc(0);
  const record = {
    id,
    passed,
    fault_injected: true,
    historical_ci_reproduction: false,
    runtime: process.version,
    platform: process.platform,
    pid: process.pid,
    source_sha256: crypto.createHash('sha256').update(source).digest('hex'),
    recorded_at_utc: new Date().toISOString(),
    network_calls: networkCalls,
    config_directory: path.dirname(getConfigPath()),
    ...data,
  };
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
}

async function observed(
  id: string,
  collect: () => ObservationData,
  body: () => void | Promise<void>
): Promise<void> {
  let passed = false;
  let failure: string | null = null;
  try {
    await body();
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    try {
      let data: ObservationData;
      try {
        data = { ...collect(), error: failure };
      } catch (collectError) {
        data = { error: failure, collection_error: String(collectError) };
      }
      writeObservation(id, passed, data);
    } catch {
      // Observation recording must never mask the acceptance assertion.
    }
  }
}

function replace(object: object, key: string, value: unknown): () => void {
  const target = object as Record<string, unknown>;
  const original = target[key];
  target[key] = value;
  return () => {
    target[key] = original;
  };
}

function stubPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(descriptor !== undefined);
  Object.defineProperty(process, 'platform', { configurable: true, value });
  return () => {
    Object.defineProperty(process, 'platform', descriptor);
  };
}

function nodeError(message: string, code: string): NodeError {
  const error = new Error(message) as NodeError;
  error.code = code;
  return error;
}

/* -------------------------------------------------------------------------- */
/* Config publication seams                                                    */
/* -------------------------------------------------------------------------- */

interface ConfigFaults {
  write?: (context: {
    call: number;
    fd: number;
    bytes: Buffer;
    offset: number;
    length: number;
    realWrite: RealWriteSync;
  }) => number;
  close?: (context: { call: number; fd: number; realClose: RealCloseSync }) => void;
}

interface ConfigHarness {
  readonly events: string[];
  readonly writes: Array<{ call: number; offset: number; requested: number; returned: number }>;
  readonly tempPaths: string[];
  writeAttempts: number;
  restore(): void;
}

function traceConfig(faults: ConfigFaults): ConfigHarness {
  const configPath = getConfigPath();
  const tempPrefix = `${configPath}.tmp.`;
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync as unknown as (...args: unknown[]) => number;
  const realClose = fs.closeSync;
  const realSync = fs.fsyncSync;
  const realRename = fs.renameSync;
  const owned = new Set<number>();
  const events: string[] = [];
  const writes: ConfigHarness['writes'] = [];
  const tempPaths: string[] = [];
  let writeCall = 0;
  let closeCall = 0;
  let restored = false;

  const harness: ConfigHarness = {
    events,
    writes,
    tempPaths,
    writeAttempts: 0,
    restore: () => {},
  };

  const restorers = [
    replace(fs, 'openSync', (target: unknown, flags?: unknown, mode?: unknown) => {
      const fd = (realOpen as (...args: unknown[]) => number)(target, flags, mode);
      if (typeof target === 'string' && target.startsWith(tempPrefix) && flags === 'wx') {
        owned.add(fd);
        tempPaths.push(target);
        events.push('open');
      }
      return fd;
    }),
    replace(fs, 'writeSync', (fd: number, data: unknown, ...rest: unknown[]) => {
      if (!owned.has(fd)) return realWrite(fd, data, ...rest);
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as Buffer);
      const offset = typeof data === 'string' ? 0 : Number(rest[0] ?? 0);
      const length = typeof data === 'string' ? bytes.length : Number(rest[1] ?? bytes.length);
      const call = writeCall;
      writeCall += 1;
      harness.writeAttempts += 1;
      events.push(`write:${call}`);
      const returned = faults.write
        ? faults.write({ call, fd, bytes, offset, length, realWrite: realWrite as unknown as RealWriteSync })
        : realWrite(fd, bytes, offset, length);
      writes.push({ call, offset, requested: length, returned });
      return returned;
    }),
    replace(fs, 'fsyncSync', (fd: number) => {
      if (owned.has(fd)) events.push('fsync');
      realSync(fd);
    }),
    replace(fs, 'closeSync', (fd: number) => {
      if (!owned.has(fd)) {
        (realClose as (target: number) => void)(fd);
        return;
      }
      const call = closeCall;
      closeCall += 1;
      events.push('close-start');
      try {
        if (faults.close) faults.close({ call, fd, realClose: realClose as unknown as RealCloseSync });
        else (realClose as (target: number) => void)(fd);
      } finally {
        owned.delete(fd);
      }
      events.push('close-complete');
    }),
    replace(fs, 'renameSync', (from: unknown, to: unknown) => {
      if (to === configPath) events.push('publish');
      (realRename as (...args: unknown[]) => void)(from, to);
    }),
  ];

  harness.restore = () => {
    if (restored) return;
    for (const restore of restorers.reverse()) restore();
    restored = true;
  };
  return harness;
}

/* -------------------------------------------------------------------------- */
/* Lock acquisition seams                                                      */
/* -------------------------------------------------------------------------- */

interface LockFaults {
  open?: (context: { attempt: number; openReal: () => number }) => number;
  write?: (context: {
    call: number;
    fd: number;
    bytes: Buffer;
    offset: number;
    length: number;
    realWrite: RealWriteSync;
  }) => number;
  close?: (context: { call: number; fd: number; realClose: RealCloseSync }) => void;
}

interface LockClock {
  readonly fake: boolean;
  now: number;
  readonly sleeps: number[];
}

interface LockHarness {
  readonly events: string[];
  readonly writes: Array<{ call: number; offset: number; requested: number; returned: number }>;
  readonly clock: LockClock;
  opens: number;
  writeAttempts: number;
  dateNowCalls: number;
  setTimeoutCalls: number;
  restore(): void;
}

function traceLock(faults: LockFaults, options: { fakeClock?: number } = {}): LockHarness {
  const lockPath = path.join(path.dirname(getConfigPath()), 'config.lock');
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync as unknown as (...args: unknown[]) => number;
  const realClose = fs.closeSync;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const owned = new Set<number>();
  const events: string[] = [];
  const writes: LockHarness['writes'] = [];
  const clock: LockClock = { fake: options.fakeClock !== undefined, now: options.fakeClock ?? 0, sleeps: [] };
  let writeCall = 0;
  let closeCall = 0;
  let restored = false;

  const harness: LockHarness = {
    events,
    writes,
    clock,
    opens: 0,
    writeAttempts: 0,
    dateNowCalls: 0,
    setTimeoutCalls: 0,
    restore: () => {},
  };

  const restorers = [
    replace(fs, 'openSync', (target: unknown, flags?: unknown, mode?: unknown) => {
      if (target === lockPath && flags === 'wx') {
        const attempt = harness.opens;
        harness.opens += 1;
        if (faults.open) {
          const fd = faults.open({
            attempt,
            openReal: () => (realOpen as (...args: unknown[]) => number)(target, flags, mode),
          });
          owned.add(fd);
          events.push('open');
          return fd;
        }
      }
      const fd = (realOpen as (...args: unknown[]) => number)(target, flags, mode);
      if (target === lockPath && flags === 'wx') {
        owned.add(fd);
        events.push('open');
      }
      return fd;
    }),
    replace(fs, 'writeSync', (fd: number, data: unknown, ...rest: unknown[]) => {
      if (!owned.has(fd)) return realWrite(fd, data, ...rest);
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as Buffer);
      const offset = typeof data === 'string' ? 0 : Number(rest[0] ?? 0);
      const length = typeof data === 'string' ? bytes.length : Number(rest[1] ?? bytes.length);
      const call = writeCall;
      writeCall += 1;
      harness.writeAttempts += 1;
      events.push(`write:${call}`);
      const returned = faults.write
        ? faults.write({ call, fd, bytes, offset, length, realWrite: realWrite as unknown as RealWriteSync })
        : realWrite(fd, bytes, offset, length);
      writes.push({ call, offset, requested: length, returned });
      return returned;
    }),
    replace(fs, 'closeSync', (fd: number) => {
      if (!owned.has(fd)) {
        (realClose as (target: number) => void)(fd);
        return;
      }
      const call = closeCall;
      closeCall += 1;
      events.push('close-start');
      try {
        if (faults.close) faults.close({ call, fd, realClose: realClose as unknown as RealCloseSync });
        else (realClose as (target: number) => void)(fd);
      } finally {
        owned.delete(fd);
      }
      events.push('close-complete');
    }),
    replace(Date, 'now', () => {
      harness.dateNowCalls += 1;
      // Every read advances the fake clock so a pre-fix spin loop still reaches
      // its deadline deterministically instead of blocking the event loop.
      if (clock.fake) clock.now += 1;
      return clock.fake ? clock.now : realNow();
    }),
    replace(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      harness.setTimeoutCalls += 1;
      if (clock.fake) {
        const step = ms ?? 0;
        clock.sleeps.push(step);
        clock.now += step;
        queueMicrotask(() => callback(...args));
        return 0;
      }
      return realSetTimeout(callback, ms, ...args);
    }) as unknown as typeof setTimeout),
  ];

  harness.restore = () => {
    if (restored) return;
    for (const restore of restorers.reverse()) restore();
    restored = true;
  };
  return harness;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('acquisition must not succeed');
    },
    (error: unknown) => error
  );
}

function lockPath(): string {
  return path.join(path.dirname(getConfigPath()), 'config.lock');
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                       */
/* -------------------------------------------------------------------------- */

describe('config V3 acceptance', () => {
  let fixture: string;
  let originalConfigDir: string | undefined;
  let originalVaultPath: string | undefined;
  let restoreNetwork: (() => void)[];

  beforeEach(() => {
    const configuredRoot = process.env.PALEE_V3_FIXTURE_ROOT;
    const base = configuredRoot && configuredRoot.length > 0 ? configuredRoot : os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    fixture = fs.mkdtempSync(path.join(base, 'config-v3-'));
    originalConfigDir = process.env.PALEE_CONFIG_DIR;
    originalVaultPath = process.env.PALEE_VAULT_PATH;
    process.env.PALEE_CONFIG_DIR = fixture;
    process.env.PALEE_VAULT_PATH = path.join(fixture, 'vault');
    networkCalls = 0;
    const denyNetwork = (): never => {
      networkCalls += 1;
      throw new Error('V3 config acceptance must not use a network transport');
    };
    restoreNetwork = [
      replace(net, 'connect', denyNetwork),
      replace(net, 'createConnection', denyNetwork),
      replace(tls, 'connect', denyNetwork),
      replace(dns, 'lookup', denyNetwork),
      replace(dns, 'resolve', denyNetwork),
      replace(dns.promises, 'lookup', denyNetwork),
      replace(dns.promises, 'resolve', denyNetwork),
      replace(globalThis, 'fetch', denyNetwork),
    ];
  });

  afterEach(() => {
    for (const restore of restoreNetwork.reverse()) restore();
    if (originalConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
    else process.env.PALEE_CONFIG_DIR = originalConfigDir;
    if (originalVaultPath === undefined) delete process.env.PALEE_VAULT_PATH;
    else process.env.PALEE_VAULT_PATH = originalVaultPath;
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function seedConfig(seed: PaleeConfig = { vaultPath: '/vault', aiProvider: 'openai', model: 'keep-this-model' }): string {
    const text = JSON.stringify(seed, null, 2);
    fs.writeFileSync(getConfigPath(), text, 'utf8');
    return text;
  }

  /* ------------------------------ S1: config ------------------------------ */

  test('V3 S1: seven-byte writes split UTF-8 and preserve supplied unchanged fields', async () => {
    const seed: PaleeConfig = { vaultPath: '/vault', aiProvider: 'openai', model: 'keep-this-model' };
    fs.writeFileSync(getConfigPath(), JSON.stringify(seed, null, 2));
    let config: PaleeConfig = seed;
    let expected = Buffer.alloc(0);
    for (let padding = 0; padding < 7; padding += 1) {
      config = { ...seed, vaultPath: `/vault/${'x'.repeat(padding)}€files` };
      expected = Buffer.from(JSON.stringify(config, null, 2), 'utf8');
      const start = expected.indexOf(Buffer.from('€', 'utf8'));
      if (start % 7 === 6) break;
    }
    const harness = traceConfig({
      write: ({ fd, bytes, offset, length, realWrite }) =>
        realWrite(fd, bytes, offset, Math.min(7, length)),
    });
    let actual = Buffer.alloc(0);
    await observed('s1-utf8-short-write', () => ({
      expected_bytes: expected.length,
      actual_bytes: actual.length,
      config_hex: actual.toString('hex'),
      writes: harness.writes,
      events: harness.events,
    }), () => {
      try {
        saveConfig(config);
      } finally {
        harness.restore();
      }
      actual = fs.readFileSync(getConfigPath());
      assert.deepEqual(actual, expected, 'publication must preserve complete UTF-8 bytes');
      assert.ok(harness.writes.length > 1, 'the payload must have been completed across short writes');
      assert.ok(harness.writes.some(({ offset }) => {
        const byte = expected[offset];
        return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
      }), 'an observed short-write boundary must split the multibyte character');
      const parsed = JSON.parse(actual.toString('utf8')) as PaleeConfig;
      assert.equal(parsed.aiProvider, seed.aiProvider);
      assert.equal(parsed.model, seed.model);
      assert.ok(harness.events.indexOf('fsync') < harness.events.indexOf('close-complete'));
      assert.ok(harness.events.indexOf('close-complete') < harness.events.indexOf('publish'));
      assert.equal(networkCalls, 0);
    });
  });

  test('V3 S1: zero progress fails precisely, leaves prior bytes, removes the owned temp, publishes nothing', async () => {
    const seeded = seedConfig();
    const next: PaleeConfig = { vaultPath: '/vault-two', aiProvider: 'gemini' };
    const expectedLength = Buffer.byteLength(JSON.stringify(next, null, 2), 'utf8');
    const harness = traceConfig({ write: () => 0 });
    let error: unknown;
    await observed('s1-zero-progress', () => ({
      expected_length: expectedLength,
      writes: harness.writes,
      temp_paths: harness.tempPaths,
      temp_remains: harness.tempPaths.map((temp) => fs.existsSync(temp)),
      events: harness.events,
    }), () => {
      try {
        try {
          saveConfig(next);
        } catch (thrown: unknown) {
          error = thrown;
        }
      } finally {
        harness.restore();
      }
      assert.ok(error instanceof Error, 'zero progress must fail the write');
      assert.equal(
        error.message,
        `config write stalled at byte 0 of ${expectedLength}`,
        'the write error must name the exact byte and total'
      );
      assert.equal(fs.readFileSync(getConfigPath(), 'utf8'), seeded, 'prior config must be byte-for-byte intact');
      assert.equal(harness.writes.length, 1);
      assert.equal(harness.writes[0]?.returned, 0);
      assert.equal(harness.tempPaths.length, 1);
      assert.equal(fs.existsSync(harness.tempPaths[0] ?? ''), false, 'the owned temp must be removed');
      assert.equal(harness.events.includes('publish'), false, 'nothing may be published');
    });
  });

  test('V3 S1: negative progress is a write error, never a partial success', async () => {
    const seeded = seedConfig();
    const next: PaleeConfig = { vaultPath: '/vault-two', aiProvider: 'gemini' };
    const expectedLength = Buffer.byteLength(JSON.stringify(next, null, 2), 'utf8');
    const harness = traceConfig({ write: () => -1 });
    let error: unknown;
    await observed('s1-negative-progress', () => ({
      expected_length: expectedLength,
      writes: harness.writes,
      temp_paths: harness.tempPaths,
      temp_remains: harness.tempPaths.map((temp) => fs.existsSync(temp)),
      events: harness.events,
    }), () => {
      try {
        try {
          saveConfig(next);
        } catch (thrown: unknown) {
          error = thrown;
        }
      } finally {
        harness.restore();
      }
      assert.ok(error instanceof Error, 'negative progress must fail the write');
      assert.equal(error.message, `config write stalled at byte 0 of ${expectedLength}`);
      assert.equal(fs.readFileSync(getConfigPath(), 'utf8'), seeded);
      assert.equal(harness.writes[0]?.returned, -1);
      assert.equal(fs.existsSync(harness.tempPaths[0] ?? ''), false);
      assert.equal(harness.events.includes('publish'), false);
    });
  });

  test('V3 S1: partial progress then throw keeps the thrown Error and publishes nothing', async () => {
    const seeded = seedConfig();
    const next: PaleeConfig = { vaultPath: '/vault-two', aiProvider: 'gemini' };
    const injected = nodeError('EIO: injected after partial progress', 'EIO');
    const harness = traceConfig({
      write: ({ call, fd, bytes, offset, length, realWrite }) => {
        if (call === 0) return realWrite(fd, bytes, offset, Math.min(7, length));
        throw injected;
      },
    });
    let error: unknown;
    await observed('s1-partial-then-throw', () => ({
      writes: harness.writes,
      write_attempts: harness.writeAttempts,
      temp_paths: harness.tempPaths,
      temp_remains: harness.tempPaths.map((temp) => fs.existsSync(temp)),
      events: harness.events,
    }), () => {
      try {
        try {
          saveConfig(next);
        } catch (thrown: unknown) {
          error = thrown;
        }
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, injected, 'the injected Error object must be the one surfaced');
      assert.equal(harness.writeAttempts, 2, 'the loop must attempt the write that throws');
      assert.equal(harness.writes.length, 1);
      assert.equal(harness.writes[0]?.returned, 7);
      assert.equal(fs.readFileSync(getConfigPath(), 'utf8'), seeded);
      assert.equal(fs.existsSync(harness.tempPaths[0] ?? ''), false);
      assert.equal(harness.events.includes('fsync'), false);
      assert.equal(harness.events.includes('publish'), false);
    });
  });

  test('V3 S1: a close-only failure after a complete write surfaces the close Error and publishes nothing', async () => {
    const seeded = seedConfig();
    const next: PaleeConfig = { vaultPath: '/vault-two', aiProvider: 'gemini' };
    const injected = nodeError('ECLOSE: injected close failure', 'ECLOSE');
    const harness = traceConfig({
      close: ({ call, fd, realClose }) => {
        realClose(fd);
        if (call === 0) throw injected;
      },
    });
    let error: unknown;
    await observed('s1-close-only-failure', () => ({
      writes: harness.writes,
      temp_paths: harness.tempPaths,
      temp_remains: harness.tempPaths.map((temp) => fs.existsSync(temp)),
      events: harness.events,
    }), () => {
      try {
        try {
          saveConfig(next);
        } catch (thrown: unknown) {
          error = thrown;
        }
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, injected, 'the close Error object must be surfaced unchanged');
      const written = harness.writes.reduce((sum, write) => sum + Math.max(0, write.returned), 0);
      assert.equal(written, Buffer.byteLength(JSON.stringify(next, null, 2), 'utf8'), 'the payload itself was complete');
      assert.equal(fs.readFileSync(getConfigPath(), 'utf8'), seeded);
      assert.equal(fs.existsSync(harness.tempPaths[0] ?? ''), false);
      assert.equal(harness.events.includes('fsync'), true);
      assert.equal(harness.events.includes('publish'), false);
    });
  });

  test('V3 S1: a write error wins over a close failure and still cleans the owned temp', async () => {
    const seeded = seedConfig();
    const next: PaleeConfig = { vaultPath: '/vault-two', aiProvider: 'gemini' };
    const writeError = nodeError('EWRITE: injected write failure', 'EWRITE');
    const closeError = nodeError('ECLOSE: injected close failure', 'ECLOSE');
    let closeAttempts = 0;
    const harness = traceConfig({
      write: ({ call, fd, bytes, offset, length, realWrite }) => {
        if (call === 0) return realWrite(fd, bytes, offset, Math.min(7, length));
        throw writeError;
      },
      close: ({ fd, realClose }) => {
        closeAttempts += 1;
        realClose(fd);
        throw closeError;
      },
    });
    let error: unknown;
    await observed('s1-write-and-close-failure', () => ({
      writes: harness.writes,
      close_attempts: closeAttempts,
      temp_paths: harness.tempPaths,
      temp_remains: harness.tempPaths.map((temp) => fs.existsSync(temp)),
      events: harness.events,
    }), () => {
      try {
        try {
          saveConfig(next);
        } catch (thrown: unknown) {
          error = thrown;
        }
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, writeError, 'the first error must win over the close failure');
      assert.ok(closeAttempts >= 1, 'the close seam must have fired');
      assert.equal(fs.readFileSync(getConfigPath(), 'utf8'), seeded);
      assert.equal(fs.existsSync(harness.tempPaths[0] ?? ''), false);
      assert.equal(harness.events.includes('publish'), false);
    });
  });

  test('V3 S1: an actual temp-name collision leaves the pre-existing entry untouched', async () => {
    const seeded = seedConfig();
    const fixed = Buffer.from('abababab', 'hex');
    const realRandom = crypto.randomBytes;
    const restoreRandom = replace(crypto, 'randomBytes', ((size: number) =>
      size === 4 ? fixed : (realRandom as (count: number) => Buffer)(size)) as typeof crypto.randomBytes);
    const tempPath = `${getConfigPath()}.tmp.${process.pid}.abababab`;
    const marker = 'preexisting-entry-this-call-never-created';
    fs.writeFileSync(tempPath, marker, 'utf8');
    const harness = traceConfig({});
    let error: unknown;
    await observed('s1-temp-collision', () => ({
      temp_path: tempPath,
      temp_remains: fs.existsSync(tempPath),
      events: harness.events,
    }), () => {
      try {
        try {
          saveConfig({ vaultPath: '/vault-two' } satisfies PaleeConfig);
        } catch (thrown: unknown) {
          error = thrown;
        }
      } finally {
        harness.restore();
        restoreRandom();
      }
      assert.ok(error instanceof Error, 'a wx collision must fail the save');
      assert.equal((error as NodeError).code, 'EEXIST');
      assert.equal(fs.existsSync(tempPath), true, 'the entry this call did not create must survive');
      assert.equal(fs.readFileSync(tempPath, 'utf8'), marker);
      assert.equal(fs.readFileSync(getConfigPath(), 'utf8'), seeded);
      assert.equal(harness.events.includes('publish'), false);
      fs.rmSync(tempPath, { force: true });
    });
  });

  /* ------------------------------- S2: lock ------------------------------- */

  test('V3 S2: progressing short payload writes complete the payload, close before the callback, and release', async () => {
    const nonceBytes = Buffer.from('0011223344556677', 'hex');
    const realRandom = crypto.randomBytes;
    const restoreRandom = replace(crypto, 'randomBytes', ((size: number) =>
      size === 8 ? nonceBytes : (realRandom as (count: number) => Buffer)(size)) as typeof crypto.randomBytes);
    const harness = traceLock({
      write: ({ fd, bytes, offset, length, realWrite }) =>
        realWrite(fd, bytes, offset, Math.min(7, length)),
    });
    let payloadText: string | null = null;
    let callbacks = 0;
    let result: string | null = null;
    await observed('s2-short-payload-write', () => {
      let observedNonce: string | null = null;
      if (payloadText !== null) {
        try {
          observedNonce = (JSON.parse(payloadText) as { nonce?: string }).nonce ?? null;
        } catch {
          observedNonce = null;
        }
      }
      return {
        nonce: observedNonce,
        payload_bytes: payloadText === null ? null : Buffer.byteLength(payloadText, 'utf8'),
        writes: harness.writes,
        events: harness.events,
        callbacks,
        lock_remains: fs.existsSync(lockPath()),
      };
    }, async () => {
      try {
        result = await withConfigLock(() => {
          callbacks += 1;
          harness.events.push('callback');
          payloadText = fs.readFileSync(lockPath(), 'utf8');
          return 'ran';
        }, { timeoutMs: 5000, staleMs: 60000 });
      } finally {
        harness.restore();
        restoreRandom();
      }
      assert.equal(result, 'ran');
      assert.equal(callbacks, 1, 'exactly one callback');
      assert.ok(payloadText !== null);
      const payload = JSON.parse(payloadText) as { pid?: unknown; nonce?: unknown; acquired_at?: unknown };
      assert.equal(payload.pid, process.pid);
      assert.equal(payload.nonce, '0011223344556677', 'the callback must see the complete nonce');
      assert.equal(typeof payload.acquired_at, 'string');
      assert.ok(!Number.isNaN(Date.parse(String(payload.acquired_at))), 'acquired_at must be a parseable timestamp');
      const returned = harness.writes.reduce((sum, write) => sum + Math.max(0, write.returned), 0);
      assert.equal(returned, Buffer.byteLength(payloadText, 'utf8'), 'every payload byte landed');
      assert.ok(harness.writes.some((write) => write.returned < write.requested), 'the seam produced short writes');
      assert.ok(harness.events.indexOf('close-complete') !== -1);
      assert.ok(harness.events.indexOf('close-complete') < harness.events.indexOf('callback'), 'close before the callback');
      assert.equal(fs.existsSync(lockPath()), false, 'release must remove the lock it acquired');
    });
  });

  test('V3 S2: zero progress fails acquisition precisely with zero callbacks and no wait', async () => {
    const harness = traceLock({ write: () => 0 }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-zero-progress', () => ({
      opens: harness.opens,
      writes: harness.writes,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      sleeps: harness.clock.sleeps,
      callbacks,
      lock_remains: fs.existsSync(lockPath()),
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 30000, staleMs: 60000 }));
      } finally {
        harness.restore();
      }
      assert.ok(error instanceof Error);
      assert.match((error as Error).message, /^config lock payload write stalled at byte 0 of \d+$/);
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1, 'ownership failure must not retry creation');
      assert.equal(harness.dateNowCalls, 1, 'the loop must not re-enter after ownership');
      assert.equal(harness.setTimeoutCalls, 0);
      assert.deepEqual(harness.clock.sleeps, []);
    });
  });

  test('V3 S2: negative progress fails acquisition with zero callbacks and no wait', async () => {
    const harness = traceLock({ write: () => -1 }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-negative-progress', () => ({
      opens: harness.opens,
      writes: harness.writes,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      sleeps: harness.clock.sleeps,
      callbacks,
      lock_remains: fs.existsSync(lockPath()),
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 30000, staleMs: 60000 }));
      } finally {
        harness.restore();
      }
      assert.ok(error instanceof Error);
      assert.match((error as Error).message, /^config lock payload write stalled at byte 0 of \d+$/);
      assert.equal(harness.writes[0]?.returned, -1);
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.equal(harness.dateNowCalls, 1);
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  test('V3 S2: an EPERM thrown before any payload byte surfaces unchanged without retry', async () => {
    const restorePlatform = stubPlatform('win32');
    const injected = nodeError('EPERM: injected payload write denial', 'EPERM');
    const harness = traceLock({ write: () => { throw injected; } }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-eperm-before-progress', () => ({
      opens: harness.opens,
      writes: harness.writes,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
      } finally {
        harness.restore();
        restorePlatform();
      }
      assert.strictEqual(error, injected, 'the payload EPERM must not be relabelled');
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1, 'post-ownership failures never retry creation');
      assert.equal(harness.dateNowCalls, 1, 'no wait/backoff loop may run after ownership');
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  test('V3 S2: an EPERM after partial payload progress surfaces unchanged without retry', async () => {
    const restorePlatform = stubPlatform('win32');
    const injected = nodeError('EPERM: injected payload write denial', 'EPERM');
    const harness = traceLock({
      write: ({ call, fd, bytes, offset, length, realWrite }) => {
        if (call === 0) return realWrite(fd, bytes, offset, Math.min(7, length));
        throw injected;
      },
    }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-eperm-after-progress', () => ({
      opens: harness.opens,
      writes: harness.writes,
      write_attempts: harness.writeAttempts,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
      } finally {
        harness.restore();
        restorePlatform();
      }
      assert.strictEqual(error, injected);
      assert.equal(harness.writes[0]?.returned, 7);
      assert.equal(harness.writeAttempts, 2, 'the loop must attempt the write that throws');
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.equal(harness.dateNowCalls, 1);
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  test('V3 S2: an EIO thrown before any payload byte surfaces unchanged', async () => {
    const injected = nodeError('EIO: injected payload write failure', 'EIO');
    const harness = traceLock({ write: () => { throw injected; } }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-eio-before-progress', () => ({
      opens: harness.opens,
      writes: harness.writes,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, injected);
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.equal(harness.dateNowCalls, 1);
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  test('V3 S2: an EIO after partial payload progress surfaces unchanged', async () => {
    const injected = nodeError('EIO: injected payload write failure', 'EIO');
    const harness = traceLock({
      write: ({ call, fd, bytes, offset, length, realWrite }) => {
        if (call === 0) return realWrite(fd, bytes, offset, Math.min(7, length));
        throw injected;
      },
    }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-eio-after-progress', () => ({
      opens: harness.opens,
      writes: harness.writes,
      write_attempts: harness.writeAttempts,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, injected);
      assert.equal(harness.writes[0]?.returned, 7);
      assert.equal(harness.writeAttempts, 2, 'the loop must attempt the write that throws');
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.equal(harness.dateNowCalls, 1);
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  test('V3 S2: a close-only failure after a complete payload surfaces unchanged with zero callbacks', async () => {
    const injected = nodeError('ECLOSE: injected lock close failure', 'ECLOSE');
    const harness = traceLock({
      close: ({ call, fd, realClose }) => {
        realClose(fd);
        if (call === 0) throw injected;
      },
    }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-close-only-failure', () => ({
      opens: harness.opens,
      writes: harness.writes,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, injected);
      const returned = harness.writes.reduce((sum, write) => sum + Math.max(0, write.returned), 0);
      assert.ok(returned > 0, 'the payload write itself completed');
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.equal(harness.dateNowCalls, 1);
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  test('V3 S2: a write error wins over a close failure on the lock payload', async () => {
    const writeError = nodeError('EWRITE: injected lock write failure', 'EWRITE');
    const closeError = nodeError('ECLOSE: injected lock close failure', 'ECLOSE');
    let closeAttempts = 0;
    const harness = traceLock({
      write: ({ call, fd, bytes, offset, length, realWrite }) => {
        if (call === 0) return realWrite(fd, bytes, offset, Math.min(7, length));
        throw writeError;
      },
      close: ({ fd, realClose }) => {
        closeAttempts += 1;
        realClose(fd);
        throw closeError;
      },
    }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s2-write-and-close-failure', () => ({
      opens: harness.opens,
      writes: harness.writes,
      close_attempts: closeAttempts,
      date_now_calls: harness.dateNowCalls,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
      } finally {
        harness.restore();
      }
      assert.strictEqual(error, writeError, 'the original write Error must win');
      assert.ok(closeAttempts >= 1);
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.equal(harness.dateNowCalls, 1);
      assert.equal(harness.setTimeoutCalls, 0);
    });
  });

  /* --------------------------- S3: retry scope --------------------------- */

  test('V3 S3: a transient win32 creation EPERM is retried with one backoff and then acquired', async () => {
    const restorePlatform = stubPlatform('win32');
    const transient = nodeError('EPERM: transient create denial', 'EPERM');
    const harness = traceLock({
      open: ({ attempt, openReal }) => {
        if (attempt === 0) throw transient;
        return openReal();
      },
    }, { fakeClock: 1000 });
    const start = harness.clock.now;
    let callbacks = 0;
    await observed('s3-win32-transient-create-eperm', () => ({
      opens: harness.opens,
      sleeps: harness.clock.sleeps,
      fake_now: harness.clock.now,
      fake_elapsed: harness.clock.now - start,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
      lock_remains: fs.existsSync(lockPath()),
    }), async () => {
      try {
        await withConfigLock(() => {
          callbacks += 1;
          return 'ran';
        }, { timeoutMs: 5000, staleMs: 60000 });
      } finally {
        harness.restore();
        restorePlatform();
      }
      assert.equal(callbacks, 1, 'the operation must complete after the retry');
      assert.equal(harness.opens, 2, 'exactly one retry of the creation');
      assert.equal(harness.clock.sleeps.length, 1, 'the winning retry path backs off once');
      assert.equal(harness.clock.sleeps[0], 10);
      assert.ok(harness.clock.now - start >= 10, 'the fake clock advanced through the backoff');
      assert.equal(fs.existsSync(lockPath()), false, 'normal release still runs');
    });
  });

  test('V3 S3: persistent win32 creation EPERM ends at the deadline as ECONFLICT', async () => {
    const restorePlatform = stubPlatform('win32');
    const harness = traceLock({
      open: () => {
        throw nodeError('EPERM: persistent create denial', 'EPERM');
      },
    }, { fakeClock: 1000 });
    const start = harness.clock.now;
    let callbacks = 0;
    let error: unknown;
    await observed('s3-win32-persistent-create-eperm', () => ({
      opens: harness.opens,
      sleeps: harness.clock.sleeps,
      fake_elapsed: harness.clock.now - start,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
      writes: harness.writes,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 1000, staleMs: 60000 }));
        assert.equal((error as NodeError).code, 'ECONFLICT');
        assert.match((error as Error).message, /timed out waiting for the configuration lock/);
        assert.equal(callbacks, 0);
        assert.equal(harness.writes.length, 0, 'creation denials never own a descriptor');
        const elapsed = harness.clock.now - start;
        assert.ok(elapsed >= 1000, 'the deadline itself must end the wait');
        assert.ok(elapsed - 1000 < 150, 'the wait must stop promptly at the deadline, not at an attempt ceiling');
        assert.equal(harness.opens, harness.clock.sleeps.length + 1, 'each round makes one create attempt');
        assert.ok(harness.clock.sleeps.every((step) => step <= 100), 'backoff stays capped');

        const attemptsAtOneSecond = harness.opens;
        harness.opens = 0;
        harness.clock.sleeps.length = 0;
        harness.clock.now = 1000;
        error = await rejectionOf(withConfigLock(() => 'never', { timeoutMs: 200, staleMs: 60000 }));
        assert.equal((error as NodeError).code, 'ECONFLICT');
        const shortElapsed = harness.clock.now - 1000;
        assert.ok(shortElapsed >= 200 && shortElapsed < 300);
        assert.ok(harness.opens < attemptsAtOneSecond, 'a shorter deadline makes fewer attempts (deadline-driven)');
      } finally {
        harness.restore();
        restorePlatform();
      }
    });
  });

  test('V3 S3: a POSIX creation EPERM is surfaced immediately and never retried', async () => {
    const restorePlatform = stubPlatform('linux');
    const injected = nodeError('EPERM: posix permission denial', 'EPERM');
    const harness = traceLock({
      open: () => {
        throw injected;
      },
    }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    await observed('s3-posix-create-eperm', () => ({
      opens: harness.opens,
      sleeps: harness.clock.sleeps,
      setTimeout_calls: harness.setTimeoutCalls,
      callbacks,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 5000, staleMs: 60000 }));
      } finally {
        harness.restore();
        restorePlatform();
      }
      assert.strictEqual(error, injected, 'the POSIX creation error must surface unchanged');
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1, 'POSIX EPERM is not creation contention');
      assert.equal(harness.setTimeoutCalls, 0);
      assert.deepEqual(harness.clock.sleeps, []);
    });
  });

  /* ------------------- S4: successor-during-teardown control ------------------- */

  test('V3 S4 control: a successor installed during failed initialization is preserved', async () => {
    const successorText = JSON.stringify({
      pid: 999999,
      nonce: 'feedfacefeedface',
      acquired_at: '2026-01-01T00:00:00.000Z',
    });
    const injected = nodeError('EIO: injected write failure during teardown', 'EIO');
    let installMethod = 'none';
    const harness = traceLock({
      write: ({ call }) => {
        if (call > 0) throw injected;
        const successorTemp = `${lockPath()}.successor`;
        fs.writeFileSync(successorTemp, successorText, 'utf8');
        try {
          fs.renameSync(successorTemp, lockPath());
          installMethod = 'rename';
        } catch {
          try {
            fs.rmSync(lockPath(), { force: true });
            fs.writeFileSync(lockPath(), successorText, 'utf8');
            installMethod = 'unlink-recreate';
          } catch {
            fs.writeFileSync(successorTemp, successorText, 'utf8');
            installMethod = 'failed';
          }
        }
        throw injected;
      },
    }, { fakeClock: 1000 });
    let callbacks = 0;
    let error: unknown;
    let remains: string | null = null;
    await observed('s4-successor-preserved', () => ({
      opens: harness.opens,
      install_method: installMethod,
      callbacks,
      successor_remains: remains,
    }), async () => {
      try {
        error = await rejectionOf(withConfigLock(() => {
          callbacks += 1;
          return 'never';
        }, { timeoutMs: 5000, staleMs: 60000 }));
      } finally {
        harness.restore();
        remains = fs.existsSync(lockPath()) ? fs.readFileSync(lockPath(), 'utf8') : null;
      }
      assert.strictEqual(error, injected);
      assert.equal(callbacks, 0);
      assert.equal(harness.opens, 1);
      assert.ok(installMethod !== 'failed', 'the successor must actually be installed');
      assert.equal(remains, successorText, 'no teardown path may delete or alter the successor');
    });
  });
});
