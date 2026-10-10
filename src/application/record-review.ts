/**
 * `record-review` use-case: the pure SM-2 state transition behind `palee review`.
 *
 * Given a note's frontmatter, a recall-quality rating, and the review time, it
 * computes the frontmatter field updates to persist. It performs no I/O, OCC, or
 * process handling — the CLI layer keeps the read-reread fingerprint check, the
 * atomic write, output formatting, and exit-code mapping.
 */

import { processReview, computeDueDate, formatLocalDateOnly } from '../engine/sm2';
import { resolveTopicMastery, normalizeScore } from '../engine/mastery';
import { Review } from '../types';

export interface ReviewOutcome {
  /** Frontmatter fields to write back. */
  updates: Record<string, unknown>;
  /** The post-review SM-2 state (for display). */
  newState: Partial<Review>;
  /** The computed next due date (for display). */
  dueDate: Date;
}

export function buildReviewUpdate(
  frontmatter: Record<string, unknown>,
  quality: number,
  reviewedAt: Date,
): ReviewOutcome {
  // Explicit null/undefined checks; a literal 0 is preserved, not defaulted.
  const currentState = {
    ease_factor: frontmatter.ease_factor !== undefined && frontmatter.ease_factor !== null
      ? (frontmatter.ease_factor as number)
      : 2.5,
    interval_days: frontmatter.interval_days !== undefined && frontmatter.interval_days !== null
      ? (frontmatter.interval_days as number)
      : 1,
    repetition: frontmatter.repetition !== undefined && frontmatter.repetition !== null
      ? (frontmatter.repetition as number)
      : 0,
    lapses: frontmatter.lapses !== undefined && frontmatter.lapses !== null
      ? (frontmatter.lapses as number)
      : 0,
  };

  const newState = processReview(currentState, quality);
  const dueDate = computeDueDate(reviewedAt, newState.interval_days!);

  const topicMastery = resolveTopicMastery({
    conceptual: frontmatter.conceptual,
    practical: frontmatter.practical,
    debug: frontmatter.debug,
    feynman: frontmatter.feynman,
    existing: frontmatter.topic_mastery,
    precedence: 'pillars-first',
  });

  const updates: Record<string, unknown> = {
    ...newState,
    conceptual: normalizeScore(frontmatter.conceptual),
    practical: normalizeScore(frontmatter.practical),
    debug: normalizeScore(frontmatter.debug),
    feynman: normalizeScore(frontmatter.feynman),
    topic_mastery: topicMastery,
    last_reviewed_at: formatLocalDateOnly(reviewedAt),
    due_at: formatLocalDateOnly(dueDate),
  };

  return { updates, newState, dueDate };
}
