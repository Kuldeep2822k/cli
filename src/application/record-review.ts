/**
 * `record-review` use-case: the pure SM-2 state transition behind `palee review`.
 *
 * Given a note's frontmatter, a recall-quality rating, and the review time, it
 * computes the frontmatter field updates to persist. It performs no I/O, OCC, or
 * process handling — the CLI layer keeps the read-reread fingerprint check, the
 * atomic write, output formatting, and exit-code mapping.
 */

import { processReview, computeDueDate, formatLocalDateOnly } from '../engine/sm2';
import { resolveTopicMastery, carriedPillarScores } from '../engine/mastery';
import { Review } from '../types';

export interface ReviewOutcome {
  /** Frontmatter fields to write back. */
  updates: Record<string, unknown>;
  /** The post-review SM-2 state (for display). */
  newState: Partial<Review>;
  /** The computed next due date (for display). */
  dueDate: Date;
  /**
   * True when the note carried a due date and this review happened before it (#301).
   *
   * @remarks
   * The comparison lives here, in the application layer: `processReview` stays
   * pure and owns no timestamps — callers own `last_reviewed_at`/`due_at` — so
   * an early-review check that reads the note's stored `due_at` and the review
   * instant cannot move into `sm2.ts`.
   */
  early: boolean;
  /** The note's pre-review due date as a local `YYYY-MM-DD`, or null when it had none. */
  currentDueAt: string | null;
}

/**
 * Reads the note's current due date as a local calendar day.
 *
 * @param frontmatter - Parsed frontmatter of the note being reviewed
 * @returns The stored due day as `YYYY-MM-DD`, or null when absent or unreadable
 *
 * @remarks
 * `due_at` may be the literal `null` (never reviewed), a `YYYY-MM-DD` string, or
 * another date shape — never assume one format. A literal `null`/absent key is
 * handled before any `new Date(...)` construction. A day string is returned as
 * it stands so the early comparison is calendar-day text, not an instant parse:
 * `new Date('YYYY-MM-DD')` reads as UTC midnight and would make same-day local
 * reviews look early west of UTC.
 */
function carriedDueDay(frontmatter: Record<string, unknown>): string | null {
  const raw = frontmatter.due_at;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : formatLocalDateOnly(parsed);
  }
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : formatLocalDateOnly(raw);
  }
  return null;
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

  const currentDueAt = carriedDueDay(frontmatter);
  const early = currentDueAt !== null && formatLocalDateOnly(reviewedAt) < currentDueAt;

  const topicMastery = resolveTopicMastery({
    conceptual: frontmatter.conceptual,
    practical: frontmatter.practical,
    debug: frontmatter.debug,
    feynman: frontmatter.feynman,
    existing: frontmatter.topic_mastery,
    precedence: 'pillars-first',
  });

  // A pillar absent from the note is dropped here, exactly as roadmap import (#191)
  // and adopt (#277) already do: review must never write an assessment score the
  // learner does not have (#300). Present pillars pass through byte-identical.
  const updates: Record<string, unknown> = {
    ...newState,
    ...carriedPillarScores(frontmatter),
    topic_mastery: topicMastery,
    last_reviewed_at: formatLocalDateOnly(reviewedAt),
    due_at: formatLocalDateOnly(dueDate),
  };

  return { updates, newState, dueDate, early, currentDueAt };
}
