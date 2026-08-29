/**
 * Roadmap Command Handler
 * Manages learning roadmaps (Phase 1: deterministic --from only)
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { updateFrontmatter, computeFingerprint, parseFrontmatter } from '../storage/frontmatter';
import { parseRoadmapContent } from '../storage/roadmap-parser';
import { atomicWrite, isConflictError } from '../storage/atomic-write';
import { walkVault } from '../storage/vault-walker';
import { detectCycle } from '../engine/dependency';
import { RoadmapOptions, TopicNode } from '../types';
import readline from 'readline';

/**
 * CLI command handler for validating and importing learning roadmaps into the vault.
 *
 * @param options - Roadmap options including `--from` file path and `--yes` confirmation.
 * @returns Promise resolving when roadmap validation and import complete.
 * @remarks Sets process.exitCode = 2 on missing/invalid arguments or missing vault,
 * process.exitCode = 3 on dependency cycles or validation errors in the roadmap,
 * process.exitCode = 1 on partial import failure, and process.exitCode = 5 on unexpected runtime exceptions.
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

    const resolvedVault = path.resolve(vaultPath);

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

      topicsMap.set(id, { palee_id: id, depends_on: topic.depends_on || [], topic_mastery: 0 });
    }

    const files = walkVault(vaultPath);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const parsed = parseFrontmatter(content);
        if (parsed.frontmatter && parsed.frontmatter.palee_id) {
          const pid = parsed.frontmatter.palee_id as string;
          if (!topicsMap.has(pid)) {
            topicsMap.set(pid, { palee_id: pid, depends_on: parsed.frontmatter.depends_on as string[] || [], topic_mastery: 0 });
          }
        }
      } catch {}
    }

    for (const topic of roadmap.topics) {
      const deps = topic.depends_on || [];
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

    async function doImport() {
      try {

      let created = 0;
      let updated = 0;
      let failed = 0;

      for (const topic of roadmap.topics) {
        const absolutePath = path.resolve(vaultPath, topic.path);
        
        const relative = path.relative(resolvedVault, absolutePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          console.error(`Roadmap path escapes vault: ${topic.path}`);
          failed++;
          continue;
        }

        const dir = path.dirname(absolutePath);
        let resolvedTargetPath = absolutePath;

        try {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          const canonicalDir = fs.realpathSync(dir);
          const canonicalVault = fs.realpathSync(resolvedVault);
          if (canonicalDir !== canonicalVault && !canonicalDir.startsWith(canonicalVault + path.sep)) {
            console.error(`Symlink escape detected: ${topic.path} resolves outside vault`);
            failed++;
            continue;
          }
          resolvedTargetPath = path.join(canonicalDir, path.basename(absolutePath));
        } catch (e) {
          console.error(`Error creating directory for ${topic.path}: ${(e as Error).message}`);
          failed++;
          continue;
        }

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
          palee_id: topic.id,
          palee_schema: existingData.palee_schema ?? 1,
          title: topic.title,
          difficulty: topic.difficulty || existingData.difficulty || 'intermediate',
          depends_on: topic.depends_on || existingData.depends_on || [],
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
        try {
          await atomicWrite(vaultPath, resolvedTargetPath, updatedContent, fingerprint);
        } catch (e) {
          if (isConflictError(e)) {
            throw e;
          }
          console.error(`Error writing ${topic.path}: ${(e as Error).message}`);
          failed++;
          continue;
        }

        if (isNew) {
          created++;
        } else {
          updated++;
        }
      }

      console.log();
      if (failed > 0) {
        console.error(`Failed to import ${failed} topics.`);
        console.log(`  Created: ${created} notes`);
        console.log(`  Updated: ${updated} notes`);
        process.exitCode = 1;
        return;
      } else {
        console.log('✓ Roadmap imported successfully');
        console.log(`  Created: ${created} notes`);
        console.log(`  Updated: ${updated} notes`);
        process.exitCode = 0;
        return;
      }
      } catch (err: unknown) {
        console.error(`Error during import: ${(err as Error).message}`);
        process.exitCode = isConflictError(err) ? 4 : 5;
        return;
      }
    }

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = isConflictError(e) ? 4 : 5;
    return;
  }
}

export default roadmapCommand;
