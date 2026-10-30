/**
 * File Locking System with Heartbeat & Stale Lock Recovery
 *
 * @remarks
 * Provides safe cross-process mutex synchronization for file mutations across POSIX and Windows.
 *
 * Design features:
 * - **Atomic Directory Acquisition**: Uses `mkdir` atomic primitives to avoid Time-of-Check-to-Time-of-Use (TOCTOU) races.
 * - **Session-Specific JSON Locks**: Records holder PID, timestamp, and hostname inside the lock directory.
 * - **Liveness Heartbeat**: Updates lock file timestamps (`mtime`) every 15 seconds.
 * - **Platform-Aware Stale Recovery**: Automatically quarantines and reclaims locks after 60s on Windows or 120s on other OSes.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { assertContainedInVault } from './containment';
import { LockData, NodeError } from '../types';

/**
 * Interval in milliseconds (15,000 ms) at which {@link Lock.startHeartbeat}
 * touches the held lock file's `mtime` to advertise liveness, keeping other
 * processes from reclaiming the lock as stale while this process still holds it.
 *
 * @remarks Module-private: consumed by the heartbeat timer in {@link Lock} and
 * by the storage-lock tests. Not re-exported on the public storage barrel per
 * the #131 census.
 */
const HEARTBEAT_INTERVAL = 15000;
/** Stale lock expiration timeout in milliseconds for Windows environments (60,000 ms) */
const STALE_TIMEOUT_WINDOWS = 60000;
/** Stale lock expiration timeout in milliseconds for POSIX/macOS environments (120,000 ms) */
const STALE_TIMEOUT_OTHER = 120000;

/**
 * Age in milliseconds past a lock file's last heartbeat after which the lock is
 * considered stale and eligible for takeover: 60,000 ms on Windows, 120,000 ms
 * on POSIX/macOS. Consulted by {@link isLockStale} and by the stale-lock
 * quarantine/cleanup inside {@link createLock}.
 *
 * @remarks Module-private: consumed internally and by the storage-lock tests.
 * Not re-exported on the public storage barrel per the #131 census.
 */
const STALE_TIMEOUT = process.platform === 'win32' ? STALE_TIMEOUT_WINDOWS : STALE_TIMEOUT_OTHER;

/**
 * Bounded retry parameters for Windows EPERM/EBUSY transient handle-holders on
 * the lock directory. Mirrors `src/storage/atomic-write.ts:20-24` so a persistent
 * handle surfaces to the caller rather than hanging the CLI in a busy spin.
 *
 * @remarks
 * Only `WINDOWS_RETRY_ATTEMPTS` is Windows-specific. The four delay parameters are
 * the module's one backoff policy and are shared with the `ENOTEMPTY` budget below,
 * so a lock directory cannot be retried on two different schedules.
 */
const WINDOWS_RETRY_ATTEMPTS = 5;
const WINDOWS_RETRY_INITIAL_DELAY = 50; // ms
const WINDOWS_RETRY_MULTIPLIER = 2;
const WINDOWS_RETRY_JITTER = 0.25; // ±25%
const WINDOWS_RETRY_MAX_DELAY = 300; // ms

/**
 * Retry budget for the `ENOTEMPTY` answer from `fs.rmdirSync` on a stale lock
 * directory.
 *
 * @remarks
 * `ENOTEMPTY` after the sweep means an entry survived it — a file another process
 * still holds open, or a subdirectory this module never creates — so the directory
 * cannot become empty on its own. Before #539 this case shared the unconditional
 * `continue` with `ENOENT`, which is why one un-removable entry spun the acquisition
 * loop at 100% CPU for as long as the entry lived.
 *
 * Five retries are made *after* the first attempt, so one removal costs at most six
 * `rmdirSync` calls and ~950 ms of parked time. Deliberately not one: when a rival
 * merely won the directory between our `readdirSync` and our `rmdirSync`, the next
 * round sees its fresh record and throws the precise "locked by PID" conflict
 * instead of this one.
 *
 * Module-private: consumed by {@link createLock}, and mirrored numerically by the
 * storage-lock tests the way they already mirror `WINDOWS_RETRY_ATTEMPTS`. Not
 * exported on the public storage barrel per the #131 census.
 */
