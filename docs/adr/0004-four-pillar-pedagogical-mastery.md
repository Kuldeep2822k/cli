# ADR-0004: Four-Pillar Pedagogical Assessment Model

## Status
Accepted

## Context
Traditional flashcard spaced repetition models measure recall as a 1-dimensional score. However, real-world engineering and technical mastery requires multiple cognitive competencies: theoretical comprehension, practical application, debugging proficiency, and communication/teaching ability.

## Decision
We implemented a four-pillar pedagogical assessment model in `src/engine/mastery.ts`:
- **Conceptual** ($20\%$ weight): Theoretical grasp of core principles.
- **Practical** ($20\%$ weight): Ability to apply concepts in code or execution.
- **Debug** ($20\%$ weight): Ability to troubleshoot, identify root causes, and fix failures.
- **Feynman** ($40\%$ weight - double weighted): Ability to articulate and explain concepts simply without jargon.

Mastery calculation formula:

```text
topic_mastery = round((conceptual + practical + debug + 2 * feynman) / 5, 4)
```

A topic is considered **mastered** and satisfies downstream dependencies when its weighted score reaches or exceeds `0.70` (70%).

## Consequences
- **Positive**:
  - Encourages holistic comprehension rather than rote memorization.
  - Double weighting the Feynman technique emphasizes deep conceptual clarity.
  - Clean floating point normalization clamped to $[0.0, 1.0]$.
- **Negative / Tradeoffs**:
  - Requires evaluating topics across 4 dimensions rather than a single metric.

## Alternatives Considered

1. **Unweighted Equal Average (25% per Pillar)**:
   - *Description*: $\text{mastery} = (c + p + d + f) / 4$.
   - *Pros*: Simpler conceptual formulation.
   - *Why Rejected*: In accordance with Richard Feynman's learning heuristics, the ability to articulate and explain a concept simply without jargon serves as a primary indicator of genuine comprehension. PALEE deliberately double-weights the Feynman dimension (40%) as an architectural design decision to penalize superficial rote memorization and prioritize clear technical articulation.

2. **1-Dimensional Traditional Recall Score (0.0 to 1.0)**:
   - *Description*: Single scalar score representing overall familiarity.
   - *Pros*: Low cognitive friction when recording a review.
   - *Why Rejected*: Conflates theoretical memorization with practical execution. A developer might memorize a concept's definition but fail to debug a production outage or implement it in code.

3. **Bloom's Revised Taxonomy 6-Tier Scoring Hierarchy**:
   - *Description*: Evaluating Remember, Understand, Apply, Analyze, Evaluate, Create independently.
   - *Pros*: Academically comprehensive educational framework.
   - *Why Rejected*: 6 distinct evaluation dimensions impose excessive cognitive overhead on everyday study workflows. Four targeted dimensions (Conceptual, Practical, Debug, Feynman) capture software engineering workflows cleanly.

4. **Time-Decayed Dynamic Mastery**:
   - *Description*: Continuously decreasing mastery scores as time passes since the last review.
   - *Why Rejected*: Conflates retrieval scheduling with fundamental competence. Temporal decay is already handled by SM-2 `due_at` and `ease_factor` intervals; modifying the underlying mastery score creates dual-decay instability in dependency graph prerequisites.

