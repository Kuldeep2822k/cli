import fs from 'fs';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import {
  loadTopics,
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  isConflictError,
} from '../storage';
import { processReview, computeDueDate, formatLocalDateOnly } from '../engine/sm2';
import { computeTopicMastery, normalizeScore } from '../engine/mastery';
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

    const currentState = {
      ease_factor: (frontmatter.ease_factor as number) || 2.5,
      interval_days: (frontmatter.interval_days as number) || 1,
      repetition: (frontmatter.repetition as number) || 0,
      lapses: (frontmatter.lapses as number) || 0,
    };

    const newState = processReview(currentState, quality);
    const reviewedAt = new Date();
    const dueDate = computeDueDate(reviewedAt, newState.interval_days!);

    const conceptual = normalizeScore(frontmatter.conceptual);
    const practical = normalizeScore(frontmatter.practical);
    const debug = normalizeScore(frontmatter.debug);
    const feynman = normalizeScore(frontmatter.feynman);

    const hasPillarScores = conceptual > 0 || practical > 0 || debug > 0 || feynman > 0;

    const topicMastery = hasPillarScores
      ? computeTopicMastery(conceptual, practical, debug, feynman)
      : (frontmatter.topic_mastery !== undefined && frontmatter.topic_mastery !== null
          ? normalizeScore(frontmatter.topic_mastery)
          : 0.0);

    const updates: Record<string, unknown> = {
      ...newState,
      conceptual,
      practical,
      debug,
      feynman,
      topic_mastery: topicMastery,
      last_reviewed_at: formatLocalDateOnly(reviewedAt),
      due_at: formatLocalDateOnly(dueDate),
    };

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
    process.exitCode = isConflictError(e) ? 4 : 5;
  }
}

export { reviewCommand };
export default reviewCommand;
