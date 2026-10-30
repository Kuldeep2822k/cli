import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT, isTransientHandleCode } from '../src/storage/lock';
import { isConflictError } from '../src/storage/atomic-write';
import { exitCodeFor, ExitCode } from '../src/cli/exit-codes';
import { NodeError } from '../src/types';

function getLockData(lockDir: string) {
  if (!fs.existsSync(lockDir)) return null;
  try {
    const files = fs.readdirSync(lockDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    const [recordFile] = files;
    if (recordFile === undefined) return null;
    const content = fs.readFileSync(path.join(lockDir, recordFile), 'utf8');
    if (!content.trim()) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** One recorded `fs.utimesSync` call: the path it was given and both stamps. */
interface UtimesCall {
  file: string;
  atime: Parameters<typeof fs.utimesSync>[1];
  mtime: Parameters<typeof fs.utimesSync>[2];
}

/**
 * Records every `fs.utimesSync` call while still performing the real touch.
 *
 * @remarks
 * `src/storage/lock.ts` imports the same `fs` namespace object this file does, so
 * replacing the method here is what makes the heartbeat's own touch observable —
 * the same seam the `fs.rmdirSync` patch below uses, for the same reason. The
 * heartbeat is the ONLY production path that calls `utimesSync` (the whole of
 * `lock.ts` has one call site), so an empty record list proves nobody stamped
 * the lock file.
 *
 * @returns The live record list plus the function that puts `fs` back.
 */
function spyUtimesSync(): { calls: UtimesCall[]; restore: () => void } {
  const calls: UtimesCall[] = [];
  const originalUtimesSync = fs.utimesSync;
  (fs as unknown as { utimesSync: typeof fs.utimesSync }).utimesSync = function recordingUtimesSync(
    this: unknown,
    p: fs.PathLike,
    atime: Parameters<typeof fs.utimesSync>[1],
    mtime: Parameters<typeof fs.utimesSync>[2]
  ): void {
    if (typeof p === 'string') calls.push({ file: p, atime, mtime });
    return (originalUtimesSync as unknown as (...a: unknown[]) => void).call(this, p, atime, mtime);
  };
  return {
    calls,
    restore: () => {
      (fs as unknown as { utimesSync: typeof fs.utimesSync }).utimesSync = originalUtimesSync;
    },
  };
}

/**
 * Records every `SyncWait` park without performing it.
 *
 * @remarks
 * `SyncWait.sleepMs` is the lock module's only parking primitive, so wrapping
 * `Atomics.wait` is what makes "did this path back off?" observable without paying
 * the wall clock for it — the same seam `spyUtimesSync` uses for the heartbeat. An
 * elapsed-milliseconds assertion would be a timing guard, and those flake on a
 * loaded runner (ADR-0026).
 *
 * @returns The live record list plus the function that puts `Atomics` back.
 */
function spyAtomicsWait(onPark?: () => void): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  const originalWait = Atomics.wait;
  // Typed as `unknown` on the slot rather than `typeof Atomics.wait`: the real member
  // is overloaded, and a single Int32Array-shaped recorder is not assignable to it.
  (Atomics as unknown as { wait: unknown }).wait = function recordingWait(
    _typedArray: Int32Array,
    _index: number,
    _value: number,
    timeout?: number
  ): 'ok' | 'not-equal' | 'timed-out' {
    calls.push(typeof timeout === 'number' ? timeout : -1);
    // A park is the moment a concurrent actor gets to move, so the hook runs here to
    // stage a rival's progress deterministically instead of racing a real timer.
    onPark?.();
    // Return immediately: the assertion is on the schedule the code asked for, so a
    // test must never pay for the park it is measuring.
    return 'timed-out';
  };
  return {
    calls,
    restore: () => {
      (Atomics as unknown as { wait: unknown }).wait = originalWait;
    },
  };
}

/** Path of the holder's session file, asserting the lock dir holds exactly one. */
function singleSessionFile(lockDir: string): string {
  const files = fs.readdirSync(lockDir).filter(f => f.endsWith('.json'));
  assert.strictEqual(files.length, 1, `precondition: one lock session file expected, found ${files.length}`);
  const sessionFile = files[0];
  assert.strictEqual(
    sessionFile,
    `${getLockData(lockDir).lock_id}.json`,
    `precondition: session file must be named after the lock id inside it, found ${sessionFile}`
  );
  return path.join(lockDir, sessionFile);
}

/**
 * Mirrors of the bounds declared in `src/storage/lock.ts`, named apart from them on
 * purpose.
 *
 * @remarks
 * Both are module-private there and stay that way (the #131 census keeps the storage
 * barrel small), so a test can only mirror them numerically. A local that shares a
 * production constant's name hides the difference when the value moves; these do not,
 * and a changed budget in `src/` stops matching what the acquisition actually does,
 * which reddens the tests below rather than quietly re-deriving their expectations
 * from the implementation (ADR-0026).
 */
const RESIDUE_RETRY_BUDGET = 5; // ENOTEMPTY_RETRY_ATTEMPTS
const ACQUISITION_ITERATION_CAP = 20; // MAX_ACQUISITION_ITERATIONS

/**
 * The delay each successive spend of {@link RESIDUE_RETRY_BUDGET} must ask for.
 *
 * @remarks
 * Computed by hand from `WINDOWS_RETRY_INITIAL_DELAY` (50) doubled per attempt under a
 * ±25 % jitter and a 300 ms ceiling: 50 → 37.5..62.5, 100 → 75..125, 200 → 150..250,
 * and the 400 and 800 the doubling reaches are clamped to exactly 300. The Windows
 * `EPERM`/`EBUSY` loop asks for the same bands, because the module has one backoff
 * policy shared by both paths (ADR-0036).
 */
const PARK_BANDS: ReadonlyArray<readonly [min: number, max: number]> = [
  [37.5, 62.5],
  [75, 125],
  [150, 250],
  [300, 300],
  [300, 300],
];

/** An `fs` method the fault patches below replace. */
type PatchableFsMethod = 'readdirSync' | 'rmdirSync' | 'unlinkSync';

/** An `fs` method whose call order is recorded without altering it. */
type RecordableFsMethod = 'mkdirSync' | 'renameSync';

/** One test's lock directory, its fault patches, and the teardown that undoes them. */
interface ResidueVault {
  /** The note being locked. */
  readonly target: string;
  /** The note's lock directory — created, planted and aged by `residueVault`. */
  readonly lockDir: string;
  /** Path of `name` inside {@link ResidueVault.lockDir}. */
  entry(name: string): string;
  /** A fresh `Lock` on this target: a second instance is a second acquirer. */
  newLock(): Lock;
  /** Tracks a lock this test acquired so `dispose()` releases it. */
  hold(lock: Lock): Lock;
  /** Queues a put-back, run by `dispose()` even when an assertion throws. */
  onRestore(restore: () => void): void;
  /** Undoes every patch, releases every tracked lock, deletes the vault. */
  dispose(): void;
}

/** A filesystem error carrying the errno `code`, as `fs` would have reported it. */
function fsErrorWith(code: string, message: string): NodeError {
  const err = new Error(message) as NodeError;
  err.code = code;
  return err;
}

/** Stamps `target` older than `STALE_TIMEOUT` so `createLock` treats it as abandoned. */
function agePastStale(target: string): void {
  const stamp = new Date(Date.now() - STALE_TIMEOUT - 5000);
  fs.utimesSync(target, stamp, stamp);
}

/**
 * A vault holding one note whose lock directory already exists, contains whatever
 * `plant` wrote into it, and is aged past `STALE_TIMEOUT` — the state a stale recovery
 * reaches and then cannot finish clearing.
 *
 * @param prefix  Fragment of the temp directory's name, so a vault left behind by a
 *                crashed run traces back to the scenario that made it. Also names the
 *                note, which makes the lockdir hash deterministic: no test here needs
 *                an unseeded random path it cannot reproduce.
 * @param plant   Fills the lock directory. It runs *before* the aging step, and that
 *                order is load-bearing rather than tidy: planting an entry stamps the
 *                directory's own mtime, and `createLock` reads a young lockdir that
 *                lists empty as "an incoming process" and abandons the sweep. A test
 *                that aged first would be answered by the heuristic instead of by the
 *                residue path, and would pass on the unfixed code (#539, ADR-0026).
 */
function residueVault(prefix: string, plant: (lockDir: string, target: string) => void = () => {}): ResidueVault {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), `palee-lock-${prefix}-`));
  const target = path.join(vault, `${prefix}-target.md`);
  fs.writeFileSync(target, `# ${prefix} target`, 'utf8');
  const lockDir = new Lock(vault, target).lockPath;
  fs.mkdirSync(lockDir);
  plant(lockDir, target);
  agePastStale(lockDir);

  const undo: Array<() => void> = [];
  const held: Lock[] = [];
  return {
    target,
    lockDir,
    entry: name => path.join(lockDir, name),
    newLock: () => new Lock(vault, target),
    hold(lock: Lock): Lock {
      held.push(lock);
      return lock;
    },
    onRestore(restore: () => void): void {
      undo.push(restore);
    },
    dispose(): void {
      // Reverse order: a patch layered over another is removed before what it wraps.
      for (let i = undo.length - 1; i >= 0; i--) undo[i]?.();
      undo.length = 0;
      for (const lock of held) lock.release();
      held.length = 0;
      // Best-effort: a handle the platform will not drop must not fail a passing test.
      try {
        fs.rmSync(vault, { recursive: true, force: true });
      } catch { /* the temp directory is the only thing left */ }
    },
  };
}

