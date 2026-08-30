/**
 * Validate Command Handler
 * Validates vault integrity
 */

import { loadConfig } from './config';
import { isJsonOutput, validateVaultPath } from './onboarding';
import { walkVault } from '../storage/vault-walker';
import { loadTopics } from '../storage/loader';
import { validateDependencyGraph } from '../engine/dependency';
import { ValidateOptions, TopicNode, ValidationError } from '../types';


/**
 * CLI command handler for validating vault integrity, schema compliance, and dependency cycles.
 *
 * @param options - Validate options including `--json` and `--fix`.
 * @returns Promise resolving when validation completes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * process.exitCode = 3 if validation errors are found in the vault,
 * and process.exitCode = 5 on unexpected exceptions.
 */
async function validateCommand(options: ValidateOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const jsonMode = isJsonOutput(options);
    const vaultPath = validateVaultPath(config.vaultPath, { json: jsonMode });
    if (!vaultPath) return;

    if (!jsonMode) {
      console.log(`Validating vault: ${vaultPath}`);
      console.log();
    }

    const files = walkVault(vaultPath);
    const loaded = loadTopics(vaultPath, files);
    const topics = new Map<string, TopicNode & { path: string }>();

    const errors: ValidationError[] = [];

    for (const t of loaded) {
      if (topics.has(t.palee_id)) {
        const existingError = errors.find((e) => e.type === 'duplicate_id' && e.id === t.palee_id);

        if (existingError && existingError.files) {
          existingError.files.push(t.path);
        } else {
          errors.push({
            type: 'duplicate_id',
            id: t.palee_id,
            files: [topics.get(t.palee_id)!.path, t.path],
          });
        }
        // Merge dependencies from duplicate node so graph validation does not miss edges
        const existingNode = topics.get(t.palee_id)!;
        const mergedDeps = Array.from(new Set([...(existingNode.depends_on || []), ...(t.depends_on || [])]));
        existingNode.depends_on = mergedDeps;
      } else {
        topics.set(t.palee_id, {
          palee_id: t.palee_id,
          depends_on: t.depends_on,
          topic_mastery: t.topic_mastery,
          path: t.path,
        });
      }
    }


    const graphValidation = validateDependencyGraph(topics);
    errors.push(...graphValidation.errors);

    if (jsonMode) {
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
    process.exitCode = 5;
    return;
  }
}

export { validateCommand };
export default validateCommand;
