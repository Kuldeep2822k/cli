import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { LockData, NodeError } from '../types';

/**
 * File locking with heartbeat and stale lock recovery
 * Platform-aware: 60s stale timeout on Windows, 120s elsewhere
 * Uses file descriptors (r+) for atomic check-and-set to prevent TOCTOU races.
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

function getLockPath(vaultPath: string, targetPath: string): string {
  const relativePath = path.relative(vaultPath, targetPath).replace(/\\/g, '/');
  const hash = crypto.createHash('sha256').update(relativePath, 'utf8').digest('hex');
  const lockDir = path.join(vaultPath, '.palee', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  return path.join(lockDir, `${hash}.lock`);
}

function readLock(lockPath: string): LockData | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    if (!content.trim()) return null;
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

function takeOverStaleLock(lockPath: string, expectedLockId: string | null, newLockData: LockData): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'r+');
    const content = fs.readFileSync(fd, 'utf8');
    let currentLockId: string | null = null;
    if (content.trim()) {
      const lock = JSON.parse(content) as LockData;
      currentLockId = lock.lock_id;
    }
    
    if (currentLockId !== expectedLockId) {
      return false; // Someone else took it over or changed it
    }
    
    const updatedContent = Buffer.from(JSON.stringify(newLockData, null, 2), 'utf8');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, updatedContent, 0, updatedContent.length, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
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

  try {
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), { flag: 'wx' });
    return lockData;
  } catch (e: unknown) {
    const err = e as NodeError;
    if (err.code === 'EEXIST') {
      const existingLock = readLock(lockPath);
      if (isLockStale(existingLock)) {
        const expectedId = existingLock ? existingLock.lock_id : null;
        if (takeOverStaleLock(lockPath, expectedId, lockData)) {
          return lockData;
        }
      }
      const currentLock = readLock(lockPath);
      throw new Error(`Lock conflict: ${targetPath} is locked by PID ${currentLock?.pid || 'unknown'}`);
    }
    throw err;
  }
}

function updateHeartbeat(lockPath: string, expectedLockId: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'r+');
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.trim()) return;
    const lock = JSON.parse(content) as LockData;
    if (lock.lock_id === expectedLockId) {
      lock.heartbeat_at = new Date().toISOString();
      const updatedContent = Buffer.from(JSON.stringify(lock, null, 2), 'utf8');
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, updatedContent, 0, updatedContent.length, 0);
    }
  } catch {
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function releaseLock(lockPath: string, expectedLockId: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'r+');
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.trim()) return;
    const lock = JSON.parse(content) as LockData;
    if (lock.lock_id === expectedLockId) {
      fs.ftruncateSync(fd, 0); // Empty the file to release it
    }
  } catch {
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
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
