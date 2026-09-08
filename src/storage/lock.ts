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
import { LockData, NodeError } from '../types';

/**
 * Interval in milliseconds (15,000 ms) between periodic heartbeat mtime updates.
 *
 * @remarks Internal lock tuning parameter. Removed from the public storage barrel per the #131 census (zero runtime consumers, no reservations); module-private export used internally and by storage-lock tests.
 */
const HEARTBEAT_INTERVAL = 15000;
/** Stale lock expiration timeout in milliseconds for Windows environments (60,000 ms) */
const STALE_TIMEOUT_WINDOWS = 60000;
/** Stale lock expiration timeout in milliseconds for POSIX/macOS environments (120,000 ms) */
const STALE_TIMEOUT_OTHER = 120000;

/**
 * Active stale lock threshold for current runtime platform.
 *
 * @remarks Internal lock tuning parameter. Removed from the public storage barrel per the #131 census (zero runtime consumers, no reservations); module-private export used internally and by storage-lock tests.
 */
const STALE_TIMEOUT = process.platform === 'win32' ? STALE_TIMEOUT_WINDOWS : STALE_TIMEOUT_OTHER;

/**
 * Bounded retry parameters for Windows EPERM/EBUSY transient handle-holders on
 * the lock directory. Mirrors `src/storage/atomic-write.ts:20-24` so a persistent
 * handle surfaces to the caller rather than hanging the CLI in a busy spin.
 */
const WINDOWS_RETRY_ATTEMPTS = 5;
const WINDOWS_RETRY_INITIAL_DELAY = 50; // ms
const WINDOWS_RETRY_MULTIPLIER = 2;
const WINDOWS_RETRY_JITTER = 0.25; // ±25%
const WINDOWS_RETRY_MAX_DELAY = 300; // ms

/**
 * Synchronous busy-wait sleep primitive used by the lock acquisition retry loop.
 *
 * @param ms - Number of milliseconds to wait
 * @returns Void
 *
 * @remarks
 * `createLock` is synchronous and runs on the lock-acquisition hot path, so we
 * cannot yield to the event loop (no `await setTimeout`). Uses a wall-clock
 * `Date.now()` poll so the wait duration is independent of CPU-bound spin
 * scheduling. Capped at `WINDOWS_RETRY_MAX_DELAY` (300 ms) per `atomicWrite`
 * precedent.
 *
 * @example
 * ```typescript
 * BusyWait.sleepMs(75);
 * ```
 */
