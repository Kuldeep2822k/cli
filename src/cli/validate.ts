/**
 * Validate Command Handler
 * Validates vault integrity
 */

import fs from 'fs';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import path from 'path';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter } from '../storage/frontmatter';
import { validateDependencyGraph } from '../engine/dependency';
import { ValidateOptions, TopicNode, ValidationError } from '../types';

async function validateCommand(options: ValidateOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath, { json: options.json });
    if (!vaultPath) return;

    if (!options.json) {
      console.log(`Validating vault: ${vaultPath}`);
      console.log();
    }

    const files = walkVault(vaultPath);
    const topics = new Map<string, TopicNode & { path: string }>();
    const errors: ValidationError[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(vaultPath, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (!frontmatter || !frontmatter.palee_id) {
        continue; // Not a PALEE topic
      }

      const topicId = frontmatter.palee_id as string;

      if (topics.has(topicId)) {
        const existingError = errors.find(e => e.type === 'duplicate_id' && e.id === topicId);
        
        if (existingError && existingError.files) {
          existingError.files.push(relativePath);
        } else {
          errors.push({
            type: 'duplicate_id',
            id: topicId,
            files: [topics.get(topicId)!.path, relativePath],
          });
        }
      } else {
        topics.set(topicId, {
          palee_id: topicId,
          depends_on: (frontmatter.depends_on as string[]) || [],
          topic_mastery: (frontmatter.topic_mastery as number) || 0,
          path: relativePath,
        });
      }
    }

    const graphValidation = validateDependencyGraph(topics);
    errors.push(...graphValidation.errors);

    if (options.json) {
      console.log(JSON.stringify({
        valid: errors.length === 0,
        topic_count: topics.size,
        file_count: files.length,
        error_count: errors.length,
        errors,
      }));
      if (errors.length > 0) {
        process.exitCode = 3;
      }
      return;
    }

    console.log(`Found ${topics.size} PALEE topics in ${files.length} files`);
    console.log();

    if (errors.length === 0) {
      console.log('✓ Vault validation passed - no errors found');
      return;
    } else {
      console.log(`✗ Found ${errors.length} validation error(s):\n`);

      for (const error of errors) {
        if (error.type === 'duplicate_id') {
          console.log(`  • Duplicate ID: ${error.id}`);
          console.log(`    Files: ${error.files?.join(', ')}`);
        } else if (error.type === 'missing_dependency') {
          console.log(`  • Missing dependency: ${error.topic} depends on ${error.missing}`);
        } else if (error.type === 'cycle') {
          console.log(`  • Dependency cycle: ${error.path?.join(' → ')}`);
        }
        console.log();
      }

      if (options.fix) {
        console.log('Note: --fix is not implemented in Phase 1');
      }

      process.exitCode = 3;
      return;
    }

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export { validateCommand };
export default validateCommand;
