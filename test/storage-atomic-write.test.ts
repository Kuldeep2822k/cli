import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, isConflictError } from '../src/storage/atomic-write';
import { computeFingerprint } from '../src/storage/frontmatter';

describe('Atomic Write', () => {
  let testVaultPath: string;
  let testFilePath: string;

  before(() => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-write-test-'));
    fs.mkdirSync(path.join(testVaultPath, '.palee', 'locks'), { recursive: true });
    testFilePath = path.join(testVaultPath, 'test-note.md');
  });

  after(() => {
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  });

  test('writes new file successfully', async () => {
    const content = '# Test Note\n\nContent here.';
    await atomicWrite(testVaultPath, testFilePath, content);

    assert.ok(fs.existsSync(testFilePath));
    const written = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(written, content);
  });

  test('OCC detects concurrent modification', async () => {
    const originalContent = '# Original';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const fingerprint = computeFingerprint(originalContent);

    // Modify file externally
    fs.writeFileSync(testFilePath, '# Modified Externally', 'utf8');

    // Attempt write with stale fingerprint
    await assert.rejects(
      async () => await atomicWrite(testVaultPath, testFilePath, '# My Update', fingerprint),
      { message: /OCC conflict/ }
    );

    // Original external modification should be preserved
    const current = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(current, '# Modified Externally');
  });

  test('OCC allows write when fingerprint matches', async () => {
    const originalContent = '# Original Content';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const fingerprint = computeFingerprint(originalContent);

    const newContent = '# Updated Content';
    await atomicWrite(testVaultPath, testFilePath, newContent, fingerprint);

    const written = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(written, newContent);
  });

  test('write leaves target untouched on failure', async () => {
    const originalContent = '# Original';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const wrongFingerprint = 'invalid-fingerprint';

    try {
      await atomicWrite(testVaultPath, testFilePath, '# New', wrongFingerprint);
    } catch {
      // Expected to fail
    }

    const current = fs.readFileSync(testFilePath, 'utf8');
    assert.strictEqual(current, originalContent, 'Target should be unchanged after failed write');
  });

  test('no temp file remains after successful write', async () => {
    await atomicWrite(testVaultPath, testFilePath, '# Clean Write');

    const files = fs.readdirSync(testVaultPath);
    const hasTempFile = files.some(f => f.includes('.tmp.'));
    assert.strictEqual(hasTempFile, false);
  });

  test('no temp file remains after failed write', async () => {
    const originalContent = '# Original';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');

    try {
      await atomicWrite(testVaultPath, testFilePath, '# New', 'wrong-fp');
    } catch {
      // Expected
    }

    const files = fs.readdirSync(testVaultPath);
    const hasTempFile = files.some(f => f.includes('.tmp.'));
    assert.strictEqual(hasTempFile, false);
  });

  test('concurrent write attempts serialize via locks', async () => {
    const content1 = '# Writer 1';
    const content2 = '# Writer 2';

    // Start two writes concurrently
    const write1 = atomicWrite(testVaultPath, testFilePath, content1);
    const write2 = atomicWrite(testVaultPath, testFilePath, content2);

    // One should succeed, other should fail with lock conflict
    const results = await Promise.allSettled([write1, write2]);

    const succeeded = results.filter(r => r.status === 'fulfilled');

    // At least one should succeed (lock serialization)
    assert.ok(succeeded.length >= 1);

    // File should contain one of the writes
    const final = fs.readFileSync(testFilePath, 'utf8');
    assert.ok(final === content1 || final === content2);
  });

  test('OCC conflict sets ECONFLICT error code', async () => {
    const originalContent = '# OCC Code Check';
    fs.writeFileSync(testFilePath, originalContent, 'utf8');
    const fingerprint = computeFingerprint(originalContent);

    // Modify file externally
    fs.writeFileSync(testFilePath, '# OCC Modified Externally', 'utf8');

    try {
      await atomicWrite(testVaultPath, testFilePath, '# My Update', fingerprint);
      assert.fail('Expected atomicWrite to throw on OCC conflict');
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      assert.strictEqual(err.code, 'ECONFLICT');
      assert.match(err.message || '', /OCC conflict/);
      assert.strictEqual(isConflictError(e), true);
    }
  });

  test('OCC conflict sets ECONFLICT when expectedFingerprint is provided for missing/deleted target', async () => {
    const nonExistentPath = path.join(testVaultPath, 'nonexistent-deleted.md');
    try {
      await atomicWrite(testVaultPath, nonExistentPath, '# New Content', 'expected-sha256-hash');
      assert.fail('Expected atomicWrite to throw ECONFLICT for missing expected file');
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      assert.strictEqual(err.code, 'ECONFLICT');
      assert.match(err.message || '', /OCC conflict/);
      assert.strictEqual(isConflictError(e), true);
    }
  });

  test('isConflictError helper correctly classifies error objects', () => {
    assert.strictEqual(isConflictError({ code: 'ECONFLICT' }), true);
    assert.strictEqual(isConflictError(new Error('OCC conflict: target modified')), true);
    assert.strictEqual(isConflictError(new Error('Lock conflict: target locked by PID 123')), true);
    assert.strictEqual(isConflictError(new Error('Generic file read failure')), false);
    assert.strictEqual(isConflictError(null), false);
    assert.strictEqual(isConflictError(undefined), false);
    assert.strictEqual(isConflictError('some string error'), false);
    assert.strictEqual(isConflictError(123), false);
  });
});

