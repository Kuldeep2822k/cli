# File Locking
<details>
<summary><b>Relevant Source Files</b></summary>

- [src/storage/lock.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts)
- [test/storage-lock.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-lock.test.ts)

</details>

The `palee` CLI implements a robust file locking mechanism to prevent race conditions during concurrent vault access. It utilizes atomic directory creation and a heartbeat system to ensure that only one process can modify a specific resource at a time, while providing mechanisms to recover from crashed processes.

## Overview

Locking is handled by the `Lock` class in `src/storage/lock.ts`. It manages the lifecycle of a lock, from acquisition and heartbeat maintenance to release and stale lock recovery. The system is designed to be platform-aware, adjusting timeouts based on the underlying operating system's filesystem behavior.

### Lock Identity and Path Hashing

Locks are not stored alongside the target files but in a centralized directory: `.palee/locks/`. To ensure that the same file always maps to the same lock directory regardless of relative pathing or symlinks, the system:

1. Resolves the absolute path of the target file using `fs.realpathSync` [src/storage/lock.ts#32-47](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L32-L47).
2. Calculates a SHA-256 hash of the path relative to the vault root [src/storage/lock.ts#49-50](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L49-L50).
3. Creates a lock directory named `{hash}.lockdir` [src/storage/lock.ts#53](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L53-L53).

---

## Lock Acquisition Protocol

Acquisition uses `fs.mkdirSync` as an atomic primitive. Because directory creation is atomic at the OS level, it serves as a "test-and-set" operation [src/storage/lock.ts#92-128](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L92-L128).

### Acquisition Flow

1. **Directory Creation**: Attempt to create `{hash}.lockdir`.
2. **Success**: Write a session-specific JSON file (e.g., `L-20231027T103000-abcd1234.json`) containing the PID, hostname, and timestamp [src/storage/lock.ts#99-125](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L99-L125).
3. **Failure (EEXIST)**: If the directory exists, the process inspects the contents for stale locks [src/storage/lock.ts#126-179](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L126-L179).

```mermaid
sequenceDiagram
    participant P as Process
    participant FS as Filesystem
    participant LD as Lock Directory (.lockdir)

    P->>FS: mkdirSync(lockDir)
    alt Acquisition Succeeded
        P->>LD: writeFileSync(sessionID.json, LockData)
        Note over P: Lock Acquired (Heartbeat Active)
    else Collision / EEXIST (Contended)
        P->>LD: readdirSync() &rarr; check stale mtime
        alt Lock is Stale (Windows &gt;60s / POSIX &gt;120s)
            P->>LD: renameSync(file, file.quarantine)
            alt Heartbeat Refreshed Mid-Rename
                P->>LD: renameSync(quarantine, file)
                Note over P: Restored &rarr; Retry
            else Still Stale
                P->>LD: unlinkSync(quarantine)
                P->>FS: rmdirSync(lockDir)
                Note over P: Stale Reclaimed &rarr; Retry
            end
        else Lock is Active
            Note over P: Throw ECONFLICT
        end
    end
```

> **Note on Exit Codes**: `src/storage/lock.ts` operates purely at the storage layer and throws an error with `code = 'ECONFLICT'`. Upstream CLI command handlers (such as [src/cli/review.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/review.ts) and [src/cli/adopt.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/adopt.ts)) catch this error and set `process.exitCode = 4` to signal concurrency contention to callers.

---

## Heartbeat and Timeouts

To prevent a process from holding a lock indefinitely after a crash, the owner must "check in" periodically.

### Heartbeat Mechanism

Once a lock is acquired, the `Lock` class starts a timer that calls `updateHeartbeat` every 15 seconds (`HEARTBEAT_INTERVAL`) [src/storage/lock.ts#13](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L13-L13). This function uses `fs.utimesSync` to update the access and modification times of the session JSON file without rewriting the content [src/storage/lock.ts#187-197](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L187-L197).

### Platform-Specific Stale Timeouts

The system accounts for different filesystem latencies and clock skews by varying the stale threshold:

- Windows: 60 seconds [src/storage/lock.ts#14](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L14-L14)
- Other (POSIX): 120 seconds [src/storage/lock.ts#15](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L15-L15)

A lock is considered stale if `Date.now() - mtime > STALE_TIMEOUT` [src/storage/lock.ts#80-89](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L80-L89).

---

## Stale Lock Recovery

When a process encounters an existing lock directory, it attempts to recover it if the lock is stale. This process uses a Quarantine-Rename strategy to avoid race conditions between two processes trying to clean up the same stale lock.

### The Quarantine Pattern

1. **Rename**: The process renames the stale `.json` file to `.json.quarantine`. This acts as an atomic test-and-set [src/storage/lock.ts#190-194](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L190-L194).
2. **Verify**: It checks the `mtime` of the quarantined file. If the `mtime` was updated just before the rename, it means the original owner is actually still alive; the process restores the file and aborts recovery [src/storage/lock.ts#196-201](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L196-L201).
3. **Cleanup**: If verified stale, the quarantined file is unlinked, and the process attempts to `rmdirSync` the lock directory [src/storage/lock.ts#197-206](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L197-L206).

### Stale Recovery Logic

| Step | Action | Failure Handling |
| --- | --- | --- |
| 1 | `readdirSync(lockDir)` | If `ENOENT`, someone else cleaned it; retry loop (`createLock`) |
| 2 | Filter `activeFiles` | If the directory is under 5s old *and* is either empty or holds an in-flight `.json.quarantine`, throw `ECONFLICT` (incoming process). The quarantine term does not depend on how many `.json` records sit beside it — a stale record of our own is not permission to sweep someone else's recovery. A directory holding only foreign residue is never treated as incoming (`createLock`) |
| 3 | `renameSync` to `.quarantine` | If it fails, the file was already moved/deleted; continue (`createLock`) |
| 4 | `rmdirSync(lockDir)` | `ENOENT` → another process removed it, retry the loop. `ENOTEMPTY` → bounded retry, then `ECONFLICT` naming what is still inside. Windows `EPERM`/`EBUSY` → bounded retry, then the raw error surfaces (`createLock`) |

### Bounded Acquisition

Every branch that cannot make progress is bounded, so no vault write can spin the
CLI. Three rules cover it:

- **`ENOTEMPTY` is a budget, not a retry signal.** The sweep above deletes the entries
  it observed; `rmdirSync` answering `ENOTEMPTY` afterwards means one survived — a file
  another process holds open, or a subdirectory this module never creates. The removal
  is retried `ENOTEMPTY_RETRY_ATTEMPTS` times (5, i.e. one attempt plus five retries,
  50 ms doubling to a 300 ms ceiling with ±25% jitter — ~950 ms of *parked* time) and
  then throws `Lock conflict: … would not empty after 5 retries; still present: <entries>`
  with `code = 'ECONFLICT'`, exit `4` (INV-04, INV-09). Waiting is a thread park
  (`SyncWait`), never a spin.
- **A directory entry fails fast.** Nothing in this module writes a directory into a
  lockdir, so one found there is foreign residue that `rmdirSync` will never get past.
  It is named and refused immediately rather than spending the budget first.
- **A quarantine in flight is left alone.** The sweep renames a record to
  `.json.quarantine` before deciding to delete or restore it. In that window the
  directory holds no `.json` record for that holder, so a second acquirer that read the
  quarantine as residue would delete the record a live holder is about to be given back
  — and the restore would then fail. A fresh directory holding a quarantine is therefore
  another recovery, and is refused; once its mtime ages past 5s it is treated as
  abandoned and cleaned up. The check is independent of any other `.json` records in the
  directory, because a stale record of ours says nothing about the safety of sweeping
  someone else's. A restore that cannot put a live record back is a conflict, never a
  silent swallow: the holder would otherwise keep writing with no record on disk.
- **`ENOENT` is the only unbudgeted *forward-progress signal*.** It reports that the
  directory is already gone, so the next `mkdirSync` is a real acquisition attempt.
  The loop's other non-parking `continue`s (a vanished record at write time, a
  successfully removed stale directory) each make one syscall of progress, and the
  acquisition loop is capped at `MAX_ACQUISITION_ITERATIONS` (20) so their repetition
  is bounded too; reaching the cap means another process keeps deleting the directory,
  and it exits `4` like any other contention.

Recorded in ADR-0036.

---

## Data Structures

### LockData

The metadata stored within the session JSON file.

```typescript
interface LockData {
  lock_id: string;    // Format: L-YYYYMMDDTHHMMSS-xxxx
  target: string;     // Absolute path of the locked file
  pid: number;        // Process ID of the owner
  hostname: string;   // Hostname for multi-machine vault sync safety
  created_at: string; // ISO timestamp
}
```

---

## Summary of Key Functions

| Function | Role | Key Logic |
| --- | --- | --- |
| `getLockDir` | Path resolution | Resolves `realpathSync` to handle symlinks and computes SHA-256 hash [src/storage/lock.ts#32-54](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L32-L54) |
| `createLock` | Atomic acquisition | The main loop using `mkdirSync` and stale recovery logic [src/storage/lock.ts#99-220](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L99-L220) |
| `updateHeartbeat` | Liveness | Uses `fs.utimesSync` to touch the session file [src/storage/lock.ts#187-197](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L187-L197) |
| `releaseLock` | Cleanup | Deletes the session file and attempts to remove the directory [src/storage/lock.ts#282-315](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts#L282-L315) |
