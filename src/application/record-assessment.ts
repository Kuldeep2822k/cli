/**
 * `record-assessment` use-case: the four-pillar write core and plan-availability
 * diff behind `palee assess`. Pure — no OCC, fs, Commander, or process handling.
 * The CLI keeps `--pillar` argument parsing, the read-reread fingerprint check,
 * the atomic write, output formatting, and exit-code mapping.
 */

import { computeTopicMastery, normalizeScore, MASTERY_THRESHOLD } from '../engine/mastery';
import { getReadyTopics, quarantineCyclicTopics } from '../engine/dependency';
import { TopicNode } from '../types';

/** The four pillar flags, in the order they are printed and validated. */
export const PILLARS = ['conceptual', 'practical', 'debug', 'feynman'] as const;

export type Pillar = (typeof PILLARS)[number];

/**
 * Reads a pillar score already stored in a note, without clamping it. A stored
 * value outside `[0, 1]` is refused rather than silently clamped, because it
 * would otherwise feed a mastery contribution nobody entered and could open a
 * prerequisite gate.
 */
function readScoreRange(flag: string, raw: unknown): { value?: number; error?: string } {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return {
      error:
        `Error: stored ${flag} score on this note is not a number between 0 and 1 ` +
        `(received ${JSON.stringify(raw)}). Pass --${flag} to set it, or repair the note with palee validate.`,
    };
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return {
      error:
        `Error: stored ${flag} score on this note is not a number between 0 and 1 ` +
        `(received ${JSON.stringify(raw)}). Pass --${flag} to set it, or repair the note with palee validate.`,
    };
  }
  return { value: normalizeScore(parsed) };
}

/**
 * Which topics `palee plan` would offer if `assessmentId` had the given mastery,
 * computed the way plan computes it: cyclic topics quarantined, prerequisites
 * checked over the acyclic subgraph.
 */
function readyTopicIds(topics: TopicNode[], assessmentId: string, mastery: number): Set<string> {
  const map = new Map<string, TopicNode>();
  for (const t of topics) {
    map.set(t.palee_id, t.palee_id === assessmentId ? { ...t, topic_mastery: mastery } : t);
  }
  const { acyclic } = quarantineCyclicTopics(map);
  return new Set(getReadyTopics(acyclic, MASTERY_THRESHOLD).map((t) => t.palee_id));
}

export interface AssessmentUpdate {
  /** Resolved pillar scores (given overrides merged over stored values). */
  scores: Record<Pillar, number>;
  /** Mastery before this assessment. */
  previousMastery: number;
  /** Mastery after this assessment. */
  topicMastery: number;
  /** Frontmatter fields to write back. */
  updates: Record<string, unknown>;
}

export type AssessmentResult =
  | { ok: true; value: AssessmentUpdate }
  | { ok: false; error: string };

/**
 * Compute the frontmatter update for an assessment. Explicitly supplied pillar
 * scores (`parsed`) replace stored values; a pillar not supplied is read from
 * the note, and an unusable stored value is surfaced as an error rather than
 * guessed at. Only supplied pillars are written back.
 */
export function buildAssessmentUpdate(
  frontmatter: Record<string, unknown>,
  parsed: Map<Pillar, number>,
  assessedAt: Date,
): AssessmentResult {
  const scores: Record<Pillar, number> = { conceptual: 0, practical: 0, debug: 0, feynman: 0 };
  for (const pillar of PILLARS) {
    if (parsed.has(pillar)) continue;
    const raw = frontmatter[pillar];
    if (raw === undefined || raw === null || raw === '') continue;
    const stored = readScoreRange(pillar, raw);
    if (stored.error) return { ok: false, error: stored.error };
    scores[pillar] = stored.value as number;
  }
  for (const [pillar, value] of parsed) {
    scores[pillar] = value;
  }

  const previousMastery = normalizeScore(frontmatter.topic_mastery);
  const topicMastery = computeTopicMastery(scores.conceptual, scores.practical, scores.debug, scores.feynman);

  const updates: Record<string, unknown> = {
    topic_mastery: topicMastery,
    assessed_at: assessedAt.toISOString(),
  };
  for (const [pillar, value] of parsed) {
    updates[pillar] = value;
  }

  return { ok: true, value: { scores, previousMastery, topicMastery, updates } };
}

export interface AvailabilityDiff {
  /** Ids newly offered by `palee plan` after the assessment (excluding the assessed topic). */
  unlocked: string[];
  /** Ids no longer offered after the assessment (excluding the assessed topic). */
  newlyBlocked: string[];
}

/**
 * How the assessed topic's new mastery changes what `palee plan` would offer.
 * The assessed topic itself is excluded from both lists: it dropping out of the
 * ready list once mastered is the point of the call, not a lockout.
 */
export function assessmentAvailabilityDiff(
  topics: TopicNode[],
  topicId: string,
  previousMastery: number,
  newMastery: number,
): AvailabilityDiff {
  const readyBefore = readyTopicIds(topics, topicId, previousMastery);
  const readyAfter = readyTopicIds(topics, topicId, newMastery);
  const others = (ids: Set<string>): string[] => [...ids].filter((id) => id !== topicId);
  const unlocked = others(readyAfter).filter((id) => !readyBefore.has(id));
  const newlyBlocked = others(readyBefore).filter((id) => !readyAfter.has(id));
  return { unlocked, newlyBlocked };
}

