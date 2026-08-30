# ADR-0005: Concurrency-Hardened Storage and Automated Schema Migration

## Status
Accepted

## Context
As PALEE vaults grow in complexity, notes may be created outside the CLI (by Obsidian plugins, manual text editing, or external sync engines) without the canonical `palee_schema: 1` version attribute. Simultaneously, multi-process CLI operations, background automated tasks, and async command pipelines create high-frequency write contention where intra-process temporary file collisions and unhandled exception traces could degrade reliability.

## Decision
We implemented a multi-layered storage hardening and schema migration strategy:

1. **Entropy-Augmented Collision-Proof Temporary Files**:
   - In `atomicWrite()`, temporary filenames are constructed using `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`.
   - Eliminates intra-process race conditions where concurrent promises in the same process instance write to overlapping temporary filenames.
   - Unlinks lingering temporary files in `finally` blocks on any write, fsync, or rename exception.

2. **Automated OCC Schema Migration (`palee migrate --fix`)**:
   - Extends the `migrate` CLI command with an automatic `--fix` flag.
   - Discovers notes containing a valid `palee_id` but missing `palee_schema`.
   - Computes the pre-write SHA-256 fingerprint and applies `atomicWrite()` with optimistic concurrency control (`expectedFingerprint`) to upgrade frontmatter to `palee_schema: 1` safely.
   - Tracks failed file paths in the validation report to guarantee atomic convergence.

3. **CST (Concrete Syntax Tree) YAML Document Frontmatter Serializer**:
   - Replaced ad-hoc JSON array serialization with unified `yaml` package `Document` CST formatting.
   - Ensures newly generated frontmatter arrays (`depends_on`, `tags`) serialize as standard YAML block sequences (`- item`) instead of bracketed strings.

4. **Timezone-Safe Local Calendar SM-2 Arithmetic**:
   - Decomposes `YYYY-MM-DD` strings into year, month, and day components and uses local date arithmetic with a `due.setFullYear(year)` guard to eliminate 1900-offset bugs for years `0000–0099` and negative-UTC-offset day shifts.

## Consequences
- **Positive**:
  - Vault notes without schema versions can be repaired non-destructively in a single command (`palee migrate --fix`).
  - High-concurrency async operations within a single Node.js runtime run without temp-file overwrites.
  - Frontmatter formatting remains clean, readable, and 100% compliant with standard YAML parsers.
  - Review intervals and due dates compute deterministically regardless of local timezone or historical dates.
- **Negative / Tradeoffs**:
  - Adds a small cryptographic entropy generation step per atomic write.

## Alternatives Considered

1. **Implicit On-the-Fly Schema Upgrades during All Read Commands**:
   - *Why Rejected*: Automatic mutation on reading violates the read-only idempotency invariant of `next`, `plan`, and `progress` commands.
2. **Global Single-Threaded Write Mutex**:
   - *Why Rejected*: Unnecessarily serializes distinct file writes across separate subdirectories, degrading throughput on large vault batches.
