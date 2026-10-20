import fs from 'fs';
import { loadConfig } from './config';
import { resolveVaultTarget } from './vault-echo';
import { exitCodeFor } from './exit-codes';
import { resolveTopicQuery } from './topic-query';
import {
  loadTopics,
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
} from '../storage';
import { computeTopicMastery, normalizeScore, MASTERY_THRESHOLD } from '../engine/mastery';
import { programName } from './program-name';
import {
  PILLARS,
  Pillar,
  buildAssessmentUpdate,
  assessmentAvailabilityDiff,
} from '../application/record-assessment';
import { AssessOptions, NodeError } from '../types';

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
 * Prints what an assessment did, or would do, to mastery and to the notes gated
 * behind it.
 *
 * @param parsed - Pillars the learner named on the command line
 * @param scores - The full pillar set after merging stored values
 * @param previousMastery - `topic_mastery` as the note held it
 * @param topicMastery - `topic_mastery` this assessment produces
 * @param unlocked - Dependent ids `palee plan` would newly offer
 * @param newlyBlocked - Dependent ids `palee plan` would stop offering
 * @param context - `recording` after a write, or `preview` for `--dry-run`;
 *   `force` silences the lowering notice on a recording only
 *
 * @remarks One implementation serves both the recording and the preview, so a
 * `--dry-run` cannot drift from the outcome it predicts (#269). The lowering
 * notice names what a *recorded* assessment re-hid; a preview already says it
 * wrote nothing, and `--force` suppresses the notice without changing the record
 * — the same shape `palee review` set for an early review (#301).
 *
 * @returns Nothing; writes the report to stdout.
 */
function printAssessmentEffect(
  parsed: Map<Pillar, number>,
  scores: Record<Pillar, number>,
  previousMastery: number,
  topicMastery: number,
  unlocked: string[],
  newlyBlocked: string[],
  context: { recording: boolean; force?: boolean }
): void {
  const threshold = MASTERY_THRESHOLD.toFixed(2);
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
    if (context.recording && !context.force) {
      console.log(`  ⚠ Lowered from ${previousMastery} to ${topicMastery} - these notes were ready while mastery sat above ${threshold}; palee plan stops offering them until it rises again`);
      console.log('  Pass --force to record a lowering assessment without this warning, or --dry-run to see it before you commit to it.');
    }
  } else {
    console.log('  No topic changes availability; a dependent may gate on something else.');
  }
}

/**
 * CLI command handler for recording a four-pillar assessment of a topic.
 *
 * @param topicQuery - The palee_id or title substring matching the target topic.
 * @param options - Pillar scores given on the command line, as raw strings, plus
 * the `force` and `dryRun` modifiers.
 * @returns Promise resolving when the assessment is written and mastery recomputed.
 * @remarks Sets process.exitCode = 2 on a missing vault, an unusable score, a
 * missing or ambiguous topic, or a call naming no pillar at all;
 * process.exitCode = 4 on OCC lock conflicts, and process.exitCode = 5 on
 * unexpected exceptions. `--dry-run` exits 0 and writes nothing; `--force`
 * changes only whether the lowering notice prints, never what is recorded.
 * Neither flag adds an exit code to the set above.
 *
 * @remarks A recorded assessment that lowers mastery re-hides the notes that
 * were ready behind the old value. They are named in the report rather than
 * left for the learner to discover in `palee plan`, and `--dry-run` gives the
 * same report before anything is committed (#269).
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
      console.error(`Usage: ${programName()} assess <topic> [--conceptual N] [--practical N] [--debug N] [--feynman N]`);
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
    // An assessment rewrites the note it scores, so it names the vault it wrote into (#311).
    // `json: false` keeps PALEE_JSON from switching this human-only command's
    // vault refusal to JSON above prose results.
    const target = resolveVaultTarget(config, { json: false });
    if (!target) return;
    const vaultPath = target.vaultPath;
    const loaded = loadTopics(vaultPath);
    const resolution = resolveTopicQuery(loaded, topicQuery);

    if (resolution.kind === 'none') {
      console.error(`Error: No topic found matching "${topicQuery}"`);
      process.exitCode = 2;
      return;
    }

    if (resolution.kind === 'ambiguous') {
      console.error(`Error: Multiple topics match "${topicQuery}":`);
      for (const c of resolution.candidates) {
        console.error(`  - ${c.palee_id}: ${c.title}`);
      }
      console.error('Please provide a more specific query.');
      process.exitCode = 2;
      return;
    }

    const topic = resolution.topic;
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

    const result = buildAssessmentUpdate(frontmatter, parsed, new Date());
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 2;
      return;
    }
    const { scores, previousMastery, topicMastery, updates } = result.value;

    // The effect on dependents is computed from the snapshot taken before any
    // write, so a `--dry-run` preview and a recording report the same numbers
    // and neither can drift from the other (#269).
    const { unlocked, newlyBlocked } = assessmentAvailabilityDiff(loaded, topic.palee_id, previousMastery, topicMastery);

    if (options.dryRun) {
      // Every check a recording runs has passed by this point: the vault, the
      // topic resolution, the note re-read and fingerprint compare, and each
      // stored pillar. No lock is taken and no byte is written.
      console.log(`Assessment preview for ${topic.title} (${topic.palee_id})`);
      printAssessmentEffect(parsed, scores, previousMastery, topicMastery, unlocked, newlyBlocked, { recording: false });
      console.log('Dry-run complete. No files were modified.');
      return;
    }

    const updatedContent = updateFrontmatter(freshContent, updates);

    await atomicWrite(vaultPath, filePath, updatedContent, freshFingerprint);

    console.log(`✓ Assessment recorded for ${topic.title} (${topic.palee_id})`);
    printAssessmentEffect(parsed, scores, previousMastery, topicMastery, unlocked, newlyBlocked, {
      recording: true,
      force: options.force === true,
    });
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
  }
}

export { assessCommand };
export default assessCommand;
