import { loadConfig } from './config';
import { printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
/**
 * Progress Command Handler
 * Shows learning progress summary
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter } from '../storage/frontmatter';
import { Difficulty, normalizeDifficulty, ProgressOptions } from '../types';

interface ProgressTopic {
  id: string;
  title: string;
  path: string;
  mastery: number;
  repetition: number;
  lapses: number;
  assessed_at: string | null;
  last_reviewed_at: string | null;
  difficulty: Difficulty;
}

async function progressCommand(options: ProgressOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath, { json: options.json });
    if (!vaultPath) return;

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
        difficulty: normalizeDifficulty(frontmatter.difficulty),
      });
    }

    if (topics.length === 0 && !options.topic) {
      if (options.json) {
        console.log(JSON.stringify({
          total_topics: 0,
          mastered: 0,
          learning: 0,
          new: 0,
          avg_mastery: 0,
          total_reviews: 0,
          total_lapses: 0,
          by_difficulty: {
            beginner: { total: 0, avg_mastery: 0 },
            intermediate: { total: 0, avg_mastery: 0 },
            advanced: { total: 0, avg_mastery: 0 },
          },
        }));
        return;
      }
      console.log('=== Learning Progress ===\n');
      printEmptyVaultOnboarding();
      return;
    }

    if (options.topic) {
      const match = topics.find(t =>
        t.id === options.topic || t.id.includes(options.topic!) ||
        t.title.toLowerCase().includes(options.topic!.toLowerCase())
      );

      if (!match) {
        if (options.json) {
          console.error(JSON.stringify({ error: `Topic not found: ${options.topic}` }));
        } else {
          console.error(`Error: Topic not found: ${options.topic}`);
        }
        process.exitCode = 2;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          id: match.id,
          title: match.title,
          path: match.path,
          mastery: match.mastery,
          difficulty: match.difficulty,
          repetition: match.repetition,
          lapses: match.lapses,
          assessed_at: match.assessed_at,
          last_reviewed_at: match.last_reviewed_at,
        }));
        return;
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

      const byDifficulty: Record<string, ProgressTopic[]> = {
        beginner: topics.filter(t => t.difficulty === 'beginner'),
        intermediate: topics.filter(t => t.difficulty === 'intermediate'),
        advanced: topics.filter(t => t.difficulty === 'advanced'),
      };

      if (options.json) {
        console.log(JSON.stringify({
          total_topics: total,
          mastered,
          learning,
          new: newTopics,
          avg_mastery: avgMastery,
          total_reviews: totalReps,
          total_lapses: totalLapses,
          by_difficulty: {
            beginner: {
              total: byDifficulty.beginner.length,
              avg_mastery: byDifficulty.beginner.length > 0
                ? byDifficulty.beginner.reduce((s, t) => s + t.mastery, 0) / byDifficulty.beginner.length
                : 0,
            },
            intermediate: {
              total: byDifficulty.intermediate.length,
              avg_mastery: byDifficulty.intermediate.length > 0
                ? byDifficulty.intermediate.reduce((s, t) => s + t.mastery, 0) / byDifficulty.intermediate.length
                : 0,
            },
            advanced: {
              total: byDifficulty.advanced.length,
              avg_mastery: byDifficulty.advanced.length > 0
                ? byDifficulty.advanced.reduce((s, t) => s + t.mastery, 0) / byDifficulty.advanced.length
                : 0,
            },
          },
        }));
        return;
      }

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

      console.log('By Difficulty:');
      for (const [level, list] of Object.entries(byDifficulty)) {
        if (list.length > 0) {
          const avgMast = list.reduce((s, t) => s + t.mastery, 0) / list.length;
          console.log(`  ${level}: ${list.length} topics, avg mastery ${(avgMast * 100).toFixed(1)}%`);
        }
      }
    }

    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export { progressCommand };
export default progressCommand;