const ENOTEMPTY_RETRY_ATTEMPTS = 5;

/**
 * Hard bound on the rounds {@link createLock}'s acquisition loop may run.
 *
 * @remarks
 * A backstop, not a contention policy. The budget above bounds the only branch that
 * cannot observe a state change; this cap makes termination a property of the code
 * rather than an argument about which branch may `continue`. A legitimate
 * acquisition needs one round (uncontended), one (a live holder, which throws), or
 * two (quarantine, then reclaim), so twenty is an order of magnitude of headroom.
 *
 * Must stay greater than {@link ENOTEMPTY_RETRY_ATTEMPTS} + 1, or the outer bound
 * pre-empts the budget and blames churn for an entry that never cleared.
 */
const MAX_ACQUISITION_ITERATIONS = 20;

/**
 * Synchronous non-spinning sleep primitive used by the lock acquisition retry loop.
 *
 * @param ms - Number of milliseconds to wait
 * @returns Void
 *
 * @remarks
 * `createLock` is synchronous and runs on the lock-acquisition hot path, so we
 * cannot yield to the event loop (no `await setTimeout`). `Atomics.wait`
 * parks the thread for the requested duration instead of spinning on a
 * wall-clock poll — Node.js permits it on the main thread (unlike browsers),
 * so the wait is blocking but consumes no CPU. The caller already caps the
 * delay at `WINDOWS_RETRY_MAX_DELAY` (300 ms) per `atomicWrite` precedent.
 *
 * @example
 * ```typescript
 * SyncWait.sleepMs(75);
 * ```
 */