/**
 * #318 (mode preservation) and #333 (rename durability via directory fsync).
 *
 * POSIX-mode assertions guard-return on win32, the idiom this repo uses for
 * filesystem semantics (see the platform guards in
 * `test/cli-config-provider-credentials.test.ts`): NTFS resolves access through the
 * directory ACL, so the bits only mean something elsewhere. The call-recording tests
 * run on *every* platform because they assert which syscalls the primitive makes, not
 * what the filesystem does with the result — they pin the behaviour change itself.
 */
describe('atomic write mode preservation and durability (#318, #333)', () => {
  let vaultPath: string;

  before(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-write-mode-durability-'));
    fs.mkdirSync(path.join(vaultPath, '.palee', 'locks'), { recursive: true });
  });

  after(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  type FsEvent =
    | { type: 'open'; path: string; fd: number | null }
    | { type: 'fsync'; fd: number }
    | { type: 'fchmod'; fd: number; mode: number }
    | { type: 'rename'; from: string; to: string };

  /**
   * Records every `openSync`/`fsyncSync`/`fchmodSync`/`renameSync` call made while
   * `fn` runs (each wrapper delegates to the real implementation, so behaviour is
   * unchanged), then restores the module. `atomicWrite` reaches `fs` through the
   * module object at call time, so instrumenting it exercises the real code path.
   */
  async function withFsCallLog<T>(fn: (events: FsEvent[]) => Promise<T>): Promise<T> {
    const events: FsEvent[] = [];
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalFchmod = fs.fchmodSync;
    const originalRename = fs.renameSync;
    Object.defineProperty(fs, 'openSync', {
      configurable: true,
      writable: true,
      value: (target: fs.PathLike, flags: fs.OpenMode, mode?: number | string): number => {
        const calledPath = target.toString();
        try {
          const fd = mode === undefined
            ? originalOpen.call(fs, target, flags)
            : originalOpen.call(fs, target, flags, mode);
          events.push({ type: 'open', path: calledPath, fd });
          return fd;
        } catch (e: unknown) {
          events.push({ type: 'open', path: calledPath, fd: null });
          throw e;
        }
      },
    });
    Object.defineProperty(fs, 'fsyncSync', {
      configurable: true,
      writable: true,
      value: (fd: number): void => {
        events.push({ type: 'fsync', fd });
        originalFsync.call(fs, fd);
      },
    });
    Object.defineProperty(fs, 'fchmodSync', {
      configurable: true,
      writable: true,
      value: (fd: number, mode: number): void => {
        events.push({ type: 'fchmod', fd, mode });
        originalFchmod.call(fs, fd, mode);
      },
    });
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      writable: true,
      value: (from: fs.PathLike, to: fs.PathLike): void => {
        events.push({ type: 'rename', from: from.toString(), to: to.toString() });
        originalRename.call(fs, from, to);
      },
    });
    try {
      return await fn(events);
    } finally {
      Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: originalOpen });
      Object.defineProperty(fs, 'fsyncSync', { configurable: true, writable: true, value: originalFsync });
      Object.defineProperty(fs, 'fchmodSync', { configurable: true, writable: true, value: originalFchmod });
      Object.defineProperty(fs, 'renameSync', { configurable: true, writable: true, value: originalRename });
    }
  }

  /** Permission bits of a path on disk (POSIX-only check). */
  function modeOf(file: string): number {
    return fs.statSync(file).mode & 0o777;
  }

  test('a rewrite preserves a 0600 destination mode (#318, POSIX)', async () => {
    if (process.platform === 'win32') return; // NTFS resolves access through the directory ACL
    const file = path.join(vaultPath, 'mode-600.md');
    fs.writeFileSync(file, '# v1', 'utf8');
    fs.chmodSync(file, 0o600);
    assert.strictEqual(modeOf(file), 0o600, 'fixture starts owner-only');

    await atomicWrite(vaultPath, file, '# v2');

    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# v2');
    const mode = modeOf(file);
    assert.strictEqual(mode, 0o600, `rewrite widened the mode to 0o${mode.toString(8)}`);
  });

  test('a rewrite preserves a 0644 destination mode without tightening it (#318, POSIX)', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(vaultPath, 'mode-644.md');
    fs.writeFileSync(file, '# v1', 'utf8');
    fs.chmodSync(file, 0o644);
    assert.strictEqual(modeOf(file) & 0o077, 0o044, 'fixture starts world-readable');

    await atomicWrite(vaultPath, file, '# v2');

    // Preservation, not silently forcing 0600: the ordinary note mode must survive.
    assert.strictEqual(modeOf(file), 0o644);
  });

  test('a rewrite preserves a 0640 destination mode (#318, POSIX)', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(vaultPath, 'mode-640.md');
    fs.writeFileSync(file, '# v1', 'utf8');
    fs.chmodSync(file, 0o640);
    const fingerprint = computeFingerprint('# v1');

    await atomicWrite(vaultPath, file, '# v2', fingerprint);

    assert.strictEqual(modeOf(file), 0o640);
  });

  test('a write to a fresh destination keeps the default umask mode (#318, POSIX)', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(vaultPath, 'mode-new.md');
    const control = path.join(vaultPath, 'mode-new-control.md');
    fs.writeFileSync(control, 'x', 'utf8'); // baseline: plain open with no explicit mode

    await atomicWrite(vaultPath, file, '# fresh');

    // No prior mode to preserve, so behaviour is exactly what it was before #318:
    // the temp file's umask-default mode becomes the file's mode.
    assert.strictEqual(modeOf(file), modeOf(control));
    assert.strictEqual(modeOf(file), 0o666 & ~process.umask());
  });

  test('the temp fd is fchmod-ed to the prior mode before the rename (#318)', async () => {
    const file = path.join(vaultPath, 'instrumented-600.md');
    fs.writeFileSync(file, '# v1', 'utf8');
    fs.chmodSync(file, 0o600);
    // Compare against what stat actually reports rather than a hardcoded 0600: on
    // win32 Node synthesises the mode, but the primitive must still hand *that*
    // value to fchmodSync, which is the behaviour the fix added.
    const priorMode = modeOf(file);

    const events = await withFsCallLog(async log => {
      await atomicWrite(vaultPath, file, '# v2');
      return log;
    });

    const renameIdx = events.findIndex(e => e.type === 'rename');
    assert.ok(renameIdx >= 0, 'rename was not recorded');
    const rename = events[renameIdx] as Extract<FsEvent, { type: 'rename' }>;
    const chmods = events
      .map((e, i) => ({ e, i }))
      .filter(x => x.e.type === 'fchmod') as Array<{ e: Extract<FsEvent, { type: 'fchmod' }>; i: number }>;
    assert.ok(chmods.length >= 1, 'no fchmodSync call before rename — the prior mode was discarded');
    for (const { e, i } of chmods) {
      assert.ok(i < renameIdx, 'fchmodSync must happen before the rename replaces the file');
      assert.strictEqual(e.mode, modeOf(file), 'fchmod mode must match the destination mode');
      assert.strictEqual(priorMode & 0o777, modeOf(file), 'mode stayed stable across the writes');
      // The chmod must target the temp fd: the open recorded for `from` returned it.
      const tempOpen = events.find(x => x.type === 'open' && x.path === rename.from) as Extract<FsEvent, { type: 'open' }>;
      assert.ok(tempOpen, 'temp file open was recorded');
      assert.strictEqual(e.fd, tempOpen.fd, 'fchmod must apply to the temp fd, not elsewhere');
    }
  });

  test('no fchmod is issued when the destination does not exist (#318)', async () => {
    const file = path.join(vaultPath, 'instrumented-new.md');

    const events = await withFsCallLog(async log => {
      await atomicWrite(vaultPath, file, '# fresh');
      return log;
    });

    // `atomicWrite` renames to the containment-resolved path, so the recorded target is
    // the realpath: on macOS `os.tmpdir()` is under `/var`, which is a symlink to
    // `/private/var`, and comparing against the unresolved `file` would fail there only.
    const realTarget = path.join(fs.realpathSync(vaultPath), 'instrumented-new.md');
    assert.ok(events.some(e => e.type === 'rename' && e.to === realTarget), 'the write itself happened');
    assert.strictEqual(events.filter(e => e.type === 'fchmod').length, 0, 'a new file must keep the default mode');
  });

  test('the containing directory is fsync-ed after the rename (#333)', async () => {
    const file = path.join(vaultPath, 'dir-fsync.md');
    fs.writeFileSync(file, '# v1', 'utf8');

    const events = await withFsCallLog(async log => {
      await atomicWrite(vaultPath, file, '# v2');
      return log;
    });

    const renameIdx = events.findIndex(e => e.type === 'rename');
    assert.ok(renameIdx >= 0);
    const rename = events[renameIdx] as Extract<FsEvent, { type: 'rename' }>;
    const dir = path.dirname(rename.to);
    const dirOpenIdx = events.findIndex(
      (e, i) => i > renameIdx && e.type === 'open' && e.path === dir
    );
    assert.ok(dirOpenIdx >= 0, `no open of the containing directory (${dir}) after the rename`);
    const dirOpen = events[dirOpenIdx] as Extract<FsEvent, { type: 'open' }>;
    if (dirOpen.fd !== null) {
      assert.ok(
        events.some((e, i) => i > dirOpenIdx && e.type === 'fsync' && e.fd === dirOpen.fd),
        'the directory fd was opened but never fsync-ed'
      );
    }
    // win32 note: the open itself may fail (or the fsync on the handle does); the
    // fix swallows that, so recording the *attempt* is the platform-agnostic pin.
  });

  test('a refused directory fsync does not fail the write (#333)', async () => {
    const file = path.join(vaultPath, 'dir-fsync-refused.md');
    await atomicWrite(vaultPath, file, '# seed');

    const realVault = fs.realpathSync(vaultPath);
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const dirFds = new Set<number>();
    let refusalRaised = false;
    try {
      Object.defineProperty(fs, 'openSync', {
        configurable: true,
        writable: true,
        value: (target: fs.PathLike, flags: fs.OpenMode, mode?: number | string): number => {
          const fd = mode === undefined
            ? originalOpen.call(fs, target, flags)
            : originalOpen.call(fs, target, flags, mode);
          // Only the post-rename durability open uses 'r' on the vault directory.
          if (flags === 'r' && target.toString() === realVault) dirFds.add(fd);
          return fd;
        },
      });
      Object.defineProperty(fs, 'fsyncSync', {
        configurable: true,
        writable: true,
        value: (fd: number): void => {
          if (dirFds.has(fd)) {
            refusalRaised = true;
            const err = new Error('simulated: platform refuses directory fsync') as NodeJS.ErrnoException;
            err.code = 'EPERM';
            throw err;
          }
          originalFsync.call(fs, fd);
        },
      });

      await atomicWrite(vaultPath, file, '# rewritten');

      assert.strictEqual(fs.readFileSync(file, 'utf8'), '# rewritten');
      if (process.platform === 'win32') {
        // Locally the directory fsync genuinely raises EPERM (the swallow branch fires
        // for real); whether the forced refusal also ran is platform detail.
        assert.ok(true);
      } else {
        assert.ok(refusalRaised, 'the forced refusal never reached the directory fd');
      }
    } finally {
      Object.defineProperty(fs, 'openSync', { configurable: true, writable: true, value: originalOpen });
      Object.defineProperty(fs, 'fsyncSync', { configurable: true, writable: true, value: originalFsync });
    }
  });
});
