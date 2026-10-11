# ADR-0020: Readiness and Scheduling Contracts

## Status

Accepted

## Context

`palee next` and `palee plan` answer the same question — "what should I work on now?" — and for most of v0.6.0 they answered it differently, both exiting 0. `plan` computed the dependency gate correctly; `get-next-topics` contained **no dependency logic at all**. On a two-note graph (`T-aa` depends on `T-bb`, both unassessed), `plan` printed "Blocked by prerequisites: 1" for `T-aa` while `next` recommended that same `T-aa` — and `next` is the command a learner actually obeys. The README says "Never study topics before prerequisites."

The same round fixed the reporting on both sides: a note could appear under both "Reviews Due" and "Blocked by prerequisites" (the due list and the blocked set were built from different topic sets), archived topics leaked into readiness (`getReadyTopics` had no `status` filter, and `dashboard` derived all its totals from the unfiltered list while `progress` was already correct — same vault, contradictory numbers), and `dashboard` picked `next_review` by its own rule.

## Decision

### One gate, shared by every read model

The prerequisite gate lives in one place — `findPrerequisiteBlocked` in `src/application/get-next-topics.ts`, deciding via the engine's `areDependenciesSatisfied` and never re-deriving a mastery comparison — and `plan` dedupes its "Reviews Due" list against it while `dashboard` draws `next_review` from it. A learner never gets two answers about the same note.

The decision itself is the engine's; the presentation walks the same dependency list only to phrase each blocker, matching `plan`'s wording byte-for-byte. Advisory edges (`toc`, `tie`) and missing references are handled by the engine predicate, so the read models stay in step with `getReadyTopics` without duplicating its rules.

### "Blocked by prerequisites" names the two cases that need different action

A note held off the ready list by an unmet prerequisite and a note whose prerequisite id no longer resolves are different problems with different fixes, and both used to be invisible — the first looked like "nothing left to study," and the second could never return, because `areDependenciesSatisfied` returns false for an unknown id while `no-missing-dependency` reports it at warning severity and `validate` exits 0. The new section distinguishes them, `--json` gains a matching `blocked` array, and the empty-vault response carries the same key set as the populated one — pinned by a key-set comparison test rather than a field-name assertion, so it cannot drift the next time a field is added to one branch.

### A note is never in both lists

The due set and the blocked set are disjoint by construction: the gate runs first, and each actionable topic lands in exactly one of the two lists. The counts no longer double-count.

### Archived topics are out of readiness *and* out of blocked reporting

`getReadyTopics` skips archived topics, and so does the blocked loop. The ruling: **"an archived note is not study material, so it cannot be *waiting on prerequisites* either — reporting it there would reintroduce the leak through a section that did not exist when the branch was written."** The graph itself is built from every topic, archived ones included — dropping an archived prerequisite would read as a *missing* dependency and hide ready topics (the BUG-002 shape).

### Quarantined notes are never reported as blocked

A topic on or downstream of a cycle had its ordering claim quarantined, so the gate is undefined for it; `plan` keeps such a note in "Reviews Due" and reports it under Quarantined Cycles instead. `next` must not disagree by silently withholding it. The graph is quarantined first (`quarantineCyclicTopics`), then gated — the same order `plan` uses, which is also what makes the availability delta reported by `assess` true.

### The mutation honesty rule

When a test fixture cannot catch a mutation, the PR says so rather than implying coverage: the dashboard's Learning-numerator mutation is *not* caught by the fixture, because the vault's single archived note sits at mastery 0 and belongs to the New band. "Catching it needs a second archived note inside (0, 0.7)" — a property of the fixture, not of the assertion, stated in the review thread rather than buried.

## Consequences

### Positive

- `next` and `plan` cannot disagree; the command a learner obeys enforces the same gate as the command they plan with.
- A note that will never become ready is named, with its dangling prerequisite, instead of vanishing.
- Archived notes are consistently out of every study surface, and consistently *in* the graph so their absence never reads as "missing."

### Negative / Tradeoffs

- **The blocked list costs a graph pass on every `next`.** Quarantine + readiness over the whole vault, skipped only when the vault has no edges at all (the fast path). For a huge vault that is real work per invocation — accepted because the alternative (two answers) is the defect this ADR closes.
- **A note inside a cycle stays in "Reviews Due"** even though its order is undefined. That is the honest placement — the cycle is reported separately — but it means "Reviews Due" is not strictly "ready to study" for quarantined vaults.

## Alternatives Considered

1. **Let `next` stay ungated and document the difference.**
   - *Why Rejected*: `next` is the command a learner obeys; recommending a gated note contradicts the README's first promise. Documentation does not fix a command that gives the wrong answer.
2. **Re-derive the gate inside each command** (each handler checks dependencies itself).
   - *Why Rejected*: that is the pre-#413 shape — `plan` had it, `next` did not, and `dashboard` had a third variant. One shared gate is the only shape where the commands cannot drift.
3. **Report blocked notes only in `plan`, not `next`.**
   - *Why Rejected*: a learner running `next` on a vault where everything is gated would see an empty list with no explanation. The blocked list is the explanation, and `next` is where it is needed most.
4. **Exclude archived topics from the graph entirely.**
   - *Why Rejected*: an archived prerequisite would then read as missing, hiding ready topics behind a dangling-reference warning — the BUG-002 failure in the other direction. Archived notes participate in the graph; they just never appear as study candidates.
