/**
 * Atomic File Writer with Optimistic Concurrency Control (OCC)
 *
 * @remarks
 * Implements crash-resilient atomic file overwriting:
 * 1. Acquires target file {@link Lock}.
 * 2. Compares `expectedFingerprint` against disk state (OCC) to detect concurrent modifications.
 * 3. Writes contents to a unique temporary file (`<target>.tmp.<pid>`).
 * 4. Calls `fsyncSync` to flush data and metadata to physical storage.
 * 5. Atomically renames temporary file over the destination file.
 * 6. Handles Windows filesystem locking (`EPERM`/`EBUSY`) using exponential backoff with jitter.
 */

import fs from 'fs';
import { computeFingerprint } from './frontmatter';
import { Lock } from './lock';
import { NodeError } from '../types';

const WINDOWS_RETRY_ATTEMPTS = 5;
const WINDOWS_RETRY_INITIAL_DELAY = 50; // ms
const WINDOWS_RETRY_MULTIPLIER = 2;
const WINDOWS_RETRY_JITTER = 0.25; // ±25%
const WINDOWS_RETRY_MAX_DELAY = 300; // ms
function sleep(baseDelay: number, jitter: number = 0): Promise<void> {
  const jitterAmount = baseDelay * jitter;
  const delay = baseDelay + (Math.random() * 2 - 1) * jitterAmount;
  return new Promise(resolve => setTimeout(resolve, Math.min(delay, WINDOWS_RETRY_MAX_DELAY)));
}

/**
 * Checks whether a given error represents an OCC version conflict or a lock acquisition contention.
 *
 * @param e - Error object or unknown caught value
 * @returns `true` if the error indicates a concurrency conflict (`ECONFLICT`), otherwise `false`
 *
 * @example
 * ```typescript
 * try {
 *   await atomicWrite(vault, path, content, oldFingerprint);
 * } catch (err) {
 *   if (isConflictError(err)) {
 *     console.warn('File was concurrently modified, reloading...');
 *   }
 * }
 * ```
 */
export function isConflictError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: string; message?: string };
  if (err.code === 'ECONFLICT') return true;
  if (typeof err.message === 'string') {
    return err.message.includes('OCC conflict') || err.message.includes('Lock conflict');
  }
  return false;
}

/**
 * Atomically writes content to a target file within a vault with OCC verification and lock synchronization.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param targetPath - Absolute path of destination file
 * @param newContent - Complete text content to persist
 * @param expectedFingerprint - Optional expected SHA-256 fingerprint; if provided, ensures the file has not changed since last read
 * @returns Promise that resolves once data is fsync-flushed and renamed
 * @throws {NodeError} If an OCC fingerprint mismatch is detected (`ECONFLICT`) or lock cannot be acquired
 *
 * @example
 * ```typescript
 * await atomicWrite(
 *   '/vault',
 *   '/vault/notes/topic.md',
 *   '---\npalee_id: t1\n---\n# Topic',
 *   initialFingerprint
 * );
 * ```
 */
async function atomicWrite(
  vaultPath: string,
  targetPath: string,
  newContent: string,
  expectedFingerprint: string | null = null
): Promise<void> {
  const lock = new Lock(vaultPath, targetPath);

  let lockAcquired = false;
  try {
    await lock.acquire();
    lockAcquired = true;

    // OCC: Check fingerprint against disk state
    if (expectedFingerprint !== null) {
      if (!fs.existsSync(targetPath)) {
        const conflictErr = new Error(`OCC conflict: ${targetPath} does not exist (was deleted or missing)`) as NodeError;
        conflictErr.code = 'ECONFLICT';
        throw conflictErr;
      }

      let currentContent: string;
      try {
        currentContent = fs.readFileSync(targetPath, 'utf8');
      } catch (e: unknown) {
        const readErr = e as NodeError;
        if (readErr.code === 'ENOENT') {
          const conflictErr = new Error(`OCC conflict: ${targetPath} does not exist`) as NodeError;
          conflictErr.code = 'ECONFLICT';
          throw conflictErr;
        }
        throw readErr;
      }

      const currentFingerprint = computeFingerprint(currentContent);
      if (currentFingerprint !== expectedFingerprint) {
        const conflictErr = new Error(`OCC conflict: ${targetPath} was modified by another process`) as NodeError;
        conflictErr.code = 'ECONFLICT';
        throw conflictErr;
      }
    }

    const tempPath = targetPath + '.tmp.' + process.pid;

    for (let attempt = 1; attempt <= WINDOWS_RETRY_ATTEMPTS; attempt++) {
      try {
        let fd: number | null = null;
        try {
          fd = fs.openSync(tempPath, 'w');
          fs.writeSync(fd, newContent);
          fs.fsyncSync(fd);
        } finally {
          if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
          }
        }

        fs.renameSync(tempPath, targetPath);
        break;
      } catch (e: unknown) {
        const err = e as NodeError;

        // Windows EPERM/EBUSY - retry with exponential backoff
        if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY')) {
          if (attempt < WINDOWS_RETRY_ATTEMPTS) {
            const delay = WINDOWS_RETRY_INITIAL_DELAY * Math.pow(WINDOWS_RETRY_MULTIPLIER, attempt - 1);
            await sleep(delay, WINDOWS_RETRY_JITTER);
            continue;
          }
        }

        // Other errors or max retries reached - cleanup and throw
        try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup errors */ }
        throw err;
      }
    }

  } finally {
    if (lockAcquired) {
      lock.release();
    }
  }
}

export { atomicWrite };

