/**
 * Due-topic selection primitives shared by the `next`, `plan`, and `dashboard`
 * read models. These are pure: no Commander, no process, no I/O.
 */

/**
 * Coerce a raw `due_at` value into a Date, treating empty/absent and
 * unparseable values as `null` (never scheduled).
 */
export function normalizeDueDate(raw: string | Date | null | undefined): Date | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Comparator ordering never-scheduled topics (null) first, then by oldest due
 * date. Stable for equal keys.
 */
export function compareDue(a: Date | null, b: Date | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a.getTime() - b.getTime();
}

export interface DuePartition<T> {
  /** Topics with a real due date that has elapsed (`due <= now`). */
  dueReviews: T[];
  /** Topics that have never been scheduled (`due == null`). */
  neverReviewed: T[];
}

/**
 * Split topics into elapsed scheduled reviews vs. never-scheduled topics.
 * Topics whose due date is still in the future fall into neither bucket.
 *
 * Callers compose the two buckets to match their own meaning of "due":
 * `next`/`plan` treat `neverReviewed ∪ dueReviews` as actionable, while
 * `dashboard`'s review-backlog metric counts `dueReviews` only.
 */
export function partitionDue<T>(
  items: T[],
  now: Date,
  getDue: (item: T) => Date | null,
): DuePartition<T> {
  const dueReviews: T[] = [];
  const neverReviewed: T[] = [];
  for (const item of items) {
    const due = getDue(item);
    if (due === null) {
      neverReviewed.push(item);
    } else if (due <= now) {
      dueReviews.push(item);
    }
  }
  return { dueReviews, neverReviewed };
}
