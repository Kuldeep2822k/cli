/**
 * Roadmap Command Handler
 * Manages learning roadmaps (Phase 1: deterministic --from only)
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { updateFrontmatter, computeFingerprint } from '../storage/frontmatter';
import { atomicWrite } from '../storage/atomic-write';
import { detectCycle } from '../engine/dependency';
import { RoadmapOptions, RoadmapFile, TopicNode } from '../types';
import readline from 'readline';

async function roadmapCommand(options: RoadmapOptions): Promise<void> {
  try {
    if (!options.from) {
      console.error('Error: Phase 1 only supports --from <file>');
      console.error('Usage: palee roadmap --from <roadmap.yaml>');
      process.exit(2);
    }

    const configModule = await import('./config');
    const config = configModule.loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const roadmapPath = path.resolve(options.from);

    if (!fs.existsSync(roadmapPath)) {
      console.error(`Error: Roadmap file not found: ${roadmapPath}`);
      process.exit(2);
    }

    const yamlContent = fs.readFileSync(roadmapPath, 'utf8');
    let roadmap: RoadmapFile;
    try {
      roadmap = yaml.parse(yamlContent) as RoadmapFile;
    } catch (e: unknown) {
      const parseErr = e as Error;
      console.error(`Error: Invalid YAML: ${parseErr.message}`);
      process.exit(2);
    }

    if (!roadmap.topics || !Array.isArray(roadmap.topics)) {
      console.error('Error: Roadmap must have a "topics" array');
      process.exit(2);
    }

    const errors: string[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const topicsMap = new Map<string, TopicNode>();

    for (const topic of roadmap.topics) {
      const { id, title, path: relativePath, difficulty, order } = topic;

      if (!id) errors.push('Topic missing "id" field');
      if (!title) errors.push('Topic missing "title" field');
      if (!relativePath) errors.push('Topic missing "path" field');

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
      process.exit(3);
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
    console.log('Proceed? (y/N): ');

    // In Phase 1, auto-confirm for non-interactive
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('', async (answer: string) => {
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }

      let created = 0;
      let updated = 0;

      for (const topic of roadmap.topics) {
        const absolutePath = path.join(vaultPath, topic.path);
        const dir = path.dirname(absolutePath);

        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        let content = '';
        let fingerprint: string | null = null;
        let isNew = false;

        if (fs.existsSync(absolutePath)) {
          content = fs.readFileSync(absolutePath, 'utf8');
          fingerprint = computeFingerprint(content);
        } else {
          isNew = true;
          content = `# ${topic.title}\n\n(Add your notes here)`;
        }

        const paleeData: Record<string, unknown> = {
          palee_id: topic.id,
          palee_schema: 1,
          title: topic.title,
          difficulty: topic.difficulty || 'intermediate',
          depends_on: topic.depends_on || [],
          topic_mastery: 0.0,
          assessed_at: null,
          conceptual: 0.0,
          practical: 0.0,
          debug: 0.0,
          feynman: 0.0,
          ease_factor: 2.5,
          interval_days: 1,
          repetition: 0,
          lapses: 0,
          last_quality: null,
          last_reviewed_at: null,
          due_at: null,
        };

        const updatedContent = updateFrontmatter(content, paleeData);
        await atomicWrite(vaultPath, absolutePath, updatedContent, fingerprint);

        if (isNew) {
          created++;
        } else {
          updated++;
        }
      }

      console.log();
      console.log('✓ Roadmap imported successfully');
      console.log(`  Created: ${created} notes`);
      console.log(`  Updated: ${updated} notes`);
      process.exit(0);
    });

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default roadmapCommand;
