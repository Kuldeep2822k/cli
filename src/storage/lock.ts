import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { LockData, NodeError } from '../types';

/**
 * File locking with heartbeat and stale lock recovery
 * Platform-aware: 60s stale timeout on Windows, 120s elsewhere
 * Uses atomic directory creation to prevent TOCTOU race conditions.
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
  return path.join(lockDir, `${hash}.lockdir`);
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
    fs.mkdirSync(lockPath);
    const dataFile = path.join(lockPath, `${lockId}.json`);
    fs.writeFileSync(dataFile, JSON.stringify(lockData, null, 2), 'utf8');
    return lockData;
  } catch (e: unknown) {
    const err = e as NodeError;
    if (err.code === 'EEXIST') {
      const existingLock = readLock(lockPath);
      if (isLockStale(existingLock)) {
        quarantineStaleLock(lockPath);
        fs.mkdirSync(lockPath);
        const dataFile = path.join(lockPath, `${lockId}.json`);
        fs.writeFileSync(dataFile, JSON.stringify(lockData, null, 2), 'utf8');
        return lockData;
      }
      throw new Error(`Lock conflict: ${targetPath} is locked by PID ${existingLock?.pid}`);
    }
    throw err;
  }
}

function readLock(lockPath: string): LockData | null {
  try {
    const files = fs.readdirSync(lockPath);
    const dataFile = files.find(f => f.endsWith('.json'));
    if (!dataFile) return null;
    const content = fs.readFileSync(path.join(lockPath, dataFile), 'utf8');
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
  }
}

function updateHeartbeat(lockPath: string, expectedLockId: string): void {
  try {
    const dataFile = path.join(lockPath, `${expectedLockId}.json`);
    const content = fs.readFileSync(dataFile, 'utf8');
    const lock = JSON.parse(content) as LockData;
    
    lock.heartbeat_at = new Date().toISOString();
    
    const tempFile = path.join(lockPath, `${expectedLockId}.tmp`);
    fs.writeFileSync(tempFile, JSON.stringify(lock, null, 2), 'utf8');
    fs.renameSync(tempFile, dataFile);
  } catch {
    // Heartbeat update failed - likely quarantined
  }
}

function releaseLock(lockPath: string, expectedLockId: string): void {
  try {
    const dataFile = path.join(lockPath, `${expectedLockId}.json`);
    fs.unlinkSync(dataFile);
    fs.rmdirSync(lockPath);
  } catch {
    // Lock already released, doesn't exist, or directory wasn't empty
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
