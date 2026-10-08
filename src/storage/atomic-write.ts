/**
 * Atomic File Writer with Optimistic Concurrency Control (OCC)
 *
 * @remarks
 * Implements crash-resilient atomic file overwriting:
 * 1. Asserts the resolved destination lies inside the vault (#264).
 * 2. Acquires target file {@link Lock}.
 * 3. Compares `expectedFingerprint` against disk state (OCC) to detect concurrent modifications.
 * 4. Writes contents to a unique temporary file (`<target>.tmp.<pid>.<entropy>`).
 * 5. Calls `fsyncSync` to flush data and metadata to physical storage.
 * 6. Atomically renames temporary file over the destination file.
 * 7. Handles Windows filesystem locking (`EPERM`/`EBUSY`) using exponential backoff with jitter.
 */

import fs from 'fs';
import crypto from 'crypto';
import { computeFingerprint } from './frontmatter';
import { Lock } from './lock';
import { assertContainedInVault, isContainmentError } from './containment';
import { NodeError } from '../types';

const WINDOWS_RETRY_ATTEMPTS = 5;
const WINDOWS_RETRY_INITIAL_DELAY = 50; // ms
const WINDOWS_RETRY_MULTIPLIER = 2;
const WINDOWS_RETRY_JITTER = 0.25; // ±25%
const WINDOWS_RETRY_MAX_DELAY = 300; // ms
/**
 * Asynchronously pauses execution for a randomized duration to implement retry backoff.
 *
 * @param baseDelay - Base delay duration in milliseconds
 * @param jitter - Fraction (e.g. 0.25 for ±25%) of random jitter to apply
 * @returns Promise that resolves after the computed backoff delay
 *
 * @remarks
 * Caps the total sleep duration at `WINDOWS_RETRY_MAX_DELAY` (300 ms).
 *
 * @example
 * ```typescript
 * await sleep(50, 0.25);
 * ```
 */
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
 * @remarks
 * Evaluates both the `code` property (`ECONFLICT`) and message prefix strings (`OCC conflict:` or `Lock conflict:`).
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
    return err.message.startsWith('OCC conflict:') || err.message.startsWith('Lock conflict:');
  }
  return false;
}

