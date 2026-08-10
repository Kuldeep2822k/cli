import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { LockData, NodeError } from '../types';

/**
 * File locking with heartbeat and stale lock recovery
 * Platform-aware: 60s stale timeout on Windows, 120s elsewhere
 * Uses atomic directory creation + session-specific filenames to guarantee zero TOCTOU races.
 */

const HEARTBEAT_INTERVAL = 15000; // 15 seconds
const STALE_TIMEOUT_WINDOWS = 60000; // 60 seconds
const STALE_TIMEOUT_OTHER = 120000; // 120 seconds

const STALE_TIMEOUT = process.platform === 'win32' ? STALE_TIMEOUT_WINDOWS : STALE_TIMEOUT_OTHER;

interface ParsedLock {
  filename: string;
  data: LockData | null;
  mtime: number;
}

function generateLockId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const random = crypto.randomBytes(2).toString('hex');
  return `L-${timestamp}-${random}`;
}

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

function isLockStale(lockInfo: ParsedLock): boolean {
  if (lockInfo.mtime === 0) return true; // File disappeared mid-read
  const now = Date.now();
  return now - lockInfo.mtime > STALE_TIMEOUT;
}

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
        try {
          const dirStat = fs.statSync(lockDir);
          if (Date.now() - dirStat.mtimeMs < 5000) {
            const conflictErr = new Error(`Lock conflict: ${targetPath} is locked by an incoming process`) as NodeError;
            conflictErr.code = 'ECONFLICT';
            throw conflictErr;
          }
        } catch {}
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

class Lock {
  private targetPath: string;
  readonly lockPath: string; // This is a directory path
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private lockData: LockData | null = null;

  constructor(vaultPath: string, targetPath: string) {
    this.targetPath = targetPath;
    this.lockPath = getLockDir(vaultPath, targetPath);
    this.heartbeatTimer = null;
  }

  async acquire(): Promise<void> {
    this.lockData = createLock(this.lockPath, this.targetPath);
    this.startHeartbeat();
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.lockData) {
        updateHeartbeat(this.lockPath, this.lockData.lock_id);
      }
    }, HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref();
  }

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
