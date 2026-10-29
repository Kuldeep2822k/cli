---
description: "Two independent defects, one theme: a comparison or rewrite that half-applied a rule the rest of the pipeline applied fully. Both produced silent, permanent divergence — the failure direction this codebase treats as unacceptable."
---


# ADR-0016: Frontmatter Byte Fidelity and Unicode Fold Discipline

## Status

Accepted

## Context

Two independent defects, one theme: a comparison or a rewrite that half-applied a rule the rest of the pipeline applied fully. Both produced silent, permanent divergence — the failure direction this codebase treats as unacceptable.

**Byte fidelity** (#272): `updateFrontmatter` emitted `---\n${yaml}---\n` from both return sites, and `parseFrontmatter` strips a leading U+FEFF that nothing put back. Any command rewriting one key therefore re-serialised the whole head with LF into a file whose body was still CRLF, and destroyed the BOM. Reproduced on a three-note CRLF vault through `palee migrate --relabel-ties`: the untouched note was the control — `CRLF=12 loneLF=0` before and after — while the written note came back `CRLF=4 loneLF=8`, mixed, and the BOM'd note lost its BOM. The damage belonged to the writer, not the reader.

**Unicode fold** (#281, #289, #292): `walkVault` matched the Markdown extension case-sensitively while `isResolvableNotePath` folded it, so a `Setup.MD` was invisible to `loadTopics` yet resolvable as a link target. `withWalkedCasing` folded the index key with case + NFC but compared full paths with `toLowerCase()` alone — on APFS a composed `café` link resolved to a spelling no directory listing contains, and callers keyed already-adopted notes and duplicate-target detection by that string. Three more half-fold sites remained in the declared-prerequisite index and its dedup key.

## Decision

### A rewrite keeps the note's line terminator and BOM

Two private helpers: `detectLineTerminator(region)` reads the convention off the input rather than the platform — a vault can legitimately hold both, and the rebuilt head must agree with the body it did not touch — and `renderFencedBlock(yamlText, eol)` retimes the YAML body too, since the `Document` API's `toString()` is LF-only. The BOM is stripped by the parser and re-emitted by the writer.

The principle: `updateFrontmatter` is CST-preserving (ADR-0003) — body byte-for-byte, unknown keys, comments and order survive — and "byte-for-byte" has to include the bytes *around* the frontmatter, not just under it. A mixed-terminator file is a corrupted file.

### One fold, at every comparison

Case **and** Unicode (NFC), applied by both sides of every identity comparison. Case because `isResolvableNotePath` already folds it, and a fold only one side performs is no fold. Unicode because APFS stores an accented name decomposed — `café` + U+0301 — while a link typed for it arrives composed, and `toLowerCase()` alone leaves those two unequal: the note resolves to nothing, and an accented subtree chains to no predecessor at all.

The fold lives in one place (`foldIdentity` / `foldNoteKey` in `vault-walker.ts`) and every comparison that keys notes goes through it — the walker's index, `isResolvableNotePath`, `withWalkedCasing`'s re-spelling, the declared-prerequisite index (`prereqByPath` / `prereqByBase`), and the extraction dedup key (`${form}:${name.toLowerCase().normalize('NFC')}` — the same note named in both spellings became two declarations before the fix).

### A link destination means what the author wrote

Covered in full in ADR-0011's link-parsing discipline; recorded here because the same review round produced it and the theme is identical: the scanner must not clean, split, or decode in an order that resolves a destination onto a *different* real note.

## Consequences

### Positive

- A CRLF vault stays CRLF through any single-key rewrite; the BOM survives; a mixed-terminator file is no longer producible by the CLI.
- An accented note resolves from either spelling, so a prerequisite typed composed finds a note stored decomposed.
- One fold function means adding a comparison site cannot half-apply the rule — the compiler-visible helper is the only spelling.

### Negative / Tradeoffs

- **The fold is case-insensitive everywhere, including on case-sensitive filesystems.** On Linux, `Setup.md` and `setup.md` are two different files that the index now treats as one name. That collision is theoretical in an Obsidian vault (Obsidian itself is case-insensitive about links) and the alternative — a fold on some comparisons and not others — is the defect this ADR closes.
- **`dev:inode` was considered and rejected as the identity key**: `st.ino` is 0 on FAT32/exFAT and redirected cloud volumes, which would collapse every note to `dev:0` and produce false duplicates — the opposite failure. The walked-casing re-spell was chosen instead: identity from the maps the pipeline already agrees on, no extra syscalls.

## Alternatives Considered

1. **Emit LF always** ("normalize on write").
   - *Why Rejected*: it corrupts the other 12 lines of a CRLF note to fix one key, and the untouched-note control proved the writer was the only thing making the file mixed. The vault's convention is the vault's business.
2. **Fold case only, ignore Unicode** (status quo before #289).
   - *Why Rejected*: APFS decomposition is what a synced vault carries onto any volume, and the composed/decomposed pair is exactly the link a learner types. The re-spell existed to remove that divergence and was itself performing half of it.
3. **Key note identity on inode + device.**
   - *Why Rejected*: 0 on FAT32/exFAT and on redirected cloud volumes (Dropbox/iCloud are explicitly in scope in the storage docs), collapsing every note to `dev:0`; `statSync` throws on a path deleted mid-scan; hardlinks become "the same note." The identity source the maps already agree on needed no new syscall and no new failure mode.
4. **Trim the delimiters loosely in the frontmatter guard** (accept `--- ` as an opener).
   - *Why Rejected*: covered in ADR-0015 — a trim disagrees with the parser in both directions, and the dangerous direction strands an identity.
