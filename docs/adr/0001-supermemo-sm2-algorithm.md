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
   - Repetition $n > 2$: `round(interval_{n-1} * EF)`.
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

## Alternatives Considered

1. **FSRS-4.5 / FSRS-5 (Free Spaced Repetition Scheduler)**:
   - *Description*: A modern 17-parameter DSR (Difficulty, Stability, Retrievability) model that optimizes review intervals with machine learning techniques.
   - *Pros*: Higher long-term retention efficiency and lower review count overhead on very large flashcard decks.
   - *Why Rejected*: Requires dozens to hundreds of historical reviews per user to fit parameters effectively; significantly higher mathematical and storage overhead (storing floating-point stability and retrievability vectors in frontmatter). SM-2 provides deterministic, zero-configuration scheduling with standard 4-state parameters (`repetition`, `interval_days`, `ease_factor`, `lapses`).

2. **Leitner Box System**:
   - *Description*: Fixed integer interval buckets (1, 2, 4, 8, 16 days) with box-shifting mechanics.
   - *Pros*: Extremely simple to conceptualize and test.
   - *Why Rejected*: Lacks difficulty-based interval adaptation; treats challenging and simple topics identically once promoted, leading to premature forgetting of complex architectural material.

3. **Anki-Modified SM-2 with Sub-Day Learning Steps**:
   - *Description*: SM-2 with intra-day learning steps (e.g. 1min, 10min) and graduating intervals.
   - *Pros*: Excellent for rapid memorization of vocabulary cards.
   - *Why Rejected*: PALEE tracks comprehensive learning notes and technical topics where daily review cadence is appropriate; sub-day review steps introduce unnecessary timer complexity to a CLI tool.

4. **Half-Life Regression (Duolingo HLR)**:
   - *Description*: Statistical regression modeling exponential forgetting curves based on user feature vectors.
   - *Why Rejected*: Violates the zero-dependency, local-first offline CLI invariant by requiring ML runtime weights or training infrastructure.

