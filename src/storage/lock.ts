import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { LockData, NodeError } from '../types';

/**
 * File locking with heartbeat and stale lock recovery
 * Platform-aware: 60s stale timeout on Windows, 120s elsewhere
 */

const HEARTBEAT_INTERVAL = 15000; // 15 seconds
const STALE_TIMEOUT_WINDOWS = 60000; // 60 seconds
const STALE_TIMEOUT_OTHER = 120000; // 120 seconds

const STALE_TIMEOUT = process.platform === 'win32' ? STALE_TIMEOUT_WINDOWS : STALE_TIMEOUT_OTHER;

function generateLockId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '');
  const random = crypto.randomBytes(2).toString('hex');
  return `L-${timestamp}-${random}`;
}

function getLockPath(vaultPath: string, targetPath: string): string {
  const relativePath = path.relative(vaultPath, targetPath).replace(/\\/g, '/');
  const hash = crypto.createHash('sha256').update(relativePath, 'utf8').digest('hex');
  const lockDir = path.join(vaultPath, '.palee', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  return path.join(lockDir, `${hash}.lock`);
}

function createLock(lockPath: string, targetPath: string): LockData {
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

  const lockContent = JSON.stringify(lockData, null, 2);

  try {
    // Exclusive create - fails if file exists
    fs.writeFileSync(lockPath, lockContent, { flag: 'wx' });
    return lockData;
  } catch (e: unknown) {
    const err = e as NodeError;
    if (err.code === 'EEXIST') {
      // Lock exists - check if stale
      const existingLock = readLock(lockPath);
      if (isLockStale(existingLock)) {
        quarantineStaleLock(lockPath);
        // Retry creation
        fs.writeFileSync(lockPath, lockContent, { flag: 'wx' });
        return lockData;
      }
      throw new Error(`Lock conflict: ${targetPath} is locked by PID ${existingLock?.pid}`, {
        cause: e,
      });
    }
    throw err;
  }
}

function readLock(lockPath: string): LockData | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(content) as LockData;
  } catch {
    return null;
  }
}

function isLockStale(lock: LockData | null): boolean {
  if (!lock || !lock.heartbeat_at) return true;
  const heartbeatTime = new Date(lock.heartbeat_at).getTime();
  const now = Date.now();
  return now - heartbeatTime > STALE_TIMEOUT;
}

function quarantineStaleLock(lockPath: string): void {
  const quarantinePath = lockPath + '.stale.' + Date.now();
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch {
    // If rename fails, someone else already claimed or deleted it
    // Do not unlink!
  }
}

function updateHeartbeat(lockPath: string): void {
  try {
    const lock = readLock(lockPath);
    if (lock) {
      lock.heartbeat_at = new Date().toISOString();
      const tempPath = lockPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(lock, null, 2), 'utf8');
      fs.renameSync(tempPath, lockPath);
    }
  } catch {
    // Heartbeat update failed - continue, next interval will retry
  }
}

function releaseLock(lockPath: string, expectedLockId: string): void {
  try {
    const releasePath = lockPath + '.release.' + expectedLockId;
    fs.renameSync(lockPath, releasePath);
    
    const currentLock = readLock(releasePath);
    if (currentLock && currentLock.lock_id === expectedLockId) {
      fs.unlinkSync(releasePath);
    } else {
      // It wasn't ours! Restore it so the rightful owner keeps it.
      try {
        fs.renameSync(releasePath, lockPath);
      } catch {
        // Ignore restore errors if someone else immediately created a new lock
      }
    }
  } catch {
    // Lock already released or doesn't exist
  }
}

class Lock {
  private targetPath: string;
  readonly lockPath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private lockData: LockData | null = null;

  constructor(vaultPath: string, targetPath: string) {
    this.targetPath = targetPath;
    this.lockPath = getLockPath(vaultPath, targetPath);
    this.heartbeatTimer = null;
  }

  async acquire(): Promise<void> {
    this.lockData = createLock(this.lockPath, this.targetPath);
    this.startHeartbeat();
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      updateHeartbeat(this.lockPath);
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

export { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT };
