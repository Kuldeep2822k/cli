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
import { parseFrontmatterRule, readFailureRule } from '../validation/rules/parse-frontmatter';
import { noDuplicateTopicIdRule } from '../validation/rules/no-duplicate-topic-id';
import { noMissingDependencyRule } from '../validation/rules/no-missing-dependency';
import { noDependencyCycleRule } from '../validation/rules/no-dependency-cycle';
import { validPaleeSchemaRule } from '../validation/rules/valid-palee-schema';
import { validTopicIdFormatRule } from '../validation/rules/valid-topic-id-format';
import { validTopicStatusRule } from '../validation/rules/valid-topic-status';
import { validAssessmentFieldsRule } from '../validation/rules/valid-assessment-fields';
import { validTopicMasteryRule } from '../validation/rules/valid-topic-mastery';
import { validReviewFieldsRule } from '../validation/rules/valid-review-fields';
import { validReviewDatesRule } from '../validation/rules/valid-review-dates';
import { validDependencyListRule } from '../validation/rules/valid-dependency-list';
import type { ValidationRule } from '../validation/types';

/**
 * Rules executed by `palee validate`, in registration order.
 *
 * @remarks
 * Parse and read warnings come first (they explain why a note may be
 * missing from the collected topic set), then identity and schema checks,
 * then graph checks, then field/assessment consistency checks. Rule order
 * is the deterministic output order.
 */
const VALIDATION_RULES: ValidationRule[] = [
  parseFrontmatterRule,
  readFailureRule,
  validPaleeSchemaRule,
  validTopicIdFormatRule,
  validTopicStatusRule,
  noDuplicateTopicIdRule,
  // Shape gate before the graph rules (#33): the graph rules receive
  // whatever the loader normalized; this rule reports the raw-shape
  // defects the loader's coercion would have hidden.
  validDependencyListRule,
  noMissingDependencyRule,
  noDependencyCycleRule,
  validAssessmentFieldsRule,
  validTopicMasteryRule,
  // SM-2 state after the assessment pair, in VERDICT tier order
  // (R13 #38 → R14 #39): numeric shape first, then dates.
  validReviewFieldsRule,
  validReviewDatesRule,
];

/**
 * CLI command handler for validating vault integrity, schema compliance, and dependency cycles.
 *
 * @param options - Validate options including `--json`, `--fix`, and `--strict`.
 * @returns Promise resolving when validation completes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * process.exitCode = 3 if validation errors are found in the vault,
 * and process.exitCode = 5 on unexpected exceptions.
 * Warnings never gate the exit code unless `--strict` is passed
 * (adopted severity policy, #25).
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
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
    // Old behavior: topic_count is the number of UNIQUE palee_ids, not the
    // number of topic notes (duplicates collapse to one entry).
    const uniqueTopicCount = new Set(context.topics.map((topic) => topic.palee_id)).size;

    if (jsonMode) {
      console.log(
        formatJson(issues, {
          topicCount: uniqueTopicCount,
          fileCount: context.files.length,
        })
      );
      if (errorCount > 0 || (options.strict && warningCount > 0)) {
        process.exitCode = ExitCode.Validation;
      }
      return;
    }

    console.log(`Found ${uniqueTopicCount} PALEE topics in ${context.files.length} files`);
    console.log();

    // Human report (or the pass line), then the --fix note for any vault
    // state — a clean vault with --fix set still tells the user fix is a
    // Phase-1 stub rather than silently implying fixes ran.
    console.log(formatHuman(issues));

    if (options.fix) {
      console.log('Note: --fix is not implemented in Phase 1');
    }

    if (errorCount > 0 || (options.strict && warningCount > 0)) {
      process.exitCode = ExitCode.Validation;
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