/**
 * Intercepts the calls to one `fs` method whose path argument is exactly `target`.
 *
 * @param fx     The fixture that owns this patch's lifetime.
 * @param method The `fs` method to replace.
 * @param target The absolute path the lock module is expected to pass.
 * @param handle Sees the 1-based call count and the original method. Whatever it
 *               throws is what the lock module sees; a returned value answers the
 *               call; returning nothing lets the real call run.
 * @returns A live counter of the calls that named `target` — other paths never reach
 *          `handle`, so the count is the scenario's own traffic, not the process's.
 *
 * @remarks
 * `src/storage/lock.ts` imports the same `fs` namespace object this file does, so
 * replacing a method here is what makes the module's own filesystem traffic observable
 * — the same seam `spyUtimesSync` uses for the heartbeat. The restore is registered on
 * the fixture instead of handed back, so a patch cannot survive a throwing assertion,
 * and no test has to get the restore order right by hand.
 */
function patchFsOnPath(
  fx: ResidueVault,
  method: PatchableFsMethod,
  target: string,
  handle: (call: number, original: (...args: unknown[]) => unknown, args: unknown[]) => unknown
): { calls: number } {
  const slot = fs as unknown as Record<PatchableFsMethod, (...args: unknown[]) => unknown>;
  const original = slot[method];
  const counter = { calls: 0 };
  slot[method] = (...args: unknown[]): unknown => {
    // A path handed over as a Buffer or URL is not this scenario's target; comparing
    // without the typeof guard would silently intercept nothing.
    if (typeof args[0] === 'string' && args[0] === target) {
      counter.calls += 1;
      const verdict = handle(counter.calls, original, args);
      if (verdict !== undefined) return verdict;
    }
    return original(...args);
  };
  fx.onRestore(() => {
    slot[method] = original;
  });
  return counter;
}

/**
 * `fs.unlinkSync` refuses the entry at `entryPath` for its first `times` calls.
 *
 * @remarks
 * The refusal is the Windows shape of "another process holds this file open with no
 * sharing": `EPERM`, and the name will not go away.
 *
 * @param times Leading calls that refuse. Omit it for a handle that is never released;
 *              pass a count to model the handle being let go mid-budget, which is what
 *              makes the release path observable rather than assumed.
 */
function refuseUnlink(fx: ResidueVault, entryPath: string, times = Infinity): { calls: number } {
  return patchFsOnPath(fx, 'unlinkSync', entryPath, call => {
    if (call <= times) {
      throw fsErrorWith('EPERM', `EPERM: operation not permitted, unlink '${entryPath}'`);
    }
  });
}

/**
 * Counts `fs.rmdirSync` calls on `dir` and lets each proceed unless `fault` says
 * otherwise.
 *
 * @param fault Sees the 1-based call count and a `remove` that performs the real
 *              removal. A scenario that reports `ENOENT` because a rival *did* take
 *              the directory has to leave the filesystem in the state that claim
 *              describes, which is why removal is offered rather than implied.
 */
function watchRmdir(
  fx: ResidueVault,
  dir: string,
  fault?: (call: number, remove: () => void) => void
): { calls: number } {
  return patchFsOnPath(fx, 'rmdirSync', dir, (call, original, args) => {
    fault?.(call, () => {
      original(...args);
    });
  });
}

/**
 * Answers `fs.readdirSync` on `dir` from `listing` instead of the disk.
 *
 * @param listing Produces the entry names the lock module sees, or throws the answer a
 *                scenario needs (a directory that reports itself gone while it is
 *                still there).
 */
function overrideReaddir(
  fx: ResidueVault,
  dir: string,
  listing: (call: number) => string[]
): { calls: number } {
  return patchFsOnPath(fx, 'readdirSync', dir, call => listing(call));
}

/**
 * A hang breaker, not an assertion.
 *
 * @remarks
 * `createLock` is synchronous, so a regressed spin owns the event loop: neither a
 * per-test `timeout` nor any timer can fire against it, and the suite freezes instead
 * of failing. The only thing that turns that regression into a named failure is a
 * check inside the patch itself. `ELOOP` is not a code the module handles, so it
 * escapes to the caller. `limit` sits above the rounds a bounded run can reach, so it
 * cannot trip on correct code.
 */
function spinGuard(call: number, limit: number, detail: string): void {
  if (call <= limit) return;
  throw fsErrorWith('ELOOP', `${limit} ${detail} — the loop is unbounded`);
}

/** `spyAtomicsWait` bound to `fx`, so its restore runs with the rest of the fixture. */
function watchParks(fx: ResidueVault, onPark?: () => void): { calls: number[] } {
  const spy = spyAtomicsWait(onPark);
  fx.onRestore(spy.restore);
  return { calls: spy.calls };
}

/**
 * Records the order of calls to one `fs` method, without changing what any of them do.
 *
 * @param log     Shared event log, so calls to different methods stay ordered against
 *                each other — the whole point of a quarantine-ordering assertion.
 * @param when    Whether this call is the scenario's traffic (other paths are ignored).
 * @param label   What to push for a matching call.
 *
 * @remarks
 * `patchFsOnPath` decides between "answer this call" and "let the real one run" by
 * whether the handler returned a value, so it cannot express "log and delegate" for a
 * void method like `mkdirSync` — the delegating branch would invoke the real method a
 * second time. This always delegates, exactly once.
 */
