/**
 * Roadmap Command Handler
 * Manages learning roadmaps (Phase 1: deterministic --from only)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import {
  updateFrontmatter,
  computeFingerprint,
  parseFrontmatter,
  parseRoadmapContent,
  atomicWrite,
  isConflictError,
  loadTopics,
  ensureVaultDirectory,
  normalizeDependencies,
} from '../storage';
import { detectCycle, getTopicDependencies } from '../engine/dependency';
import { RoadmapOptions, TopicNode } from '../types';

/**
 * CLI command handler for validating and importing learning roadmaps into the vault.
 *
 * @param options - Roadmap options including `--from` file path and `--yes` confirmation.
 * @returns Promise resolving when roadmap validation and import complete.
 * @remarks Sets process.exitCode = 2 on missing/invalid arguments or missing vault,
 * process.exitCode = 3 on dependency cycles or validation errors in the roadmap,
 * process.exitCode = 1 on partial import failure, and process.exitCode = 5 on unexpected runtime exceptions.
 * @example
 * ```typescript
 * await roadmapCommand({ from: 'roadmap.yaml', yes: true });
 * ```
 */
async function roadmapCommand(options: RoadmapOptions): Promise<void> {
  try {
    if (!options.from) {
      console.error('Error: Phase 1 only supports --from <file>');
      console.error('Usage: palee roadmap --from <roadmap.yaml|roadmap.md>');
      process.exitCode = 2;
      return;
    }

    const config = loadConfig();
    const validatedVault = validateVaultPath(config.vaultPath);
    if (!validatedVault) return;
    const vaultPath = validatedVault;
    const roadmapPath = path.resolve(options.from);

    if (!fs.existsSync(roadmapPath)) {
      console.error(`Error: Roadmap file not found: ${roadmapPath}`);
      process.exitCode = 2;
      return;
    }

    const rawContent = fs.readFileSync(roadmapPath, 'utf8');
    const parseResult = parseRoadmapContent(rawContent, roadmapPath);

    if (!parseResult.roadmap || !parseResult.roadmap.topics || !Array.isArray(parseResult.roadmap.topics)) {
      console.error(`Error: ${parseResult.error || 'Roadmap must have a "topics" array'}`);
      process.exitCode = 2;
      return;
    }

    const roadmap = parseResult.roadmap;

    const errors: string[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const topicsMap = new Map<string, TopicNode>();

    const resolvedVault = fs.existsSync(vaultPath) ? fs.realpathSync(path.resolve(vaultPath)) : path.resolve(vaultPath);

    for (const topic of roadmap.topics) {
      const { id, title, path: relativePath, difficulty, order } = topic;

      if (!id) errors.push('Topic missing "id" field');
      if (!title) errors.push('Topic missing "title" field');
      if (!relativePath) {
        errors.push('Topic missing "path" field');
      }

      if (seenIds.has(id)) {
        errors.push(`Duplicate topic ID: ${id}`);
      }
      seenIds.add(id);

      if (seenPaths.has(relativePath)) {
        errors.push(`Duplicate path: ${relativePath}`);
      }
      seenPaths.add(relativePath);

      if (difficulty && !['beginner', 'intermediate', 'advanced'].includes(difficulty)) {
        errors.push(`Invalid difficulty for ${id}: ${difficulty}`);
      }

      if (order !== undefined && typeof order !== 'number') {
        errors.push(`Invalid order for ${id}: must be a number`);
      }

      // Path boundary validation: ensure topic path does not escape vault
      if (relativePath) {
        const absoluteTopicPath = path.isAbsolute(relativePath)
          ? path.resolve(relativePath)
          : path.resolve(resolvedVault, relativePath);
        const rel = path.relative(resolvedVault, absoluteTopicPath);
        if (
          path.isAbsolute(rel) ||
          rel === '..' ||
          rel.startsWith('..' + path.sep) ||
          rel.startsWith('../') ||
          rel.split(path.sep).includes('..')
        ) {
          errors.push(`Topic "${id || '(unnamed)'}" path escapes vault boundary: ${relativePath}`);
        }
      }

      const normalizedDeps = getTopicDependencies(topic);
      topicsMap.set(id, { palee_id: id, depends_on: normalizedDeps, topic_mastery: 0 });
    }

    const existingTopics = loadTopics(vaultPath);
    for (const t of existingTopics) {
      if (!topicsMap.has(t.id)) {
        topicsMap.set(t.id, { palee_id: t.id, depends_on: t.depends_on, topic_mastery: 0 });
      }
    }

    for (const topic of roadmap.topics) {
      const topicId = topic.id || (topic as { palee_id?: string }).palee_id || '';
      const deps = topicsMap.get(topicId)?.depends_on ?? getTopicDependencies(topic);
      for (const depId of deps) {
        if (!topicsMap.has(depId)) {
          errors.push(`Topic ${topicId} depends on missing topic: ${depId}`);
        }
      }
    }

    const cycle = detectCycle(topicsMap);
    if (cycle) {
      errors.push(`Dependency cycle detected: ${cycle.join(' → ')}`);
    }

    if (errors.length > 0) {
      console.error('Validation errors:');
      for (const err of errors) {
        console.error(`  • ${err}`);
      }
      process.exitCode = 3;
      return;
    }

    console.log('Roadmap validated successfully.');
    console.log(`  Topics: ${roadmap.topics.length}`);
    console.log(`  Source: ${roadmapPath}`);
    console.log();
    console.log('This will create/update the following files:');
    for (const topic of roadmap.topics) {
      console.log(`  • ${topic.path}`);
    }
    console.log();

    /**
     * Executes batch import of parsed roadmap topics into vault notes with error isolation and OCC tracking.
     *
     * @returns Promise resolving when all topics have been processed
     *
     * @remarks
     * Iterates through all roadmap topics, validating vault path boundaries and writing topic notes with frontmatter.
     * Catches and isolates per-topic errors (logging OCC conflicts vs standard write errors) and assigns exit codes (4 for conflict, 1 for other failures).
     *
     * @example
     * ```typescript
     * await doImport();
     * ```
     */
    async function doImport(): Promise<void> {
      let created = 0;
      let updated = 0;
      let failed = 0;
      let conflicts = 0;

      for (const topic of roadmap.topics) {
        const absolutePath = path.isAbsolute(topic.path) ? path.resolve(topic.path) : path.resolve(resolvedVault, topic.path);

        const relative = path.relative(resolvedVault, absolutePath);
        if (
          path.isAbsolute(relative) ||
          relative === '..' ||
          relative.startsWith('..' + path.sep) ||
          relative.startsWith('../') ||
          relative.split(path.sep).includes('..')
        ) {
          console.error(`Roadmap path escapes vault: ${topic.path}`);
          failed++;
          continue;
        }
        
        let resolvedTargetPath: string;

        try {
          const canonicalDir = ensureVaultDirectory(vaultPath, topic.path);
          resolvedTargetPath = path.join(canonicalDir, path.basename(absolutePath));
        } catch (e) {
          console.error(`Error creating directory for ${topic.path}: ${(e as Error).message}`);
          failed++;
          continue;
        }

        try {
          let content = '';
          let fingerprint: string | null = null;
          let isNew = false;
          let existingData: Record<string, unknown> = {};

          if (fs.existsSync(resolvedTargetPath)) {
            content = fs.readFileSync(resolvedTargetPath, 'utf8');
            fingerprint = computeFingerprint(content);
            const parsed = parseFrontmatter(content);
            if (parsed.frontmatter) {
              existingData = parsed.frontmatter;
            }
          } else {
            isNew = true;
            content = `# ${topic.title}\n\n(Add your notes here)`;
          }

          const topicId = topic.id || (topic as { palee_id?: string }).palee_id || '';
          const roadmapDeps = topicsMap.get(topicId)?.depends_on ?? getTopicDependencies(topic);
          const hasExplicitDeps =
            topic.depends_on !== undefined ||
            (topic as { dependencies?: unknown }).dependencies !== undefined;
          const paleeData: Record<string, unknown> = {
            palee_id: topicId,
            palee_schema: existingData.palee_schema ?? 1,
            title: topic.title,
            difficulty: topic.difficulty || existingData.difficulty || 'intermediate',
            depends_on:
              hasExplicitDeps
                ? roadmapDeps
                : normalizeDependencies(existingData.depends_on, existingData.dependencies),
            topic_mastery: existingData.topic_mastery ?? 0.0,
            assessed_at: existingData.assessed_at ?? null,
            conceptual: existingData.conceptual ?? 0.0,
            practical: existingData.practical ?? 0.0,
            debug: existingData.debug ?? 0.0,
            feynman: existingData.feynman ?? 0.0,
            ease_factor: existingData.ease_factor ?? 2.5,
            interval_days: existingData.interval_days ?? 1,
            repetition: existingData.repetition ?? 0,
            lapses: existingData.lapses ?? 0,
            last_quality: existingData.last_quality ?? null,
            last_reviewed_at: existingData.last_reviewed_at ?? null,
            due_at: existingData.due_at ?? null,
          };

          const updatedContent = updateFrontmatter(content, paleeData);
          await atomicWrite(vaultPath, resolvedTargetPath, updatedContent, fingerprint);

          if (isNew) {
            created++;
          } else {
            updated++;
          }
        } catch (err: unknown) {
          const targetPath = topic.path;
          const isConflict = isConflictError(err);
          if (isConflict) {
            conflicts++;
            console.error(`  - Failed ${topic.id} (${targetPath}): OCC conflict (file locked or concurrently modified)`);
          } else {
            console.error(`  - Failed ${topic.id} (${targetPath}): ${(err as Error).message}`);
          }
          failed++;
          continue;
        }
      }

      console.log();
      if (failed > 0) {
        console.error(`Failed to import ${failed} topics.`);
        console.log(`  Created: ${created} notes`);
        console.log(`  Updated: ${updated} notes`);
        process.exitCode = conflicts > 0 ? 4 : 1;
        return;
      } else {
        console.log('✓ Roadmap imported successfully');
        console.log(`  Created: ${created} notes`);
        console.log(`  Updated: ${updated} notes`);
        process.exitCode = 0;
        return;
      }
    }

    if (!options.yes && !process.stdin.isTTY) {
      console.error('Error: Non-interactive environment detected. Use --yes to confirm import.');
      process.exitCode = 2;
      return;
    }

    if (options.yes) {
      console.log('Auto-confirmed via --yes.');
      await doImport();
    } else {
      console.log('Proceed? (y/N): ');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>(resolve => rl.question('', resolve));
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
      await doImport();
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = isConflictError(e) ? 4 : 5;
    return;
  }
}

export default roadmapCommand;
