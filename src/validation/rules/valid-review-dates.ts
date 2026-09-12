/**
 * valid-review-dates rule (#39)
 *
 * @remarks
 * Validates the RAW on-disk review date fields (`last_reviewed_at`,
 * `due_at`) on topic notes. The loader stringifies any truthy value
 * (`String(v)`), so this rule reads the original frontmatter values —
 * a full ISO timestamp or an impossible calendar date must be
 * reported, not silently blessed into the scheduling pipeline.
 *
 * Policy (issue #39 + Phase-1 persisted shape):
 * - `null`/absent pass — that is the newly adopted state (adopt
 *   writes `last_reviewed_at: null, due_at: null`).
 * - Values must be strict zero-padded `YYYY-MM-DD` date-only strings
 *   — the exact shape `formatLocalDateOnly` writes — and real
 *   calendar dates (`2026-02-31` fails, it is not normalized into
 *   March). Full timestamps (`2026-09-01T12:00:00Z`) FAIL: date-only
 *   is the product contract; review scheduling compares local
 *   calendar days and a timestamp implies an instant.
 * - When both fields are present and individually valid, `due_at`
 *   must not be earlier than `last_reviewed_at` — an inverted pair
 *   schedules a review in the past and is corruption.
 *
 * Deterministic by construction: strict syntactic matching plus the
 * shared UTC calendar round-trip (see `review-dates.ts`) — no `new
 * Date(string)` parsing, no timezone or locale influence.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { isValidReviewDate, parseDateOnly } from './review-dates';

/**
 * Reports review date fields that are not real date-only calendar
 * dates, plus inverted reviewed/due pairs.
 */
export const validReviewDatesRule: ValidationRule = {
  id: 'valid-review-dates',
  description:
    'Review dates must be null or real YYYY-MM-DD calendar dates, and due_at must not precede last_reviewed_at',
  severity: 'error',
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      // Deterministic per-topic report order: last_reviewed_at, due_at
      // (the chronological pair in read order), then the inversion
      // finding.
      const lastReviewed = topic.frontmatter.last_reviewed_at;
      const dueAt = topic.frontmatter.due_at;

      const lastReviewedValid = isValidReviewDate(lastReviewed);
      const dueAtValid = isValidReviewDate(dueAt);

      if (!lastReviewedValid) {
        issues.push({
          ruleId: 'valid-review-dates',
          severity: 'error',
          message: `Topic ${topic.palee_id}: last_reviewed_at must be null or a YYYY-MM-DD calendar date, got ${JSON.stringify(lastReviewed)}`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'last_reviewed_at',
          details: { actual: lastReviewed },
        });
      }
      if (!dueAtValid) {
        issues.push({
          ruleId: 'valid-review-dates',
          severity: 'error',
          message: `Topic ${topic.palee_id}: due_at must be null or a YYYY-MM-DD calendar date, got ${JSON.stringify(dueAt)}`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'due_at',
          details: { actual: dueAt },
        });
      }

      // Chronological inversion: only decidable when both values are
      // individually valid date-only dates.
      if (lastReviewedValid && dueAtValid) {
        const from = parseDateOnly(lastReviewed);
        const to = parseDateOnly(dueAt);
        if (from !== null && to !== null && isEarlier(to, from)) {
          issues.push({
            ruleId: 'valid-review-dates',
            severity: 'error',
            message: `Topic ${topic.palee_id}: due_at (${String(dueAt)}) is earlier than last_reviewed_at (${String(lastReviewed)})`,
            file: topic.path,
            topicId: topic.palee_id,
            field: 'due_at',
            details: { due_at: dueAt, last_reviewed_at: lastReviewed },
          });
        }
      }
    }

    return issues;
  },
};

/**
 * Pure calendar-component ordering: is `a` an earlier date than `b`?
 *
 * @remarks Component-wise comparison of `YYYY-MM-DD` triples — no
 * `Date` objects, no timezone arithmetic, no ambiguity.
 */
function isEarlier(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number }
): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day < b.day;
}