const BusyWait = {
  sleepMs(ms: number): void {
    const target = Date.now() + Math.min(ms, WINDOWS_RETRY_MAX_DELAY);
    // Spin on wall-clock until elapsed. We intentionally do not yield to the
    // event loop — createLock is sync and used inside lock acquisition.
    while (Date.now() < target) {
      // No-op busy-wait; the wall-clock check bounds the duration.
    }
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
 * @returns Lock ID in format `L-YYYYMMDDTHHMMSS-XXXX`
 *
 * @remarks
 * Uses ISO timestamp segments and 2 bytes of random hex entropy.
 *
 * @example
 * ```typescript
 * const lockId = generateLockId(); // "L-20260830T120000-abcd"
 * ```
 */
function generateLockId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const random = crypto.randomBytes(2).toString('hex');
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
  const locksDir = path.join(vaultPath, '.palee', 'locks');
  fs.mkdirSync(locksDir, { recursive: true });
  return path.join(locksDir, `${hash}.lockdir`);
}

/**
 * Checks whether an existing lock descriptor exceeds the platform's stale timeout threshold.
 *
 * @param lockInfo - Parsed lock record
 * @returns `true` if lock has expired and is eligible for stale recovery, otherwise `false`
 *
 * @remarks
 * Compares current epoch milliseconds against lock file modification time (`mtime`).
 *
 * @example
 * ```typescript
 * const stale = isLockStale(parsedLock);
 * ```
 */
function isLockStale(lockInfo: ParsedLock): boolean {
  if (lockInfo.mtime === 0) return true; // File disappeared mid-read
  const now = Date.now();
  return now - lockInfo.mtime > STALE_TIMEOUT;
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

  while (true) {
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
        const active = freshLocks[0].data;
        const conflictErr = new Error(`Lock conflict: ${targetPath} is locked by PID ${active?.pid || 'unknown'}`) as NodeError;
        conflictErr.code = 'ECONFLICT';
        throw conflictErr;
      }

      if (activeFiles.length === 0) {
        let incomingConflict = false;
        try {
          const dirStat = fs.statSync(lockDir);
          if (Date.now() - dirStat.mtimeMs < 5000) {
            incomingConflict = true;
          }
        } catch {}
        
        if (incomingConflict) {
          const conflictErr = new Error(`Lock conflict: ${targetPath} is locked by an incoming process`) as NodeError;
          conflictErr.code = 'ECONFLICT';
          throw conflictErr;
        }
      }

      // If we reach here, the directory exists but ALL active locks (if any) are stale!
      // We must clean up the stale directory to reset the state.
      // We only attempt to delete the exact files we observed in this iteration.
      for (const file of files) {
        const filePath = path.join(lockDir, file);
        if (!file.endsWith('.json')) {
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }
        const quarantinePath = filePath + '.quarantine';
        try {
          // Rename acts as an atomic test-and-set to prevent Process B from renewing
          // a lock we are about to delete.
          fs.renameSync(filePath, quarantinePath);
          const stats = fs.statSync(quarantinePath);
          if (Date.now() - stats.mtimeMs > STALE_TIMEOUT) {
            fs.unlinkSync(quarantinePath);
          } else {
            // It was refreshed before we renamed it! Restore it.
            fs.renameSync(quarantinePath, filePath);
          }
        } catch {}
      }

      try {
        fs.rmdirSync(lockDir);
      } catch (rmErr: unknown) {
        const rmCode = (rmErr as NodeError).code;
        // ENOTEMPTY: A new file was written (someone else won the lock).
        // ENOENT: Someone else already removed the directory.
        // Both are legitimate forward-progress signals on every platform and
        // warrant an unconditional `continue` (this was the pre-existing
        // behaviour and is not under review).
        if (rmCode === 'ENOTEMPTY' || rmCode === 'ENOENT') {
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
            BusyWait.sleepMs(delay);
            try {
              fs.rmdirSync(lockDir);
              // Removal succeeded after a transient handle cleared: fall
              // through to the post-rmdir acquisition loop below.
              exhausted = false;
              break;
            } catch (retryErr: unknown) {
              const retryCode = (retryErr as NodeError).code;
              if (retryCode === 'ENOTEMPTY' || retryCode === 'ENOENT') {
                // Forward-progress condition; let the outer loop handle it.
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
            // rather than a hang.
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
}

/**
 * Updates the lock file modification timestamp to maintain liveness.
 *
 * @param lockDir - Lock directory path
 * @param expectedLockId - Lock ID held by this process
 * @returns Void
 *
 * @remarks
 * Touches `mtime` using `fs.utimesSync` without modifying file content.
 *
 * @example
 * ```typescript
 * updateHeartbeat('/vault/.palee/locks/hash.lockdir', 'L-1');
 * ```
 */
function updateHeartbeat(lockDir: string, expectedLockId: string): void {
  const lockFile = path.join(lockDir, `${expectedLockId}.json`);
  try {
    const now = new Date();
    // utimesSync updates mtime/atime natively without modifying file contents.
    // Throws ENOENT if file was quarantined (unlinked) by a stale takeover.
    fs.utimesSync(lockFile, now, now);
  } catch {
    // If ENOENT, we lost the lock. Stop updating.
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
   * @example
   * ```typescript
   * lock.startHeartbeat();
   * ```
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.lockData) {
        updateHeartbeat(this.lockPath, this.lockData.lock_id);
      }
    }, HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref();
  }

  /**
   * Releases the acquired lock and terminates the background heartbeat timer.
   *
   * @returns Void
   *
   * @remarks
   * Stops interval timer and removes session file from disk.
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
