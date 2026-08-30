/**
 * Topic Loader
 *
 * @remarks
 * Centralized boundary for scanning, parsing, normalizing, and loading PALEE topics from an Obsidian vault.
 * Guarantees uniform fallback values, score clamping, type coercion, and dependency parsing across all CLI commands.
 */

import fs from 'fs';
import path from 'path';
import { walkVault } from './vault-walker';
import { parseFrontmatter } from './frontmatter';
import { TopicNode, normalizeDifficulty } from '../types';

/**
 * Fully materialized in-memory representation of a PALEE topic note loaded from disk.
 */
export interface LoadedTopic extends TopicNode {
  /** Canonical topic ID (`palee_id`) */
  id: string;
  /** Topic title */
  title: string;
  /** Relative POSIX path from the vault root */
  path: string;
  /** Absolute filesystem path to the Markdown note */
  filePath: string;
  /** Full raw Markdown text content */
  content: string;
  /** Parsed YAML frontmatter dictionary */
  frontmatter: Record<string, unknown>;
}

/**
 * Parses and clamps a score value to `[0.0, 1.0]` with 4 decimal places.
 *
 * @remarks
 * If `val` cannot be parsed into a finite number, the provided `fallback` value is returned
 * unchanged without clamping.
 *
 * @param val - Score input
 * @param fallback - Default fallback if invalid (default: 0.0)
 * @returns Clamped numeric score or raw fallback
 */
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
 * Coerces and floors an input value into an integer.
 *
 * @remarks
 * If `val` cannot be parsed into a finite integer, the provided `fallback` value is returned
 * unchanged without integer flooring.
 *
 * @param val - Numeric input
 * @param fallback - Default fallback value (default: 0)
 * @returns Integer value or raw fallback
 */
function parseInteger(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

/**
 * Parses a floating-point number with fallback.
 *
 * @param val - Numeric input
 * @param fallback - Default fallback value (default: 0)
 * @returns Floating point number
 */
function parseNumber(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    return val;
  }
  if (typeof val === 'string') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Scans the vault and parses all Markdown files containing a valid `palee_id`.
 *
 * @remarks
 * Normalizes all frontmatter fields, sets default SM-2 values if omitted,
 * and extracts prerequisite dependencies from `depends_on` or `dependencies` arrays.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param files - Optional pre-scanned array of absolute file paths (avoids duplicate vault walks)
 * @returns Array of parsed and normalized {@link LoadedTopic} instances
 *
 * @example
 * ```typescript
 * const topics = loadTopics('/path/to/vault');
 * console.log(`Loaded ${topics.length} topics`);
 * ```
 */
export function loadTopics(vaultPath: string, files?: string[]): LoadedTopic[] {
  const scanFiles = files ?? walkVault(vaultPath);
  const topics: LoadedTopic[] = [];

  for (const filePath of scanFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue; // Transient error or file deleted/locked by concurrent writer - skip gracefully
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
      ease_factor: parseNumber(frontmatter.ease_factor, 2.5),
      interval_days: parseInteger(frontmatter.interval_days, 1),
      repetition: parseInteger(frontmatter.repetition, 0),
      lapses: parseInteger(frontmatter.lapses, 0),
      last_quality: typeof frontmatter.last_quality === 'number' && Number.isFinite(frontmatter.last_quality)
        ? Math.floor(frontmatter.last_quality)
        : null,
      assessed_at: frontmatter.assessed_at ? String(frontmatter.assessed_at) : null,
      last_reviewed_at: frontmatter.last_reviewed_at ? String(frontmatter.last_reviewed_at) : null,
      due_at: frontmatter.due_at ? String(frontmatter.due_at) : null,
    };

    topics.push(topic);
  }

  return topics;
}


