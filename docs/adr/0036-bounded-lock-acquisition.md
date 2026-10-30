# ADR-0036: Bounded Lock Acquisition — A Non-Empty Lockdir Is Not a Retry Signal

## Status

Accepted

## Context

`createLock` recovers a stale lock by quarantining the records it observed, deleting what it can, and then removing the lock directory with `rmdirSync`. Three failure codes reached that removal and were answered three different ways: `ENOTEMPTY` and `ENOENT` shared one unconditional `continue` with no sleep and no bound, `EPERM`/`EBUSY` spent a five-attempt budget on Windows only, and everything else was rethrown.

The first was a hang. `ENOTEMPTY` after the sweep means an entry survived it — a leftover subdirectory, or a file another process holds open with no sharing. No amount of re-reading that entry removes it, so the loop re-ran the same sweep at 100% CPU for as long as it lived. Measured on the reporter's Windows machine: 10.47 CPU-seconds in 10 wall-seconds, until Task Manager.

Two facts made this visible as a defect rather than a design choice. The module's own policy comment promised that "a persistent handle surfaces to the caller rather than hanging the CLI in a busy spin", and the bounded path right below it kept that promise for `EPERM`/`EBUSY` — the `ENOTEMPTY` arm simply bypassed it. And INV-09 already promises that a persistent lock returns exit code `4`, which is the retryable-conflict class the rest of the storage layer reports.

Two premises in the originating issue were checked rather than accepted. Its cited ADR numbers (`0014-lock-recovery`, `0018-lock-liveness`) name files that do not exist — the live records are ADR-0018 (note read path, caching and locking) and ADR-0024 (exit codes). And its claim that `ENOTEMPTY` should behave "same as the EPERM/EBUSY path" inverts that path: it rethrows the raw `EPERM`, which `exitCodeFor` maps to `5`, so the EPERM path is itself the thing inconsistent with INV-09, and a test pins that inconsistency deliberately.

## Decision

### `ENOTEMPTY` is a budget, not a retry signal

The removal is attempted once, then retried `ENOTEMPTY_RETRY_ATTEMPTS` times (5) with the module's existing 50 ms-doubling-to-300 ms ceiling and ±25 % jitter, and then throws `Lock conflict: … would not empty after 5 retries; still present: <entries>` with `code = 'ECONFLICT'`. The budget is deliberately not one: when a rival merely won the directory between our `readdirSync` and our `rmdirSync`, the next round sees its fresh record and throws the precise "locked by PID" conflict instead of this one, so a single retry of grace is what distinguishes contention from corruption.

Every retry parks on `SyncWait.sleepMs` (`Atomics.wait`), which is what makes "no scenario spins for more than 100 ms without backoff" true by construction rather than by measurement: `createLock` is synchronous, so parking the thread is the only way to wait without burning a core.

### A directory entry fails fast; a file is waited out

The distinction is whether waiting can help. Nothing in this module writes a directory into a lockdir, so one found there is foreign residue that `rmdirSync` will never get past — waiting cannot change the outcome, so it is named and refused on the spot. A file is different: a handle another process holds open clears on its own.

`unlink` cannot tell the two apart by code alone — it reports `EISDIR` on POSIX and `EPERM` on Windows, and that `EPERM` collides with the transient one. One `lstatSync` on the failure path separates them. The probe is best-effort: an `lstatSync` that itself fails reports "not a directory", so a vanished or unreadable entry falls back to the bounded retry rather than being misdiagnosed as permanent.

### `ENOENT` remains the only unbudgeted `continue`

`ENOENT` reports that the directory is already gone, so the next `mkdirSync` is a real acquisition attempt. Budgeting it would turn a lost race into a spurious conflict.

### The acquisition loop is capped

`createLock`'s loop runs at most `MAX_ACQUISITION_ITERATIONS` (20) rounds. This is a backstop, not a contention policy: the budget above bounds the only branch that cannot observe a state change, and this cap makes termination a property of the code rather than an argument about which branch may `continue`. Reaching it means another process keeps deleting the directory we are about to create — contention, not corruption — so it exits `4` like every other conflict. The cap must stay greater than the budget plus one, or it would pre-empt the budget's own conflict and blame churn for an entry that never cleared.

### One budget covers both paths that can reach it

The Windows `EPERM`/`EBUSY` retry loop can also answer `ENOTEMPTY`: a transient directory handle clears during the park, and the next attempt finds a file that survived the sweep. That answer used to be free forward progress, so the budget was unreachable there and the loop cap eventually reported churn for what was a stuck entry. Both sites now call one `spendEnotemptyBudget`, which is what keeps the counter, the park and the message from diverging.

### The heuristic asks about other people's work, not about the budget

`incomingConflict` answers "could this directory's freshness belong to someone else?". Two states say yes: the directory is empty (a rival created it and has not written its record yet), or it holds a `.json.quarantine` (another recovery is between its rename and its restore). Those are also the only states in which the sweep could undo a rival's work — `rmdirSync` on an empty directory takes it away, and unlinking a quarantine destroys the record a live holder is about to be given back, after which that holder keeps writing while the next acquirer holds.

