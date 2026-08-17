import { loadConfig } from './config';
import { loadTopics } from '../storage/loader';
import { updateFrontmatter, computeFingerprint } from '../storage/frontmatter';
import { atomicWrite } from '../storage/atomic-write';
import { processReview, computeDueDate, formatLocalDateOnly } from '../engine/sm2';

async function reviewCommand(topicQuery: string, qualityStr: string): Promise<void> {
  try {
    if (!/^[0-5]$/.test(qualityStr)) {
      console.error('Error: Quality must be an integer from 0 to 5');
      process.exit(2);
    }
    const quality = parseInt(qualityStr, 10);

    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const loaded = loadTopics(vaultPath);
    const candidates = loaded.filter(
      (t) =>
        t.palee_id === topicQuery ||
        t.palee_id.includes(topicQuery) ||
        t.title.toLowerCase().includes(topicQuery.toLowerCase())
    );

    if (candidates.length === 0) {
      console.error(`Error: No topic found matching "${topicQuery}"`);
      process.exit(2);
    }

    if (candidates.length > 1) {
      console.error(`Error: Multiple topics match "${topicQuery}":`);
      for (const c of candidates) {
        console.error(`  - ${c.palee_id}: ${c.title}`);
      }
      console.error('Please provide a more specific query.');
      process.exit(2);
    }

    const topic = candidates[0];
    const { content, frontmatter, filePath } = topic;


    const currentState = {
      ease_factor: (frontmatter.ease_factor as number) || 2.5,
      interval_days: (frontmatter.interval_days as number) || 1,
      repetition: (frontmatter.repetition as number) || 0,
      lapses: (frontmatter.lapses as number) || 0,
    };

    const newState = processReview(currentState, quality);
    const reviewedAt = new Date();
    const dueDate = computeDueDate(reviewedAt, newState.interval_days!);

    const updates: Record<string, unknown> = {
      ...newState,
      last_reviewed_at: formatLocalDateOnly(reviewedAt),
      due_at: formatLocalDateOnly(dueDate),
    };

    const updatedContent = updateFrontmatter(content, updates);
    const fingerprint = computeFingerprint(content);

    await atomicWrite(vaultPath, filePath, updatedContent, fingerprint);



    console.log(`✓ Review recorded for ${topic.title}`);
    console.log(`  Quality: ${quality}`);
    console.log(`  New ease factor: ${newState.ease_factor}`);
    console.log(`  Next interval: ${newState.interval_days} day(s)`);
    console.log(`  Due: ${formatLocalDateOnly(dueDate)}`);
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
