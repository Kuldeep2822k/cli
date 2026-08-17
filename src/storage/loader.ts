/**
 * Topic Loader
 * Centralized boundary for scanning, parsing, and loading PALEE topics from a vault.
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from './vault-walker';
import { parseFrontmatter } from './frontmatter';
import { TopicNode, normalizeDifficulty } from '../types';

export interface LoadedTopic extends TopicNode {
  id: string;
  title: string;
  path: string;
  filePath: string;
  content: string;
  frontmatter: Record<string, unknown>;
}


function parseScore(val: unknown, fallback: number = 0.0): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return Math.round(Math.max(0, Math.min(1, val)) * 10000) / 10000;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return Math.round(Math.max(0, Math.min(1, parsed)) * 10000) / 10000;
      }
    }
  }
  return fallback;
}

/**
 * Scans the vault and parses all Markdown files containing a valid palee_id.
 * Guarantees a single consistent parsing, normalization, and validation pipeline across all CLI commands.
 */
export function loadTopics(vaultPath: string): LoadedTopic[] {
  const files = walkVault(vaultPath);
  const topics: LoadedTopic[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const { frontmatter } = parseFrontmatter(content);
    if (!frontmatter || typeof frontmatter.palee_id !== 'string' || !frontmatter.palee_id.trim()) {
      continue;
    }

    const paleeId = frontmatter.palee_id.trim();
    const relPath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
    const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : path.basename(filePath, '.md');

    const rawDeps = frontmatter.depends_on || frontmatter.dependencies;
    const dependsOn = Array.isArray(rawDeps)
      ? rawDeps.map((d) => String(d).trim()).filter(Boolean)
      : [];

    const difficulty = normalizeDifficulty(frontmatter.difficulty);
    const topicMastery = parseScore(frontmatter.topic_mastery, 0.0);

    const topic: LoadedTopic = {
      palee_id: paleeId,
      id: paleeId,
      title,
      path: relPath,
      filePath,
      content,
      frontmatter,
      difficulty,
      depends_on: dependsOn,
      topic_mastery: topicMastery,
      status: typeof frontmatter.status === 'string' ? frontmatter.status.trim().toLowerCase() : 'not_started',
      conceptual: parseScore(frontmatter.conceptual, 0.0),
      practical: parseScore(frontmatter.practical, 0.0),
      debug: parseScore(frontmatter.debug, 0.0),
      feynman: parseScore(frontmatter.feynman, 0.0),
      ease_factor: typeof frontmatter.ease_factor === 'number' ? frontmatter.ease_factor : 2.5,
      interval_days: typeof frontmatter.interval_days === 'number' ? frontmatter.interval_days : 1,
      repetition: typeof frontmatter.repetition === 'number' ? frontmatter.repetition : 0,
      lapses: typeof frontmatter.lapses === 'number' ? frontmatter.lapses : 0,
      last_quality: typeof frontmatter.last_quality === 'number' ? frontmatter.last_quality : null,
      assessed_at: frontmatter.assessed_at ? String(frontmatter.assessed_at) : null,
      last_reviewed_at: frontmatter.last_reviewed_at ? String(frontmatter.last_reviewed_at) : null,
      due_at: frontmatter.due_at ? String(frontmatter.due_at) : null,
    };

    topics.push(topic);
  }

  return topics;
}

