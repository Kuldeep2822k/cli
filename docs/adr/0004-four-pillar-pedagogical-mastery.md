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
$$\text{topic\_mastery} = \text{round}\left(\frac{\text{conceptual} + \text{practical} + \text{debug} + (2 \times \text{feynman})}{5}, 4\right)$$

A topic is considered **mastered** and satisfies downstream dependencies when its weighted score reaches or exceeds `0.70` (70%).

## Consequences
- **Positive**:
  - Encourages holistic comprehension rather than rote memorization.
  - Double weighting the Feynman technique emphasizes deep conceptual clarity.
  - Clean floating point normalization clamped to $[0.0, 1.0]$.
- **Negative / Tradeoffs**:
  - Requires evaluating topics across 4 dimensions rather than a single metric.
