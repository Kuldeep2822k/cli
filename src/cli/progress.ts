import { loadConfig } from './config';
/**
 * Progress Command Handler
 * Shows learning progress summary
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter } from '../storage/frontmatter';
import { ProgressOptions } from '../types';

interface ProgressTopic {
  id: string;
  title: string;
  path: string;
  mastery: number;
  repetition: number;
  lapses: number;
  assessed_at: string | null;
  last_reviewed_at: string | null;
  difficulty: string;
}

async function progressCommand(options: ProgressOptions): Promise<void> {
  try {
    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const files = walkVault(vaultPath);
    const topics: ProgressTopic[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (!frontmatter || !frontmatter.palee_id) continue;

      topics.push({
        id: frontmatter.palee_id as string,
        title: (frontmatter.title as string) || path.basename(filePath, '.md'),
        path: path.relative(vaultPath, filePath),
        mastery: (frontmatter.topic_mastery as number) || 0,
        repetition: (frontmatter.repetition as number) || 0,
        lapses: (frontmatter.lapses as number) || 0,
        assessed_at: (frontmatter.assessed_at as string) || null,
        last_reviewed_at: (frontmatter.last_reviewed_at as string) || null,
        difficulty: (frontmatter.difficulty as string) || 'intermediate',
      });
    }

    if (topics.length === 0 && !options.topic) {
      console.log('=== Learning Progress ===\n');
      console.log('No topics found in vault.\n');
      console.log('To get started:');
      console.log('  • Adopt an existing note:');
      console.log('    palee adopt "path/to/note.md"\n');
      console.log('  • Import a curriculum roadmap:');
      console.log('    palee roadmap --from <file.yaml>\n');
      process.exit(0);
    }

    if (options.topic) {
      const match = topics.find(t =>
        t.id === options.topic || t.id.includes(options.topic!) ||
        t.title.toLowerCase().includes(options.topic!.toLowerCase())
      );

      if (!match) {
        console.error(`Error: Topic not found: ${options.topic}`);
        process.exit(2);
      }

      console.log(`Progress for: ${match.title}`);
      console.log(`ID: ${match.id}`);
      console.log(`Path: ${match.path}`);
      console.log();
      console.log(`Mastery: ${(match.mastery * 100).toFixed(1)}%`);
      console.log(`Difficulty: ${match.difficulty}`);
      console.log(`Repetitions: ${match.repetition}`);
      console.log(`Lapses: ${match.lapses}`);
      if (match.assessed_at) {
        console.log(`Last Assessed: ${new Date(match.assessed_at).toISOString().split('T')[0]}`);
      }
      if (match.last_reviewed_at) {
        console.log(`Last Reviewed: ${new Date(match.last_reviewed_at).toISOString().split('T')[0]}`);
      }
    } else {
      const total = topics.length;
      const mastered = topics.filter(t => t.mastery >= 0.7).length;
      const learning = topics.filter(t => t.mastery > 0 && t.mastery < 0.7).length;
      const newTopics = topics.filter(t => t.mastery === 0).length;

      const totalReps = topics.reduce((sum, t) => sum + t.repetition, 0);
      const totalLapses = topics.reduce((sum, t) => sum + t.lapses, 0);
      const avgMastery = total > 0
        ? topics.reduce((sum, t) => sum + t.mastery, 0) / total
        : 0;

      console.log('=== Learning Progress ===\n');
      console.log(`Total Topics: ${total}`);
      console.log(`  Mastered (≥70%): ${mastered} (${(total > 0 ? mastered / total * 100 : 0).toFixed(1)}%)`);
      console.log(`  Learning: ${learning} (${(total > 0 ? learning / total * 100 : 0).toFixed(1)}%)`);
      console.log(`  New: ${newTopics} (${(total > 0 ? newTopics / total * 100 : 0).toFixed(1)}%)`);
      console.log();
      console.log(`Average Mastery: ${(avgMastery * 100).toFixed(1)}%`);
      console.log(`Total Reviews: ${totalReps}`);
      console.log(`Total Lapses: ${totalLapses}`);
      console.log();

      const byDifficulty: Record<string, ProgressTopic[]> = {
        beginner: topics.filter(t => t.difficulty === 'beginner'),
        intermediate: topics.filter(t => t.difficulty === 'intermediate'),
        advanced: topics.filter(t => t.difficulty === 'advanced'),
      };

      console.log('By Difficulty:');
      for (const [level, list] of Object.entries(byDifficulty)) {
        if (list.length > 0) {
          const avgMast = list.reduce((s, t) => s + t.mastery, 0) / list.length;
          console.log(`  ${level}: ${list.length} topics, avg mastery ${(avgMast * 100).toFixed(1)}%`);
        }
      }
    }

    process.exit(0);

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default progressCommand;
