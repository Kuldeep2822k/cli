import fs from 'fs';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { exitCodeFor } from './exit-codes';
import { resolveTopicQuery } from './topic-query';
import {
  loadTopics,
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
} from '../storage';
import { formatLocalDateOnly } from '../engine/sm2';
import { buildReviewUpdate } from '../application/record-review';
import { NodeError } from '../types';

/**
 * CLI command handler for recording a spaced repetition (SM-2) review for a topic.
 *
 * @param topicQuery - The palee_id or title substring matching the target topic.
 * @param qualityStr - The SM-2 recall quality rating as a string ('0' through '5').
 * @returns Promise resolving when the review state is updated and saved.
 * @remarks Sets process.exitCode = 2 on invalid quality, missing vault, or missing/ambiguous topic,
 * process.exitCode = 4 on OCC lock conflicts, and process.exitCode = 5 on unexpected exceptions.
 *
 * @example
 * ```typescript
 * await reviewCommand('topic-calculus', '5');
 * ```
 */
async function reviewCommand(topicQuery: string, qualityStr: string): Promise<void> {
  try {
    if (!/^[0-5]$/.test(qualityStr)) {
      console.error('Error: Quality must be an integer from 0 to 5');
      process.exitCode = 2;
      return;
    }
    const quality = parseInt(qualityStr, 10);

    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath);
    if (!vaultPath) return;
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

    // OCC TOCTOU Protection: Re-read disk immediately prior to write
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
      const conflictErr = new Error(`OCC conflict: Topic note ${filePath} was modified concurrently during review`) as NodeError;
      conflictErr.code = 'ECONFLICT';
      throw conflictErr;
    }

    const { frontmatter: rawFm } = parseFrontmatter(freshContent);
    const frontmatter = rawFm || {};
    const reviewedAt = new Date();
    const { updates, newState, dueDate } = buildReviewUpdate(frontmatter, quality, reviewedAt);

    const updatedContent = updateFrontmatter(freshContent, updates);

    await atomicWrite(vaultPath, filePath, updatedContent, freshFingerprint);

    console.log(`✓ Review recorded for ${topic.title}`);
    console.log(`  Quality: ${quality}`);
    console.log(`  New ease factor: ${newState.ease_factor}`);
    console.log(`  Next interval: ${newState.interval_days} day(s)`);
    console.log(`  Due: ${formatLocalDateOnly(dueDate)}`);
    console.log(`  Repetitions: ${newState.repetition}`);

    if (quality < 3) {
      console.log('  ⚠ Review failed - interval reset to 1 day');
    }

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    // Corrupted on-disk SM-2 state is user-recoverable: point at the
    // repair path instead of leaving exit 5 as a dead end (BUG-003).
    if (/^Invalid (ease_factor|interval_days|repetition):/.test(err.message)) {
      console.error('Hint: this note\'s SM-2 review state is invalid. Run "palee validate --fix" to repair it.');
    }
    process.exitCode = exitCodeFor(e);
  }
}

export { reviewCommand };
export default reviewCommand;
