---
description: "atomicWrite is the single write primitive every vault mutation goes through — roadmap, adopt, migrate, review, session, and the .palee tree itself. ADR-0002..."
---


# ADR-0014: Atomic-Write Durability and Vault Containment

## Status

Accepted

## Context

`atomicWrite` is the single write primitive every vault mutation goes through — roadmap, adopt, migrate, review, session, and the `.palee` tree itself. ADR-0002 established the shape (lock + fingerprint OCC + temp-file rename); this ADR records what the v1.0.0 audit round changed about it, because each change fixed a claim the primitive made in prose that it did not keep in code.

Three of those claims were wrong at once. The module docstring said a write "flushes data and metadata to physical storage" while only the file fd was ever flushed; it promised mode preservation it never performed; and it certified the destination only lexically, so a junction planted mid-path moved note content outside the vault and reported success (#280 reproduced `palee session end` exiting 0 with the session note filed outside the vault, invisible to `walkVault` and therefore to `validate`).

## Decision

### Containment is the first statement, and the certified path is the written path

`assertContainedInVault` runs before anything else — before the `Lock` is even constructed, because `getLockDir` creates `.palee/locks` the moment it runs, so a refusal raised after acquisition would still have left lock metadata behind for a destination it had just rejected. The canonical path the guard returns is then used for *every* filesystem operation below: the guard resolves a relative destination against the vault root, while `targetPath` passed verbatim to `fs` would reach the filesystem relative to the process cwd — certifying one spelling and writing another could put bytes somewhere the guard never looked.

The guard lives in the one primitive rather than at each call site, so roadmap, adopt, migrate, review and session inherit it instead of each re-implementing it badly. The `.palee` tree is asserted where it is *created* (`getPaleeDir`/`getSessionsDir`, `getLockDir`), because a refusal raised only at the note would still have let `mkdirSync` make a directory outside the vault on the way there. Every site runs the same predicate, so notes, directories and locks share one refusal surface — `ECONTAINMENT`, exit 3.

The assertion is re-run on every attempt, immediately before the temp file is opened and the destination renamed, and the re-check **binds** rather than merely passes: if the destination now resolves elsewhere, that is an `ECONFLICT` — the retryable class — because the next call re-resolves, locks the path it now resolves to, and re-reads that file's fingerprint. The residual gap (one syscall between the re-check and the `openSync`) is stated in the code as not closable from JS: Node exposes no relative, no-follow open of an ancestor.

### A final-component link inside the vault is written through, not replaced

The OCC read follows the link, so renaming onto the spelled path would have the writer verify the linked note's fingerprint and then replace the link itself — the verified fingerprint would never match again, the bytes would land in a new regular file, and one note would live under two paths minting two `palee_id`s. Writing through keeps read and write on one file. A link that resolves *out* of the vault is refused, with the link left intact.

### Existence is a statement the caller makes, not an absence of one

`expectedFingerprint = null` used to mean "the file did not exist when I read it," which silently disabled the whole OCC block — so the second of two concurrent creators of `.palee/hot.md` overwrote the first's brand-new file and nobody could tell. The expectation is now explicit:

```typescript
// first creation: fails with ECONFLICT if someone else created the file first
await atomicWrite(vault, target, content, null, { expectExists: false });
// overwrite: the fingerprint of the content that was read is mandatory
await atomicWrite(vault, target, content, fingerprint, { expectExists: true });
```

A caller that expected absence cannot also hold a fingerprint of it, and one that expected an overwrite cannot be relying on nothing to attribute it with — either combination is a caller bug, and refusing it keeps a guard from degrading back into a silent overwrite. This is what makes a first-creation write and a lost-lock write detectable (#423), and it is what the adopt rollback journal now uses when it restores a note: the revert states its expectation — the note exists, and it must still hold exactly what our adoption wrote.

### The destination's mode is captured before the temp file is opened

`openSync(tempPath, 'w')` creates the temp file with the umask default, and `renameSync` replaces the destination inode — so a file deliberately set to 0600 came back world-readable after any rewrite. The mode is now `statSync`ed off the destination and `fchmodSync`ed onto the temp fd *before* the fsync, so the flushed metadata already carries it. A missing destination keeps the default mode: this primitive preserves, it never tightens — tightening is `saveConfig`'s own job, which has its own `openSync(tempPath, 'wx', 0o600)` path and does not go through here. On win32 the POSIX bits are decorative (NTFS resolves access through the directory ACL), so the preservation is correct where the bits mean something and harmless where they do not.

### The rename itself is made durable

Flushing the file fd does not make the *rename* durable: on POSIX the new directory entry lives in the directory's own metadata, so a crash right after a "successful" write could roll the file back to pre-write content. The containing directory is now fsynced after the rename, best-effort — a platform that refuses to open a directory or fsync the handle (win32 raises `EPERM`/`EISDIR`) is no worse off than before, and the write still succeeds.

## Consequences

### Positive

- One guard point covers every write path; the three refusal surfaces (notes, directories, locks) cannot disagree because they share the predicate.
- A 0600 file stays 0600 through any rewrite, and a crash after a successful write cannot silently roll the rename back on POSIX.
- Concurrent first creation of the derived `.palee` views is a retryable conflict instead of a lost update.
- The adopt rollback journal is verified rather than best-effort: a note that was adopted, reverted, or rewritten by a process that took the lock over is caught by fingerprint instead of silently restored to the wrong bytes.

### Negative / Tradeoffs

- **The final TOCTOU gap is documented, not closed.** One syscall wide, between the re-check and the `openSync`; Node exposes no `openat`-style relative no-follow open of an ancestor. The code says so instead of implying completeness.
- **The directory fsync is best-effort**, so on Windows the durability claim is weaker than on POSIX by necessity, not by choice.
- **Mode preservation is never tightening.** A new file gets the umask default through this primitive; callers that need 0600 (the config writer) have their own path, which means two mode policies exist in the codebase by design.

## Alternatives Considered

1. **Keep the containment check at each call site** (validate the path where it is built).
   - *Why Rejected*: #280 is the argument — the check existed at the final-component level and nothing asked whether the resolved destination was still inside the vault. Call sites forget; the primitive cannot.
2. **Certify the path once and trust it through the `await`s.**
   - *Why Rejected*: everything between the first certification and the write is `await`s — `lock.acquire()` and its retry sleeps, then the OCC read — and a component replaced with a link during that window still spells an in-vault destination. The re-check costs two `realpathSync` calls and replaces a window spanning a retry loop with one spanning a syscall.
3. **Replace final-component links instead of writing through them.**
   - *Why Rejected*: the OCC read follows the link, so replacing it splits one note across two names with a fingerprint that belongs to the file the write ignored. Write-through keeps read and write on one file.
4. **fsync the file fd and call that durability.**
   - *Why Rejected*: that was the shipped prose, and it was false — the rename's durability lives in the directory entry. The claim was corrected in the docstring and the flush added to the code in the same change.
5. **Tighten modes for new files through this primitive too** (0600 everything).
   - *Why Rejected*: notes are not secrets and vaults are shared with Obsidian; a blanket tighten would fight legitimate vault permissions. The one file that is a secret (the config) has its own writer with its own mode.
