---
description: "ADR-0009's gating model is correct for the v0.6.x writer: one depends_on_source label per note, advisory or gating for the whole list. #224 identifies the..."
---


# ADR-0013: Per-Edge Blocking Policy and OR-Groups

## Status

Proposed

Specified in #224; not implemented.

## Context

ADR-0009's gating model is correct for the v0.6.x writer: one `depends_on_source` label per note, advisory or gating for the whole list. #224 identifies the two ways that will bite as soon as the sources mix:

1. **The policy is per note, but it is a property of each edge.** `depends_on` is `string[]`. A note can hold one authored prerequisite and one TOC-inferred predecessor at the same time, and today a single label decides the gating behaviour of the whole list. Hand-editing `depends_on` on a note labelled `toc` leaves the learner's own new prerequisite silently advisory — the documented remedy today is deleting the label line, which is a workaround, not a contract.
2. **Declared text and enumeration can land on the same note.** #206-style explicit prerequisite text produces edges that *should* gate, and they would land on a note whose enumeration-derived label says they should not.

Adding a third source (`declared`, #232) already meant adding a third all-or-nothing policy. The model that fits is per-edge.

## Decision (as specified in #224)

Each edge carries its own policy, with the plain string list remaining the canonical shorthand:

```yaml
depends_on:
  - id: T-linear-algebra
    via: authored      # who wrote the edge: authored | numbered | toc | tie | declared
    policy: block      # block | warn | hide
  - id: T-svd
    via: toc
    policy: warn       # show it in palee plan, do not lock the note
```

Policy semantics:

| policy | behaviour |
|---|---|
| `block` | today's gating behaviour — the note is not ready until the prerequisite reaches the mastery threshold |
| `warn` | the edge is *shown* in `palee plan`'s blocked reporting, but never holds the note off the ready list — the shape Moodle and Canvas surface for an unmet prerequisite |
| `hide` | today's advisory behaviour for `toc`/`tie` — the edge ranks and cycle-checks but is not reported as blocking |

`via` records provenance per edge so the advisory set stops being a note-level label, and OR-groups become expressible: a note requiring *one of* several prerequisites carries a group the readiness gate can evaluate as a disjunction instead of forcing every member to master.

Existing vaults parse unchanged: a bare string list is exactly `policy: block` with `via` absent, which keeps ADR-0009's fail-closed rule (an absent label gates).

## Consequences

### Positive (expected)

- Hand-edited prerequisites on an advisory-labelled note stop being silently demoted; the learner's edit carries its own policy.
- The `warn` tier gives `palee plan` somewhere to put "this edge exists and is unmet" without the all-or-nothing lock — the reporting gap #220's "Blocked by prerequisites" section already half-solves.
- A third chain source no longer means a third all-or-nothing policy.

### Negative / Tradeoffs (expected)

- The frontmatter shape grows a structured form beside the string list, and `updateFrontmatter`'s CST-preserving rewrite has to handle both without normalizing one into the other.
- The readiness gate changes from a per-note predicate to a per-edge evaluation, which is where `quarantineCyclicTopics` and the plan/next readiness computation both live (ADR-0020). Both call sites move together or they disagree — the same failure mode ADR-0020 records for `next` vs `plan`.

## Alternatives Considered

1. **Keep the per-note label and document the hand-edit workaround.**
   - *Why Rejected (as the status quo, not as a decision)*: the workaround is deleting a line the learner did not write, and the failure it prevents is silent and permanent. #224 was filed because the workaround is not a contract.
2. **A per-note label with more values** (add `declared` and a future third source as more note-level labels).
   - *Why Rejected*: that is the current design's failure mode restated. Every new source adds another all-or-nothing policy, and the mixed-source note — one authored edge plus one enumerated edge — stays inexpressible.
3. **Move the policy decision to read time** (decide gating from the edge's shape rather than storing it).
   - *Why Rejected*: a `toc` edge and a hand-edited edge are byte-identical in the list; only the label separates them today, and a read-time rule would have to re-derive provenance from data that does not record it. `via` exists so the decision is recorded, not re-guessed.

## Implementation notes (from #224)

- Not before edge identity lands in the data model; this ADR is the design record so the shape is decided before the code, not after.
- `hide` remains today's behaviour for authored edges that are advisory — the policy vocabulary is a superset of the current label semantics, not a replacement.
- Cross-references: ADR-0009 (the gating model this refines), #220 (the blocked-reporting surface `warn` completes), #206 (the AI verification verdicts that would *set* per-edge policy).
