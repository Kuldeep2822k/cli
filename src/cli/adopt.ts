/**
 * Adopt Command Handler
 * Adopts an existing note as a PALEE topic
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from '../storage/frontmatter';
import { atomicWrite } from '../storage/atomic-write';
import { AdoptOptions } from '../types';

function generateTopicId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0]; // YYYYMMDDTHHMMSS
  const random = Math.random().toString(36).substring(2, 6); // 4 char random
  return `T-${timestamp}-${random}`;
}

async function adoptCommand(relativePath: string, options: AdoptOptions): Promise<void> {
  try {
    const configModule = await import('./config');
    const config = configModule.loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const resolvedVault = path.resolve(vaultPath);
    const absolutePath = path.resolve(vaultPath, relativePath);
    
    if (!absolutePath.startsWith(resolvedVault + path.sep) && absolutePath !== resolvedVault) {
      console.error(`Error: Path escapes vault: ${relativePath}`);
      process.exit(2);
    }

    if (!fs.existsSync(absolutePath)) {
      console.error(`Error: File not found: ${relativePath}`);
      process.exit(2);
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);

    if (frontmatter && frontmatter.palee_id) {
      console.error(`Error: Note already adopted as topic ${frontmatter.palee_id}`);
      process.exit(2);
    }

    const difficulty = options.difficulty || 'intermediate';
    const validDifficulties = ['beginner', 'intermediate', 'advanced'];
    if (!validDifficulties.includes(difficulty)) {
      console.error(`Error: Invalid difficulty. Must be one of: ${validDifficulties.join(', ')}`);
      process.exit(2);
    }

    const dependsOn = options.dependsOn ? options.dependsOn.split(',').map(s => s.trim()).filter(Boolean) : [];

    const topicId = generateTopicId();

    const paleeData: Record<string, unknown> = {
      palee_id: topicId,
      palee_schema: 1,
      difficulty,
      depends_on: dependsOn,
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
    const fingerprint = computeFingerprint(content);

    await atomicWrite(vaultPath, absolutePath, updatedContent, fingerprint);

    console.log(`✓ Adopted as topic ${topicId}`);
    console.log(`  Path: ${relativePath}`);
    console.log(`  Difficulty: ${difficulty}`);
    if (dependsOn.length > 0) {
      console.log(`  Dependencies: ${dependsOn.join(', ')}`);
    }

    process.exit(0);

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default adoptCommand;
