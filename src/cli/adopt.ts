/**
 * Adopt Command Handler
 * Adopts existing notes as PALEE topics (single-file or batch mode)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from '../storage/frontmatter';
import { atomicWrite } from '../storage/atomic-write';
import { walkVault } from '../storage/vault-walker';
import { matchesPattern, matchesTags } from '../storage/pattern-matcher';
import { AdoptOptions, Difficulty, normalizeDifficulty } from '../types';

function generateTopicId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0]; // YYYYMMDDTHHMMSS
  const random = Math.random().toString(36).substring(2, 6); // 4 char random
  return `T-${timestamp}-${random}`;
}

async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

interface StagedNote {
  absolutePath: string;
  relativePath: string;
  content: string;
  fingerprint: string;
}

async function adoptCommand(targetPath?: string, options: AdoptOptions = {}): Promise<void> {
  try {
    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const resolvedVault = fs.realpathSync(path.resolve(vaultPath));

    // Validate difficulty if provided
    let difficulty: Difficulty = 'intermediate';
    if (options.difficulty !== undefined) {
      const rawInput = String(options.difficulty).trim().toLowerCase();
      const validInputs = ['beginner', 'intermediate', 'advanced', '1', '2', '3', '4', '5'];
      if (!validInputs.includes(rawInput)) {
        console.error('Error: Invalid difficulty. Must be one of: beginner, intermediate, advanced');
        process.exit(2);
      }
      difficulty = normalizeDifficulty(options.difficulty);
    }

    // ─────────────────────────────────────────────────────────────────
    // Mode Detection: Single File vs Batch
    // ─────────────────────────────────────────────────────────────────
    const isExplicitSingleFile =
      !options.all &&
      Boolean(targetPath) &&
      fs.existsSync(path.resolve(vaultPath, targetPath!)) &&
      fs.statSync(path.resolve(vaultPath, targetPath!)).isFile() &&
      targetPath!.endsWith('.md');

    if (isExplicitSingleFile) {
      // Single-file adoption mode
      const absolutePath = path.resolve(vaultPath, targetPath!);
      const realPath = fs.realpathSync(absolutePath);

      if (!realPath.startsWith(resolvedVault + path.sep) && realPath !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exit(2);
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (frontmatter && frontmatter.palee_id) {
        console.error(`Error: Note already adopted as topic ${frontmatter.palee_id}`);
        process.exit(2);
      }

      const dependsOn = options.dependsOn
        ? options.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

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
      console.log(`  Path: ${targetPath}`);
      console.log(`  Difficulty: ${difficulty}`);
      if (dependsOn.length > 0) {
        console.log(`  Dependencies: ${dependsOn.join(', ')}`);
      }

      process.exit(0);
    }

    // ─────────────────────────────────────────────────────────────────
    // Batch Adoption Mode
    // ─────────────────────────────────────────────────────────────────
    if (!targetPath && !options.all) {
      console.error('Error: Specify a note path, a directory, or use --all to adopt notes across the vault.');
      process.exit(2);
    }

    let scanRoot = vaultPath;
    if (targetPath) {
      const candidatePath = path.resolve(vaultPath, targetPath);
      if (!fs.existsSync(candidatePath)) {
        console.error(`Error: Target directory not found: ${targetPath}`);
        process.exit(2);
      }
      const realCandidate = fs.realpathSync(candidatePath);
      if (!realCandidate.startsWith(resolvedVault + path.sep) && realCandidate !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exit(2);
      }
      if (!fs.statSync(candidatePath).isDirectory()) {
        console.error(`Error: Expected directory path for batch adoption: ${targetPath}`);
        process.exit(2);
      }
      scanRoot = candidatePath;
    }

    // Scan vault markdown files
    const allFiles = walkVault(scanRoot);

    if (allFiles.length === 0) {
      console.log('No markdown files found to adopt.');
      process.exit(0);
    }

    const toAdopt: StagedNote[] = [];
    const alreadyAdopted: string[] = [];
    const skippedByPattern: string[] = [];
    const skippedByTag: string[] = [];

    for (const filePath of allFiles) {
      const relPath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      // Check if already adopted
      if (frontmatter && frontmatter.palee_id) {
        alreadyAdopted.push(relPath);
        continue;
      }

      // Check include filter
      if (options.include && !matchesPattern(relPath, options.include)) {
        skippedByPattern.push(relPath);
        continue;
      }

      // Check exclude filter
      if (options.exclude && matchesPattern(relPath, options.exclude)) {
        skippedByPattern.push(relPath);
        continue;
      }

      // Check tag filter
      if (options.tag && !matchesTags(frontmatter?.tags, options.tag)) {
        skippedByTag.push(relPath);
        continue;
      }

      toAdopt.push({
        absolutePath: filePath,
        relativePath: relPath,
        content,
        fingerprint: computeFingerprint(content),
      });
    }

    // Display summary preview
    const scanLabel = targetPath ? targetPath : '(Entire Vault)';
    console.log('=== PALEE Batch Adoption ===');
    console.log(`Scope:            ${scanLabel}`);
    console.log(`Total Scanned:    ${allFiles.length} files`);
    console.log(`Ready to Adopt:   ${toAdopt.length} notes`);
    console.log(`Already Adopted:  ${alreadyAdopted.length} notes`);
    if (options.include || options.exclude) {
      console.log(`Excluded (Pattern): ${skippedByPattern.length} notes`);
    }
    if (options.tag) {
      console.log(`Excluded (Tag):     ${skippedByTag.length} notes`);
    }
    console.log(`Difficulty:       ${difficulty}`);

    if (options.verbose) {
      if (toAdopt.length > 0) {
        console.log('\nNotes to adopt:');
        toAdopt.forEach((n) => console.log(`  + ${n.relativePath}`));
      }
      if (alreadyAdopted.length > 0) {
        console.log('\nAlready adopted:');
        alreadyAdopted.forEach((f) => console.log(`  = ${f}`));
      }
      if (skippedByPattern.length > 0) {
        console.log('\nSkipped by pattern filter:');
        skippedByPattern.forEach((f) => console.log(`  - ${f}`));
      }
      if (skippedByTag.length > 0) {
        console.log('\nSkipped by tag filter:');
        skippedByTag.forEach((f) => console.log(`  ~ ${f}`));
      }
    }

    if (options.dryRun) {
      console.log('\nDry-run complete. No files were modified.');
      process.exit(0);
    }

    if (toAdopt.length === 0) {
      console.log('\nNo new notes matched the criteria to adopt.');
      process.exit(0);
    }

    // Confirmation gate
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error('Error: Non-interactive environment. Use -y or --yes to confirm batch adoption.');
        process.exit(2);
      }

      console.log(`\nThis will initialize PALEE tracking for ${toAdopt.length} notes.`);
      const confirmed = await promptConfirmation('Proceed with adoption? (y/N): ');
      if (!confirmed) {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    // Execute atomic batch writes
    let adoptedCount = 0;
    for (const note of toAdopt) {
      const topicId = generateTopicId();
      const paleeData: Record<string, unknown> = {
        palee_id: topicId,
        palee_schema: 1,
        difficulty,
        depends_on: [],
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

      const updatedContent = updateFrontmatter(note.content, paleeData);
      await atomicWrite(vaultPath, note.absolutePath, updatedContent, note.fingerprint);
      adoptedCount++;
    }

    console.log(`\n✓ Successfully adopted ${adoptedCount} notes into PALEE.`);
    process.exit(0);
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default adoptCommand;
