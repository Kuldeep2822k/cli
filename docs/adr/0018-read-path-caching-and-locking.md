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

- **Two accepted trade-offs are preserved deliberately** (#427), and the "obvious fix" for each is net-negative: (a) the unclosed-frontmatter heuristic can miss one shape — a swallowed heading followed by a `key: value`-shaped line — because that shape is byte-identical to a legal `##` YAML comment between mapping entries, and position is the only signal; the chosen direction fails safe (the note still parses; the leak costs a warning, not the note's metadata). (b) An oversized topic note is dropped rather than partially read — a topic that cannot be loaded cannot be recommended, which is honest, and truncating it would invent a partial frontmatter.
- **The fingerprint fallback costs a hash** whenever `mtime` has no sub-second precision — which is most Windows filesystems. That is the price of correctness on the platform most users run.
- **The liveness probe is same-host only.** A lock from another machine still waits out the timeout; there is no cluster protocol, by design.

## Alternatives Considered

1. **Cache non-topic verdicts in the topic cache.**
   - *Why Rejected*: markers would evict real topics on large vaults and turn the optimization into a re-parse. A separate cache with its own cap costs well under a megabyte and leaves topic eviction exactly as it was.
2. **Read oversized files partially** (first N KiB).
   - *Why Rejected*: a truncated frontmatter is a lie the loader would then normalize — worse than declining the file outright. An oversized note is not a topic; the scan says so once, by diagnostic, and moves on.
3. **Trust `mtime` alone and accept same-second misses.**
   - *Why Rejected*: the window is exactly the one that matters for a rapid edit-save-edit loop, and the fix is a hash the cache already computes for validation purposes.
4. **Keep the 2-byte ids and rely on the OCC fingerprint.**
   - *Why Rejected*: the OCC check passes *against the colliding file's own path*, which is why the collision is silent. For the lock id it is worse: the collision deletes a live lock. The width is one byte more of entropy for a collision class that disappears.
5. **Widen the lock timeout instead of probing liveness.**
   - *Why Rejected*: a crashed process's lock would block every writer for the full timeout on every occurrence; the probe answers the actual question (is the holder alive?) in one syscall, same-host.
