---
description: "loadTopics is the boundary every command reads the vault through, and the v1.0.0 audit round hardened four things about it: what it accepts, what it remembers, what it refuses to read, and how long a lock may outlive its owner."
---


# ADR-0018: Note Read Path, Caching, and Locking

## Status

Accepted

## Context

`loadTopics` is the boundary every command reads the vault through, and the v1.0.0 audit round hardened four things about it: what it accepts, what it remembers, what it refuses to read, and how long a lock may outlive its owner. Each fix was small; together they change the cost model and the failure modes of every scan.

## Decision

### YAML comments are frontmatter

A note whose frontmatter carries `##`-style comments is a topic note. The parser accepts them; the loader no longer declines the note over them.

### Non-topic verdicts are negatively cached, in their own cache

A path already known not to be a topic note costs one `stat` on the next scan rather than a read plus a YAML parse, so scan cost tracks the topic count instead of the total vault size. The markers live in their **own** `FileCache` with their own cap (`MAX_NON_TOPIC_CACHE_ENTRIES`, 2000), not the topic cache: in a vault of several thousand ordinary notes, markers written into the topic cache would push every real topic past the eviction limit on each scan and turn the fix into a re-parse of the topics it was meant to protect. Entries are fingerprint/mtime-validated exactly like topic entries, so an edited file that gains a `palee_id` loads on the next pass without any clearing. Snapshot-injected content (`{ contents }`) never enters either cache — it is snapshot truth, not on-disk truth.

### A file over the read cap is declined stat-first, never read

`MAX_NOTE_SOURCE_BYTES` bounds what one scan will pull into memory: an exported log or a generated index in the vault is not a note, and reading it whole on every scan made scan cost unbounded. The decline is stat-first — the file is never opened — and silent here by design (the file simply is not a topic, exactly as an unreadable one is not), while `scanNotes` reports the same decline as a per-file diagnostic.

### Stale reads are decided by fingerprint when `mtime` cannot decide

Outside the `UNSETTLED_HORIZON` (2 s), the cache trusted a size + `mtime` match. On filesystems with whole-second `mtime` resolution, a same-second edit keeps `mtime` (and size) identical, so the entry read as a false hit. When the `mtime` carries no sub-second precision, the fingerprint decides: the cached entry is returned only if it still matches and evicted otherwise. The cache Map is LRU-bounded on `lastVerified`, which was previously a write-only field.

### A lock's liveness is probed, not just timed out

`isLockStale` runs a same-host liveness probe: when a lock records this machine's hostname, the holding PID is checked with `kill(pid, 0)` — a dead PID (`ESRCH`) is stale immediately instead of waiting out the timeout, `EPERM` (exists, owned by another user) counts as alive, and cross-host locks keep the timeout path. The same predicate gates the quarantine cleanup, so a lock with a fresh `mtime` but a dead holder is deleted rather than restored. This makes the previously-unread `hostname` field load-bearing.

### Entropy is four bytes, not two

`generateSessionId` drew `randomBytes(2)` beside a second-granular UTC timestamp: two sessions started in the same second collide about once in 65,536, and the collision is silent data loss — `writeSessionNote` computes its OCC fingerprint from the *target* file, so the new note satisfies the check against its own path and replaces the earlier session note. `generateLockId` had the same width, and there the consequence is worse than lost data: the id names the acquisition's own file inside the lockdir and `releaseLock` unlinks exactly that file, so a collision lets one process delete another's **live lock** — the precise failure the lockdir exists to prevent. Both now draw 4 bytes, and the width is pinned by tests asserting the full id shape, not just the prefix. `getDrafts` is sorted so recovery offers the same draft first on every OS.

### Glob segments are precompiled

`matchPathGlob`'s dynamic-programming inner loop compiled a fresh `RegExp` per DP cell; the same glob segment pattern is now compiled once per match. Behaviour is identical — `matchesPattern` output is unchanged — and the fast paths (literal segment, single-segment basename) are preserved.

## Consequences

### Positive

- Scan cost tracks the topic count, not the vault size; a vault of thousands of ordinary notes is no longer re-parsed on every command.
- An oversized generated file cannot stall or OOM a scan.
- A same-second edit is detected even on whole-second-mtime filesystems.
- A crashed process's lock is reclaimed on the next attempt instead of blocking for the stale timeout; a live lock cannot be deleted by an id collision.
- Draft recovery is deterministic across platforms.

