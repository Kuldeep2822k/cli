# ADR-0023: `migrate --relabel-ties` as the Migration Surface

## Status

Accepted

## Context

ADR-0009 split gating by provenance, and #234 stopped the engine from *writing* `depends_on_source: numbered` on a filename tie. That fix was forward-only by construction: a vault adopted before #234 stored the alphabetical tie as `numbered`, `numbered` gates, and `adopt` deliberately never rewrites an adopted note (INV-46) — so those notes stayed locked after the engine stopped producing the label, permanently, because nothing raises `topic_mastery` on its own.

The backward half needed a home. This ADR records the surface ruling and the seven sub-decisions the implementation round produced, because "which command owns a stored-state migration" is exactly the kind of decision that gets made implicitly and then defended forever.

## Decision

### The surface is `migrate`

`validate` is read-only by contract, so writing there would change what the command *is*. On `adopt`, the flag would sit next to a command whose defining guarantee is that it does not rewrite adopted notes — and the pass has nothing to do with adoption. `migrate` already owns "bring stored notes up to the current model," already does an OCC-guarded frontmatter write, and already reports three outcomes. The pass audits for exactly the stored state and reports it; `--relabel-ties` rewrites the label to `tie`, which makes the edge advisory and returns the note to `palee plan`'s ready list.

### Ruling: give the pass a route, not retract the promise

`bin/palee.ts` advertised the pass as relabelling ties "on notes adopted before that label existed" — and those notes have **no** `depends_on_source` key, because the 0.5.x auto-chain never wrote one, while the pass asked only for the exact string `numbered`. The population the flag exists for was the population it ignored, silently, at exit 0. The ruling taken on the issue: **give the pass a route** (reach the unlabeled vaults via `--include-unlabeled-ties`), not retract the promise. Even opted in, a note is demoted only when the planner itself could have written the edge — one prerequisite, pointing backward, same directory, equal rank, no same-rank sibling still between the pair, no legacy `dependencies` alias, and both notes inside the plan — and `depends_on` is never edited.

### Demote only when no sibling sits between the pair

The pass asks three pairwise questions — same directory, `tiedByName`, and which of the two the numbering puts first — and must also ask whether anything sat between them. The chain links neighbours: for `02-a`, `02-b`, `02-c` it writes `02-b → 02-a` and `02-c → 02-b`, never `02-c → 02-a`. A stored edge that steps over a present sibling is therefore not one the chain wrote, and demoting it **removed a gate** — the bad direction, because nothing raises mastery on its own. The rule: demote only when no other same-directory note that ties by name with the candidate ranks strictly between the stored predecessor and the candidate. Both predicates are the planner's own, so the pass keeps re-asking the chain's rules instead of restating them — a migration restating the order is how a real numbering decision eventually gets demoted.

### The three refusals are counted

A note whose stored `depends_on` no longer matches any computable plan is left alone **and counted**, not guessed at: more than one prerequisite (the numbered chain writes one edge per note), an edge pointing at the sibling the numbering puts *after* it, and an edge stepping over a same-rank sibling. All three were left gated and reported as nothing at all before the fix.

### `vanished` is classified by existence, not by error code

`atomicWrite` also raises ENOENT from its temp handling and its rename, so a parent directory vanishing mid-run counted a note that still exists as "nothing to relabel" and let the command exit 0. Vanished now means `existsSync` reports the path absent; every other ENOENT stays a write error and keeps exit 5. A non-conflict write failure exits 5 (the documented "unexpected runtime exception," which a permission or disk error is); a conflict still exits 4 and re-runs. A note skipped by the write-time recheck is counted in the summary and leaves the exit code alone — it no longer matches the pattern, which is a correct outcome, not a failure.

### Rename detection is by path, not id

Comparing the predecessor's *id* is "exactly the one thing a rename preserves" — `02-a → 01-a` passed every check while the premise under it ("these two are tied, the filenames ordered them") had stopped being true. Each write re-confirms the pair: the dependent's fingerprint, then the predecessor re-loaded to confirm the recorded id still lives at the recorded path. A rename shows up as the path being gone or holding another topic; the note is left gated and the caller is told to re-run.

### One derived set is printed *and* written

The pass used to report success over work it had refused. A run that will write reads the vault then and derives once; that same set is what it printed and what it writes — so "not the predecessor the audit first saw" is not a state the code can be in, and a re-pointed edge is judged as the edge it is now. `tieStillHolds` re-derives the decision from the bytes about to be written rather than a scan-time fingerprint, because `loadTopics` serves from a module cache keyed on mtime — "a conflict against a baseline that may not exist." The predecessor is re-loaded through `loadTopics` so both sides of a comparison went through the same normalization; two sides of a comparison can only disagree if they are read two different ways.

## Consequences

### Positive

- Vaults adopted before the `tie` label existed can be unlocked without hand-editing frontmatter, and the pass says what it did and did not touch.
- The demotion rules are the planner's own predicates, so the migration cannot drift from the engine's current behaviour.
- Every refusal, conflict and vanished note is counted where the summary reads — the books add up.

### Negative / Tradeoffs

- **The pass writes one key on notes it did not create.** The guard is the re-derivation at write time (fingerprint + predecessor identity), but the residual window between the check and the write is one syscall, same as every OCC path (ADR-0014).
- **`--include-unlabeled-ties` is opt-in for a reason.** An absent label is the fail-closed spelling for "the learner typed this list," and it is byte-identical to what a chain edge looks like — nothing on disk separates the two. Opening the route on upgrade would rewrite frontmatter nobody asked to touch; the flag hands that judgement to the user.

## Alternatives Considered

1. **Put the pass on `adopt`** (`adopt --relabel-inferred`).
   - *Why Rejected*: the flag would sit next to a command whose defining guarantee is that it does not rewrite adopted notes, and the pass has nothing to do with adoption. `migrate` already owns stored-state upgrades and already has the OCC write.
2. **Put it on `validate --fix-labels`.**
   - *Why Rejected*: `validate` is read-only by contract; writing there changes what the command *is*. (The later `--fix` machinery, #416, dispatches off rule metadata — a different surface with its own rules.)
3. **Retract the help text's promise** instead of reaching the unlabeled vaults.
   - *Why Rejected*: the promise describes the population the pass exists for. The honest fix is the route, with the fail-closed guard, not a narrower claim.
4. **Demote on the three pairwise questions alone** (no adjacency check).
   - *Why Rejected*: an edge stepping over a present sibling is not one the chain wrote; demoting it removed a gate, and nothing raises mastery on its own, so the note stays unlocked permanently.
5. **Snapshot fingerprints at scan time and trust them.**
   - *Why Rejected*: `loadTopics` serves from a module cache keyed on mtime, so a scan-time fingerprint would sometimes assert a read the cache never performed — a conflict against a baseline that may not exist. Re-deriving from the bytes about to be written is the only version that means anything.
6. **Classify vanished by error code** (the pre-#283 behaviour).
   - *Why Rejected*: `atomicWrite` raises ENOENT from its own temp handling and rename, so a still-existing note counted as vanished and the command exited 0 over refused work. Existence is the question; the error code only sometimes answers it.
