import fs from 'fs';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { exitCodeFor } from './exit-codes';
import {
  loadTopics,
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
} from '../storage';
import { computeTopicMastery, normalizeScore, MASTERY_THRESHOLD } from '../engine/mastery';
import { getReadyTopics, quarantineCyclicTopics } from '../engine/dependency';
import { matchesTopicQuery } from '../application/resolve-topic-query';
import { AssessOptions, NodeError, type TopicNode } from '../types';

/** The four pillar flags, in the order they are printed and validated. */
const PILLARS = ['conceptual', 'practical', 'debug', 'feynman'] as const;

type Pillar = (typeof PILLARS)[number];

/**
 * Parses and range-checks one `--pillar` argument.
 *
 * @param flag - The flag name, for the error message
 * @param raw - The raw CLI string
 * @returns `{ value }` on success, or `{ error }` explaining the rejection
 *
 * @remarks
 * Out-of-range values are rejected rather than clamped. `normalizeScore` clamps
 * silently, which is right for a frontmatter field read from disk but wrong for
 * a number the learner just typed: `--conceptual 85` meaning 85% would become a
 * mastery contribution of 1.0 with no complaint, and the resulting score would
 * be untraceable to the input.
 */
function parsePillar(flag: string, raw: string): { value?: number; error?: string } {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed)) {
    return { error: `Error: --${flag} expects a number between 0 and 1 (received "${raw}")` };
  }
  if (parsed < 0 || parsed > 1) {
    return { error: `Error: --${flag} expects a number between 0 and 1 (received ${raw})` };
  }
  return { value: normalizeScore(parsed) };
}

/**
 * Reads a pillar score already stored in a note, without clamping it.
 *
 * @param flag - The pillar name, for the error message
 * @param raw - The frontmatter value as found on disk
 * @returns `{ value }` when it is a usable score, or `{ error }` naming the field
 *
 * @remarks
 * `normalizeScore` clamps to `[0, 1]`, which is the right treatment for a field
 * being displayed and the wrong one for a number that is about to decide whether
 * a prerequisite gate opens. A stored `feynman: 2` contributing a full mark would
 * unlock a topic the learner never assessed, so it is refused instead — and the
 * pillar can still be set by naming it explicitly on the command line.
 */
