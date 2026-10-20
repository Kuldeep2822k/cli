# ADR-0022: Adoption — Non-Destructive, Reversible, Honest About Filters

## Status

Accepted

## Context

`palee adopt` writes `palee_id` and the SM-2/assessment frontmatter into the learner's own notes, and it is documented as strictly non-destructive. The v0.6.0–v1.0.0 rounds found three ways it was not, one way it could not be undone, and one way its filters lied about what they did. Each fix is small; together they define what "non-destructive" has to mean for a command that edits files the learner wrote.

## Decision

### A hand-written `depends_on` survives first adoption

A note that declares its own prerequisites in frontmatter before it has ever been adopted lost them to the inferred chain edge — in all three invocations. The write was unconditional, so `adopt <note>` came back with `depends_on: []` over a note carrying `depends_on: [T-real]`, and `adopt --all --auto-chain` replaced the learner's list with the chain's id and stamped it `numbered` — "the learner's real gate deleted, a filename collation gating in its place, and since `topic_mastery` never rises on its own, that swap is permanent."

A hand-written list is the same claim a `## Prerequisites` section makes, so it takes the `declared` label and survives. `--depends-on` still outranks the note: passing it in the same invocation *is* the learner overriding what the frontmatter said.

### Batch filters are refused in single-file mode

`--include`, `--exclude` and `--tag` select notes out of a directory walk, and single-file mode has no walk — the learner already named the one note. Validating their syntax upstream and then dropping them meant `palee adopt "a/fresh.md" --exclude 'a/*.md'` exited 0 having adopted exactly the note the flag excluded. An explicit path plus a filter is a contradiction, and silently writing is the one outcome the user cannot detect after the fact, so it exits 2 naming the flag and the mode.

### Every filter pattern is accounted for

Each supplied pattern is measured against the whole scanned scope — every file the scan looked at, including ones later dropped for unreadable frontmatter, because a filter is a statement about *paths* — and a pattern that matched nothing is named back, with the anchoring rule explained: a pattern carrying `/` is matched against the whole vault-relative path from the root, not against a filename. Repeated flags accumulate rather than the last one winning silently.

### Single-file `--dry-run` previews instead of writing

The batch branch returned before writing when `--dry-run` was set; the single-file branch had no such guard, so the command a cautious user runs *before* trusting it adopted the note — and `docs/02-1-topic-management-commands.md` promises adoption "without modifying any files" — came back with a minted `palee_id`, eight new frontmatter keys, and its hand-authored `depends_on` replaced by `[]`. Eleven lines: preview the fields that will be written, print the same completion line the batch path prints, and return before `updateFrontmatter`.

### `--undo` strips only the keys adoption writes

Adoption was a one-way door: after `adopt --all --yes` over 120 notes the only way back was hand-editing YAML in every file, which is what made the `--auto-chain` scope finding unrecoverable rather than merely annoying. Idempotency was never the gap — a second `adopt --all` reports "Already adopted" — the gap was reversibility.

A single `PALEE_OWNED_KEYS` list drives the strip; every other key, comment and byte of the body is untouched. **`--drop-title` is opt-in** because adoption writes `title`, but the key is not on the PALEE-owned list and a note that already carried one keeps it — so reversal cannot tell an authored title from a minted one, and "only the user can say whether a key was adopted or typed by hand, so this opt-in is how that judgement is handed back to them rather than guessed at." It is a **flag, not a command**, deliberately: the docs-command-matrix test requires the exit-code table to carry exactly one row per registered command, so a flag closes the feature without touching that contract. All the scope-selection flags (`all`, `include`, `exclude`, `tag`, `dryRun`, `verbose`, `yes`) carry over; the write-describing flags (`difficulty`, `dependsOn`, `autoChain`, `chainTier`) are refused with it.

### The rollback journal is verified, not best-effort

A partially-completed batch adoption restores each journaled note to its original content in reverse order, and the restore states its expectation: the note exists, and it must still hold exactly what our adoption wrote. Three-argument writes — where `expectedFingerprint` defaulted to null and nothing could tell that the note had been adopted, reverted, or rewritten by a process that took the lock over — were the one unguarded vault write in the CLI (#334).

### Single-file mode has no hygiene pass — intentionally

Tier-0 hygiene (ADR-0010) runs in every batch mode. A learner who wants a hygiene-excluded note adopts it directly; the batch pass is about what a *scan* should conclude, not about what any individual note is allowed to be.

## Consequences

### Positive

- Adoption is reversible, and the reversal touches only what adoption wrote.
- A filter that matched nothing is a named mistake instead of a silent no-op.
- The rollback journal cannot restore the wrong bytes.

### Negative / Tradeoffs

- **`--drop-title` exists because the data cannot answer the question.** A note with an authored title and a note with a minted one are byte-identical after adoption; the flag hands the judgement back rather than guessing. Default-off means the common case leaves a `title` key behind.
- **A flag rather than a command** keeps the docs-matrix contract intact at the cost of `adopt --help` carrying a mode the command name does not advertise.
- **Single-file mode adopting a translation or meta note is possible by design.** That is the escape hatch the hygiene report points at ("to keep one of these notes anyway, adopt it directly"), and it means the hygiene guarantee is a property of batches, not of the command.

## Alternatives Considered

1. **Let adoption overwrite the note's own `depends_on` when the chain has an opinion.**
   - *Why Rejected*: the swap is permanent — nothing raises mastery on its own — and it replaces a claim the learner made with a filename collation. Docs already promised "explicit non-empty `depends_on` always wins" and "adoption is strictly non-destructive"; the code now matches the docs.
2. **Accept and ignore filters in single-file mode** (validate syntax, drop semantics).
   - *Why Rejected*: it adopts exactly the note the flag excluded, exits 0, and leaves no trace. A contradiction should be a usage error, not a silent write.
3. **A separate `palee unadopt` command.**
   - *Why Rejected*: the exit-code matrix test pins one row per registered command, and a flag closes the feature without editing that contract. The flag also makes the reversibility discoverable next to the command it reverses.
4. **Remove `title` on undo by default.**
   - *Why Rejected*: adoption cannot tell a minted title from an authored one, so removing it would delete a key the learner wrote. The opt-in is the honest shape; the guessing alternative is not recoverable.
5. **Skip the rollback journal's fingerprint check** (restore unconditionally).
   - *Why Rejected*: the unguarded three-argument write is exactly how a note that was rewritten mid-batch gets restored to stale bytes. The expectation costs one fingerprint comparison and makes the revert correct.
