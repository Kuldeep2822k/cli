import fs from 'fs';
import { computeFingerprint } from './frontmatter';
import { Lock } from './lock';
import { NodeError } from '../types';

/**
 * Atomic write with OCC conflict detection and Windows retry logic
 */

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

async function atomicWrite(vaultPath: string, targetPath: string, newContent: string, expectedFingerprint: string | null = null): Promise<void> {
  const lock = new Lock(vaultPath, targetPath);

  try {
    await lock.acquire();

    // OCC: Check fingerprint if file exists
    if (expectedFingerprint !== null && fs.existsSync(targetPath)) {
      const currentContent = fs.readFileSync(targetPath, 'utf8');
      const currentFingerprint = computeFingerprint(currentContent);

      if (currentFingerprint !== expectedFingerprint) {
        throw new Error(`OCC conflict: ${targetPath} was modified by another process`);
      }
    }

    const tempPath = targetPath + '.tmp.' + process.pid;
    let writeSuccess = false;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= WINDOWS_RETRY_ATTEMPTS; attempt++) {
      try {
        fs.writeFileSync(tempPath, newContent, 'utf8');

        // fsync (flush to disk)
        const fd = fs.openSync(tempPath, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        fs.renameSync(tempPath, targetPath);
        writeSuccess = true;
        break;
      } catch (e: unknown) {
        const err = e as NodeError;
        lastError = err;

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

    if (!writeSuccess) {
      throw lastError || new Error('Write failed after retries');
    }

  } finally {
    lock.release();
  }
}

export { atomicWrite };
