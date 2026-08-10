import { loadConfig } from './config';
/**
 * Plan Command Handler
 * Shows learning plan for the day
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter } from '../storage/frontmatter';
import { getReadyTopics } from '../engine/dependency';
import { TopicNode } from '../types';

interface PlanTopic extends TopicNode {
  title: string;
  path: string;
  due_at: Date | null;
  repetition: number;
  difficulty: string;
}

async function planCommand(): Promise<void> {
  try {
    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const files = walkVault(vaultPath);
    const topics = new Map<string, PlanTopic>();
    const now = new Date();

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (!frontmatter || !frontmatter.palee_id) continue;

      const id = frontmatter.palee_id as string;
      let dueAt = frontmatter.due_at ? new Date(frontmatter.due_at as string) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) {
        dueAt = null;
      }

      topics.set(id, {
        palee_id: id,
        title: (frontmatter.title as string) || path.basename(filePath, '.md'),
        path: path.relative(vaultPath, filePath),
        topic_mastery: (frontmatter.topic_mastery as number) || 0,
        depends_on: (frontmatter.depends_on as string[]) || [],
        due_at: dueAt,
        repetition: (frontmatter.repetition as number) || 0,
        difficulty: (frontmatter.difficulty as string) || 'intermediate',
      });
    }

    const dueTopics: PlanTopic[] = [];
    for (const topic of topics.values()) {
      if (!topic.due_at || topic.due_at <= now) {
        dueTopics.push(topic);
      }
    }

    // Get ready to learn (deps satisfied, not mastered)
    const readyTopics = getReadyTopics(topics, 0.7) as PlanTopic[];

    console.log('=== Today\'s Learning Plan ===\n');

    // Section 1: Due for review
    console.log(`Reviews Due: ${dueTopics.length}`);
    if (dueTopics.length > 0) {
      const sorted = dueTopics.sort((a, b) => {
        if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return -1;
        if (!b.due_at) return 1;
        return a.due_at.getTime() - b.due_at.getTime();
      });

      for (let i = 0; i < Math.min(5, sorted.length); i++) {
        const topic = sorted[i];
        const dueStr = topic.due_at
          ? topic.due_at.toISOString().split('T')[0]
          : 'Never reviewed';
        console.log(`  • ${topic.title} (${topic.palee_id}) - Due: ${dueStr}`);
      }

      if (sorted.length > 5) {
        console.log(`  ... and ${sorted.length - 5} more`);
      }
    }
    console.log();

    // Section 2: Ready to learn
    console.log(`Ready to Learn: ${readyTopics.length}`);
    if (readyTopics.length > 0) {
      const diffOrder: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };
      const sorted = readyTopics.sort((a, b) => {
        return (diffOrder[a.difficulty] ?? 1) - (diffOrder[b.difficulty] ?? 1);
      });

      for (let i = 0; i < Math.min(5, sorted.length); i++) {
        const topic = sorted[i];
        console.log(`  • ${topic.title} (${topic.palee_id}) - ${topic.difficulty}`);
      }

      if (sorted.length > 5) {
        console.log(`  ... and ${sorted.length - 5} more`);
      }
    }
    console.log();

    // Section 3: Summary stats
    const masteredCount = Array.from(topics.values()).filter(t => t.topic_mastery >= 0.7).length;
    const learningCount = Array.from(topics.values()).filter(t => t.topic_mastery > 0 && t.topic_mastery < 0.7).length;
    const newCount = Array.from(topics.values()).filter(t => t.topic_mastery === 0).length;

    console.log('Progress Summary:');
    console.log(`  Total Topics: ${topics.size}`);
    console.log(`  Mastered (≥70%): ${masteredCount}`);
    console.log(`  Learning: ${learningCount}`);
    console.log(`  New: ${newCount}`);

    process.exit(0);

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default planCommand;
