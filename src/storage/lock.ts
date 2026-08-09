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

function generateLockId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const random = crypto.randomBytes(2).toString('hex');
  return `L-${timestamp}-${random}`;
}

function getLockDir(vaultPath: string, targetPath: string): string {
  const relativePath = path.relative(vaultPath, targetPath).replace(/\\/g, '/');
  const hash = crypto.createHash('sha256').update(relativePath, 'utf8').digest('hex');
  const locksDir = path.join(vaultPath, '.palee', 'locks');
  fs.mkdirSync(locksDir, { recursive: true });
  return path.join(locksDir, `${hash}.lockdir`);
}

function isLockStale(lock: LockData | null): boolean {
  if (!lock || !lock.heartbeat_at) return true;
  const heartbeatTime = new Date(lock.heartbeat_at).getTime();
  const now = Date.now();
  return now - heartbeatTime > STALE_TIMEOUT;
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
    heartbeat_at: now,
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

      if (activeFiles.length === 0) {
        // Corrupted/empty directory (previous owner crashed before writing file, or we caught them in between, or garbage files)
        for (const file of files) {
          try { fs.unlinkSync(path.join(lockDir, file)); } catch {}
        }
        try {
          fs.rmdirSync(lockDir);
        } catch (rmErr: unknown) {
          if ((rmErr as NodeError).code === 'ENOTEMPTY') continue; // Someone wrote a file, retry read
        }
        continue; // Directory removed, retry mkdir
      }

      // Check all active lock files (usually just 1)
      const parsedLocks = activeFiles.map(f => {
        try {
          const content = fs.readFileSync(path.join(lockDir, f), 'utf8');
          return { filename: f, data: JSON.parse(content) as LockData };
        } catch {
          return { filename: f, data: null };
        }
      });

      const freshLocks = parsedLocks.filter(l => !isLockStale(l.data));
      if (freshLocks.length > 0) {
        const active = freshLocks[0].data;
        throw new Error(`Lock conflict: ${targetPath} is locked by PID ${active?.pid || 'unknown'}`);
      }

      // All active locks are stale. We must quarantine ALL of them to take over.
      // If we fail to unlink ANY of them, it means someone else beat us to it.
      let takeoverSuccessful = true;
      for (const staleLock of parsedLocks) {
        const oldPath = path.join(lockDir, staleLock.filename);
        try {
          fs.unlinkSync(oldPath);
        } catch (unlinkErr: unknown) {
          if ((unlinkErr as NodeError).code === 'ENOENT') {
            // Someone else already unlinked it! We lost the takeover race.
            takeoverSuccessful = false;
            break;
          }
          throw unlinkErr;
        }
      }

      if (!takeoverSuccessful) {
        // We failed to quarantine. Someone else is taking over. Retry the whole process.
        continue; 
      }

      // We successfully quarantined the stale lock(s). The lock is ours!
      try {
        fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf8');
      } catch (writeErr: unknown) {
        if ((writeErr as NodeError).code === 'ENOENT') {
          // The lock directory was removed out from under us by the stale owner releasing!
          // We must retry creating the directory.
          continue;
        }
        throw writeErr;
      }
      return lockData;
    }
  }
}

function updateHeartbeat(lockDir: string, expectedLockId: string): void {
  const lockFile = path.join(lockDir, `${expectedLockId}.json`);
  let fd: number | null = null;
  try {
    // Open with r+ ensures we only update if the file STILL exists.
    // If someone quarantined us, they unlinked it, and this throws ENOENT.
    fd = fs.openSync(lockFile, 'r+');
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.trim()) return;
    const lock = JSON.parse(content) as LockData;
    
    // Safety check just in case, though the filename guarantees the ID.
    if (lock.lock_id === expectedLockId) {
      lock.heartbeat_at = new Date().toISOString();
      const updatedContent = Buffer.from(JSON.stringify(lock, null, 2), 'utf8');
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, updatedContent, 0, updatedContent.length, 0);
    }
  } catch {
    // If ENOENT, we were quarantined and lost the lock. Stop updating.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
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
