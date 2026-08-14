/**
 * Dashboard Command Handler
 * Interactive learning dashboard (Phase 1: text summary only)
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter } from '../storage/frontmatter';
import { loadConfig } from './config';
import { printEmptyVaultOnboarding, validateVaultPath } from './onboarding';

interface DashboardTopic {
  id: string;
  title: string;
  mastery: number;
  repetition: number;
  lapses: number;
  difficulty: string;
  due_at: Date | null;
}

async function dashboardCommand(): Promise<void> {
  try {
    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath);
    const files = walkVault(vaultPath);
    const now = new Date();

    // Load all topics sequentially
    const topics: DashboardTopic[] = [];
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        if (!frontmatter || !frontmatter.palee_id) continue;

        let dueAt = frontmatter.due_at ? new Date(frontmatter.due_at as string) : null;
        if (dueAt && Number.isNaN(dueAt.getTime())) {
          dueAt = null;
        }
        topics.push({
          id: frontmatter.palee_id as string,
          title: (frontmatter.title as string) || path.basename(filePath, '.md'),
          mastery: (frontmatter.topic_mastery as number) || 0,
          repetition: (frontmatter.repetition as number) || 0,
          lapses: (frontmatter.lapses as number) || 0,
          difficulty: (frontmatter.difficulty as string) || 'intermediate',
          due_at: dueAt,
        });
      } catch {}
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              PALEE Learning Dashboard                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    if (topics.length === 0) {
      printEmptyVaultOnboarding();
      return;
    }

    // Stats
    const total = topics.length;
    const mastered = topics.filter(t => t.mastery >= 0.7).length;
    const learning = topics.filter(t => t.mastery > 0 && t.mastery < 0.7).length;
    const newTopics = topics.filter(t => t.mastery === 0).length;
    const due = topics.filter(t => t.due_at && t.due_at <= now).length;

    const masteredPct = total > 0 ? (mastered / total * 100).toFixed(1) : '0.0';
    const learningPct = total > 0 ? (learning / total * 100).toFixed(1) : '0.0';
    const newPct = total > 0 ? (newTopics / total * 100).toFixed(1) : '0.0';

    console.log(`Total Topics:      ${total}`);
    console.log(`Mastered (≥70%):   ${mastered} (${masteredPct}%)`);
    console.log(`Learning:          ${learning} (${learningPct}%)`);
    console.log(`New:               ${newTopics} (${newPct}%)`);
    console.log(`Due for Review:    ${due}`);
    console.log();

    // By difficulty
    console.log('By Difficulty:');
    const byDiff: Record<string, DashboardTopic[]> = {
      beginner: topics.filter(t => t.difficulty === 'beginner'),
      intermediate: topics.filter(t => t.difficulty === 'intermediate'),
      advanced: topics.filter(t => t.difficulty === 'advanced'),
    };

    for (const [level, list] of Object.entries(byDiff)) {
      if (list.length > 0) {
        const masteredInLevel = list.filter(t => t.mastery >= 0.7).length;
        console.log(`  ${level.padEnd(15)}: ${list.length} topics (${masteredInLevel} mastered)`);
      }
    }
    console.log();

    // Next review
    const dueTopics = topics.filter(t => t.due_at && t.due_at <= now);
    if (dueTopics.length > 0) {
      dueTopics.sort((a, b) => {
        if (!a.due_at) return -1;
        if (!b.due_at) return 1;
        return a.due_at.getTime() - b.due_at.getTime();
      });

      const next = dueTopics[0];
      console.log('Next Review:');
      console.log(`  ${next.title} (${next.id})`);
      console.log(`  Mastery: ${(next.mastery * 100).toFixed(1)}% | Reps: ${next.repetition}`);
      console.log();
    }

    console.log('─────────────────────────────────────────────────────────────');
    console.log('Run "palee next" to start reviewing');
    console.log('Run "palee plan" to see today\'s learning plan');

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default dashboardCommand;
