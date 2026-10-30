---
description: "Mastery repair skips topics with missing assessment pillars. Only topics with all four valid pillar scores are checked and repaired."
---


# ADR-0035: `--fix` Mastery Repair and Partial Pillar Eligibility

## Status

Accepted (2026-10-22)

## Context

`palee validate --fix` recomputes `topic_mastery` via `applyMasteryRepairs`, which
zero-fills absent pillars before calling `computeTopicMastery`. The
`valid-topic-mastery` rule does the same. This means a note with 3 of 4 pillars
scored (e.g. `conceptual/practical/debug: 0.9`, no `feynman`) computes
`(0.9 + 0.9 + 0.9 + 0) / 5 = 0.54` and can be flagged or rewritten as drift —
locking a learner out of a gate on the strength of a pillar they never entered.

The issue (#514) asks: does an absent pillar mean "zero in that dimension" or
"no data"? ADR-0021 already resolved this for `adopt` and `review`: absent
pillars are omitted, not zeroed, because `0` is a score and "absent" is not.

## Decision

**Absent pillars mean "no data", not zero.** This direction is adopted from
#277 (`carriedPillarScores` omits absent pillars) and #300 (`record-review`
drops them). `--fix` and `valid-topic-mastery` must agree: a topic with any
absent pillar is **skipped**, not zero-filled. The rule and repair only
operate on topics where all four pillars are present and shaped.

This is a "skip" decision, not a "reweight" decision: reweighting the formula
`(c + p + d + 2·f) / 5` to sum over a subset of pillars would change the
weighting semantics and silently alter mastery for notes whose formula was
always meant to run over all four. Skipping is conservative and matches the
rule's existing behavior for the all-absent case.

## Consequences

- **Rule (`valid-topic-mastery.ts`)**: changed from "skip if all pillars absent"
  to "skip if any pillar absent." Topics with partial data are not flagged
  for mastery drift.
- **Repair (`validate.ts` `applyMasteryRepairs`)**: unchanged in mechanics;
  it only repairs topics the rule flagged, so partial-pillar topics are
  naturally excluded. The `: 0` fallback in the pillar map is now
  unreachable but retained as a type guard.
- **`assessed_at` is never touched by `--fix`** — unchanged. The timestamp
  attests to an `assess` recording, not a `validate` recomputation.
- **Tests**: updated the two "Greptile P1" tests that asserted zero-fill
  behavior; added a 3-note fixture test (#514 reproduction) covering
  no-pillars, partial-pillars, and full-pillars in one `validate --fix` run.
- See also: ADR-0021 (assessment surface), #277, #300, #514.
