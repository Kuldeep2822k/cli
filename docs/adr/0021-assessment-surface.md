---
description: "topic_mastery is the only thing that opens a prerequisite gate — areDependenciesSatisfied blocks a topic until every gating prerequisite reaches 0.70, while advisory toc/tie edges never gate — and until v0.6.0 no command could raise it."
---


# ADR-0021: The Assessment Surface

## Status

Accepted

Extended for #269 by the section "A lowering is named, not blocked". The v0.6.0 decisions above it stand unchanged; that section also corrects two claims made about this surface elsewhere.

## Context

`topic_mastery` is the only thing that opens a prerequisite gate — `areDependenciesSatisfied` blocks a topic until every prerequisite reaches 0.70 — and until v0.6.0 **no command could raise it**. Every gate in the product was a one-way door: a topic behind an unmastered prerequisite never appeared in `palee plan`, no matter what the learner did. `palee review` was the near-miss — it drives SM-2 spacing and derives mastery from pillars it never collects, so mapping review quality onto mastery would have redefined the assessment model and every invariant citing 0.70.

`palee assess` closed the surface. This ADR records its contract decisions, most of which were made in review threads about what the command must *refuse* to write — because the command that opens gates is the one place a permissive read can lock a learner out permanently.

## Decision

### Only the pillars the learner supplied are written

Omitted pillars went through `normalizeScore`, which returns 0 for an absent value — so a single review or assessment on a never-assessed note created `conceptual/practical/debug/feynman: 0` while leaving `assessed_at: null`: frontmatter that contradicted itself, assessed-but-zero, for an assessment that never happened. Downstream, `valid-topic-mastery` skips notes whose pillars are all absent; with minted zeros it compares stored mastery against a computed 0, pinning mastery low so dependents hide behind a score nobody gave. Now: pillars the learner did not name are not written at all, and the distinction between "no assessment data" and "assessed at zero" survives on disk.

### A corrupt stored value is refused, not clamped into an unlock

A stored value that is not a number in `[0,1]` is refused with the field named. This was "the worst of the three, because it could open a gate on a number nobody entered": a stored `feynman: 2` became `1` in the file and in the recomputation, and the note's mastery silently jumped. Passing `--feynman` explicitly is the way past it — a stored value that is invalid is the learner's to fix, and naming the field is them fixing it. (An explicitly supplied pillar is never validated against a corrupt stored one; the message has to mean something.)

### Non-scalars are refused

`Number(String([1]))` really is `1`, so a one-element sequence read as a perfect mark while `loadTopics` reads the field as 0 and `validate` rejects it — "three answers from one note, and the command that opens gates was giving the most permissive." Only scalars are accepted.

### Exact `palee_id` wins before the fuzzy pass

The topic scan OR'd exact-id, substring-id and substring-title into one candidate list, so `T-math` matched `T-math-2` and the command refused both: "the more specific the input, the less likely it worked." Exact matches now win before any fuzzy pass runs; genuine ambiguity (`Alpha` against `Alpha Topic` and `Alphabeta Topic`) still exits 2 and writes nothing. This resolution rule was lifted verbatim into the shared `resolveTopicQuery` that `review`, `progress` and `assess` all call (one query, one answer — the pre-#394 shape had three different answers).

### The availability delta is the ready-set delta

What `assess` reports as unlocked is computed the way `plan` computes readiness — `quarantineCyclicTopics` first, then `getReadyTopics` — not a `depends_on` scan. The scan version counted a dependent with a second unmet prerequisite as reachable, and one inside a cycle as available. One subtlety the tests surfaced: the assessed topic leaves the ready list itself when it is mastered, so it is excluded from both sides of the diff rather than reported as blocked.

### The Feynman hint names the pillar, computed from the table

Mastery is `(conceptual + practical + debug + 2·feynman) / 5`, so the three ordinary pillars cap mastery at 0.60 and the 0.70 gate is unreachable without a Feynman score. A learner who maxed them got only "Below the 0.70 threshold" — which reads as *your score was too low* when the truth is *this pillar can never be enough on its own*. When a below-threshold assessment has no `feynman` score, the hint now names the missing pillar, shows the arithmetic, and points at `--feynman`. The cap is computed from the pillar table, not hardcoded, so it cannot drift from the formula; a below-threshold case that *did* score `--feynman` is asserted not to blame that pillar, so the hint stays honest. The weighting is stated where the threshold is documented (ADR-0004).

### SM-2 untouched, threshold untouched, no new keys

