# ADR-0034: Reclaiming a Killed Writer's Temporary File, Bounded to the Target It Belongs To

## Status

Accepted — amends ADR-0005 §1 (*Entropy-Augmented Collision-Proof Temporary Files*), whose cleanup clause covers only a handled exception. Fixes [#481](https://github.com/Kuldeep2822k/cli/issues/481).

## Context

`atomicWrite` creates `<target>.tmp.<pid>.<entropy>` in the destination's own directory and unlinks it from the `catch` of a handled error. A process killed by a signal between the temp write and the `renameSync` runs no `catch` and no `finally`, so the file survives forever. Nothing else in the vault ever notices it: `walkVault`, `session.ts` and `lock.ts` are the only three directory enumerations in `src/`, and each filters on `.md`, on the `S-`/`DRAFT-S-` session prefix, or on `.json` respectively. A temp file matches none of them. So the residue is invisible to a rebuild, invisible to `validate`, and invisible to `palee` — but plainly visible in Obsidian's file picker, in a vault git diff, and in a backup. It is litter, not corruption: the target itself is never touched, which is why INV-08 was never violated.

That distinction sets the bar for the fix. Deleting a file in a user's vault is the operation this storage layer has always refused, and ADR-0002 set the precedent for the one case where it does delete: a stale lock is **quarantined by rename, never blind-deleted**, because the cost of a wrong deletion is somebody's data. A sweep has to earn that exception, and the objection recorded during the v0.6.0 audit against an earlier attempt was precisely this — a whole-vault reaper deletes arbitrary files as a side effect of opening a note, which is a policy decision disguised as a bug fix.

Two facts decide the shape. First, the temp name carries the owner's pid, so a sweep can ask whether the writer still exists. Second, the lock serialises writers of one target, so a writer holding that lock knows no cooperating local process is mid-write on the same note.

## Decision

1. **Scope is one target's own siblings, never the vault.** The sweep runs against `path.dirname(resolvedTarget)` and considers only names beginning with that target's basename. Opening a note reclaims that note's debris and nobody else's. A recursive walk of the vault is rejected; see Alternatives §1.
2. **Placement is part of the contract.** It runs after `lock.acquire()` and after the OCC check, before the temp file is created. Before the OCC check, a write that went on to refuse with `ECONFLICT` would still have mutated the directory, contradicting the guarantee ADR-0005 records for the conflict path. Before the lock, it would reclaim from behind a lock it does not hold. Both are pinned by their own test in `test/storage-atomic-write-stale-temp-reap.test.ts`, and each was proved by moving the call and watching that test fail. **`test/stress-concurrency.test.ts` does not catch a hoisted sweep** — measured, not assumed: with the sweep moved above `acquire()`, all 30 stress tests still pass, because a local writer's in-flight temp is younger than the 30-second floor, which is the guard doing its job. The stress suite therefore proves the predicate is safe under contention; only the two placement tests prove the placement.
3. **Deletion requires proof of abandonment, on two independent axes.** Both must hold: the pid in the name is **absent from this host's process table**, *and* the file is **older than a 30-second floor**. The earlier attempt joined those with `or`, which is how a sweep deletes a live writer's temp — age alone is not evidence of death. Requiring both also makes pid reuse fail safe: a recycled pid makes a stray look alive, so the worst outcome is litter that survives, never a write that is lost.
4. **The name must be one this primitive could have written.** The pattern is anchored at end-of-name and demands eight or more hex characters. `note.md.tmp.2147483647.abcd1234.md` is a **note** — `walkVault` enumerates anything ending in `.md` — and a prefix test alone would delete it. An older or foreign spelling whose owner cannot be parsed is left in place deliberately: this code deletes only what it can prove it wrote.
5. **`isFile()` gates first, and the age comes from `lstatSync`.** A symlink wearing the spelling is not a file this primitive created, and following one out of the directory is exactly the escape the containment work (#264, #335) exists to prevent.
6. **Every failure is a skip, never a raise.** An unreadable directory and an `EBUSY`/`EPERM` unlink — the ordinary answer on Windows when a scanner or sync client holds the handle — are swallowed. Litter in a vault must not cost the user their write.
7. **The tests separate the reaper from INV-08.** [#484](https://github.com/Kuldeep2822k/cli/issues/484) asks that a *failed* write leave no temp behind. Because a pre-write sweep could satisfy that assertion by deleting evidence the failure path never cleaned, the two behaviours are pinned by different tests, and the failure-path test asserts the order of the refused rename and the unlink of that same temp. Each guard above was proved load-bearing by removing only that guard and naming the test that then fails.

## Consequences

### Positive

- The residue from a crash, a power loss or a `Ctrl+C` mid-write goes away the next time that note is written, with no command to remember and no operator step.
- Nothing is deleted that this primitive cannot prove it wrote, in a directory it was already authorised to write to, while holding the lock that note's writer must also hold.
- The rejected whole-vault walk keeps the policy question unasked: no command ever scans and prunes a user's vault.

### Negative / Tradeoffs

- **This is not a correctness fix.** INV-08 held throughout, and no enumerator was ever misled. The change buys a clean directory.
- **A vault shared over a network filesystem is outside the predicate's reach.** The pid belongs to the host that wrote it; a live writer on a second machine looks dead here. The 30-second floor is what stands between that case and a lost write, and it is the reason `age` is required rather than merely sufficient. A reclaim that races a remote writer surfaces as that writer's `renameSync` failing `ENOENT` — its bytes are lost, the target is intact, and the exit code is 5, not the 4 a conflict normally reports.
- **`Ctrl+C` is still unhandled on the write path.** #481 also floats installing a `SIGINT` handler in `bin/palee.ts` that releases the lock and unlinks the in-flight temp before exiting 130. That is separate work: it changes signal semantics for every command, and the handler must run while an `fsync` or `rename` is in flight. The reclaim covers that residue either way, which is why it was not attempted here.
- **A third-party file wearing this exact shape is a candidate.** The predicate identifies an owner from the name alone, so any file named `<target>.tmp.<pid>.<8+ hex>` whose pid is dead here and whose age clears the floor gets deleted whatever wrote it. This cannot catch a *note*: `walkVault` enumerates only names ending in `.md`, and the anchored pattern refuses a name ending in anything else — which is why `note.md.tmp.2147483647.abcd1234.md` survives and is pinned as a test. So the exposure is limited to a non-note file a user or another tool happens to have named exactly this way.
- **`saveConfig` keeps its own copy of the shape** (`src/cli/config.ts:202`), outside the vault and outside this sweep. Its strays live in the config directory and are not reclaimed; #481 notes the identical structure.

## Alternatives Considered

1. **Reap the whole vault when it is next walked**, as the abandoned `fix/269-audit-sweep` branch did.
   - *Why Rejected*: it deletes arbitrary files under a user's vault root on the strength of a filename pattern, and it does so during a read-only command. That is a broader policy change than #481 asks for, and it buys nothing the scoped version does not — the litter is per-note, so the note's next write reaches it.
2. **Quarantine by rename instead of unlinking**, following ADR-0002's stale-lock precedent.
   - *Why Rejected*: quarantine exists for a lock because the lock's *contents* are evidence another process may still need. A temp file has no reader, and moving it merely relocates the litter the issue is about — the user still sees a stray in the file picker, now under a second name.
3. **Install a `SIGINT`/`SIGTERM` handler that cleans up and exits 130.**
   - *Why Rejected*: not as a complement — as the *only* fix it cannot self-heal. A `SIGKILL`, an OOM kill, a laptop battery dying, or a `fsync` that never returns all leave the residue with no handler running. #481 says the same. Signal semantics belong to every command and are worth their own issue.
4. **Leave the residue and let the user delete it.**
   - *Why Rejected*: nothing tells them it exists. The file is invisible to every `palee` command, so the only way to learn of it is to notice it in Obsidian and understand the naming scheme.
