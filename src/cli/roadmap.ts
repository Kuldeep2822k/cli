/**
 * Roadmap Command Handler
 * Manages learning roadmaps (Phase 1: deterministic --from only)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  updateFrontmatter,
  computeFingerprint,
  parseFrontmatter,
  parseRoadmapContent,
  atomicWrite,
  isConflictError,
  loadTopics,
  ensureVaultDirectory,
} from '../storage';
import { detectCycle } from '../engine/dependency';
import { RoadmapOptions, TopicNode, ResolvedTopicUpdates } from '../types';

/**
 * Effective-input bundle for one roadmap topic, used by `resolveTopicUpdates`.
 *
 * @remarks
 * "Existing" identity is two-keyed on purpose (#137 follow-up): `depends_on`'s
 * preserve-existing rule looks the topic up BY `palee_id` (the roadmap topic may
 * not exist on disk yet, so its pre-import identity is its future ID), while
 * frontmatter pass-through fields come from the note AT THE TARGET PATH (the
 * file the import will actually write).
 */
interface ResolveTopicInput {
  /** Roadmap-declared topic */
  topic: RoadmapTopicAlias;
  /** Existing vault topic with the same `palee_id` (for depends_on preservation), or undefined */
  existingById: LoadedTopicAlias | undefined;
  /** Raw frontmatter of the note at the target path, or `{}` for new notes */
  existingAtPath: Record<string, unknown>;
}

type RoadmapTopicAlias = import('../types').RoadmapTopic;
type LoadedTopicAlias = { id: string; depends_on?: string[] };

/**
 * Single derivation of the effective frontmatter values a roadmap import
 * writes for one topic (#139).
 *
 * @remarks
 * SINGLE SOURCE OF TRUTH for both passes: `roadmapCommand`'s validation pass
 * (graph + field checks) AND `doImport`'s writeback both consume this helper.
 * Never re-derive an import field at a call site — any new field added to the
 * roadmap import path must be added HERE (and to `ResolvedTopicUpdates`), or
 * the validation-vs-writeback divergence pattern returns (the class of bug that
 * produced the #137 cycle-on-import defect).
 *
 * This function is PURE: it derives from the inputs it is given. The writeback
 * pass calls it with the FRESH at-path frontmatter re-read just before the
 * atomic write (OCC requires re-reading the target at write time), while the
 * validation pass calls it earlier with the pre-import snapshot. Same rules,
 * fresh data per pass — the divergence being removed is in the RULES, not in
 * when the data is read.
 *
 * `depends_on` semantics (unchanged since #137): explicit `[]` clears,
 * omitted preserves the existing topic's deps (by ID), populated replaces.
 *
 * @param input - Roadmap topic plus its existing on-disk context
 * @returns Effective values for every frontmatter field the import writes
 */
function resolveTopicUpdates(input: ResolveTopicInput): ResolvedTopicUpdates {
  const { topic, existingById, existingAtPath } = input;

  return {
    palee_id: topic.id,
    palee_schema: existingAtPath.palee_schema ?? 1,
    title: topic.title,
    difficulty: topic.difficulty || existingAtPath.difficulty || 'intermediate',
    depends_on: topic.depends_on ?? existingById?.depends_on ?? [],
    topic_mastery: existingAtPath.topic_mastery ?? 0.0,
    assessed_at: existingAtPath.assessed_at ?? null,
    conceptual: existingAtPath.conceptual ?? 0.0,
    practical: existingAtPath.practical ?? 0.0,
    debug: existingAtPath.debug ?? 0.0,
    feynman: existingAtPath.feynman ?? 0.0,
    ease_factor: existingAtPath.ease_factor ?? 2.5,
    interval_days: existingAtPath.interval_days ?? 1,
    repetition: existingAtPath.repetition ?? 0,
    lapses: existingAtPath.lapses ?? 0,
    last_quality: existingAtPath.last_quality ?? null,
    last_reviewed_at: existingAtPath.last_reviewed_at ?? null,
    due_at: existingAtPath.due_at ?? null,
  };
}

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

    // Load existing vault topics before the validation loop so we can resolve
    // effective dependencies using the same rule for both validation and writeback.
    const existingTopics = loadTopics(vaultPath);
    const existingTopicsById = new Map(existingTopics.map((topic) => [topic.id, topic]));

    // Effective deps per roadmap topic, computed once and shared by validation + doImport.
    // User-intent rules: explicit empty array clears, omitted preserves existing, populated replaces.
    const effectiveDepsMap = new Map<string, string[]>();

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

      // Single-source-of-truth derivation (#139): both the graph/validation pass
      // and the doImport writeback resolve effective fields through
      // resolveTopicUpdates — never re-derive here.
      const resolved = resolveTopicUpdates({
        topic,
        existingById: existingTopicsById.get(id),
        existingAtPath: {}, // validation checks roadmap-declared fields; at-path frontmatter is a writeback concern
      });
      effectiveDepsMap.set(id, resolved.depends_on);
      topicsMap.set(id, { palee_id: id, depends_on: resolved.depends_on, topic_mastery: 0 });
    }

    for (const t of existingTopics) {
      if (!topicsMap.has(t.id)) {
        topicsMap.set(t.id, { palee_id: t.id, depends_on: t.depends_on, topic_mastery: 0 });
      }
    }

    for (const topic of roadmap.topics) {
      const deps = effectiveDepsMap.get(topic.id) ?? [];
      for (const depId of deps) {
        if (!topicsMap.has(depId)) {
          errors.push(`Topic ${topic.id} depends on missing topic: ${depId}`);
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


          const paleeData: Record<string, unknown> = {
            ...resolveTopicUpdates({
              topic,
              existingById: existingTopicsById.get(topic.id),
              existingAtPath: existingData,
            }),
          };

          const updatedContent = updateFrontmatter(content, paleeData, ['dependencies']);
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
        process.exitCode = conflicts > 0 ? ExitCode.Conflict : ExitCode.PartialImport;
        return;
      } else {
        console.log('✓ Roadmap imported successfully');
        console.log(`  Created: ${created} notes`);
        console.log(`  Updated: ${updated} notes`);
        process.exitCode = ExitCode.Success;
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
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export default roadmapCommand;
