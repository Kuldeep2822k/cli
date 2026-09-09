/**
 * Validate Command Handler
 * Validates vault integrity
 */

import { loadConfig } from './config';
import { isJsonOutput, validateVaultPath } from './onboarding';
import { ExitCode } from './exit-codes';
import { ValidateOptions } from '../types';
import { collectVault } from '../validation/collect-vault';
import { runRules } from '../validation/run-rules';
import { formatHuman, formatJson } from '../validation/format';
import { parseFrontmatterRule } from '../validation/rules/parse-frontmatter';
import { noDuplicateTopicIdRule } from '../validation/rules/no-duplicate-topic-id';
import { noMissingDependencyRule } from '../validation/rules/no-missing-dependency';
import { noDependencyCycleRule } from '../validation/rules/no-dependency-cycle';
import type { ValidationRule } from '../validation/types';

/**
 * Rules executed by `palee validate`, in registration order.
 *
 * @remarks
 * Parse warnings come first (they explain why a note may be missing from the
 * collected topic set), then identity and graph checks. Rule order is the
 * deterministic output order.
 */
const VALIDATION_RULES: ValidationRule[] = [
  parseFrontmatterRule,
  noDuplicateTopicIdRule,
  noMissingDependencyRule,
  noDependencyCycleRule,
];

/**
 * CLI command handler for validating vault integrity, schema compliance, and dependency cycles.
 *
 * @param options - Validate options including `--json` and `--fix`.
 * @returns Promise resolving when validation completes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * process.exitCode = 3 if validation errors are found in the vault,
 * and process.exitCode = 5 on unexpected exceptions.
 * Warnings never gate the exit code (adopted severity policy, #25).
 *
 * @example
 * ```typescript
 * await validateCommand({ json: true });
 * ```
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

    const context = collectVault(vaultPath);
    const issues = runRules(context, VALIDATION_RULES);
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;

    if (jsonMode) {
      console.log(
        formatJson(issues, {
          topicCount: context.topics.length,
          fileCount: context.files.length,
        })
      );
      if (errorCount > 0) {
        process.exitCode = ExitCode.Validation;
      }
      return;
    }

    console.log(`Found ${context.topics.length} PALEE topics in ${context.files.length} files`);
    console.log();

    if (issues.length === 0) {
      console.log('✓ Vault validation passed - no errors found');
      return;
    }

    console.log(formatHuman(issues));

    if (options.fix) {
      console.log('Note: --fix is not implemented in Phase 1');
    }

    if (errorCount > 0) {
      process.exitCode = ExitCode.Validation;
      return;
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = ExitCode.Unexpected;
    return;
  }
}

export { validateCommand };
export default validateCommand;
