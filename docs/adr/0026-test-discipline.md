---
description: "The v0.6.0 audit round audited the tests, not just the code, and found a class of defect the code audits could not: guards that could not fail. Five chain-planner guards were proven dead by neutralizing each one's deciding predicate and watching the suite stay green."
---


# ADR-0026: Test Discipline — Falsifiability Over Ceremony

## Status

Accepted

## Context

The v0.6.0 audit round audited the *tests*, not just the code, and found a class of defect the code audits could not: guards that could not fail. Five chain-planner guards were proven dead by neutralizing each one's deciding predicate and watching the suite stay green — a test that passes on correct code *and* on broken code is not a test. Two more asserted vacuously: `ids.has(path)` against a `Map<paleeId, path>` was constant-false, and a `parentOf` re-derivation over the same paths that had just populated `dirFirstSeen` could not fail — "a tautology dressed up as a check."

The SM-2 rounding test used `quality=4`, whose ease-factor delta is exactly 0.0, so `ease_factor` stayed 2.5 and the rounding path never ran — deleting `roundHalfUp` would not have failed it. The malformed-YAML test had the same shape. The macOS CI failures were proven load-bearing by reverting under a symlinked TMPDIR where the exact assertion failures reproduce, rather than by widening bounds until green.

This ADR records the discipline those rounds established, because it is a *review* standard, not a code one — and it is the standard that made every other ADR in this backfill verifiable.

## Decision

### A guard that cannot fail is proven dead, then fixed or deleted

The method: neutralize the deciding predicate, run the suite, and if it stays green the guard is dead. Then give it a case that does fail, or delete it. #225's table records eight items — five closed with real fixtures, three corrected (two of the "untestable" items turned out to be covered all along, and the audit said so).

Two deletion rulings are worth naming:

- **A tautological check is deleted, not kept.** The `parentOf` re-derivation re-computed over the same paths that had just populated the map it looked up, so it could not fail. The dedupe — grouping and lookup through one function — is the actual fix, and the comment says that instead.
- **The contrast is kept where it earns its place.** `assertBackwardEdges` inspects a map built elsewhere and genuinely can be violated by a future change, which is why it earns an assert; a check over data derived in the same expression does not.

### Timing guards assert equal work, not deadlines

The complexity guards existed to catch an *algorithmic* regression — a rescan that turns a linear pass quadratic, costing seconds — not to measure constant-factor speed. A 250 ms wall-clock bound was tight enough that a loaded CI runner tripped it (observed 261 ms on Windows) with no actual regression, and loose enough to miss the regression it claimed to guard: with the memo deleted, a 5000-node spine finished well inside it, so the test passed on correct code *and* on broken code.

The replacement is an equal-work comparison in the same process: 20 passes over a 250-node spine against 2 passes over a 2500-node one, both visiting 5×10³ nodes. The separation between correct and quadratic survives any runner — #226 measured the corrected case at 6067 ms against 333439 ms with the memo deleted on a larger fixture, a 55× gap. The interim step — widening to 2000 ms — was a band-aid that made the flake rarer, not the test honest. #385 finished the conversion: `assertAcyclicPlan` now reports the nodes its walk traversed, so the equal-work test asserts the two legs record the same count and the file contains no wall-clock complexity assertion.

### A test that pins a policy change says which side moved

When the 24h clamp landed, the existing test asserted the old policy and kept CI red. The resolution — the test moved to the clamp, the code did not move back — was stated explicitly in the PR thread, because "the assertion encodes a policy decision, and silently rewriting it would hide a behaviour change" (ADR-0019). The file headers that said "no age limit" were corrected in the same commit; those stale lines were why the contradicting test survived in the first place.

### A fixture property is distinguished from an assertion

When a mutation is not caught, the review says why rather than implying coverage: the dashboard's Learning-numerator mutation is a property of the fixture (the vault's single archived note sits at mastery 0 and belongs to the New band), not of the assertion. Catching it needs a second archived note inside (0, 0.7) — and the totals three other assertions pin all move with it, which is why the fixture was left as-is with the reasoning stated (ADR-0020).

### Expected values are computed by hand, not by the implementation

The SM-2 rounding test's expected value is derived from the formula — start at an ease of 2.456789, apply q=5's +0.1 delta, and 2.556789 rounds half-up to 2.5568 — not by calling the implementation's rounding helper. A test that asks the code under test for its expected output cannot fail.

### Negative controls are measured before committing

Every fix in the audit rounds came with before/after measurements — the reverts that must still fail, the cases that must not regress — recorded in the PR body. "Proven load-bearing: deleting X fails that test and nothing else in the suite" is the standard closing line.

## Consequences

### Positive

- Dead guards cannot accumulate: the neutralization method makes them findable, and the deletion rulings make them removable.
- Algorithmic regressions are caught on any host; constant-factor noise is not.
- Every behavioural change is a visible decision (which side moved), not a silent test rewrite.
- The audit-the-tests habit is what makes the rest of this backfill checkable — each ADR's claims were verified against code the same way.

### Negative / Tradeoffs

- **Equal-work comparisons are heavier tests** (multiple passes over synthetic spines). They cost milliseconds and buy host-independence; the trade is clearly right for the algorithmic class and would be overkill for a correctness assertion.
- **Deleting a check reduces the line count a coverage tool sees.** The B6/Tier-0 report and coverage gates did not object, because a tautology contributes nothing — but the discipline does mean some files get smaller, which reads as less work to a metrics-only review.
- **The method requires actually running the mutation.** There is no static shortcut for "would this test fail?" — each proven-dead guard cost a neutralize-and-run cycle.

## Alternatives Considered

1. **Widen timing bounds until CI is green.**
   - *Why Rejected*: it makes the flake rarer without making the test honest — and the 2000 ms bound was already loose enough to pass on the quadratic code it existed to catch. The equal-work form catches the regression class on any host.
2. **Keep vacuous checks "for documentation."**
   - *Why Rejected*: a check that cannot fail teaches the next reader that the property is guarded when it is not. If the property matters, it gets a real fixture; if it cannot be violated, the construction guarantees it and the comment says that instead.
3. **Rewrite contradicting tests silently to match new behaviour.**
   - *Why Rejected*: it hides a behaviour change behind a green suite. The 24h clamp's test move was stated in the thread precisely so the policy change was visible — and the same discipline is why ADR-0019 records the ruling's provenance.
4. **Compute expected values through the implementation's helpers.**
   - *Why Rejected*: the SM-2 rounding test did exactly that and could not fail. Hand-computed expectations are the only kind that test the formula.
5. **Trust the existing suite and audit code only.**
   - *Why Rejected*: the dead-guard class is invisible to a code audit — the guards *look* like checks. Only the neutralize-and-run method finds them, and five of them were load-bearing-looking.
