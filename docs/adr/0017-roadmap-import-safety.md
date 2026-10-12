# ADR-0017: Roadmap Import Safety

## Status

Accepted

## Context

`palee roadmap --from` rewrites `depends_on` across the whole vault, and it is the one command whose blast radius is the entire graph rather than a single note. The v0.6.0 audit found five ways it could leave the vault in a state its own validation pass had just cleared — each reproduced against the release tree before anything was written.

The core shape: the command cycle-checks the *declared* graph up front, then writes topics one at a time. Anything that makes the written plan differ from the validated plan — a skipped topic keeping its own edges, a path that resolves elsewhere, an id that violates the tool's own format rule — breaks the contract "cycle detected ⇒ exit 3, write nothing" (INV-46) in a way only visible after the fact.

## Decision

### A skip that changes the graph is decided before the first write

When a topic's existing note cannot be read, the write loop skips it — and a skipped note keeps whatever `depends_on` it already carries, which is neither the list the roadmap declared nor the list the validator cleared. One stored backward hop closes a loop the check never saw: the import writes, exits 1, and leaves the vault in exactly the state INV-46 says means exit 3 and no writes.

The declared graph is therefore rebuilt with each unreadable topic contributing the edges its note *holds* rather than the ones the roadmap meant for it, and checked again **before any write**. A cycle appearing only under that reading is refused, with the ids named, because "this note could not be read" is the reason the plan changed. Refusing every unreadable note would have been simpler and worse — it throws away a partial import the learner can act on.

### The topic ID format is enforced before any write

`id` is checked against the same `T-` + lowercase-kebab-case rule `validate` uses, on the parsed topic list, so all four input formats (pure YAML, Markdown frontmatter, fenced YAML block, wikilink) are covered and a malformed id cannot be written and then met by `validate` afterwards — at which point the notes, and every edge naming those ids, were already on disk.

### `--dry-run` prints the full per-note write plan

Id, target path, resolved `depends_on` (chain synthesis and on-disk preservation made visible), create-vs-update from the same existence test the import uses — and zero bytes written. The command rewrites prerequisite edges across the vault; a preview that shows less than the commit does is worse than none, because it is the one a cautious user runs *before* trusting the command.

### The path boundary is canonical, and the final component is inspected

A declared path is canonicalized through its nearest existing ancestor (a symlinked temp root must not read as an escape), and `lstat` — not `existsSync` — is the existence test, because `existsSync` follows a link and reports false for a dangling one: the guard never ran and the rename replaced the link, importing outside content and destroying the original link. The read half is bound to the file the `lstat` validated (inode + device, `readBoundNote`), so a link planted after the check is caught before any bytes are imported; the skip is per topic, like its neighbouring guards, so one racing path cannot abort the batch. The residual race is recorded as a gap: `O_NOFOLLOW` is undefined on win32, so a descriptor-bound open "would look like a fix and do nothing" — the static case (a symlink present in the checkout) is closed, the raced case is documented (#217).

### The dangling-edge audit keys on final writers

A topic stops existing when the import writes a different id over the note it lived on, so it cannot count as a known target just because the pre-batch scan saw it. The audit keys on where the bytes actually landed — an absolute in-vault path and an `n/./1.md` spelling both write the one note the loader knows by a single relative path — and only the last id to win a path is a topic that still exists, with edges that survive on disk.

### The effective field values have one derivation

`resolveTopicUpdates` is the single source of truth for both the validation pass and the writeback pass. This is not a style rule: the #137 cycle-on-import defect was exactly the divergence pattern — two call sites re-deriving the same field with subtly different rules. The function is pure; the writeback calls it with fresh at-path frontmatter re-read just before the atomic write (OCC requires re-reading at write time), and validation calls it with the pre-import snapshot. Same rules, fresh data per pass.

## Consequences

### Positive

- The validated plan and the written plan cannot differ silently; a graph that only holds if unreadable notes are rewritten is refused before the first byte.
- The import surface matches `validate`'s own rules, so a roadmap that imports clean also validates clean.
- The dry-run is diffable against the commit — the preview prints the write plan, not the plan's full predecessor map (which spans already-adopted notes the commit never rewrites).

### Negative / Tradeoffs

- **The unreadable-note case refuses the whole import** when the held edges would close a cycle. That is the point — but it means a single unreadable note can block a batch the learner expected to complete, and the error names the note rather than guessing.
- **`lstat` + inode/dev binding closes the static symlink case only.** The raced case needs an `openat`-style primitive Node does not expose on win32; the gap is written down in the code rather than papered over.
- **One derivation function means every new import field touches one place** — which is the intent, but it also means a field added to one pass and not the other is now a compile-visible omission rather than a silent divergence.

## Alternatives Considered

1. **Let the write loop skip unreadable topics and report at the end** (status quo before #291).
   - *Why Rejected*: the skipped note keeps its own edges, so the plan that lands is not the plan that was validated, and the vault ends in the state INV-46 reserves for exit 3 and no writes. The issue's own repro showed `validate` reporting a cycle *after* a successful import.
2. **Refuse any import containing an unreadable note.**
   - *Why Rejected*: throws away a partial import the learner can act on. The rebuild-and-recheck keeps the resilience while closing the divergence.
3. **Check the topic ID format at write time per topic.**
   - *Why Rejected*: the batch would write the valid topics and then fail on the invalid one, leaving a half-imported graph — the same class as the skip defect, one level down. All-or-nothing before the first write is the only shape that matches the exit-3 contract.
4. **Validate the declared path lexically and inspect ancestors as they are created** (create-then-verify).
   - *Why Rejected*: a link planted in the window between the ancestor read and the `mkdir` makes the recursive create materialize directories outside the vault, and the refusal — while fail-closed — arrives after the damage (ADR-0014's `ensureVaultDirectory` reasoning, same shape).
5. **Let each pass derive its own effective values** (the pre-#139 shape).
   - *Why Rejected*: it produced #137. Two derivations of one field diverge exactly when a subtle rule differs, and the divergence is invisible until the vault is wrong.
