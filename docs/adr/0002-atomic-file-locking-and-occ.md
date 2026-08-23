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
