/**
 * `get-next-topics` use-case: the pure core behind `palee next`.
 *
 * Given loaded topics and the current time, it returns the actionable set
 * (never-reviewed topics plus elapsed reviews) ordered null-first then oldest,
 * along with the total topic count. It touches no Commander or process state so
 * it can be unit-tested and reused by non-CLI interfaces.
 */

import { LoadedTopic } from '../storage';
import { Difficulty } from '../types';
import { compareDue, normalizeDueDate, partitionDue } from './due-topics';

export interface NextTopic {
  id: string;
  title: string;
  path: string;
  dueAt: Date | null;
  mastery: number;
  repetition: number;
  difficulty?: Difficulty;
}

export interface NextTopicsResult {
  /** Actionable topics, ordered never-reviewed first then oldest due. */
  dueTopics: NextTopic[];
  /** Count of all loaded topics (not just the due ones). */
  totalTopics: number;
}

export function getNextTopics(topics: LoadedTopic[], now: Date): NextTopicsResult {
  const candidates: NextTopic[] = topics.map((t) => ({
    id: t.palee_id,
    title: t.title,
    path: t.path,
    dueAt: normalizeDueDate(t.due_at),
    mastery: t.topic_mastery,
    repetition: t.repetition ?? 0,
    difficulty: t.difficulty,
  }));

  const { dueReviews, neverReviewed } = partitionDue(candidates, now, (c) => c.dueAt);
  const dueTopics = [...neverReviewed, ...dueReviews].sort((a, b) => compareDue(a.dueAt, b.dueAt));

  return { dueTopics, totalTopics: topics.length };
}
