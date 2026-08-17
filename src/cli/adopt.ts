/**
 * Adopt Command Handler
 * Adopts existing notes as PALEE topics (single-file or batch mode)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { loadConfig } from './config';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from '../storage/frontmatter';
import { atomicWrite } from '../storage/atomic-write';
import { walkVault } from '../storage/vault-walker';
import { matchesPattern, matchesTags, validatePattern } from '../storage/pattern-matcher';
import { computeTopicMastery } from '../engine/mastery';
import { AdoptOptions, Difficulty, normalizeDifficulty } from '../types';


function generateTopicId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0]; // YYYYMMDDTHHMMSS
  const random = crypto.randomBytes(4).toString('hex'); // 8 hex characters (32 bits of entropy)
  return `T-${timestamp}-${random}`;
}

/**
 * Resolves the display title for a Markdown note:
 * 1. Usable frontmatter `title` field (if defined and non-empty)
 * 2. First level-1 heading (`# Title`) in Markdown body
 * 3. Filename fallback (basename without .md extension)
 */
export function resolveNoteTitle(
  content: string,
  filePath?: string,
  parsedFrontmatter?: Record<string, unknown> | null
): string {
  let frontmatter = parsedFrontmatter;
  let bodyContent: string;

  if (frontmatter === undefined) {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    bodyContent = parsed.body;
  } else {
    bodyContent = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, '');
  }

  // Tier 1: Existing frontmatter title
  if (frontmatter && frontmatter.title !== undefined && frontmatter.title !== null) {
    if (typeof frontmatter.title === 'string') {
      const cleanFmTitle = frontmatter.title.replace(/\r?\n/g, ' ').trim();
      if (cleanFmTitle.length > 0) {
        return cleanFmTitle;
      }
    } else if (typeof frontmatter.title === 'number' || typeof frontmatter.title === 'boolean') {
      const cleanFmTitle = String(frontmatter.title).trim();
      if (cleanFmTitle.length > 0) {
        return cleanFmTitle;
      }
    }
  }

  // Tier 2: First H1 heading (# Title) in body
  // Strip HTML comments
  let sanitizedBody = bodyContent.replace(/<!--[\s\S]*?-->/g, '');
  // Strip fenced code blocks (``` and ~~~)
  sanitizedBody = sanitizedBody.replace(/(?:```|~~~)[^`~]*?\r?\n[\s\S]*?\r?\n\s*(?:```|~~~)/g, '');

  const h1Match = sanitizedBody.match(/^[ \t]{0,3}#[ \t]+([^#\r\n].*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/m);
  if (h1Match && h1Match[1]) {
    const cleanH1 = h1Match[1].trim();
    if (cleanH1.length > 0) {
      return cleanH1;
    }
  }

  // Tier 3: Filename fallback
  if (filePath) {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    if (basename.trim().length > 0) {
      return basename.trim();
    }
  }

  return 'Untitled';
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

interface RollbackRecord {
  absolutePath: string;
  relativePath: string;
  originalContent: string;
}

async function rollbackBatch(vaultPath: string, journal: RollbackRecord[]): Promise<void> {
  if (journal.length === 0) return;

  console.error('\nRolling back adopted notes...');
  for (const item of [...journal].reverse()) {
    try {
      await atomicWrite(vaultPath, item.absolutePath, item.originalContent);
    } catch (err: unknown) {
      const e = err as Error;
      console.error(`  Failed to revert ${item.relativePath}: ${e.message}`);
    }
  }
}

async function adoptCommand(targetPath?: string, options: AdoptOptions = {}): Promise<void> {
  try {
    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exitCode = 2;
      return;
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
        process.exitCode = 2;
        return;
      }
      difficulty = normalizeDifficulty(options.difficulty);
    }

    // Validate include/exclude pattern syntax early
    if (options.include) {
      try {
        validatePattern(options.include);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Error: ${e.message}`);
        process.exitCode = 2;
        return;
      }
    }
    if (options.exclude) {
      try {
        validatePattern(options.exclude);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Error: ${e.message}`);
        process.exitCode = 2;
        return;
      }
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
        process.exitCode = 2;
        return;
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (frontmatter && frontmatter.palee_id) {
        console.error(`Error: Note already adopted as topic ${frontmatter.palee_id}`);
        process.exitCode = 2;
        return;
      }

      const dependsOn = options.dependsOn
        ? options.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const topicId = generateTopicId();
      const title = resolveNoteTitle(content, absolutePath, frontmatter);

      const conceptual = typeof frontmatter?.conceptual === 'number' ? frontmatter.conceptual : 0.0;
      const practical = typeof frontmatter?.practical === 'number' ? frontmatter.practical : 0.0;
      const debug = typeof frontmatter?.debug === 'number' ? frontmatter.debug : 0.0;
      const feynman = typeof frontmatter?.feynman === 'number' ? frontmatter.feynman : 0.0;
      const topicMastery = typeof frontmatter?.topic_mastery === 'number'
        ? frontmatter.topic_mastery
        : computeTopicMastery(conceptual, practical, debug, feynman);

      const paleeData: Record<string, unknown> = {
        palee_id: topicId,
        palee_schema: 1,
        title,
        difficulty,
        depends_on: dependsOn,
        topic_mastery: topicMastery,
        assessed_at: frontmatter?.assessed_at ? String(frontmatter.assessed_at) : null,
        conceptual,
        practical,
        debug,
        feynman,
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
      console.log(`  Title: ${title}`);
      console.log(`  Path: ${targetPath}`);
      console.log(`  Difficulty: ${difficulty}`);
      if (dependsOn.length > 0) {
        console.log(`  Dependencies: ${dependsOn.join(', ')}`);
      }

      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Batch Adoption Mode
    // ─────────────────────────────────────────────────────────────────
    if (!targetPath && !options.all) {
      console.error('Error: Specify a note path, a directory, or use --all to adopt notes across the vault.');
      process.exitCode = 2;
      return;
    }

    let scanRoot = vaultPath;
    if (targetPath) {
      const candidatePath = path.resolve(vaultPath, targetPath);
      if (!fs.existsSync(candidatePath)) {
        console.error(`Error: Target directory not found: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      const realCandidate = fs.realpathSync(candidatePath);
      if (!realCandidate.startsWith(resolvedVault + path.sep) && realCandidate !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      if (!fs.statSync(candidatePath).isDirectory()) {
        console.error(`Error: Expected directory path for batch adoption: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      scanRoot = candidatePath;
    }

    // Scan vault markdown files
    const allFiles = walkVault(scanRoot);

    if (allFiles.length === 0) {
      console.log('No markdown files found to adopt.');
      return;
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
    const scanLabel = targetPath ? targetPath.replace(/\\/g, '/') : '(Entire Vault)';
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
      return;
    }

    if (toAdopt.length === 0) {
      console.log('\nNo new notes matched the criteria to adopt.');
      return;
    }

    // Confirmation gate
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error('Error: Non-interactive environment. Use -y or --yes to confirm batch adoption.');
        process.exitCode = 2;
        return;
      }

      console.log(`\nThis will initialize PALEE tracking for ${toAdopt.length} notes.`);
      const confirmed = await promptConfirmation('Proceed with adoption? (y/N): ');
      if (!confirmed) {
        console.log('Aborted.');
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 1: Preflight & Preparation
    // ─────────────────────────────────────────────────────────────────
    interface PreparedBatchItem {
      absolutePath: string;
      relativePath: string;
      originalContent: string;
      fingerprint: string;
      updatedContent: string;
    }

    const preparedBatch: PreparedBatchItem[] = [];
    for (const note of toAdopt) {
      // Re-read fresh content to minimize TOCTOU window
      const freshContent = fs.readFileSync(note.absolutePath, 'utf8');
      const freshFingerprint = computeFingerprint(freshContent);
      const { frontmatter } = parseFrontmatter(freshContent);

      const topicId = generateTopicId();
      const title = resolveNoteTitle(freshContent, note.absolutePath, frontmatter);

      const conceptual = typeof frontmatter?.conceptual === 'number' ? frontmatter.conceptual : 0.0;
      const practical = typeof frontmatter?.practical === 'number' ? frontmatter.practical : 0.0;
      const debug = typeof frontmatter?.debug === 'number' ? frontmatter.debug : 0.0;
      const feynman = typeof frontmatter?.feynman === 'number' ? frontmatter.feynman : 0.0;
      const topicMastery = typeof frontmatter?.topic_mastery === 'number'
        ? frontmatter.topic_mastery
        : computeTopicMastery(conceptual, practical, debug, feynman);

      const paleeData: Record<string, unknown> = {
        palee_id: topicId,
        palee_schema: 1,
        title,
        difficulty,
        depends_on: [],
        topic_mastery: topicMastery,
        assessed_at: frontmatter?.assessed_at ? String(frontmatter.assessed_at) : null,
        conceptual,
        practical,
        debug,
        feynman,
        ease_factor: 2.5,
        interval_days: 1,
        repetition: 0,
        lapses: 0,
        last_quality: null,
        last_reviewed_at: null,
        due_at: null,
      };


      const updatedContent = updateFrontmatter(freshContent, paleeData);
      preparedBatch.push({
        absolutePath: note.absolutePath,
        relativePath: note.relativePath,
        originalContent: freshContent,
        fingerprint: freshFingerprint,
        updatedContent,
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: Execution with Rollback Journal
    // ─────────────────────────────────────────────────────────────────
    const journal: RollbackRecord[] = [];
    try {
      for (const item of preparedBatch) {
        await atomicWrite(vaultPath, item.absolutePath, item.updatedContent, item.fingerprint);
        journal.push({
          absolutePath: item.absolutePath,
          relativePath: item.relativePath,
          originalContent: item.originalContent,
        });
      }

      console.log(`\n✓ Successfully adopted ${journal.length} notes into PALEE.`);
      return;
    } catch (writeErr: unknown) {
      const err = writeErr as Error;
      console.error(`\nBatch adoption write error: ${err.message}`);
      await rollbackBatch(vaultPath, journal);
      process.exitCode = 5;
      return;
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = 5;
    return;
  }
}

export default adoptCommand;
