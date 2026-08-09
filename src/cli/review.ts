/**
 * Review Command Handler
 * Records a manual review for a topic
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from '../storage/frontmatter';
import { atomicWrite } from '../storage/atomic-write';
import { processReview, computeDueDate } from '../engine/sm2';

interface ReviewCandidate {
  id: string;
  title: string;
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

async function reviewCommand(topicQuery: string, qualityStr: string): Promise<void> {
  try {
    if (!/^[0-5]$/.test(qualityStr)) {
      console.error('Error: Quality must be an integer from 0 to 5');
      process.exit(2);
    }
    const quality = parseInt(qualityStr, 10);

    const configModule = await import('./config');
    const config = configModule.loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const files = walkVault(vaultPath);
    const candidates: ReviewCandidate[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (!frontmatter || !frontmatter.palee_id) continue;

      const id = frontmatter.palee_id as string;
      const title = (frontmatter.title as string) || path.basename(filePath, '.md');

      if (id === topicQuery || id.includes(topicQuery) ||
          title.toLowerCase().includes(topicQuery.toLowerCase())) {
        candidates.push({ id, title, path: filePath, content, frontmatter });
      }
    }

    if (candidates.length === 0) {
      console.error(`Error: No topic found matching "${topicQuery}"`);
      process.exit(2);
    }

    if (candidates.length > 1) {
      console.error(`Error: Multiple topics match "${topicQuery}":`);
      for (const c of candidates) {
        console.error(`  - ${c.id}: ${c.title}`);
      }
      console.error('Please provide a more specific query.');
      process.exit(2);
    }

    const topic = candidates[0];
    const { content, frontmatter } = topic;

    const currentState = {
      ease_factor: (frontmatter.ease_factor as number) || 2.5,
      interval_days: (frontmatter.interval_days as number) || 1,
      repetition: (frontmatter.repetition as number) || 0,
      lapses: (frontmatter.lapses as number) || 0,
    };

    const newState = processReview(currentState, quality);
    const reviewedAt = new Date();
    const dueDate = computeDueDate(reviewedAt, newState.interval_days!);

    const newScore = quality / 5.0;
    const { computeMastery } = await import('../engine/mastery');
    const topicMastery = computeMastery({
      conceptual: newScore,
      practical: newScore,
      debug: newScore,
      feynman: newScore
    });

    const updates: Record<string, unknown> = {
      ...newState,
      last_reviewed_at: reviewedAt.toISOString(),
      due_at: dueDate.toISOString(),
      conceptual: newScore,
      practical: newScore,
      debug: newScore,
      feynman: newScore,
      topic_mastery: topicMastery,
      assessed_at: reviewedAt.toISOString(),
    };

    const updatedContent = updateFrontmatter(content, updates);
    const fingerprint = computeFingerprint(content);

    await atomicWrite(vaultPath, topic.path, updatedContent, fingerprint);

    console.log(`✓ Review recorded for ${topic.title}`);
    console.log(`  Quality: ${quality}`);
    console.log(`  New ease factor: ${newState.ease_factor}`);
    console.log(`  Next interval: ${newState.interval_days} day(s)`);
    console.log(`  Due: ${dueDate.toISOString().split('T')[0]}`);
    console.log(`  Repetitions: ${newState.repetition}`);

    if (quality < 3) {
      console.log('  ⚠ Review failed - interval reset to 1 day');
    }

    process.exit(0);

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default reviewCommand;
