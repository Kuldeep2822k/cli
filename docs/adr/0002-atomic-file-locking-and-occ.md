# ADR-0002: Atomic File Locking and Optimistic Concurrency Control

## Status
Accepted

## Context
Obsidian vaults are local directories modified by users, sync services (Obsidian Sync, iCloud, Dropbox, OneDrive), and automated CLI tools concurrently. We must prevent data loss, partial writes, and lost updates without corrupting user notes or locking the user out indefinitely.

## Decision
We implemented a two-tier synchronization mechanism:
1. **Cross-Process Mutex via Atomic Lock Directories**:
   - Uses `fs.mkdirSync` on a target-hashed directory (`.palee/locks/<hash>.lockdir`) to eliminate TOCTOU (Time-of-Check-to-Time-of-Use) races.
   - Writes a session-specific JSON descriptor holding PID, hostname, and timestamp.
   - Background heartbeat refreshes lock file `mtime` every 15 seconds.
   - Automatic stale recovery reclaims abandoned locks after 60s on Windows or 120s on other OSes using quarantine renaming.
2. **Optimistic Concurrency Control (OCC) & Atomic Overwrites**:
   - Computes SHA-256 fingerprint of target files before modification.
   - Flushes writes to temporary files using `fsyncSync` before atomic `renameSync`.
   - On Windows `EPERM` / `EBUSY` lock collisions, retries with exponential backoff and randomized jitter.

## Consequences
- **Positive**:
  - Zero partial-write corruption even on sudden crash or process termination.
  - Robust cross-platform concurrency on both POSIX and Windows filesystem semantics.
  - Detects concurrent modifications between fingerprint read and atomic write via SHA-256 OCC validation.
- **Negative / Tradeoffs**:
  - Requires momentary temporary files during writes.
  - `fs.renameSync` will atomically replace the target file; an external edit occurring after the fingerprint check could be replaced unless cooperating through PALEE locks or filesystem-level compare-and-replace.

## Alternatives Considered

1. **POSIX `flock` / `fcntl` & Windows `LockFileEx` (via native addons)**:
   - *Description*: Kernel-level advisory or mandatory file descriptor locks via native C++ bindings (e.g. `fs-ext`).
   - *Pros*: Direct OS-enforced mutual exclusion without temporary lock directories.
   - *Why Rejected*: Violates the strict Zero Native Binaries / pure JavaScript invariant across Linux, macOS, and Windows. Native addons break portable `npm install` workflows across cross-platform environments.

2. **Off-the-Shelf Locking Packages (`proper-lockfile`)**:
   - *Description*: Third-party npm package for filesystem locking.
   - *Pros*: Pre-packaged open-source utility.
   - *Why Rejected*: Introduces additional supply-chain attack surface and lacks PALEE's specific stale-lock quarantine recovery mechanics and platform-tuned timeout horizons (60s Windows vs 120s POSIX).

3. **Process-Local / In-Memory Async Mutex Queue**:
   - *Description*: Node.js in-memory mutex to synchronize concurrent write promises.
   - *Pros*: Zero filesystem I/O overhead.
   - *Why Rejected*: Completely ineffective across independent CLI process invocations, concurrent terminal windows, background scripts, or sync engines.

4. **Single Global SQLite Database with WAL (Write-Ahead Logging)**:
   - *Description*: Storing all topic metadata, locks, and logs in `.palee/state.db`.
   - *Pros*: Built-in ACID transactions and concurrency control.
   - *Why Rejected*: Violates the Markdown-First / Vault-First architecture where Markdown frontmatter is the single source of truth; SQLite creates state divergence and synchronization conflicts with Obsidian git/cloud sync.

