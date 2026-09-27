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
import { AssessOptions, NodeError } from '../types';

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
    const candidates = loaded.filter(
      (t) =>
        t.palee_id === topicQuery ||
        t.palee_id.includes(topicQuery) ||
        t.title.toLowerCase().includes(topicQuery.toLowerCase())
    );

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

    const scores: Record<Pillar, number> = {
      conceptual: normalizeScore(frontmatter.conceptual),
      practical: normalizeScore(frontmatter.practical),
      debug: normalizeScore(frontmatter.debug),
      feynman: normalizeScore(frontmatter.feynman),
    };
    for (const [pillar, value] of parsed) {
      scores[pillar] = value;
    }

    const previousMastery = normalizeScore(frontmatter.topic_mastery);
    const topicMastery = computeTopicMastery(scores.conceptual, scores.practical, scores.debug, scores.feynman);

    const updates: Record<string, unknown> = {
      conceptual: scores.conceptual,
      practical: scores.practical,
      debug: scores.debug,
      feynman: scores.feynman,
      topic_mastery: topicMastery,
      assessed_at: new Date().toISOString(),
    };

    const updatedContent = updateFrontmatter(freshContent, updates);

    await atomicWrite(vaultPath, filePath, updatedContent, freshFingerprint);

    const threshold = MASTERY_THRESHOLD.toFixed(2);
    console.log(`✓ Assessment recorded for ${topic.title} (${topic.palee_id})`);
    for (const pillar of PILLARS) {
      const mark = parsed.has(pillar) ? '' : ' (unchanged)';
      console.log(`  ${pillar.padEnd(11)} ${scores[pillar]}${mark}`);
    }
    console.log(`  mastery     ${previousMastery} → ${topicMastery}`);

    if (topicMastery >= MASTERY_THRESHOLD) {
      const gated = loaded.filter(
        (t) => t.palee_id !== topic.palee_id && (t.depends_on ?? []).includes(topic.palee_id)
      );
      const unlocked = gated.filter((t) => normalizeScore(t.topic_mastery) < MASTERY_THRESHOLD);
      console.log(`  Mastered (≥ ${threshold}).`);
      console.log(
        unlocked.length > 0
          ? `  ${unlocked.length} topic(s) gated behind it are now reachable in palee plan.`
          : '  No open topic gates on it.'
      );
    } else {
      console.log(
        `  Below the ${threshold} threshold, so anything gated behind it stays blocked.`
      );
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
  }
}

export { assessCommand };
export default assessCommand;
