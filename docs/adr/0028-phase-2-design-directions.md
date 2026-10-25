---
description: "Four Phase-2 designs are fully specified in the issue tracker and recorded nowhere durable. Each one is a decision about what the AI may and may not do, made..."
---


# ADR-0028: Phase-2 Design Directions

## Status

Proposed

Specified in open issues; not implemented.

## Context

Four Phase-2 designs are fully specified in the issue tracker and recorded nowhere durable. Each one is a *decision about what the AI may and may not do*, made while the deterministic core was being hardened — and each is the kind of design that gets re-litigated in code review if it is not written down. This ADR records them as designed, not decided, so a future implementer starts from the specification rather than rediscovering it.

The common thread: the AI may **narrow** what gates a learner, never widen it, and never invent prerequisites. Every one of the four designs encodes the same asymmetry, and the asymmetry is the lesson of #205's 98.2%-false-edge census.

## Decision (as specified)

### #24 — Provider abstraction layer

An `AIProvider` interface with an `OpenAICompatibleProvider` first, a factory driven by configuration, and capability detection (structured output, streaming) as first-class metadata so callers can degrade gracefully. Additional adapters (Anthropic, local models via Ollama/LM Studio) are explicitly deferred to later phases. #297's shipped adapter is the first concrete implementation of this shape (ADR-0027); the abstraction itself is the unbuilt part.

### #70 — Dependency-aware recommendation scoring: a deterministic decision engine

"`palee next` should be a **deterministic decision engine**, not an AI-controlled ranking system." AI may eventually produce or calibrate learner-state signals (SM-2 urgency, mastery, assessment dimensions, dependency readiness, downstream unlock value, session history), but once those signals are persisted, the recommendation must be reproducible from the same vault state without a network request — "AI-independent at decision time."

The pipeline as designed: collect candidates → validity gate → dependency/readiness gate → gather scheduling signals → deterministic scoring → explainable output. The explainability requirement is the load-bearing one: a recommendation the learner cannot see the reason for is not actionable, and an unexplainable ranker is indistinguishable from a wrong one.

### #206 — AI chain verification (`palee verify --chain`): asymmetric authority

An opt-in verifier that reads the *actual note content* behind tool-created dependency edges and issues verdicts that **downgrade or ignore** — never invent. The AI may mark an edge `supported | plausible | unsupported | contradicts`; gating (`next`, `plan`) then treats `unsupported`/`contradicts` as non-gating, and `verify --fix` can remove them from frontmatter after confirmation.

**The hard requirement:** the AI must never add or rewrite dependencies. "Removal only shrinks gating and is fail-safe; addition would re-introduce the silent-false-depends class measured in #205." The verifier exists because structural heuristics (#205's tiered fix, ADR-0009 through ADR-0012) reduced the clearly-false class to ~0% but cannot close the residual gap — "author enumerated X before Y" is not proof that "Y actually requires X" — and only content reading can. It belongs in Phase 2 because it is provider-gated.

### #224 — Per-edge blocking policy and OR-groups

`block | warn | hide` per edge with `via` provenance, once edges have identity in the data model (full design in ADR-0013). The model that fits the mixed-source note: a note holding one authored prerequisite and one enumeration-inferred predecessor gets one policy per edge instead of one per note.

## Consequences

### Positive (expected)

- Phase 2 starts from specifications with their failure directions already chosen, rather than from a blank design doc per feature.
- The asymmetry rule (narrow, never widen; remove, never invent) is consistent across all four designs, so a reviewer can check any of them against one sentence.

### Negative / Tradeoffs (expected)

- **All four are unimplemented.** Recording them as *Proposed* is the point — but it also means none of these has been tested against a real provider, and the #206 "downgrade-only" authority in particular has an obvious failure mode (an over-eager verifier shrinking legitimate gates) that only field use will price.
- **#70's determinism requirement constrains the AI's role** to signal production, not ranking. That is deliberate and worth stating: it forecloses the "AI picks what you study next" product direction, permanently, by design.

## Alternatives Considered

1. **Let the AI rank or add dependencies directly** (the natural Phase-2 shape).
   - *Why Rejected (by the designs themselves)*: #205's census is the argument. A wrong inferred edge is silent and permanent — nothing raises mastery on its own — so any authority that can *add* edges inherits the worst failure mode in the product's history. All four designs instead give the AI read-only or narrowing authority.
2. **Ship the provider abstraction before the provider.**
   - *Why Rejected (sequencing)*: #297 shipped the adapter against the config surface first; the abstraction (factory, capability detection, multiple adapters) is deferred until a second provider actually exists to justify it — "do not create unnecessary abstractions," the same rule #65's application-layer extraction followed (ADR-0025).
3. **Record these as accepted decisions.**
   - *Why Rejected*: they are designs, not decisions — nothing is implemented, and an "Accepted" ADR for unbuilt code invites a future reader to assume the behaviour exists. The Status line says Proposed, and each section says "as specified."

## The external record gap

One provenance note this audit surfaced and could not close: the 24h staleness clamp in ADR-0019 cites **"Supervisor ruling 3 of 2026-09-25"** from a `shared/bug-ledger.md` referenced in PR #212 — a formal ruling process in which BUG-002, BUG-004 and BUG-008 carried S3 severity ratings. **That ledger was never committed to the repository** — as of this backfill, `git log --all -S'bug-ledger'` finds nothing and no `shared/` directory exists on any ref. Those rulings currently exist in neither the ADR system nor git. The recommendation recorded in issue #437: either commit the ledger (or its rulings) so the provenance survives, or fold each ruling into the relevant ADR — the 24h clamp's belongs in ADR-0019.
