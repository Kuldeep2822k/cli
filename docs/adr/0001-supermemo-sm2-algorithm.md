# ADR-0001: SuperMemo SM-2 Spaced Repetition Scheduling Algorithm

## Status
Accepted

## Context
PALEE is designed to guide learners through complex topic graphs while maximizing retention. Without an automated review schedule, learners suffer from the Ebbinghaus forgetting curve. We needed a proven, deterministic, and parameterizable spaced repetition algorithm that:
1. Calculates expanding inter-review intervals based on self-assessed review performance.
2. Does not rely on cloud services or external servers.
3. Operates predictably and can be fully tested with deterministic unit tests.

## Decision
We implemented the canonical **SuperMemo-2 (SM-2)** algorithm in `src/engine/sm2.ts`.

Key design choices:
1. **Ease Factor (EF) Adjustment**:
   $$\Delta EF = 0.1 - (5 - q) \times (0.08 + (5 - q) \times 0.02)$$
   Where $q \in [0, 5]$ is the review quality rating. The minimum ease factor is clamped to `1.3`.
2. **Interval Progression**:
   - Repetition 1: 1 day.
   - Repetition 2: 6 days.
   - Repetition $n > 2$: $\text{round}(\text{interval}_{n-1} \times EF)$.
3. **Lapse Handling**:
   - Ratings $q < 3$ trigger a lapse: repetition resets to `0`, interval resets to `1`, and the lapse counter increments if the topic had prior repetitions.
4. **Calendar Due Dates**:
   - Due dates are calculated in the local timezone to avoid daylight saving time offset drift.

## Consequences
- **Positive**:
  - Deterministic scheduling with zero network dependencies.
  - Battle-tested algorithm proven across decades in spaced repetition literature.
  - Clean mathematical boundary that can easily be extended to FSRS or SM-18 in future phases.
- **Negative / Tradeoffs**:
  - Requires active recall ratings (0-5) from the user.
