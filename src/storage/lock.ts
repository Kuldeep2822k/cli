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

/** Interval in milliseconds (15,000 ms) between periodic heartbeat mtime updates */
const HEARTBEAT_INTERVAL = 15000;
/** Stale lock expiration timeout in milliseconds for Windows environments (60,000 ms) */
const STALE_TIMEOUT_WINDOWS = 60000;
/** Stale lock expiration timeout in milliseconds for POSIX/macOS environments (120,000 ms) */
const STALE_TIMEOUT_OTHER = 120000;

/** Active stale lock threshold for current runtime platform */
const STALE_TIMEOUT = process.platform === 'win32' ? STALE_TIMEOUT_WINDOWS : STALE_TIMEOUT_OTHER;

interface ParsedLock {
  filename: string;
  data: LockData | null;
  mtime: number;
}

/**
 * Generates a unique lock identifier string with timestamp and random entropy.
 *
 * @returns Lock ID in format `L-YYYYMMDDTHHMMSS-XXXX`
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
        // ENOTEMPTY: A new file was written (someone else won the lock).
        // ENOENT: Someone else already removed the directory.
        if ((rmErr as NodeError).code === 'ENOTEMPTY' || (rmErr as NodeError).code === 'ENOENT') {
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
   */
  constructor(vaultPath: string, targetPath: string) {
    this.targetPath = targetPath;
    this.lockPath = getLockDir(vaultPath, targetPath);
    this.heartbeatTimer = null;
  }

  /**
   * Acquires the lock and starts the background heartbeat timer.
   *
   * @throws {NodeError} If the lock is held by another active process (`ECONFLICT`)
   */
  async acquire(): Promise<void> {
    this.lockData = createLock(this.lockPath, this.targetPath);
    this.startHeartbeat();
  }

  /**
   * Initiates periodic heartbeat timer that touches the lock file mtime.
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