The four-pillar model, the persisted frontmatter fields, the weighting and the 0.70 threshold all already existed; the command writes the pillars it is given, preserves the rest, recomputes `topic_mastery`, and prints what the change unlocks. No schema version change.

### A lowering is named, not blocked (#269)

`assess` is the only command that raises `topic_mastery` from scores the learner types. `review`, `adopt`, `roadmap` and `validate --fix` also write it, but each derives it from values already on the note. That asymmetry decides the shape of the fix: the learner is the only reliable source of "I do not actually know this", and `assess` is the only command that lets them say so — so a lowering gets a notice, never a refusal.

A recorded lowering that re-hides dependents prints the count, the transition, and a `⚠` line naming what `palee plan` will stop offering. `--force` drops the notice and records anyway; `--dry-run` performs every check the recording performs — the stored-pillar reads for every omitted pillar, the note re-read, the fingerprint compare — then prints the shared assessment-effect report without taking the lock or writing a byte. Neither flag adds an exit code to the table above.

Three rulings are inside that shape:

- **The preview and the recording share one printer.** A `--dry-run` that forecast a different effect than the write reports is worse than no preview, because the learner acted on it. Both paths call `printAssessmentEffect`, and a test compares their shared lines rather than trusting the code shape.
- **`--force` keeps the meaning it already has on `review` (#301): it silences a notice, not the record.** Making `assess --force` a confirmation while `review --force` stayed a suppression would have given one flag two jobs in one CLI.
- **The notice prints after the write, exactly like review's early-review warning.** A pre-write warning could fire for a record that then failed `ECONFLICT` and never landed. `--dry-run` is how the effect is seen beforehand, and it is trustworthy precisely because it ran the same checks.

This section also corrects the record on two claims that were made about this surface. First, `assess` is **not** the only writer of `topic_mastery` — a citation of INV-37 for that proposition was wrong, and INV-37 is about LLM tool schemas carrying no mutations. Second, no key records *which* command wrote a mastery. `assessed_at` says an assessment happened (only `assess` stamps it) and nothing more: `validate --fix` recomputes `topic_mastery` from stored pillars and leaves the timestamp untouched, and `roadmap` writes `assessed_at: null` onto notes that never carried the key. A provenance key was considered here and **rejected as out of scope for this change**: it is a schema addition whose only plausible reader — INV-41/INV-42's "established topic", defined as a prior `assessed_at` plus four pillars above a floor — is not implemented, and a value stamped by one of five writers would leave the other four ambiguous regardless. It also has a trap: `adopt --undo` strips exactly `PALEE_OWNED_KEYS`, so a key owned by nobody would survive the undo that removed the assessment it attests to. #269 item 4 stays open on that half.

## Consequences

### Positive

- The one-way door is open: a learner can now pass a gate they are legitimately ready for.
- The command refuses rather than guesses at every point where a guess could lock someone out — corrupt values, non-scalars, ambiguous ids.
- The hint tells the learner *which* pillar is short, computed from the formula so the two cannot disagree.

### Negative / Tradeoffs

- **The 0.6 ceiling itself is untouched** — "the ceiling is a design decision, not this bug; only the silence was." A learner who cannot or will not produce a Feynman score can never pass a gate, by construction of the weighting (ADR-0004). The hint makes that visible instead of fixing it.
- **Refusing a corrupt stored value blocks the assessment entirely** for that note until the learner fixes the field by hand. That is deliberate — the alternative (clamp) silently manufactures mastery — but it means `assess` can fail on a note `validate` only warns about.

## Alternatives Considered

1. **Map review quality onto mastery** (let `palee review` raise `topic_mastery`).
   - *Why Rejected*: review quality measures recall under SM-2; the four pillars measure understanding. Conflating them redefines the assessment model and every invariant citing 0.70, to close a gap a dedicated command closes honestly.
2. **Clamp out-of-range stored values** (the pre-#228 behaviour).
   - *Why Rejected*: a stored `feynman: 2` became `1` and mastery silently jumped — the command that opens gates was giving the most permissive reading of three. Refusing names the field; clamping hides it.
3. **Mint absent pillars at 0** (the pre-#300 behaviour).
   - *Why Rejected*: it erases the distinction `valid-topic-mastery` depends on — "no assessment data" vs "assessed at zero" — and pins mastery low so dependents hide behind a score nobody gave.
4. **Keep the fuzzy topic match** (OR all three match kinds).
   - *Why Rejected*: `T-math` matched `T-math-2` and both were refused. Specificity should help, not hurt; exact-wins is the rule every other resolver in the CLI now shares.