It used to ask that question of any directory with no `.json` record, which misfired on the residue this module is trying to clear: our own sweep stamps the directory mtime the check reads, so the next round concluded a rival had just arrived and abandoned a real residue. Gating the check on the retry budget instead would have fixed the message and broken mutual exclusion in a different way — a rival that replaces the lock directory mid-budget leaves it young *and empty*.

A directory holding only foreign residue is therefore never an incoming process, and the two states above always are. The quarantine term is independent of how many `.json` records sit beside it: a stale record of our own is not permission to sweep someone else's in-flight recovery, and a gate that required "no `.json` at all" missed exactly that pairing. A quarantine older than the 5 s window counts as abandoned rather than live, so a crashed recovery still self-heals.

### A failed restore is a conflict, not a swallow

The sweep quarantines a record by rename, re-checks staleness, then either deletes the copy or puts it back. A failed put-back used to disappear into a bare `catch`: that holder still believes it owns the target while its record is gone, so the next acquirer takes the directory and both write. It is now a `Lock conflict` — retryable, and honest about which hazard it avoided.

### Residue names are escaped before they reach a terminal

Conflict messages carry entry names into stderr and into captured logs, and POSIX permits a newline or an ANSI escape sequence inside a filename. `printableEntryName` spells every C0 control character, DEL, and the C1 range (U+0080–U+009F) as `\xNN`, so the residue stays identifiable while an unescaped name cannot forge, hide or recolor the lines around the error it appears in. C1 is included because Node decodes it from valid UTF-8 and some terminals treat U+009B as a CSI introducer — the same forgery by another route. The escaping runs per character over a short name, so it happens unconditionally rather than relying on a platform refusing the name.

### Every contention path throws through one builder

`lockConflict()` now covers five cases: a fresh lock, an incoming lock, an unclearable directory (the fail-fast on a directory entry and the spent `ENOTEMPTY` budget are the same hazard), a failed restore, and the loop cap. The `Lock conflict:` prefix is how `isConflictError` recognises the error by text as well as by code, so a new path cannot invent a wording that exits `5` by accident.

## Consequences

### Positive

- A lock directory that cannot be emptied ends in a diagnosable conflict that names the entries still in it, instead of an unbounded loop. That is the difference between a user clearing one stray file and a user killing the process.
- The `EPERM`/`EBUSY`, healthy-contention and ordinary stale-recovery paths were not touched, so their cost models and their live-holder precision are exactly what they were.
- Termination is now structural: every `continue` in the loop either observes a state change or is bounded.

### Negative / Tradeoffs

- **A lost `ENOTEMPTY` race now pays up to 300 ms before the precise conflict.** Partly self-correcting: during that pause the rival usually releases and this call *acquires* — which the old code never did. Rare enough to be the right trade against an unbounded loop.
- **The residue list comes from the round's own `readdirSync`, not a fresh one.** It names what was there when the sweep started, so an entry created during the budget is not listed. Zero extra syscalls on the failure path was judged worth more than that last-gasp accuracy.
- **The `EPERM`/`EBUSY` path still exits `5`, not the `4` INV-09 promises.** Deliberate: it is pinned by a test, and changing it here would bundle a second contract change into a hang fix. Recorded as a follow-up rather than smuggled in.
- **`WINDOWS_RETRY_INITIAL_DELAY` and its siblings now back a cross-platform policy** while keeping a Windows-flavoured name. Renaming them would force an edit to the EPERM arm for zero behaviour gain; the doc comment states which part of the block is Windows-specific instead.

## Alternatives Considered

1. **Unify `ENOTEMPTY` with `EPERM`/`EBUSY` into one helper that throws `ECONFLICT` for both.**
   - *Why Rejected*: it changes a behaviour the suite pins (`code === 'EPERM'`) and turns a *permanent* POSIX `EPERM` — a read-only mount, an ownership problem — into ~950 ms of pointless parking before reporting a conflict instead of the real error. The INV-09 mismatch it would incidentally fix deserves its own change.
2. **`fs.rmSync(lockDir, { recursive: true })` on the stuck directory.**
   - *Why Rejected*: it deletes arbitrary content this module never created, and its cost is unbounded on a deeply nested tree. Content inside a lockdir that palee did not write is diagnosed, never repaired.
3. **A wall-clock recovery deadline alongside the counters.**
   - *Why Rejected*: redundant with a no-progress counter plus an iteration cap, dependent on the machine's clock, and reachable only through hostile `fs` patches — which makes it untestable in the way ADR-0026 requires.
4. **Track every unremovable entry through the quarantine `catch` as well.**
   - *Why Rejected*: a failed `renameSync` there is often a rival's *successful* rename, i.e. progress. The tracking would misclassify progress as a stall, and the `ENOTEMPTY` outcome already answers the question the tracking was for.
5. **Reset the retry counter whenever a round makes progress.**
   - *Why Rejected*: the counter only increments on a non-progress outcome, so a reset buys nothing — and the only sequence that could exhaust six consecutive retries is one where a rival holds the lock, which is precisely when `ECONFLICT` is the correct answer.
6. **Bound the loop by deadline instead of a count.**
   - *Why Rejected*: a count is deterministic and directly assertable; a deadline is neither.