/**
 * Atomically writes content to a target file within a vault with OCC verification and lock synchronization.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param targetPath - Path of the destination file. Absolute, as every in-repo
 * caller passes it; a relative path is resolved against `vaultPath` — the same
 * resolution the containment guard applies — and the resolved path is what gets
 * written, so the guard can never certify a file other than the one written
 * @param newContent - Complete text content to persist
 * @param expectedFingerprint - Optional expected SHA-256 fingerprint; if provided, ensures the file has not changed since last read
 * @returns Promise that resolves once data is fsync-flushed and renamed
 * @throws {NodeError} If the destination resolves outside the vault (`ECONTAINMENT`, a
 * security refusal — never an `ECONFLICT`, because no retry makes an escaping path safe)
 * @throws {NodeError} If an OCC fingerprint mismatch is detected (`ECONFLICT`) or lock cannot be acquired
 *
 * @remarks
 * Implements crash-resilient atomic file overwriting:
 * 1. Asserts the resolved destination is still inside the vault (#264) and adopts that resolved path.
 * 2. Acquires target file {@link Lock}.
 * 3. Compares `expectedFingerprint` against disk state (OCC) to detect concurrent modifications.
 * 4. Writes contents to a unique temporary file (`<target>.tmp.<pid>.<entropy>`).
 * 5. Calls `fsyncSync` to flush data and metadata to physical storage.
 * 6. Atomically renames temporary file over the destination file.
 * 7. Handles Windows filesystem locking (`EPERM`/`EBUSY`) using exponential backoff with jitter.
 *
 * The containment assertion guards the destination rather than trusting the
 * spelling: until #264 only the *final* path component was ever questioned, so a
 * junction planted higher up — `vault\.palee\sessions` pointing outside the vault
 * — redirected the whole write, and `.palee` is invisible to `walkVault` so
 * `validate` never noticed. It belongs here, in the one primitive every vault
 * write goes through, so the roadmap / adopt / migrate / review / session paths
 * inherit it instead of each re-implementing it badly.
 *
 * It is the write path's last line, not its only one: the `.palee` tree is asserted
 * where it is created (`getPaleeDir`/`getSessionsDir` in `src/storage/memory.ts`,
 * `getLockDir` in `src/storage/lock.ts`), because a refusal raised only at the note
 * would still have let `mkdirSync` make a directory outside the vault on the way
 * there. Every site runs the same `assertContainedInVault` → `isWithinVault`
 * predicate, so notes, directories and locks share one refusal surface —
 * `ECONTAINMENT` and exit 3 — instead of three that can disagree.
 *
 * The assertion is re-run on every attempt immediately before the temp file is
 * opened and the destination renamed. Between the first certification and the
 * write sit the `await`s — `lock.acquire()` and its retry sleeps, then the OCC read
 * — and a component of the certified path replaced with a link to outside the
 * vault during that window still spells an in-vault destination to every string
 * this function holds. Re-asserting narrows the exposure from the whole of that
 * window to the syscall that follows it; the last gap is not closable from JS,
 * because Node exposes no relative, no-follow open of an ancestor.
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
  // Containment first, before anything is written — including before the `Lock`
  // is constructed: `getLockDir` creates `.palee/locks` the moment it runs, so a
  // refusal raised after acquisition would still have left lock metadata behind
  // for a destination it had just rejected.
  //
  // The canonical path it returns is then used for *every* filesystem operation
  // below (#264 residual). The guard resolves a relative destination against the
  // vault root; `targetPath` passed verbatim to `fs` reaches the filesystem
  // relative to the process cwd, so certifying one spelling and writing another
  // could put bytes somewhere the guard never looked. Resolving once keeps the
  // certified path and the written path identical by construction — which is also
  // what makes the guard's own answer meaningful — and it leaves every absolute
  // caller (all of them today) writing the same file it always wrote.
  //
  // "Resolved", not "reached": a destination whose *final* component is a link is
  // written through the link, because the OCC read below follows it too. Renaming
  // onto the spelled path instead would replace the link with a new regular file,
  // splitting one note across two names — and the fingerprint the caller verified
  // would belong to the file the write then ignored. A link that resolves *out* of
  // the vault is refused here, with the link left intact.
  const resolvedTarget = assertContainedInVault(vaultPath, targetPath);

  const lock = new Lock(vaultPath, resolvedTarget);

  let lockAcquired = false;
  try {
    await lock.acquire();
    lockAcquired = true;

    // OCC: Check fingerprint against disk state
    if (expectedFingerprint !== null) {
      if (!fs.existsSync(resolvedTarget)) {
        const conflictErr = new Error(`OCC conflict: ${resolvedTarget} does not exist (was deleted or missing)`) as NodeError;
        conflictErr.code = 'ECONFLICT';
        throw conflictErr;
      }

      let currentContent: string;
      try {
        currentContent = fs.readFileSync(resolvedTarget, 'utf8');
      } catch (e: unknown) {
        const readErr = e as NodeError;
        if (readErr.code === 'ENOENT') {
          const conflictErr = new Error(`OCC conflict: ${resolvedTarget} does not exist`) as NodeError;
          conflictErr.code = 'ECONFLICT';
          throw conflictErr;
        }
        throw readErr;
      }

      const currentFingerprint = computeFingerprint(currentContent);
      if (currentFingerprint !== expectedFingerprint) {
        const conflictErr = new Error(`OCC conflict: ${resolvedTarget} was modified by another process`) as NodeError;
        conflictErr.code = 'ECONFLICT';
        throw conflictErr;
      }
    }

    const tempPath = `${resolvedTarget}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;

    for (let attempt = 1; attempt <= WINDOWS_RETRY_ATTEMPTS; attempt++) {
      try {
        // The bound is re-asserted as the last step before the filesystem is
        // touched, on every attempt. The certification above describes the vault as
        // it was *then*; everything between that and this line is `await`s — the
        // whole of `lock.acquire()`, its retry loop if the target is busy, then the
        // OCC read. A component of `resolvedTarget` replaced with a link during that
        // window still spells an in-vault destination, and `openSync`/`renameSync`
        // happily follow it out. Re-checking here costs two `realpathSync` calls and
        // replaces a window that spans a retry loop with one that spans a syscall:
        // the gap before `openSync` is not closable from JS, because no
        // `openat`-style relative, no-follow open is exposed (#264 review).
        //
        // The re-check also has to *bind*, not merely pass. A final-component
        // symlink installed since the first certification resolves to a different
        // in-vault note: the assertion accepts it, while `renameSync` on the path
        // spelled above replaces the link itself — and the OCC read just performed
        // followed that link. Read and write would then address two different
        // files, which is the split the resolve-once design exists to prevent, so a
        // destination that moved is a retryable conflict: the next call re-resolves,
        // locks the path it now resolves to, and re-reads that file's fingerprint.
        if (assertContainedInVault(vaultPath, resolvedTarget) !== resolvedTarget) {
          const movedErr = new Error(
            `OCC conflict: ${resolvedTarget} resolves elsewhere after the lock was taken`
          ) as NodeError;
          movedErr.code = 'ECONFLICT';
          throw movedErr;
        }

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

        fs.renameSync(tempPath, resolvedTarget);
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

export { atomicWrite, isContainmentError };