function readScoreRange(flag: string, raw: unknown): { value?: number; error?: string } {
  // Scalars only. `Number(String([1]))` is `1`, so a one-element YAML sequence
  // would otherwise read as a perfect score while `loadTopics` sees 0 and
  // `palee validate` rejects the field — three different answers from one note,
  // with this command giving the most permissive of them.
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
 * Which topics `palee plan` would offer, computed the way plan computes it:
 * cyclic topics quarantined first, then every prerequisite checked.
 *
 * @param topics - Every loaded topic, before the assessment being recorded
 * @param assessmentId - The topic whose mastery this call overrides
 * @param mastery - The mastery to assume for that topic
 * @returns The set of palee ids plan would list as ready
 *
 * @remarks Counting dependents instead would overstate what an assessment
 * unlocked: a dependent with a second unmet prerequisite stays blocked, and one
 * inside a dependency cycle is excluded from the ready list entirely.
 */
function readyTopicIds(topics: TopicNode[], assessmentId: string, mastery: number): Set<string> {
  const map = new Map<string, TopicNode>();
  for (const t of topics) {
    map.set(t.palee_id, t.palee_id === assessmentId ? { ...t, topic_mastery: mastery } : t);
  }
  const { acyclic } = quarantineCyclicTopics(map);
  return new Set(getReadyTopics(acyclic, MASTERY_THRESHOLD).map((t) => t.palee_id));
}

/**
 * CLI command handler for recording a four-pillar assessment of a topic.
 *
 * @param topicQuery - The palee_id or title substring matching the target topic.
 * @param options - Pillar scores given on the command line, as raw strings.
 * @returns Promise resolving when the assessment is written and mastery recomputed.
 * @remarks Sets process.exitCode = 2 on a missing vault, an unusable score, a
 * missing or ambiguous topic, or a call naming no pillar at all;
 * process.exitCode = 4 on OCC lock conflicts, and process.exitCode = 5 on
 * unexpected exceptions.
 *
 * @remarks Mastery is recomputed with `computeTopicMastery` directly rather than
 * through `resolveTopicMastery({ precedence: 'pillars-first' })`, because that
 * helper treats "every pillar is 0" as "no assessment data" and keeps the
 * existing value. Here the pillars are the whole point of the call, so
 * `palee assess X --conceptual 0 --practical 0 --debug 0 --feynman 0` must be
 * able to take a topic back below the threshold. Nothing else in v0.5.x raises
 * `topic_mastery`, so without this command no gate can ever be passed.
 *
 * @example
 * ```typescript
 * await assessCommand('topic-calculus', { conceptual: '0.8', feynman: '0.9' });
 * ```
 */
async function assessCommand(topicQuery: string, options: AssessOptions = {}): Promise<void> {
  try {
    const given = PILLARS.filter((p) => options[p] !== undefined);
    if (given.length === 0) {
      console.error('Error: assess needs at least one pillar score');
      console.error('Usage: palee assess <topic> [--conceptual N] [--practical N] [--debug N] [--feynman N]');
      console.error('Each score is a number from 0 to 1.');
      process.exitCode = 2;
      return;
    }

    const parsed = new Map<Pillar, number>();
    for (const pillar of given) {
      const result = parsePillar(pillar, options[pillar] as string);
      if (result.error) {
        console.error(result.error);
        process.exitCode = 2;
        return;
      }
      parsed.set(pillar, result.value as number);
    }

    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath);
    if (!vaultPath) return;
    const loaded = loadTopics(vaultPath);
    // An exact id wins outright: `T-math` is the learner naming a topic, and a
    // neighbour called `T-math-2` matching it by substring must not turn a
    // specific request into an ambiguity error that writes nothing.
    const exact = loaded.filter((t) => t.palee_id === topicQuery);
    const candidates = exact.length > 0
      ? exact
      : loaded.filter((t) => matchesTopicQuery(t.palee_id, t.title, topicQuery));

    if (candidates.length === 0) {
      console.error(`Error: No topic found matching "${topicQuery}"`);
      process.exitCode = 2;
      return;
    }

    if (candidates.length > 1) {
      console.error(`Error: Multiple topics match "${topicQuery}":`);
      for (const c of candidates) {
        console.error(`  - ${c.palee_id}: ${c.title}`);
      }
      console.error('Please provide a more specific query.');
      process.exitCode = 2;
      return;
    }

    const topic = candidates[0];
    const { filePath } = topic;
    const initialFingerprint = computeFingerprint(topic.content);

    // OCC TOCTOU protection: re-read disk immediately prior to write
    let freshContent: string;
    try {
      if (!fs.existsSync(filePath)) {
        const err = new Error(`OCC conflict: Topic note ${filePath} does not exist`) as NodeError;
        err.code = 'ECONFLICT';
        throw err;
      }
      freshContent = fs.readFileSync(filePath, 'utf8');
    } catch (readErr: unknown) {
      if ((readErr as NodeError).code === 'ENOENT') {
        const conflictErr = new Error(`OCC conflict: Topic note ${filePath} does not exist or was removed`) as NodeError;
        conflictErr.code = 'ECONFLICT';
        throw conflictErr;
      }
      throw readErr;
    }

    const freshFingerprint = computeFingerprint(freshContent);

    if (initialFingerprint !== freshFingerprint) {
      const conflictErr = new Error(`OCC conflict: Topic note ${filePath} was modified concurrently during assessment`) as NodeError;
      conflictErr.code = 'ECONFLICT';
      throw conflictErr;
    }

    const { frontmatter: rawFm } = parseFrontmatter(freshContent);
    const frontmatter = rawFm || {};

    // A pillar the learner did not name is read, never rewritten. Passing every
    // stored value through `normalizeScore` and writing it back would clamp a
    // corrupt `feynman: 2` to 1 silently and feed a mastery contribution nobody
    // entered — which can open a prerequisite gate. An unusable stored score is
    // reported instead of guessed at.
    const scores: Record<Pillar, number> = { conceptual: 0, practical: 0, debug: 0, feynman: 0 };
    for (const pillar of PILLARS) {
      // An explicitly supplied score replaces whatever was stored, so a corrupt
      // value in that field is not the learner's problem here.
      if (parsed.has(pillar)) continue;
      const raw = frontmatter[pillar];
      if (raw === undefined || raw === null || raw === '') continue;
      const stored = readScoreRange(pillar, raw);
      if (stored.error) {
        console.error(stored.error);
        process.exitCode = 2;
        return;
      }
      scores[pillar] = stored.value as number;
    }
    for (const [pillar, value] of parsed) {
      scores[pillar] = value;
    }

    const previousMastery = normalizeScore(frontmatter.topic_mastery);
    const topicMastery = computeTopicMastery(scores.conceptual, scores.practical, scores.debug, scores.feynman);

    const updates: Record<string, unknown> = {
      topic_mastery: topicMastery,
      assessed_at: new Date().toISOString(),
    };
    for (const [pillar, value] of parsed) {
      updates[pillar] = value;
    }

    const updatedContent = updateFrontmatter(freshContent, updates);

    await atomicWrite(vaultPath, filePath, updatedContent, freshFingerprint);

    const readyBefore = readyTopicIds(loaded, topic.palee_id, previousMastery);
    const readyAfter = readyTopicIds(loaded, topic.palee_id, topicMastery);

    // The topic being assessed drops out of the ready list once mastered — that
    // is the point of the call, not a lockout — so it is excluded from both
    // differences and only the other topics' availability is reported.
    const others = (ids: Set<string>): string[] => [...ids].filter((id) => id !== topic.palee_id);
    const before = others(readyBefore);
    const after = others(readyAfter);
    const unlocked = after.filter((id) => !readyBefore.has(id));
    const newlyBlocked = before.filter((id) => !readyAfter.has(id));

    const threshold = MASTERY_THRESHOLD.toFixed(2);
    console.log(`✓ Assessment recorded for ${topic.title} (${topic.palee_id})`);
    for (const pillar of PILLARS) {
      const mark = parsed.has(pillar) ? '' : ' (unchanged)';
      console.log(`  ${pillar.padEnd(11)} ${scores[pillar]}${mark}`);
    }
    console.log(`  mastery     ${previousMastery} → ${topicMastery}`);

    if (topicMastery >= MASTERY_THRESHOLD) {
      console.log(`  Mastered (≥ ${threshold}).`);
    } else {
      console.log(`  Below the ${threshold} threshold, so it still gates what depends on it.`);
      if (scores.feynman === 0) {
        // Ceiling read from the engine rather than restated here: it is whatever
        // maxed ordinary pillars actually score, so this line cannot drift from
        // the weighting it describes — and if that weighting ever changes so the
        // three pillars can reach the gate, the hint stops printing by itself.
        const ceiling = computeTopicMastery(1, 1, 1, 0);
        if (ceiling < MASTERY_THRESHOLD) {
          console.log(
            `  The feynman pillar is 0, and mastery is (conceptual + practical + debug + 2 * feynman) / 5, so the ` +
              `other three cap at ${ceiling.toFixed(2)} and cannot reach ${threshold}. Score --feynman to lift this gate.`
          );
        }
      }
    }
    if (unlocked.length > 0) {
      const listed = unlocked.slice(0, 3).join(', ');
      console.log(
        `  ${unlocked.length} topic(s) newly offered by palee plan: ${listed}` +
          (unlocked.length > 3 ? `, +${unlocked.length - 3} more` : '')
      );
    } else if (newlyBlocked.length > 0) {
      console.log(`  ${newlyBlocked.length} topic(s) are no longer offered by palee plan.`);
    } else {
      console.log('  No topic changes availability; a dependent may gate on something else.');
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
  }
}

export { assessCommand };
export default assessCommand;