function recordCalls(
  fx: ResidueVault,
  method: RecordableFsMethod,
  log: string[],
  when: (args: unknown[]) => boolean,
  label: (args: unknown[]) => string
): void {
  const slot = fs as unknown as Record<RecordableFsMethod, (...a: unknown[]) => unknown>;
  const original = slot[method];
  slot[method] = (...args: unknown[]): unknown => {
    if (when(args)) log.push(label(args));
    return original(...args);
  };
  fx.onRestore(() => {
    slot[method] = original;
  });
}

/**
 * Asserts the error is the retryable-conflict class every contention path reports.
 *
 * @param expected The wording that tells this path apart from the others.
 *
 * @remarks
 * `code = 'ECONFLICT'` and the `Lock conflict: ` prefix travel together: the prefix is
 * how `isConflictError` recognises a conflict by text as well as by code, and the pair
 * is what maps to exit `4` (INV-04, INV-09). Checking only the code would let a path
 * that never went through `lockConflict()` pass, and checking only the pair would let
 * a conflict arrive from the wrong branch — so `expected` pins which message this is.
 */
function assertConflict(err: unknown, expected: RegExp): void {
  const conflict = err as NodeError;
  assert.strictEqual(
    conflict.code,
    'ECONFLICT',
    `expected a lock conflict, got ${String(conflict.code)}: ${conflict.message}`
  );
  assert.match(conflict.message, /^Lock conflict: /, 'the prefix is what isConflictError keys on (INV-04)');
  assert.match(conflict.message, expected);
}

/**
 * Asserts one park per entry of `bandFor`, each asking for the delay the documented
 * schedule prescribes at that position.
 *
 * @param bandFor One index into {@link PARK_BANDS} per park, in the order they occur.
 *
 * @remarks
 * Equal work, not elapsed time (ADR-0026): the assertion is on the duration the code
 * *asked* for, so a loaded runner cannot change the outcome. A park that is absent (a
 * spin) or a schedule that stopped doubling both fail by position and number; the
 * `some(d => d > 100)` form this replaces passed on almost any schedule.
 */
function assertParkedSchedule(calls: number[], bandFor: readonly number[], label: string): void {
  assert.strictEqual(
    calls.length,
    bandFor.length,
    `${label}: expected ${bandFor.length} park(s), saw ${calls.length}: ${calls.join(', ')}`
  );
  for (const [index, ms] of calls.entries()) {
    const bandIndex = bandFor[index];
    const band = bandIndex === undefined ? undefined : PARK_BANDS[bandIndex];
    // Not an assertion. The length check above already bounds both indexes, so no
    // shipped mutant can reach this line; it exists to narrow
    // `noUncheckedIndexedAccess`, and fails loudly rather than silently skipping if
    // that reasoning ever stops holding (ADR-0026: a check that cannot fail is not a
    // test, so it must not be dressed as one).
    if (band === undefined) {
      throw new Error(`${label}: park #${index + 1} has no documented band`);
    }
    assert.ok(ms >= band[0], `${label}: park #${index + 1} must ask for at least ${band[0]}ms of backoff, asked ${ms}ms`);
    assert.ok(ms <= band[1], `${label}: park #${index + 1} must stay within the ${band[1]}ms ceiling, asked ${ms}ms`);
  }
}

