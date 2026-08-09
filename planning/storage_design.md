# PALEE Obsidian Storage Design

## Source of Truth

Topic Markdown notes and confirmed session notes inside the connected Obsidian vault are canonical. `.palee/index.md`, `.palee/hot.md`, and any SQLite/JSON cache are derived artifacts. They may be deleted and rebuilt without losing learning data.

## Frontmatter Preservation

PALEE must not deserialize frontmatter into a plain object and serialize the whole note with a generic YAML dumper. That can remove comments, reorder keys, discard unknown plugin metadata, and damage user-authored formatting.

The updater must:

1. Parse only frontmatter at the beginning of the file.
2. Preserve the Markdown body exactly as read.
3. Mutate only PALEE-owned keys.
4. Preserve unknown keys, comments, ordering, and scalar styles where the parser supports it.
5. Reject ambiguous or malformed frontmatter without rewriting the note.

Use a YAML concrete-syntax-tree/document-preserving implementation. A library that only parses and dumps ordinary JavaScript objects is not sufficient.

PALEE-owned keys are currently:

```text
palee_schema
palee_id
topic
track
difficulty
status
dependencies
assessment
review
```

Unknown keys such as `aliases`, `tags`, `cssclasses`, and plugin-specific fields must remain untouched.

## Conflict-Aware Atomic Writes

Every write follows this protocol:

```text
acquire an exclusive PALEE lock for the target
read target
compute fingerprint(path, size, mtime, content hash)
parse and modify a preserved document
re-read target and compare fingerprint
if changed: abort with a conflict
write temporary file in the same directory
flush and close the temporary file
atomically replace the target
release the lock in a finally block
```

Atomic replacement prevents partial files. Fingerprint comparison prevents PALEE from overwriting a change made before the lock was acquired or during the read/parse phase. The lock closes the remaining PALEE-to-PALEE race between the final fingerprint check and replacement. External applications that do not honor PALEE locks are still protected by fingerprint checks and conflict reporting, but cannot be made fully transactional by a user-space CLI.

The lock is created with exclusive-create semantics at `.palee/locks/<sha256-canonical-relative-path>.lock` and contains:

```yaml
lock_id: L-20260808-180000-a1b2
target: notes/Git-Rebase.md
pid: 12345
hostname: workstation
created_at: 2026-08-08T18:00:00+05:30
heartbeat_at: 2026-08-08T18:00:00+05:30
```

PALEE-owned locks are held through the complete read/modify/write/rename sequence. The default heartbeat interval is 15 seconds for operations lasting longer than 30 seconds — this applies to AI tutor sessions, guided roadmap generation, and batch adoption of multiple notes. Heartbeat updates are implemented as in-place lock file rewrites (same atomic temp-file + rename protocol) that update only the `heartbeat_at` field; if a heartbeat write fails (I/O error, disk full), the operation continues and the next heartbeat attempt occurs at the next interval. A lock is considered stale only when `heartbeat_at` is older than the stale timeout. The default stale timeout is **60 seconds on Windows** and 120 seconds on other platforms, because Windows does not guarantee `finally` blocks run on hard process kills, making abandoned locks more likely. The stale timeout is configurable via `palee config` for users who need to tune it. This tolerates short process pauses and scheduling delays without leaving abandoned locks indefinitely. If a lock already exists within that window, PALEE reports a conflict.

For a stale lock, recovery must atomically rename the old lock to `.stale.<lock_id>.<recovery_id>` before creating a new lock. It must never blindly delete a lock. If new-lock creation fails after quarantine, the quarantined record remains for diagnosis and recovery. The lock is released in a `finally` path after success or failure.

On Windows, replacement failures such as `EPERM` or `EBUSY` should be retried briefly and then reported as a recoverable conflict. PALEE must never fall back to truncating the original file.

The default retry policy is five attempts with exponential backoff and jitter, capped at 300 ms per delay. The exact timing is configurable and must be covered by tests; retrying must not bypass lock acquisition or fingerprint comparison. A lock or rename failure returns the documented optimistic-concurrency conflict rather than falling back to an unsafe direct write.

## Safe Vault Traversal

The default walker:

- includes Markdown files only
- skips `.obsidian`, `.trash`, `.git`, `node_modules`, and all dot-directories
- does not follow symlinks
- tracks visited real paths if symlink support is explicitly enabled
- reports unreadable files as validation warnings
- never allows one malformed note to crash the entire command

Traversal should use a streaming directory walker with bounded concurrency. It must not follow symlinks by default and must cap open file handles so large vaults cannot exhaust the operating-system descriptor limit.

## Validation Behavior

`palee validate` reports errors by file and field. Read-only commands such as `next`, `plan`, and `progress` skip invalid notes, continue processing valid notes, and display a warning count. Mutation commands refuse to modify an invalid target until the issue is fixed.

Examples of invalid data include an unknown status, non-integer difficulty, a string dependency instead of an array, a missing `palee_id`, or scores outside `0.0` to `1.0`.

## Incremental Indexing

The rebuildable cache may store path, file size, modification time, and a content fingerprint. Unchanged files can reuse their parsed representation. When metadata is unreliable or a conflict is suspected, PALEE re-reads and hashes the file. Cache failure must fall back to a safe scan, not prevent access to the vault.

When a file is recently modified or its filesystem timestamp has coarse resolution, PALEE must verify a content fingerprint before reusing a cached parse. A size-and-mtime match alone is not sufficient during the unsettled cache horizon. The unsettled horizon is **2 seconds**: if `(current_time - mtime) < 2_seconds`, PALEE recomputes the fingerprint before trusting the cache entry. This guards against filesystems with 1-second mtime resolution and rapid edit-save cycles.

## Session Checkpoints

Active session checkpoints use the same preserved, atomic write contract. A checkpoint is written after each meaningful learner turn or tool result to `.palee/sessions/DRAFT-S-<unique-id>.md` — the same directory that holds confirmed session records. Checkpoints are recoverable drafts, not confirmed learning history.

On startup, PALEE scans for drafts and offers:

```text
[R]esume  [S]ave as session  [D]iscard  [I]gnore
```

Non-interactive mode must never discard a draft automatically. It reports the draft path and exits with a recoverable-state message.
