import { loadConfig } from './config';
import { isJsonOutput, printEmptyVaultOnboarding, validateVaultPath } from './onboarding';
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
  status: string;
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
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
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
        status: typeof frontmatter.status === 'string' ? frontmatter.status.trim().toLowerCase() : 'not_started',
        mastery: (frontmatter.topic_mastery as number) || 0,
        repetition: (frontmatter.repetition as number) || 0,
        lapses: (frontmatter.lapses as number) || 0,
        assessed_at: (frontmatter.assessed_at as string) || null,
        last_reviewed_at: (frontmatter.last_reviewed_at as string) || null,
        difficulty: normalizeDifficulty(frontmatter.difficulty),
      });
    }

    if (topics.length === 0 && !options.topic) {
      if (jsonMode) {
        console.log(JSON.stringify({
          active_topic_count: 0,
          archived_topic_count: 0,
          global_mastery: null,
          mastery_status: 'no_data',
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
        if (jsonMode) {
          console.error(JSON.stringify({ error: `Topic not found: ${options.topic}` }));
        } else {
          console.error(`Error: Topic not found: ${options.topic}`);
        }
        process.exitCode = 2;
        return;
      }

      if (jsonMode) {
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
      const activeTopics = topics.filter(t => t.status !== 'archived');
      const archivedTopics = topics.filter(t => t.status === 'archived');

      const total = topics.length;
      const activeCount = activeTopics.length;
      const mastered = activeTopics.filter(t => t.mastery >= 0.7).length;
      const learning = activeTopics.filter(t => t.mastery > 0 && t.mastery < 0.7).length;
      const newTopics = activeTopics.filter(t => t.mastery === 0).length;

      const totalReps = activeTopics.reduce((sum, t) => sum + t.repetition, 0);
      const totalLapses = activeTopics.reduce((sum, t) => sum + t.lapses, 0);

      const rawMastery = activeCount > 0
        ? activeTopics.reduce((sum, t) => sum + t.mastery, 0) / activeCount
        : null;

      const globalMastery = rawMastery === null
        ? null
        : Math.round(rawMastery * 10000) / 10000;

      const masteryStatus: 'no_data' | 'learning' | 'mastered' = globalMastery === null
        ? 'no_data'
        : globalMastery >= 0.7
          ? 'mastered'
          : 'learning';


      const byDifficulty: Record<string, ProgressTopic[]> = {
        beginner: activeTopics.filter(t => t.difficulty === 'beginner'),
        intermediate: activeTopics.filter(t => t.difficulty === 'intermediate'),
        advanced: activeTopics.filter(t => t.difficulty === 'advanced'),
      };

      if (jsonMode) {
        console.log(JSON.stringify({
          active_topic_count: activeCount,
          archived_topic_count: archivedTopics.length,
          global_mastery: globalMastery,
          mastery_status: masteryStatus,
          total_topics: total,
          mastered,
          learning,
          new: newTopics,
          avg_mastery: globalMastery ?? 0,
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
      console.log(`Active Topics: ${activeCount}${archivedTopics.length > 0 ? ` (${archivedTopics.length} archived)` : ''}`);
      console.log(`  Mastered (≥70%): ${mastered} (${(activeCount > 0 ? (mastered / activeCount) * 100 : 0).toFixed(1)}%)`);
      console.log(`  Learning: ${learning} (${(activeCount > 0 ? (learning / activeCount) * 100 : 0).toFixed(1)}%)`);
      console.log(`  New: ${newTopics} (${(activeCount > 0 ? (newTopics / activeCount) * 100 : 0).toFixed(1)}%)`);
      console.log();
      if (globalMastery !== null) {
        console.log(`Average Mastery: ${(globalMastery * 100).toFixed(1)}% (${masteryStatus})`);
      } else {
        console.log(`Average Mastery: No data (${masteryStatus})`);
      }
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