describe('File Locking', () => {
  let testVaultPath: string;
  let testFilePath: string;

  before(() => {
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-test-'));
  });

  beforeEach(() => {
    const locksDir = path.join(testVaultPath, '.palee', 'locks');
    fs.rmSync(locksDir, { recursive: true, force: true });
    testFilePath = path.join(testVaultPath, 'test-note-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(testFilePath, '# Test Note', 'utf8');
  });

  after(() => {
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  });

  test('acquires lock successfully', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();

    const lockPath = lock.lockPath;
    assert.ok(fs.existsSync(lockPath));

    const lockData = getLockData(lockPath);
    assert.ok(lockData);
    assert.ok(lockData.lock_id.startsWith('L-'));
    // #356: the id must carry the full 4 bytes (8 hex chars) of entropy, not a
    // narrower suffix — two locks minted in the same second are separated by this
    // alone, exactly as the session id is.
    assert.match(
      lockData.lock_id,
      /^L-\d{8}T\d{6}-[0-9a-f]{8}$/,
      `lock id must be L-<timestamp>-<8 hex>: ${lockData.lock_id}`
    );
    assert.strictEqual(lockData.pid, process.pid);
    assert.strictEqual(lockData.target, testFilePath);

    lock.release();
    assert.ok(getLockData(lockPath) === null);
  });

  test('second lock acquisition fails with conflict', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, testFilePath);
    await assert.rejects(
      async () => await lock2.acquire(),
      { message: /Lock conflict/ }
    );

    lock1.release();
  });

  test('lock release occurs after success', async () => {
    const lock = new Lock(testVaultPath, testFilePath);
    await lock.acquire();
    lock.release();
    assert.ok(getLockData(lock.lockPath) === null);
  });



  test('heartbeat timer stamps the held session file once per HEARTBEAT_INTERVAL (INV-05)', async (t) => {
    // INV-05: a held lock advertises its own liveness. The previous version of
    // this test slept 1100ms, called `fs.utimesSync` on the lock file ITSELF and
    // then asserted the mtime had moved — it manufactured the effect it credited
    // to production, so deleting `startHeartbeat()` from `acquire()` kept it
    // green. Here the only thing allowed to touch the file is the closure
    // production handed to `setInterval`, and the clock is a mock: the 15s
    // cadence is pinned by simulated elapsed time, with no sleep, no 1100ms
    // gamble, and no dependence on Windows mtime granularity.
    t.mock.timers.enable({ apis: ['setInterval'] });
    const spy = spyUtimesSync();

    const lock = new Lock(testVaultPath, testFilePath);
    try {
      await lock.acquire();
      const lockFile = singleSessionFile(lock.lockPath);

      // Armed, but nothing has elapsed. Neither this test nor production may have
      // stamped anything yet — this is the assertion the old test faked.
      assert.deepStrictEqual(
        spy.calls.map(c => c.file),
        [] as string[],
        'acquire() must not stamp the lock file; only the interval may'
      );

      // One millisecond short of the interval: still silent. A heartbeat armed on
      // a shorter delay fires inside this window and shows up as extra calls.
      t.mock.timers.tick(HEARTBEAT_INTERVAL - 1);
      assert.deepStrictEqual(
        spy.calls.map(c => c.file),
        [] as string[],
        `heartbeat must stay silent until ${HEARTBEAT_INTERVAL}ms has elapsed`
      );

      const startedAt = Date.now();
      t.mock.timers.tick(1);
      const endedAt = Date.now();

      assert.strictEqual(
        spy.calls.length,
        1,
        `expected exactly one heartbeat stamp at ${HEARTBEAT_INTERVAL}ms, got ${spy.calls.length}`
      );
      const [firstStamp] = spy.calls;
      assert.ok(firstStamp !== undefined);
      assert.strictEqual(
        firstStamp.file,
        lockFile,
        'heartbeat must stamp the session file this holder owns'
      );

      // The stamp has to be a live timestamp: `utimesSync` on `new Date(0)` would
      // arm the timer but make the lock look abandoned to every other process.
      const { atime, mtime } = firstStamp;
      assert.ok(
        atime instanceof Date && mtime instanceof Date,
        `heartbeat must pass Date stamps to utimesSync, got ${String(atime)} / ${String(mtime)}`
      );
      assert.ok(
        atime.getTime() >= startedAt && atime.getTime() <= endedAt,
        `heartbeat stamp must be the current clock, got ${atime.toISOString()} outside ${new Date(startedAt).toISOString()}..${new Date(endedAt).toISOString()}`
      );

      // `setInterval`, not a one-shot: a second period must stamp a second time.
      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(
        spy.calls.length,
        2,
        `heartbeat must repeat every ${HEARTBEAT_INTERVAL}ms, saw ${spy.calls.length} stamps after a second period`
      );
      const [, secondStamp] = spy.calls;
      assert.ok(secondStamp !== undefined);
      assert.strictEqual(secondStamp.file, lockFile, 'repeated heartbeat must re-stamp the same session file');
    } finally {
      spy.restore();
      lock.release();
    }
  });

  test('release clears the heartbeat interval so a dead holder stops claiming liveness (INV-05)', async (t) => {
    // The other half of the liveness contract: stop advertising once released.
    // Nothing else in the suite can see a leaked interval — `release()` unlinks the
    // session file either way, and a tick after that reads ENOENT and self-clears
    // (`updateHeartbeat` returns 'lost'). The recorder sees the attempt regardless
    // of the outcome, so an interval left running after release still shows up here.
    t.mock.timers.enable({ apis: ['setInterval'] });
    const spy = spyUtimesSync();

    const lock = new Lock(testVaultPath, testFilePath);
    try {
      await lock.acquire();
      const lockFile = singleSessionFile(lock.lockPath);

      t.mock.timers.tick(HEARTBEAT_INTERVAL);
      assert.strictEqual(spy.calls.length, 1, 'precondition: the heartbeat stamps once per interval');
      const [heldStamp] = spy.calls;
      assert.ok(heldStamp !== undefined);
      assert.strictEqual(heldStamp.file, lockFile, 'precondition: that stamp is this session file');

      lock.release();
      spy.calls.length = 0;

      // Three full periods with nobody holding the lock. If the interval survived
      // `release()` the touch still happens (its ENOENT is caught by
      // `updateHeartbeat`), so a leaked timer is recorded here rather than thrown.
      t.mock.timers.tick(HEARTBEAT_INTERVAL * 3);
      assert.deepStrictEqual(
        spy.calls.map(c => c.file),
        [] as string[],
        'release() must clear the heartbeat interval'
      );
    } finally {
      spy.restore();
      lock.release();
    }
  });

  test('stale lock recovery takes over old lock', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lockPath = lock1.lockPath;

    // Manually make lock stale by modifying mtime
    const lockData = getLockData(lockPath);
    const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
    const [lockFileName] = files;
    assert.ok(lockFileName !== undefined);
    const lockFile = path.join(lockPath, lockFileName);
    
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 1000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    // Don't release lock1 - leave it in stale state
    const lock2 = new Lock(testVaultPath, testFilePath);

    // Should succeed after detecting stale lock and taking it over
    await lock2.acquire();

    const newLockData = getLockData(lockPath);
    assert.notStrictEqual(newLockData.lock_id, lockData.lock_id);
    assert.strictEqual(newLockData.pid, process.pid);

    lock2.release();
  });

  test('dead-process lock on this host is reclaimed before STALE_TIMEOUT', async () => {
    // Simulate a holder that crashed without releasing: a lock file recorded on
    // THIS host whose PID no longer exists. The same-host liveness probe should
    // treat it as stale immediately, without waiting out STALE_TIMEOUT.
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();
    const lockPath = lock1.lockPath;

    const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
    const [lockFileName] = files;
    assert.ok(lockFileName !== undefined);
    const lockFile = path.join(lockPath, lockFileName);
    const original = JSON.parse(fs.readFileSync(lockFile, 'utf8'));

    // Find a PID that is not running, using the same signal-0 check the
    // implementation relies on.
    let deadPid = 999999;
    for (let candidate = 999999; candidate > 1; candidate--) {
      try {
        process.kill(candidate, 0);
      } catch (e) {
        if ((e as NodeError).code === 'ESRCH') { deadPid = candidate; break; }
      }
    }

    // Rewrite the lock file: current hostname, a dead PID, and a FRESH mtime so
    // only the liveness probe — not the timeout — can mark it stale.
    const stale = { ...original, pid: deadPid, hostname: os.hostname() };
    fs.writeFileSync(lockFile, JSON.stringify(stale, null, 2), 'utf8');
    const now = new Date();
    fs.utimesSync(lockFile, now, now);

    // A second acquisition must take over the dead holder's lock immediately.
    const lock2 = new Lock(testVaultPath, testFilePath);
    await lock2.acquire();

    const newLockData = getLockData(lockPath);
    assert.strictEqual(newLockData.pid, process.pid);
    assert.notStrictEqual(newLockData.lock_id, stale.lock_id);

    lock2.release();
  });

  test('stale timeout is platform-specific', () => {
    if (process.platform === 'win32') {
      assert.strictEqual(STALE_TIMEOUT, 60000); // 60s on Windows
    } else {
      assert.strictEqual(STALE_TIMEOUT, 120000); // 120s elsewhere
    }
  });

  test('heartbeat interval is 15 seconds', () => {
    assert.strictEqual(HEARTBEAT_INTERVAL, 15000);
  });

  test('lock release handles already-released lock', () => {
    const lock = new Lock(testVaultPath, testFilePath);
    assert.doesNotThrow(() => lock.release());
  });

  test('validates lock collision throws ECONFLICT', async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, testFilePath);
    try {
      let err: any;
      try {
        await lock2.acquire();
      } catch (e) {
        err = e;
      }

      assert.ok(err, 'Expected error to be thrown');
      assert.strictEqual(err.code, 'ECONFLICT');
    } finally {
      lock1.release();
      lock2.release();
    }
  });

  test('lock identity is consistent across symlinks', async () => {
    const symlinkPath = path.join(testVaultPath, 'symlink-note.md');
    try {
      fs.symlinkSync(path.basename(testFilePath), symlinkPath);
    } catch (e: any) {
      if (e.code === 'EPERM' || e.code === 'ENOTSUP') return; // Skip if symlinks require admin
      throw e;
    }

    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();

    const lock2 = new Lock(testVaultPath, symlinkPath);
    try {
      let err: any;
      try {
        await lock2.acquire();
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'Expected error to be thrown');
      assert.strictEqual(err.code, 'ECONFLICT');
    } finally {
      lock1.release();
      lock2.release();
    }
  });

  test('stale-lock recovery retries EPERM/EBUSY up to the budget and rethrows', { timeout: 10000 }, async () => {
    // Pin the bounded-retry contract from `createLock`'s stale-recovery path.
    // Without this, a future refactor that drops the budget (e.g. back to a
    // bare `continue` inside `while (true)`) would re-introduce the
    // unbounded-busy-spin hang this PR was meant to remove, and CI would not
    // catch it because the existing 11 tests only exercise the happy path.
    //
    // We monkey-patch the global `fs.rmdirSync` so that every rmdirSync
    // `createLock` issues on the lock directory (after quarantining all stale
    // session files) throws a synthetic `EPERM`. On Windows the bounded retry
    // loop will spin through its 5-attempt budget and then rethrow the
    // original error. On non-Windows the platform gate in
    // `src/storage/lock.ts` skips the retry and rethrows immediately. Either
    // way the call must surface a thrown error. The setTimeout watchdog below
    // only detects hangs on the ASYNCHRONOUS path (acquire() is async, so a
    // hang before the synchronous createLock section can still tick timers);
    // a regression to an unbounded SYNCHRONOUS spin would freeze the event
    // loop and bypass the watchdog — the per-test `timeout` above is what
    // bounds that case, since the test runner supervises each child process
    // from outside.
    const isWindows = process.platform === 'win32';

    // Set up a vault + a target file the same way the other stale tests do.
    const faultVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-fault-'));
    const faultFile = path.join(faultVault, 'fault-target-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(faultFile, '# Fault Target', 'utf8');

    // Acquire a lock, then age it past the stale threshold so the next
    // acquisition enters stale-recovery and reaches the rmdirSync call.
    const seedLock = new Lock(faultVault, faultFile);
    await seedLock.acquire();
    const faultLockDir = seedLock.lockPath;

    const files = fs.readdirSync(faultLockDir).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0, 'precondition: seed lock should have a session file');
    const [faultLockFileName] = files;
    assert.ok(faultLockFileName !== undefined);
    const faultLockFile = path.join(faultLockDir, faultLockFileName);
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 5000);
    fs.utimesSync(faultLockFile, staleTime, staleTime);
    // Stop the heartbeat so it cannot refresh the lock mid-test.
    const seedTimer = (seedLock as unknown as { heartbeatTimer: ReturnType<typeof setInterval> | null }).heartbeatTimer;
    if (seedTimer) clearInterval(seedTimer);

    // Monkey-patch fs.rmdirSync. The same `fs` module instance is shared by
    // lock.ts because both files import `fs from 'fs'`, so this intercepts
    // the rmdirSync call inside `createLock`'s stale-recovery path.
    const originalRmdirSync = fs.rmdirSync;
    let rmdirCalls = 0;
    (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = function patchedRmdirSync(
      this: unknown,
      p: fs.PathLike,
      ...rest: unknown[]
    ): void {
      if (typeof p === 'string' && p === faultLockDir) {
        rmdirCalls += 1;
        const e = new Error('simulated EPERM for stale-recovery budget test') as NodeError;
        e.code = 'EPERM';
        throw e;
      }
      return (originalRmdirSync as unknown as (...a: unknown[]) => void).call(
        this,
        p as fs.PathLike,
        ...rest
      );
    };

    // Wall-clock watchdog. If `acquire` does not throw within `WATCHDOG_MS`,
    // the bounded-retry contract has regressed to an unbounded busy-spin
    // and the test must fail loudly. The contract guarantees completion well
    // under 2s on either platform (5 attempts × max 300ms each on Windows;
    // immediate rethrow on non-Windows), so 5s is a generous safety margin.
    const WATCHDOG_MS = 5000;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          `stale-recovery hung past ${WATCHDOG_MS}ms watchdog — retry is unbounded`
        ));
      }, WATCHDOG_MS);
    });

    try {
      const acquirer = new Lock(faultVault, faultFile);
      const acquirePromise = acquirer.acquire();
      await assert.rejects(
        Promise.race([acquirePromise, watchdog]),
        (err: Error & { code?: string }) => {
          // Watchdog rejection (no code) signals an unbounded regression.
          if (!err.code) return false;
          return err.code === 'EPERM';
        },
        'expected stale-recovery to surface EPERM after the retry budget'
      );
    } finally {
      if (timer) clearTimeout(timer);
      (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = originalRmdirSync;
      seedLock.release();
      try { fs.rmSync(faultVault, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    // Sanity: the patched rmdirSync must have been entered at least once.
    // (On non-Windows, rmdirSync is called once before the platform gate
    // rejects the retry path; on Windows, the bounded retry calls it at
    // least once and the loop's first attempt may also consume it.)
    assert.ok(
      rmdirCalls >= 1,
      `expected at least one intercepted rmdirSync call on lockDir (got ${rmdirCalls})`
    );
    // Cross-platform note (informational; not an assertion):
    // isWindows === true  -> bounded retry runs; with an always-throwing
    //   mock the intercepted calls are WINDOWS_RETRY_ATTEMPTS (5) retry
    //   attempts plus the initial rmdirSync before the retry loop — 6 total.
    // isWindows === false -> platform gate skips the retry loop, so exactly
    //   1 rmdirSync call is intercepted.
    void isWindows;
  });

  test('stale-lock recovery succeeds when the final retry attempt clears the handle', { timeout: 10000, skip: process.platform !== 'win32' }, async () => {
    // Regression pin for the off-by-one Greptile/Kilo flagged on the first
    // cut of the retry budget: when the last permitted attempt's rmdirSync
    // succeeds, the loop must fall through to re-acquisition — deriving the
    // outcome from the attempt count alone made the 5th attempt's success
    // rethrow the original EPERM anyway. Skipped visibly off Windows: the retry
    // budget is reached through `isTransientHandleCode`, which only answers true
    // on win32. A bare `return` here would report PASS while asserting nothing.

    const RETRY_BUDGET = 5; // mirrors WINDOWS_RETRY_ATTEMPTS in src/storage/lock.ts

    const faultVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-lock-last-'));
    const faultFile = path.join(faultVault, 'fault-target-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(faultFile, '# Fault Target', 'utf8');

    const seedLock = new Lock(faultVault, faultFile);
    await seedLock.acquire();
    const faultLockDir = seedLock.lockPath;
    const seedLockData = getLockData(faultLockDir);
    assert.ok(seedLockData, 'precondition: seed lock should parse');

    const files = fs.readdirSync(faultLockDir).filter(f => f.endsWith('.json'));
    const [faultLockFileName] = files;
    assert.ok(faultLockFileName !== undefined);
    const faultLockFile = path.join(faultLockDir, faultLockFileName);
    const staleTime = new Date(Date.now() - STALE_TIMEOUT - 5000);
    fs.utimesSync(faultLockFile, staleTime, staleTime);
    const seedTimer = (seedLock as unknown as { heartbeatTimer: ReturnType<typeof setInterval> | null }).heartbeatTimer;
    if (seedTimer) clearInterval(seedTimer);

    // Throw EPERM for the initial rmdirSync plus the first four retry
    // attempts; the next call — the final permitted attempt — lets the real
    // rmdirSync run and succeed on the now-empty directory.
    const originalRmdirSync = fs.rmdirSync;
    let rmdirCalls = 0;
    (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = function patchedRmdirSync(
      this: unknown,
      p: fs.PathLike,
      ...rest: unknown[]
    ): void {
      if (typeof p === 'string' && p === faultLockDir) {
        rmdirCalls += 1;
        if (rmdirCalls <= RETRY_BUDGET) {
          const e = new Error('simulated EPERM for final-attempt recovery test') as NodeError;
          e.code = 'EPERM';
          throw e;
        }
      }
      return (originalRmdirSync as unknown as (...a: unknown[]) => void).call(
        this,
        p as fs.PathLike,
        ...rest
      );
    };

    try {
      const acquirer = new Lock(faultVault, faultFile);
      await acquirer.acquire();
      assert.strictEqual(rmdirCalls, RETRY_BUDGET + 1);
      const newLockData = getLockData(faultLockDir);
      assert.ok(newLockData, 'expected a live lock after recovery');
      assert.notStrictEqual(newLockData.lock_id, seedLockData.lock_id);
      acquirer.release();
    } finally {
      (fs as unknown as { rmdirSync: typeof fs.rmdirSync }).rmdirSync = originalRmdirSync;
      seedLock.release();
      try { fs.rmSync(faultVault, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('a lock directory holding an unremovable subdirectory is a conflict, not a spin (#539)', { timeout: 10000 }, async () => {
    // The reported hang, reduced to one entry: stale recovery finds no readable
    // `.json` owner, unlinks what it can, and then cannot `rmdirSync` a directory it
    // never created. While that ENOTEMPTY shared an unconditional `continue` with
    // ENOENT, the loop re-read the same entry at 100% CPU for as long as it lived.
    // A directory cannot clear on its own, so ADR-0036 refuses it by name instead of
    // waiting it out.
    const fx = residueVault('subdir', lockDir => {
      fs.mkdirSync(path.join(lockDir, 'leftover-subdir'));
    });
    const parks = watchParks(fx);
    // 40 sits above the 20 rounds the iteration cap allows, so a bounded run can never
    // trip it; only an unbounded one can.
    const removals = watchRmdir(fx, fx.lockDir, call => {
      spinGuard(call, 40, 'rmdirSync calls on one un-removable lock directory');
    });

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          assertConflict(err, /leftover-subdir/);
          assert.match(err.message, /unremovable entry/, 'the fail-fast must own this conflict, not the residue budget');
          return true;
        }
      );
      // The deciding property of the fail-fast: it fires from the sweep, before a
      // removal is ever attempted. A count above zero means the budget was spent on a
      // condition that cannot change — the bug itself, dressed up as a pass.
      assert.strictEqual(
        removals.calls,
        0,
        `the directory must be refused before any removal attempt, saw ${removals.calls}`
      );
      assert.deepStrictEqual(parks.calls, [] as number[], 'a permanent condition must be refused, never waited out');
    } finally {
      fx.dispose();
    }
  });

  test('an un-unlinkable lock directory entry is retried with backoff and then reported as a conflict (#539)', { timeout: 10000 }, async () => {
    // The other shape of the reported hang: a *file* inside the lockdir that
    // `fs.unlinkSync` cannot remove because another process holds it open with no
    // sharing. Unlike a directory this can clear on its own, so it is waited out — but
    // only for the budget, and every retry parks instead of spinning.
    const residue = 'held-open.txt';
    const fx = residueVault('held-open', lockDir => {
      fs.writeFileSync(path.join(lockDir, residue), 'held', 'utf8');
    });
    const parks = watchParks(fx);
    const unlinks = refuseUnlink(fx, fx.entry(residue));
    const removals = watchRmdir(fx, fx.lockDir);

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          assertConflict(err, /held-open\.txt/);
          assert.match(err.message, /would not empty/, 'the residue budget must be what reports this');
          return true;
        }
      );
      assert.strictEqual(unlinks.calls, RESIDUE_RETRY_BUDGET + 1, 'the entry is retried, not abandoned after one refusal');
      assert.strictEqual(removals.calls, RESIDUE_RETRY_BUDGET + 1, 'one attempt plus the retry budget, then give up');
      assertParkedSchedule(parks.calls, [0, 1, 2, 3, 4], 'the residue budget');
    } finally {
      fx.dispose();
    }
  });

  test('the acquisition loop is bounded even when the lock directory never settles (#539)', { timeout: 10000 }, async () => {
    // The backstop behind the ENOTEMPTY budget: every other `continue` reports a state
    // change, but a filesystem that keeps answering ENOENT for a directory that keeps
    // existing would still loop forever. The bound makes termination a property of the
    // code rather than of the filesystem's honesty — ADR-0036 rejects a deadline for
    // exactly that reason: a count is deterministic and directly assertable.
    const fx = residueVault('bound');
    const parks = watchParks(fx);
    const listings = overrideReaddir(fx, fx.lockDir, call => {
      // 3× the cap, so only an unbounded run reaches it.
      spinGuard(call, ACQUISITION_ITERATION_CAP * 3, 'readdirSync calls on one lock directory');
      // "Someone deleted it, retry mkdir" — the forward-progress answer that never
      // becomes progress, because the directory is still there.
      throw fsErrorWith('ENOENT', `ENOENT: no such file or directory, scandir '${fx.lockDir}'`);
    });

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          // The number in the message is the cap itself: it has to be the count the
          // loop ran below, or the conflict reports a bound it did not enforce.
          assertConflict(err, /did not settle after 20 acquisition attempts/);
          return true;
        }
      );
      assert.strictEqual(listings.calls, ACQUISITION_ITERATION_CAP, 'the loop must stop at the iteration bound');
      assert.deepStrictEqual(parks.calls, [] as number[], 'the cap refuses churn outright; it does not park its way to it');
    } finally {
      fx.dispose();
    }
  });

  test('a lock directory another process removed first is forward progress, not a conflict (#539)', { timeout: 10000 }, async () => {
    // The one `continue` that must survive unbudgeted: ENOENT says the directory is
    // already gone, so the next `mkdirSync` is a real acquisition attempt. Refusing it
    // here would turn a lost race into a spurious conflict, and parking on it would
    // wait out a change that has already happened.
    // This lockdir holds nothing, so its aged stamp is what routes the acquisition to
    // the sweep rather than to the incoming-process check — the one scenario of the
    // nine where the aging alone decides which branch the test is exercising.
    const fx = residueVault('enoent');
    const parks = watchParks(fx);
    const removals = watchRmdir(fx, fx.lockDir, (call, remove) => {
      if (call !== 1) return;
      // A rival removed it between our inspection and our attempt: the removal did
      // happen, and the error the caller sees is the one that reports it.
      remove();
      throw fsErrorWith('ENOENT', `ENOENT: no such file or directory, rmdir '${fx.lockDir}'`);
    });
    const acquirer = fx.hold(fx.newLock());

    try {
      await acquirer.acquire();
      assert.strictEqual(removals.calls, 1, 'the lost race must be handled without a second removal attempt');
      assert.deepStrictEqual(parks.calls, [] as number[], 'ENOENT is forward progress and must never park');
      // The discarded return value IS the assertion: singleSessionFile throws unless
      // the lockdir holds exactly one `.json` named after the lock_id inside it, which is
      // what proves the retry acquired rather than merely stopped erroring.
      singleSessionFile(acquirer.lockPath);
    } finally {
      fx.dispose();
    }
  });

  test('a stale record beside an unremovable entry still reports the residue, not an incoming process (#539)', { timeout: 10000 }, async () => {
    // The shape the issue actually reports: a lock directory holding a stale record
    // *and* something un-unlinkable. The first round unlinks the record, which stamps
    // the directory's mtime; a second round reading that stamp used to conclude an
    // incoming process just created the directory and abandon the residue one retry
    // in — blaming a rival that does not exist, and never reaching the budget.
    const residue = 'held-open.txt';
    const staleId = 'L-20260101T000000-deadbeef';
    const fx = residueVault('mixed', (lockDir, target) => {
      // A record from another host, so the liveness probe cannot help and the aged
      // mtime is the only staleness signal — deterministic on every platform.
      // `created_at` is in the fixture because `LockData` has the field, not because
      // anything reads it: `isLockStale` compares the record's mtime, set below.
      const record = path.join(lockDir, `${staleId}.json`);
      fs.writeFileSync(record, JSON.stringify({
        lock_id: staleId,
        target,
        pid: 999999,
        hostname: 'not-this-host',
        created_at: new Date(0).toISOString()
      }, null, 2), 'utf8');
      agePastStale(record);
      fs.writeFileSync(path.join(lockDir, residue), 'held', 'utf8');
    });
    const parks = watchParks(fx);
    refuseUnlink(fx, fx.entry(residue));
    const removals = watchRmdir(fx, fx.lockDir);

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          assertConflict(err, /held-open\.txt/);
          assert.match(err.message, /would not empty/, 'the residue budget must be what reports this');
          assert.doesNotMatch(err.message, /deadbeef/, 'the record that cleared is not residue and must not be blamed');
          return true;
        }
      );
      assert.strictEqual(removals.calls, RESIDUE_RETRY_BUDGET + 1, 'the budget must be spent, not short-circuited');
      assertParkedSchedule(parks.calls, [0, 1, 2, 3, 4], 'the residue budget');
      // The sweep did its job on the thing it could reach: the record and its
      // quarantine copy are gone, and only the entry that refused is left.
      assert.deepStrictEqual(
        fs.readdirSync(fx.lockDir),
        [residue],
        'the stale record must be quarantined away and the residue left untouched'
      );
    } finally {
      fx.dispose();
    }
  });

  test('a held entry that clears mid-budget lets the acquisition succeed (#539)', { timeout: 10000 }, async () => {
    // The other half of a retry policy: it has to recover, not only give up. A file
    // another process releases while we are parking must stop being an obstacle, and
    // the acquisition must land without exhausting the budget.
    const clears = 'released-soon.txt';
    const REFUSALS = 2;
    const fx = residueVault('clears', lockDir => {
      fs.writeFileSync(path.join(lockDir, clears), 'held', 'utf8');
    });
    const parks = watchParks(fx);
    const unlinks = refuseUnlink(fx, fx.entry(clears), REFUSALS);
    const acquirer = fx.hold(fx.newLock());

    try {
      await acquirer.acquire();
      assert.strictEqual(unlinks.calls, REFUSALS + 1, 'the unlink is retried until it takes');
      assertParkedSchedule(parks.calls, [0, 1], 'the retries before the entry cleared');
      const session = singleSessionFile(acquirer.lockPath);
      // The directory this acquisition made is a new one: the entry that cleared went
      // with the sweep, and nothing else was written into the lockdir.
      assert.deepStrictEqual(
        fs.readdirSync(acquirer.lockPath),
        [path.basename(session)],
        'the cleared entry must be gone, leaving only this holder\'s record'
      );
    } finally {
      fx.dispose();
    }
  });

  test('an ENOTEMPTY reached through the Windows retry loop spends the same budget (#539)', {
    timeout: 10000,
    // The `EPERM`/`EBUSY` arm this scenario enters is gated on `process.platform` in
    // `src/storage/lock.ts`, so on any other platform the body below would assert
    // nothing while reporting a pass. A visible skip says so in the run summary —
    // a green line that proved nothing is the dead-test trap ADR-0026 names.
    skip: process.platform !== 'win32',
  }, async () => {
    // A transient directory handle clears during the retry park, and the next attempt
    // then answers ENOTEMPTY because a file inside survived the sweep. That path used
    // to treat ENOTEMPTY as free progress, so the budget was unreachable and the loop
    // cap reported churn for a stuck entry instead of naming the residue.
    const residue = 'stuck-entry.txt';
    const fx = residueVault('escalate', lockDir => {
      fs.writeFileSync(path.join(lockDir, residue), 'stuck', 'utf8');
    });
    const parks = watchParks(fx);
    refuseUnlink(fx, fx.entry(residue));
    // Only the first removal meets the transient handle; every later one meets the
    // residue, which is the escalation under test.
    const removals = watchRmdir(fx, fx.lockDir, call => {
      if (call !== 1) return;
      throw fsErrorWith('EPERM', `EPERM: operation not permitted, rmdir '${fx.lockDir}'`);
    });

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          assertConflict(err, /stuck-entry\.txt/);
          assert.match(err.message, /would not empty/, 'the budget must own this, not the loop cap');
          return true;
        }
      );
      // One attempt answered EPERM, the retry loop's first answered ENOTEMPTY, and the
      // budget then owned every round after that.
      assert.strictEqual(removals.calls, RESIDUE_RETRY_BUDGET + 2, 'the retry loop must not re-enter ENOTEMPTY for free');
      // The loop's own 50 ms park leads, then the five the budget spends: one schedule
      // for both paths is the whole of ADR-0036's "one budget covers both paths".
      assertParkedSchedule(parks.calls, [0, 0, 1, 2, 3, 4], 'the Windows retry loop and the residue budget');
    } finally {
      fx.dispose();
    }
  });

  test('a lock-dir entry name with control characters is escaped in the conflict (#539)', { timeout: 10000 }, async () => {
    // Conflict messages print entry names straight to stderr and to captured logs.
    // POSIX permits a newline or an ANSI escape in a filename, so an unescaped name
    // could forge or recolor the lines around the error it appears in. The crafted
    // name is injected through `readdirSync` rather than created on disk, because
    // Windows refuses such a name outright — which would make this test unrunnable on
    // the platform whose logs it protects.
    const evilName = 'evil\x1b[31mred';
    const fx = residueVault('evil', lockDir => {
      // This real file is what keeps `rmdirSync` answering ENOTEMPTY and so spends the
      // budget; the crafted name below is virtual, which is what lets the scenario run
      // on Windows at all. No unlink refusal is installed for it: removing a name that
      // does not exist is answered ENOENT and costs the sweep no retry.
      fs.writeFileSync(path.join(lockDir, 'placeholder.txt'), 'placeholder', 'utf8');
    });
    const parks = watchParks(fx);
    overrideReaddir(fx, fx.lockDir, () => [evilName]);

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          assertConflict(err, /evil\\x1b\[31mred/);
          // Kept separate from the match above: the pair holds today, but if the
          // escaping format ever changes the raw sequence is still what must not
          // reach a terminal.
          assert.strictEqual(
            err.message.includes('\x1b'),
            false,
            'the conflict must not carry a raw escape sequence'
          );
          return true;
        }
      );
      assertParkedSchedule(parks.calls, [0, 1, 2, 3, 4], 'the residue budget reporting the crafted name');
    } finally {
      fx.dispose();
    }
  });

  test('a rival that replaced the lock directory mid-budget is not swept away (#539)', { timeout: 10000 }, async () => {
    // The mutual exclusion property the budget must not break. A directory holding the
    // residue this process is clearing is not a rival; a directory that is young and
    // *empty* is one — a process that created it and has not written its record yet.
    // Suppressing the incoming-process check for the rest of the budget would let this
    // side `rmdir` that replacement and recreate it, and both writers would then hold
    // (ADR-0036: gating the check on the budget "would have fixed the message and
    // broken mutual exclusion").
    const residue = 'residue.txt';
    const fx = residueVault('rival', lockDir => {
      fs.writeFileSync(path.join(lockDir, residue), 'residue', 'utf8');
    });
    refuseUnlink(fx, fx.entry(residue));

    // On the first park — while this side waits out the residue — a rival removes the
    // directory and recreates it empty, then stalls before writing its record.
    let replaced = false;
    const parks = watchParks(fx, () => {
      if (replaced) return;
      replaced = true;
      fs.rmSync(fx.lockDir, { recursive: true, force: true });
      fs.mkdirSync(fx.lockDir);
    });

    try {
      await assert.rejects(
        () => fx.newLock().acquire(),
        (err: Error) => {
          assertConflict(err, /incoming process/);
          return true;
        }
      );
      assert.strictEqual(replaced, true, 'precondition: the replacement happened during the park');
      // One budget spend, then the refusal: a process that is making progress is
      // waited out once and never swept away over the rest of the budget.
      assertParkedSchedule(parks.calls, [0], 'the one spend before the replacement was seen');
      // readdirSync is the existence check: if this side swept the rival's directory
      // and recreated its own, the call either throws ENOENT or reports the record it
      // just wrote. Either way the listing below is the assertion that the replacement
      // survived untouched, so no separate existsSync line is needed.
      assert.deepStrictEqual(
        fs.readdirSync(fx.lockDir),
        [] as string[],
        "the rival's directory must survive, empty and with nothing written into it"
      );
    } finally {
      fx.dispose();
    }
  });

  test('createLock has exactly one parking primitive and never waits on a timer (#539)', () => {
    // The "must never park" assertions in this file spy `Atomics.wait`, which is only
    // sound while that stays the module's sole way to wait: a future `await sleep` on a
    // timer would never touch the spy, and those absence checks would pass without
    // noticing the path now waits. Forbidding the alternative is what keeps them from
    // being vacuous (ADR-0026). Counted with the call parenthesis so prose about the
    // primitive in a doc comment does not register as a use of it.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage', 'lock.ts'), 'utf8');
    const occurrences = (needle: string): number => source.split(needle).length - 1;

    assert.strictEqual(occurrences('Atomics.wait('), 1, 'the module must park in exactly one place');
    for (const timer of ['setTimeout(', 'setImmediate(', 'waitAsync(']) {
      assert.strictEqual(occurrences(timer), 0, `${timer} must not become a parking primitive`);
    }
    // `setInterval` is the heartbeat, which runs while a lock is *held*, not while one
    // is being acquired — so a count of one is the bound, not a tolerance.
    assert.strictEqual(occurrences('setInterval('), 1, 'setInterval belongs to the heartbeat alone');
  });

  test('only Windows treats EPERM/EBUSY as a transient handle (INV-09)', () => {
    // The retry arm is only reachable on Windows, so a platform-independent pin of the
    // rule is what keeps the decision covered on Linux and macOS. On POSIX the same
    // codes are a permission or mount problem, and spending ~950ms of budget on one
    // would delay the real error for a condition no wait can fix.
    assert.strictEqual(isTransientHandleCode('EPERM', 'win32'), true);
    assert.strictEqual(isTransientHandleCode('EBUSY', 'win32'), true);

    for (const other of ['EACCES', 'ENOTEMPTY', 'ENOENT', 'EISDIR', 'ELOOP', undefined]) {
      assert.strictEqual(
        isTransientHandleCode(other, 'win32'),
        false,
        `${String(other)} is not a transient handle on win32`
      );
    }
    for (const platform of ['linux', 'darwin', 'freebsd', 'aix'] as const) {
      for (const code of ['EPERM', 'EBUSY'] as const) {
        assert.strictEqual(
          isTransientHandleCode(code, platform),
          false,
          `${code} on ${platform} is permanent, not transient`
        );
      }
    }
  });

  test('the conflict createLock throws is classified as exit 4 (INV-04)', { timeout: 10000 }, async () => {
    // `test/cli-exit-codes.test.ts` pins the classifier against a synthetic
    // `{ code: 'ECONFLICT' }`, which proves the mapping but not that a real conflict
    // reaches it. This closes the last link in the chain a script depends on: the
    // object this module actually throws, through `isConflictError`, to exit 4.
    const fx = residueVault('exit4', lockDir => {
      fs.writeFileSync(path.join(lockDir, 'held.txt'), 'held', 'utf8');
    });
    refuseUnlink(fx, fx.entry('held.txt'));
    watchParks(fx); // spied, so the budget costs no wall clock here.
    const acquirer = fx.hold(fx.newLock());

    try {
      const thrown = await acquirer.acquire().then(
        () => {
          throw new Error('acquisition must have been refused');
        },
        (err: unknown) => err
      );
      assert.strictEqual(isConflictError(thrown), true, 'isConflictError must recognise the real error');
      assert.strictEqual(exitCodeFor(thrown), ExitCode.Conflict, 'and the classifier must land on exit 4');
    } finally {
      fx.dispose();
    }
  });

  test('stale recovery quarantines the old record before creating the new lock (INV-06)', { timeout: 10000 }, async () => {
    // INV-06 says a takeover quarantines before it creates. Prose is not a proof: this
    // records the order the syscalls actually ran in, so a recovery that deleted first
    // and created second would fail here even though the end state looks identical.
    const staleId = 'L-20260101T000000-cafebabe';
    const fx = residueVault('quarantine', (lockDir, target) => {
      const record = {
        lock_id: staleId,
        target,
        pid: 999999,
        hostname: 'not-this-host',
        created_at: new Date(0).toISOString()
      };
      fs.writeFileSync(path.join(lockDir, `${staleId}.json`), JSON.stringify(record, null, 2), 'utf8');
    });
    agePastStale(fx.entry(`${staleId}.json`));

    const events: string[] = [];
    recordCalls(fx, 'mkdirSync', events, args => args[0] === fx.lockDir, () => 'mkdir');
    recordCalls(
      fx,
      'renameSync',
      events,
      args => args[0] === fx.entry(`${staleId}.json`),
      args => `rename→${path.basename(String(args[1]))}`
    );

    const acquirer = fx.hold(fx.newLock());
    try {
      await acquirer.acquire();

      const quarantinedAt = events.findIndex(event => event.endsWith('.quarantine'));
      const createdAfterAt = events.lastIndexOf('mkdir');
      assert.notStrictEqual(
        quarantinedAt,
        -1,
        `recovery must quarantine the stale record; saw ${events.join(' → ')}`
      );
      assert.notStrictEqual(createdAfterAt, -1, `recovery must re-create the directory; saw ${events.join(' → ')}`);
      assert.ok(
        quarantinedAt < createdAfterAt,
        `the record must be quarantined before the new lock directory exists; saw ${events.join(' → ')}`
      );

      const records = fs.readdirSync(fx.lockDir).filter(name => name.endsWith('.json'));
      assert.strictEqual(records.length, 1, `the takeover must leave exactly one record, saw ${records.join(', ')}`);
      assert.notStrictEqual(records[0], `${staleId}.json`, 'and it must be the new holder’s, not the stale one');
    } finally {
      fx.dispose();
    }
  });

  test('validates Windows specific stale lock timing behavior', { skip: process.platform !== 'win32' }, async () => {
    const lock1 = new Lock(testVaultPath, testFilePath);
    await lock1.acquire();
    const lock2 = new Lock(testVaultPath, testFilePath);

    try {
      const lockPath = lock1.lockPath;
      const files = fs.readdirSync(lockPath).filter(f => f.endsWith('.json'));
      const [lockFileName] = files;
      assert.ok(lockFileName !== undefined);
      const lockFile = path.join(lockPath, lockFileName);
      
      // Stop the heartbeat so it doesn't refresh concurrently with our manual aging
      clearInterval((lock1 as any).heartbeatTimer);

      // Set exactly to 59 seconds ago (just under Windows 60s timeout)
      const activeTime = new Date(Date.now() - 59000);
      fs.utimesSync(lockFile, activeTime, activeTime);

      // Should still fail with ECONFLICT because it hasn't reached 60s
      await assert.rejects(
        async () => await lock2.acquire(),
        { code: 'ECONFLICT' }
      );

      // Now set exactly to 61 seconds ago (just over Windows 60s timeout)
      const staleTime = new Date(Date.now() - 61000);
      fs.utimesSync(lockFile, staleTime, staleTime);

      // Should succeed because it exceeded 60s
      await assert.doesNotReject(
        async () => await lock2.acquire()
      );
    } finally {
      lock1.release();
      lock2.release();
    }
  });
});