const SyncWait = {
  sleepMs(ms: number): void {
    if (ms <= 0) return;
    // Blocking wait without CPU spin. createLock is sync, so we cannot yield
    // to the event loop; Atomics.wait parks the thread instead of spinning.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

interface ParsedLock {
  filename: string;
  data: LockData | null;
  mtime: number;
}

/**
 * Generates a unique lock identifier string with timestamp and random entropy.
 *
 * @returns Lock ID in format `L-YYYYMMDDTHHMMSS-XXXXXXXX`
 *
 * @remarks
 * Uses ISO timestamp segments and 4 bytes of random hex entropy. The id names the
 * acquisition's own file inside the lockdir and `releaseLock` unlinks exactly that
 * file, so two acquisitions in the same second drawing the same entropy would let
 * one process delete another's live lock — the precise failure the lockdir exists
 * to prevent. `generateSessionId` and `generateDraftId` draw the same width.
 *
 * @example
 * ```typescript
 * const lockId = generateLockId(); // "L-20260830T120000-abcd1234"
 * ```
 */
function generateLockId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const random = crypto.randomBytes(4).toString('hex');
  return `L-${timestamp}-${random}`;
}

/**
 * Derives the canonical lock directory path in `.palee/locks/` corresponding to a target file.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param targetPath - Absolute or relative path to the file to lock
 * @returns Path to the hashed `.lockdir` directory
 *
 * @remarks
 * Uses SHA-256 hash of relative vault target path to construct a deterministic lockdir directory.
 *
 * @example
 * ```typescript
 * const lockDir = getLockDir('/vault', '/vault/notes/topic.md');
 * ```
 */
function getLockDir(vaultPath: string, targetPath: string): string {
  let resolvedTarget = targetPath;
  try {
    if (fs.existsSync(targetPath)) {
      resolvedTarget = fs.realpathSync(targetPath);
    } else {
      const dir = fs.realpathSync(path.dirname(targetPath));
      resolvedTarget = path.join(dir, path.basename(targetPath));
    }
  } catch {
    // Fallback if directory also doesn't exist
  }
  
  let resolvedVault = vaultPath;
  try {
    resolvedVault = fs.realpathSync(vaultPath);
  } catch {}

  const relativePath = path.relative(resolvedVault, resolvedTarget).replace(/\\/g, '/');
  const hash = crypto.createHash('sha256').update(relativePath, 'utf8').digest('hex');
  // Anchored once, like `getPaleeDir`: with a relative `vaultPath` the joined
  // string is relative, and the assertion below resolves a relative destination
  // *against the vault* — it would certify `<vault>/<vault>/.palee/locks` while
  // the `mkdirSync` created `<vault>/.palee/locks` through a planted link.
  const locksDir = path.resolve(vaultPath, '.palee', 'locks');
  // The lock tree hangs off the vault root, not off the destination, so the
  // containment assertion in `atomicWrite` cannot speak for it: with `.palee`
  // itself planted as a junction, an in-vault note would still file its
  // `.lockdir` outside the vault (#264). Checked before the `mkdir`, so the
  // refusal creates nothing rather than creating first and complaining after.
  assertContainedInVault(vaultPath, locksDir);
  fs.mkdirSync(locksDir, { recursive: true });
  return path.join(locksDir, `${hash}.lockdir`);
}

/**
 * Checks whether an existing lock descriptor is stale and eligible for recovery.
 *
 * @param lockInfo - Parsed lock record
 * @returns `true` if lock has expired and is eligible for stale recovery, otherwise `false`
 *
 * @remarks
 * Two independent staleness signals are applied:
 * 1. **Same-host dead-process reclaim**: when the lock records this machine's
 *    hostname, the holding PID is probed with `process.kill(pid, 0)`. A dead
 *    PID (`ESRCH`) means the holder crashed without releasing, so the lock is
 *    reclaimable immediately rather than waiting out {@link STALE_TIMEOUT}. A
 *    live PID — including `EPERM`, meaning the process exists but is owned by
 *    another user — is treated as alive and falls through to the timeout check.
 * 2. **Timeout fallback**: compares current epoch milliseconds against the lock
 *    file modification time (`mtime`). Used for cross-host or unknown-host
 *    locks where PID liveness cannot be checked meaningfully.
 *
 * @example
 * ```typescript
 * const stale = isLockStale(parsedLock);
 * ```
 */
function isLockStale(lockInfo: ParsedLock): boolean {
  if (lockInfo.mtime === 0) return true; // File disappeared mid-read

  // Same-host liveness probe. Only meaningful when the lock was written on this
  // machine — a PID on a different host says nothing about our process table.
  const data = lockInfo.data;
  if (data && typeof data.pid === 'number' && data.pid > 0 && data.hostname === os.hostname()) {
    try {
      // Signal 0 runs the kernel's existence/permission checks without
      // delivering a signal. No throw => the process is alive.
      process.kill(data.pid, 0);
    } catch (e: unknown) {
      const code = (e as NodeError).code;
      // ESRCH: no such process — holder is dead, reclaim immediately (#369).
      if (code === 'ESRCH') return true;
      // EPERM (or any other error): process exists but is owned by another
      // user, so it is alive. Fall through to the timeout-based path.
    }
  }

  const now = Date.now();
  return now - lockInfo.mtime > STALE_TIMEOUT;
}

/**
 * Builds the retryable conflict error every lock-contention path throws.
 *
 * @param detail - What the conflict is, after the `Lock conflict: ` prefix
 * @returns The error to throw, carrying `code = 'ECONFLICT'`
 *
 * @remarks
 * The prefix is how {@link isConflictError} recognises the error by text as well as
 * by code, and `exitCodeFor` maps the code to exit 4 (INV-04). One builder so a new
 * contention path cannot invent a wording that exits 5 by accident.
 */
function lockConflict(detail: string): NodeError {
  const conflictErr = new Error(`Lock conflict: ${detail}`) as NodeError;
  conflictErr.code = 'ECONFLICT';
  return conflictErr;
}

/**
 * Whether a lock directory entry that `fs.unlinkSync` refused is a directory.
 *
 * @param entryPath - The entry that could not be unlinked
 * @returns `true` when it is a directory, `false` when it is a file or could not be
 * inspected
 *
 * @remarks
 * The distinction decides whether waiting can help: a file another process holds
 * open clears on its own, a directory inside a lockdir never does. `unlink` reports
 * `EISDIR` on POSIX and `EPERM` on Windows, which collides with the *transient*
 * `EPERM` of a held-open file — one `lstat` on this failure path separates them. The
 * probe is best-effort: an `lstatSync` that itself fails reports "not a directory",
 * so a vanished or unreadable entry falls back to the bounded retry rather than
 * being misdiagnosed as permanent.
 */
function isDirectoryEntry(entryPath: string): boolean {
  try {
    return fs.lstatSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Renders a lock directory entry name with its control characters escaped.
 *
 * @param name - A directory entry name read from the lock directory
 * @returns The name with every C0 control character and DEL spelled as `\xNN`
 *
 * @remarks
 * Entry names reach human-readable errors and captured logs verbatim, and POSIX
 * allows a newline or an ANSI escape sequence inside a filename — so an unescaped
 * name could forge, hide or recolor the lines around the conflict it appears in.
 * Escaping keeps the residue identifiable while making the text safe to print.
 * Windows refuses these names outright, so this only ever matters on POSIX and
 * costs nothing where it does not.
 */
function printableEntryName(name: string): string {
  let rendered = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    rendered += code < 0x20 || code === 0x7f
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : ch;
  }
  return rendered;
}

/**
 * Spends one unit of the `ENOTEMPTY` budget, parking before the next attempt.
 *
 * @param attempts - Attempts already spent before this one
 * @param targetPath - The note whose lock could not be taken
 * @param residual - Entries the round observed and could not remove
 * @returns The number of attempts now spent
 * @throws {NodeError} `ECONFLICT` once the budget is spent
 *
 * @remarks
 * Shared by the direct `rmdirSync` branch and by the Windows retry loop so the
 * counter and the park cannot diverge. The retry loop used to treat `ENOTEMPTY` as
 * free forward progress, which left the budget unreachable on that path and let the
 * loop cap report churn for what was really a stuck entry. Every call parks, so the
 * caller never re-runs an identical sweep at full CPU.
 */
function spendEnotemptyBudget(attempts: number, targetPath: string, residual: string[]): number {
  const spent = attempts + 1;
  if (spent > ENOTEMPTY_RETRY_ATTEMPTS) {
    const still = residual.length > 0
      ? residual.map(entry => printableEntryName(entry)).join(', ')
      : 'nothing listable';
    throw lockConflict(
      `${targetPath} has a lock directory that would not empty after `
      + `${ENOTEMPTY_RETRY_ATTEMPTS} retries; still present: ${still}`
    );
  }
  // Same ±25% jitter and 300 ms ceiling the module already uses, so two processes
  // clearing one directory do not wake in lockstep.
  const baseDelay = WINDOWS_RETRY_INITIAL_DELAY * Math.pow(WINDOWS_RETRY_MULTIPLIER, spent - 1);
  const jitterAmount = baseDelay * WINDOWS_RETRY_JITTER;
  SyncWait.sleepMs(
    Math.max(
      0,
      Math.min(
        WINDOWS_RETRY_MAX_DELAY,
        baseDelay + (Math.random() * 2 - 1) * jitterAmount
      )
    )
  );
  return spent;
}

/**
 * Attempts atomic creation of the lock directory and writes the session lock data.
 *
 * @param lockDir - Target lock directory path
 * @param targetPath - Absolute path to the protected file
 * @returns {@link LockData} on successful acquisition
 * @throws {NodeError} If lock is currently held by an active live process (`ECONFLICT`)
 *
 * @remarks
 * Employs atomic `mkdir` mutex semantics with stale lock quarantine and recovery.
 *
 * @example
 * ```typescript
 * const lockData = createLock('/vault/.palee/locks/hash.lockdir', '/vault/topic.md');
 * ```
 */
function createLock(lockDir: string, targetPath: string): LockData {
  const lockId = generateLockId();
  const now = new Date().toISOString();
  const lockData: LockData = {
    lock_id: lockId,
    target: targetPath,
    pid: process.pid,
    hostname: os.hostname(),
    created_at: now,
  };

  const lockFile = path.join(lockDir, `${lockId}.json`);

  // Bounds the one `continue` below that cannot observe a state change (#539).
  let enotemptyAttempts = 0;

  for (let iteration = 0; iteration < MAX_ACQUISITION_ITERATIONS; iteration++) {
    try {
      fs.mkdirSync(lockDir);
      // We won the lock directory! Write our session file.
      try {
        fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf8');
      } catch (writeErr: unknown) {
        if ((writeErr as NodeError).code === 'ENOENT') {
          // Directory was removed before we could write!
          continue;
        }
        throw writeErr;
      }
      return lockData;
    } catch (e: unknown) {
      const err = e as NodeError;
      if (err.code !== 'EEXIST') throw err;

      // The lock directory exists. We must inspect it to see if we can recover it.
      let files: string[];
      try {
        files = fs.readdirSync(lockDir);
      } catch (readErr: unknown) {
        if ((readErr as NodeError).code === 'ENOENT') continue; // Someone deleted it, retry mkdir
        throw readErr;
      }

      const activeFiles = files.filter(f => f.endsWith('.json'));

      // Check all active lock files (usually just 1)
      const parsedLocks: ParsedLock[] = activeFiles.map(f => {
        const filePath = path.join(lockDir, f);
        try {
          const stats = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf8');
          return { filename: f, data: JSON.parse(content) as LockData, mtime: stats.mtimeMs };
        } catch {
          try {
            return { filename: f, data: null, mtime: fs.statSync(filePath).mtimeMs };
          } catch {
            return { filename: f, data: null, mtime: 0 };
          }
        }
      });

      const freshLocks = parsedLocks.filter(l => !isLockStale(l));
      if (freshLocks.length > 0) {
        // A fresh lock always conflicts; the throw is unconditional so a
        // narrowing miss can never fall through to acquiring the lock.
        // `length > 0` guarantees `first` exists; optional chaining keeps
        // the type honest without a non-null assertion.
        const first = freshLocks[0];
        const active = first?.data;
        throw lockConflict(`${targetPath} is locked by PID ${active?.pid || 'unknown'}`);
      }

      // The 5s heuristic answers one question: is this directory young and *empty*,
      // meaning a rival created it and has not written its record yet? Emptiness is
      // the load-bearing half — it is also the only state in which the `rmdirSync`
      // below would succeed and take a rival's directory out from under it, letting
      // both writers end up holding.
      //
      // A directory holding anything therefore never counts as an incoming process:
      // the residue this module is trying to clear is not a rival, and our own sweep
      // stamps the directory mtime this check would otherwise read.
      if (files.length === 0) {
        let incomingConflict = false;
        try {
          const dirStat = fs.statSync(lockDir);
          if (Date.now() - dirStat.mtimeMs < 5000) {
            incomingConflict = true;
          }
        } catch {}
        
        if (incomingConflict) {
          throw lockConflict(`${targetPath} is locked by an incoming process`);
        }
      }

      // If we reach here, the directory exists but ALL active locks (if any) are stale!
      // We must clean up the stale directory to reset the state.
      // We only attempt to delete the exact files we observed in this iteration.
      for (const file of files) {
        const filePath = path.join(lockDir, file);
        if (!file.endsWith('.json')) {
          try {
            fs.unlinkSync(filePath);
          } catch {
            // A directory is permanent: this module only ever writes files into a
            // lockdir, so one here is foreign residue and `rmdirSync` will answer
            // ENOTEMPTY for it forever. Parking cannot change that, so name it and
            // refuse now instead of spending the retry budget first (#539).
            if (isDirectoryEntry(filePath)) {
              throw lockConflict(
                `${targetPath} has a lock directory holding an unremovable entry: ${printableEntryName(file)}`
              );
            }
          }
          continue;
        }
        const quarantinePath = filePath + '.quarantine';
        try {
          // Rename acts as an atomic test-and-set to prevent Process B from renewing
          // a lock we are about to delete.
          fs.renameSync(filePath, quarantinePath);
          const stats = fs.statSync(quarantinePath);
          // Re-confirm staleness on the quarantined copy using the SAME combined
          // predicate as the conflict gate above: a dead same-host PID (ESRCH)
          // is stale regardless of mtime (#369), otherwise fall back to the
          // STALE_TIMEOUT age check. Using the raw timeout alone here would
          // restore — and spin on — a fresh-mtime lock whose holder is dead.
          const parsed = parsedLocks.find(l => l.filename === file);
          if (isLockStale({ filename: file, data: parsed?.data ?? null, mtime: stats.mtimeMs })) {
            fs.unlinkSync(quarantinePath);
          } else {
            // It was refreshed (or its holder is alive) before we renamed it! Restore it.
            fs.renameSync(quarantinePath, filePath);
          }
        } catch {}
      }

      try {
        fs.rmdirSync(lockDir);
      } catch (rmErr: unknown) {
        const rmCode = (rmErr as NodeError).code;
        // ENOENT: someone else already removed the directory. The one remaining
        // unconditional `continue` — it reports that the state changed, and the next
        // `mkdirSync` either wins the directory or answers EEXIST with a fresh
        // record to throw on.
        if (rmCode === 'ENOENT') {
          continue;
        }
        // ENOTEMPTY: something survived the sweep above, and re-running the same
        // removals immediately reproduces the same result — at 100% CPU, forever,
        // which is the hang this branch used to cause (#539). A rival that merely
        // won the directory between our readdir and this rmdir resolves on the next
        // round, because its fresh record throws the precise "locked by PID"
        // conflict; a persistent entry is surfaced after the budget as the same
        // retryable conflict class the EPERM/EBUSY path below belongs to.
        if (rmCode === 'ENOTEMPTY') {
          enotemptyAttempts = spendEnotemptyBudget(enotemptyAttempts, targetPath, files);
          continue;
        }
        // Windows EPERM/EBUSY: AV/indexer/another process briefly holds a
        // handle on the lock directory. Bounded retry with exponential
        // backoff and ±25% jitter, mirroring the policy in
        // `src/storage/atomic-write.ts` (constants on lines 20-24) so a
        // persistent handle surfaces to the caller rather than spinning the
        // CLI at 100% CPU in a busy loop. createLock is synchronous, so we
        // busy-wait on a wall clock instead of yielding the event loop.
        if (process.platform === 'win32' && (rmCode === 'EPERM' || rmCode === 'EBUSY')) {
          // `exhausted` stays true only when every attempt hit a transient
          // EPERM/EBUSY. Success and forward-progress outcomes (ENOTEMPTY/
          // ENOENT) must fall through to re-acquisition even on the final
          // attempt — inferring the outcome from the attempt count alone
          // would rethrow a recovered lock.
          let exhausted = true;
          for (let attempts = 0; attempts < WINDOWS_RETRY_ATTEMPTS; attempts++) {
            const baseDelay = WINDOWS_RETRY_INITIAL_DELAY * Math.pow(WINDOWS_RETRY_MULTIPLIER, attempts);
            const jitterAmount = baseDelay * WINDOWS_RETRY_JITTER;
            const delay = Math.max(
              0,
              Math.min(
                WINDOWS_RETRY_MAX_DELAY,
                baseDelay + (Math.random() * 2 - 1) * jitterAmount
              )
            );
            SyncWait.sleepMs(delay);
            try {
              fs.rmdirSync(lockDir);
              // Removal succeeded after a transient handle cleared: fall
              // through to the post-rmdir acquisition loop below.
              exhausted = false;
              break;
            } catch (retryErr: unknown) {
              const retryCode = (retryErr as NodeError).code;
              if (retryCode === 'ENOENT') {
                // Forward-progress condition; let the outer loop handle it.
                exhausted = false;
                break;
              }
              if (retryCode === 'ENOTEMPTY') {
                // The same residue the direct branch reports. Spending the shared
                // budget here is what keeps this path from reaching ENOTEMPTY for
                // free on every round and letting the loop cap blame churn (#539).
                enotemptyAttempts = spendEnotemptyBudget(enotemptyAttempts, targetPath, files);
                exhausted = false;
                break;
              }
              if (retryCode !== 'EPERM' && retryCode !== 'EBUSY') throw retryErr;
              // Still a transient handle; loop until the budget is spent.
            }
          }
          if (exhausted) {
            // Budget exhausted: rethrow the original EPERM/EBUSY so a
            // persistent handle surfaces to the caller as a real error
            // rather than a hang. This exits 5, not the 4 INV-09 promises for a
            // persistent lock; closing that gap moves an assertion the storage
            // tests pin on purpose, so it is tracked separately (ADR-0036).
            throw rmErr;
          }
          continue;
        }
        throw rmErr;
      }

      // Successfully removed the stale lock directory! 
      // Restart the loop to attempt mkdirSync acquisition.
      continue;
    }
  }

  // Every round either took the lock, threw, or made forward progress the next
  // round could act on. Only a process that keeps deleting the directory we are
  // about to create reaches this — contention, not corruption, so it is the same
  // retryable conflict class as every other (#539).
  throw lockConflict(
    `${targetPath} did not settle after ${MAX_ACQUISITION_ITERATIONS} acquisition attempts; `
    + 'another process keeps changing its lock directory'
  );
}

/**
 * Updates the lock file modification timestamp to maintain liveness.
 *
 * @param lockDir - Lock directory path
 * @param expectedLockId - Lock ID held by this process
 * @returns `'held'` while this process still owns the lock, `'lost'` once its own lock
 * record is gone — meaning a stale takeover quarantined it and another process holds the
 * lock now (#334)
 *
 * @remarks
 * Touches `mtime` using `fs.utimesSync` without modifying file content.
 *
 * `ENOENT` on our own record is the takeover signal, and the only one available: the
 * quarantine renames `<lockId>.json` to `<lockId>.json.quarantine` and then deletes it,
 * so the path this holder renews no longer exists. Any other failure is a transient
 * error and reports `'held'` — one failed `utimes` on a live record must not abdicate
 * the lock, or a brief `EPERM` from an antivirus handle would turn a healthy holder into
 * a self-evicted one and hand the target to the next process.
 *
 * @example
 * ```typescript
 * updateHeartbeat('/vault/.palee/locks/hash.lockdir', 'L-1');
 * ```
 */
function updateHeartbeat(lockDir: string, expectedLockId: string): 'held' | 'lost' {
  const lockFile = path.join(lockDir, `${expectedLockId}.json`);
  try {
    const now = new Date();
    // utimesSync updates mtime/atime natively without modifying file contents.
    // Throws ENOENT if file was quarantined (unlinked) by a stale takeover.
    fs.utimesSync(lockFile, now, now);
    return 'held';
  } catch (e: unknown) {
    // ENOENT: our record is gone, so this process no longer holds the lock (#334).
    // Anything else says nothing about ownership.
    return (e as NodeError).code === 'ENOENT' ? 'lost' : 'held';
  }
}

/**
 * Releases a held lock by removing its session file and attempting rmdir on the lock directory.
 *
 * @param lockDir - Lock directory path
 * @param expectedLockId - Lock ID held by this process
 * @returns Void
 *
 * @remarks
 * Unlinks the lock session JSON and removes the parent lockdir if empty.
 *
 * @example
 * ```typescript
 * releaseLock('/vault/.palee/locks/hash.lockdir', 'L-1');
 * ```
 */
function releaseLock(lockDir: string, expectedLockId: string): void {
  const lockFile = path.join(lockDir, `${expectedLockId}.json`);
  try {
    // Delete our specific session file. If someone else took over, they unlinked it.
    // We catch ENOENT safely.
    fs.unlinkSync(lockFile);
  } catch {}

  try {
    // Only removes the directory if it's completely empty.
    // If someone else took over, they created a new session file, so this fails with ENOTEMPTY.
    // This perfectly prevents deleting another writer's lock.
    fs.rmdirSync(lockDir);
  } catch {}
}

/**
 * Mutual exclusion lock controller managing lock acquisition, background heartbeat renewal, and release.
 *
 * @remarks
 * Ensures exclusive access to file modifications using atomic directory primitives and heartbeat renewals.
 *
 * @example
 * ```typescript
 * const lock = new Lock('/path/to/vault', '/path/to/vault/notes/topic.md');
 * await lock.acquire();
 * try {
 *   // perform safe atomic writes
 * } finally {
 *   lock.release();
 * }
 * ```
 */
class Lock {
  private targetPath: string;
  /** Directory path where the lock files reside */
  readonly lockPath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private lockData: LockData | null = null;
  /**
   * Set by the heartbeat when this process's own lock record has disappeared — another
   * process treated the lock as stale, quarantined it, and holds the target now (#334).
   * Read through {@link Lock.lockLost}.
   */
  private lostLock = false;

  /**
   * Whether this lock has been taken over since it was acquired.
   *
   * @remarks
   * The heartbeat used to swallow the takeover silently: the interval kept firing, the
   * dead record stayed in place, and a holder that had lost the target went on writing
   * as if it still owned it. The flag is the answer to "do I still hold it?" — a holder
   * that spans more than one heartbeat can check it before doing anything that assumes
   * exclusivity.
   *
   * @example
   * ```typescript
   * if (lock.lockLost) throw new Error('lost the target, reload and retry');
   * ```
   */
  get lockLost(): boolean {
    return this.lostLock;
  }

  /**
   * Initializes a Lock instance for a target file.
   *
   * @param vaultPath - Vault root path
   * @param targetPath - File path to lock
   *
   * @remarks
   * Computes hashed lock directory inside `.palee/locks/`.
   *
   * @example
   * ```typescript
   * const lock = new Lock('/vault', '/vault/notes/note.md');
   * ```
   */
  constructor(vaultPath: string, targetPath: string) {
    this.targetPath = targetPath;
    this.lockPath = getLockDir(vaultPath, targetPath);
    this.heartbeatTimer = null;
  }

  /**
   * Acquires the lock and starts the background heartbeat timer.
   *
   * @returns Promise resolving on successful acquisition
   * @throws {NodeError} If the lock is held by another active process (`ECONFLICT`)
   *
   * @remarks
   * Acquires directory lock atomically and starts 15-second heartbeat timer.
   *
   * @example
   * ```typescript
   * await lock.acquire();
   * ```
   */
  async acquire(): Promise<void> {
    this.lockData = createLock(this.lockPath, this.targetPath);
    // A fresh record means a fresh claim: clear the loss the previous hold observed.
    this.lostLock = false;
    this.startHeartbeat();
  }

  /**
   * Initiates periodic heartbeat timer that touches the lock file mtime.
   *
   * @returns Void
   *
   * @remarks
   * Spawns an unreferenced interval that updates heartbeat every 15,000ms.
   *
   * A touch that finds its own record gone (`'lost'`) is a takeover, and the holder
   * abdicates rather than carrying on as the lock's owner: the timer stops, the dead
   * record is dropped so {@link release} cannot touch the new holder's directory, and
   * {@link Lock.lockLost} goes true for the holder to query (#334). The comment that
   * claimed "we lost the lock. Stop updating" did none of that until now — it is the
   * detectability half of #334, not its prevention half: a holder suspended long enough
   * to be reclaimed can still be mid-rename when it resumes, and no heartbeat state can
   * close that window from JS.
   *
   * @example
   * ```typescript
   * lock.startHeartbeat();
   * ```
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const timer = setInterval(() => {
      if (this.lockData) {
        if (updateHeartbeat(this.lockPath, this.lockData.lock_id) === 'lost') {
          this.lostLock = true;
          this.lockData = null;
          clearInterval(timer);
          this.heartbeatTimer = null;
        }
      }
    }, HEARTBEAT_INTERVAL);
    this.heartbeatTimer = timer;
    timer.unref();
  }

  /**
   * Releases the acquired lock and terminates the background heartbeat timer.
   *
   * @returns Void
   *
   * @remarks
   * Stops interval timer and removes session file from disk.
   *
   * A holder whose lock was already reclaimed (#334) has dropped its record, so release
   * is a no-op by design: it must not unlink or `rmdir` a lock directory the takeover now
   * owns. `releaseLock` guarded against that by id anyway; clearing the state on loss
   * removes the chance entirely.
   *
   * @example
   * ```typescript
   * lock.release();
   * ```
   */
  release(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.lockData) {
      releaseLock(this.lockPath, this.lockData.lock_id);
    }
  }
}

export {
  Lock,
  HEARTBEAT_INTERVAL,
  STALE_TIMEOUT,
};