### Negative / Tradeoffs

- **The unclosed-frontmatter heuristic can miss one shape, and over-report its mirror** (#427). `hasBodyTextLines` decides by *position alone*, because a swallowed Markdown heading and a legal `##` YAML comment between mapping entries are byte-for-byte the same line. Two residual directions follow, and both are accepted deliberately. A swallowed heading followed by a line that merely looks like `key: value` is **not** reported: that data-shaped line moves `lastYamlDataIndex` past the heading, so the heading stops looking trailing and the block reads as still running. The mirror costs a spurious warning the other way — a *trailing* `##` comment with a blank line before it is reported as an unclosed block, though it is legal YAML. Position cannot separate the two cases, and the miss is the cheaper failure: the note still parses and keeps its metadata, so the leak costs a diagnostic and never the note. Pinned both ways in `test/storage-scanner.test.ts`, so an edit that narrows either direction fails there.
- **An oversized topic note is dropped from the study graph with no warning from `loadTopics`** (#427). The cap is applied stat-first and the file is never opened, which is what keeps a generated index or an exported log from being parsed on every scan — but it means a file the user *intended* as a topic, one carrying a `palee_id`, simply is not there. `loadTopics` returns nothing for it and says nothing: whether an oversized file has an `palee_id` cannot be known without reading it, so any message emitted here would fire on exactly the non-note files the cap exists to ignore, on every scan. The decline is reported where diagnostics belong — `scanNotes` sets `readError` from `oversizedNoteDiagnostic` and `palee validate` surfaces it as a `read-failure` warning — and a topic that cannot be loaded cannot be recommended. Truncating it instead would invent a partial frontmatter for the loader to normalize, which is worse than its absence. Pinned in `test/storage-loader.test.ts`, including the silence.
- **The fingerprint fallback costs a hash** whenever `mtime` has no sub-second precision — which is most Windows filesystems. That is the price of correctness on the platform most users run.
- **The liveness probe is same-host only.** A lock from another machine still waits out the timeout; there is no cluster protocol, by design.

## Alternatives Considered

1. **Cache non-topic verdicts in the topic cache.**
   - *Why Rejected*: markers would evict real topics on large vaults and turn the optimization into a re-parse. A separate cache with its own cap costs well under a megabyte and leaves topic eviction exactly as it was.
2. **Give `hasBodyTextLines` a signal beyond line position**, so a swallowed heading is caught even when a `key: value`-shaped body line follows it.
   - *Why Rejected*: no such signal exists at this layer. The two lines are byte-for-byte identical, and the parser cannot distinguish a comment-between-entries from a swallowed body without the closing fence, which is exactly what is missing. The shape stays unreported on purpose rather than under a heuristic that would re-open #319's false positives. Recorded as an accepted limit in the tradeoffs above.
3. **Read oversized files partially** (first N KiB).
   - *Why Rejected*: a truncated frontmatter is a lie the loader would then normalize — worse than declining the file outright. An oversized note is not a topic; the scan says so once, by diagnostic, and moves on.
4. **Warn from `loadTopics` when a file is declined for size.**
   - *Why Rejected*: the check is stat-first precisely so the file is never opened, which means the loader cannot tell an oversized *note* from an oversized non-note — the generated index and the exported log it exists to skip look identical from the outside. An unconditional per-file warning would fire for those on every scan and train the reader to ignore it. `scanNotes` already reports the same decline where a diagnostic is actionable (`read-failure` in `palee validate`).
5. **Trust `mtime` alone and accept same-second misses.**
   - *Why Rejected*: the window is exactly the one that matters for a rapid edit-save-edit loop, and the fix is a hash the cache already computes for validation purposes.
6. **Keep the 2-byte ids and rely on the OCC fingerprint.**
   - *Why Rejected*: the OCC check passes *against the colliding file's own path*, which is why the collision is silent. For the lock id it is worse: the collision deletes a live lock. The width is one byte more of entropy for a collision class that disappears.
7. **Widen the lock timeout instead of probing liveness.**
   - *Why Rejected*: a crashed process's lock would block every writer for the full timeout on every occurrence; the probe answers the actual question (is the holder alive?) in one syscall, same-host.
