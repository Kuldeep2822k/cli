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
import { VALIDATION_RULES } from '../validation';
import { repairReviewFields } from '../validation/rules/valid-review-fields';
import { displayValue } from '../validation/rules/diagnostic-value';
import type { ValidationIssue } from '../validation/types';
import {
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  isConflictError,
} from '../storage';
import type { LoadedTopic } from '../storage';

/** One field-level repair performed by `--fix` (additive JSON report entry). */
interface Sm2RepairEntry {
  topic_id: string;
  file: string;
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Repairs `valid-review-fields` corruption in collected topics by resetting
 * each invalid field to its adopt default.
 *
 * @remarks
 * Deliberately scoped to the `valid-review-fields` rule only — the general
 * fix engine remains deferred (ADR-0008). Writes go through
 * `updateFrontmatter` + `atomicWrite` with OCC fingerprinting, mirroring
 * `palee review`; a concurrent modification on one note is skipped
 * (reported as a conflict) while the remaining notes are still repaired.
 *
 * @param vaultPath - Resolved vault root
 * @param topics - Collected topics (raw frontmatter available)
 * @param issues - Validation issues from the same collection pass
 * @returns Per-field repair entries and OCC conflict messages
 */
async function applyReviewFieldRepairs(
  vaultPath: string,
  topics: LoadedTopic[],
  issues: ValidationIssue[]
): Promise<{ repairs: Sm2RepairEntry[]; conflicts: string[] }> {
  const corruptTopicIds = new Set(
    issues
      .filter((issue) => issue.ruleId === 'valid-review-fields')
      .map((issue) => issue.topicId)
  );
  const repairs: Sm2RepairEntry[] = [];
  const conflicts: string[] = [];

  for (const topic of topics) {
    if (!corruptTopicIds.has(topic.palee_id)) continue;
    const fixes = repairReviewFields(topic.frontmatter);
    if (!fixes) continue;
    try {
      const updatedContent = updateFrontmatter(topic.content, fixes);
      await atomicWrite(vaultPath, topic.filePath, updatedContent, computeFingerprint(topic.content));
      for (const [field, to] of Object.entries(fixes)) {
        repairs.push({
          topic_id: topic.palee_id,
          file: topic.path,
          field,
          from: displayValue(topic.frontmatter[field]),
          to,
        });
      }
    } catch (e: unknown) {
      if (isConflictError(e)) {
        conflicts.push(`${topic.path}: ${(e as Error).message}`);
        continue;
      }
      throw e;
    }
  }

  return { repairs, conflicts };
}

/**
 * CLI command handler for validating vault integrity, schema compliance, and dependency cycles.
 *
 * @param options - Validate options including `--json`, `--fix`, and `--strict`.
 * @returns Promise resolving when validation completes.
 * @remarks Sets process.exitCode = 2 on missing/invalid vault path,
 * process.exitCode = 3 if validation errors remain after an optional `--fix`
 * pass (a note skipped due to an OCC conflict is still an error), and
 * process.exitCode = 5 on unexpected exceptions.
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
    let issues = runRules(context, VALIDATION_RULES);
    let reportContext = context;

    let repairs: Sm2RepairEntry[] = [];
    let conflicts: string[] = [];
    if (options.fix) {
      const repairResult = await applyReviewFieldRepairs(vaultPath, context.topics, issues);
      repairs = repairResult.repairs;
      conflicts = repairResult.conflicts;
      if (repairs.length > 0) {
        // Re-validate from fresh disk state so the report and exit code
        // reflect what actually remains after the repair pass.
        reportContext = collectVault(vaultPath);
        issues = runRules(reportContext, VALIDATION_RULES);
      }
    }

    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
    // Old behavior: topic_count is the number of UNIQUE palee_ids, not the
    // number of topic notes (duplicates collapse to one entry).
    const uniqueTopicCount = new Set(reportContext.topics.map((topic) => topic.palee_id)).size;

    if (jsonMode) {
      const json = JSON.parse(
        formatJson(issues, {
          topicCount: uniqueTopicCount,
          fileCount: reportContext.files.length,
        })
      ) as Record<string, unknown>;
      if (options.fix) {
        json.repairs = repairs;
        json.repair_conflicts = conflicts;
      }
      console.log(JSON.stringify(json));
      if (errorCount > 0 || (options.strict && warningCount > 0)) {
        process.exitCode = ExitCode.Validation;
      }
      return;
    }

    console.log(`Found ${uniqueTopicCount} PALEE topics in ${reportContext.files.length} files`);
    console.log();

    if (options.fix) {
      for (const repair of repairs) {
        console.log(`✓ Repaired ${repair.topic_id}: ${repair.field} ${JSON.stringify(repair.from)} -> ${JSON.stringify(repair.to)} (${repair.file})`);
      }
      for (const conflict of conflicts) {
        console.error(`⚠ Skipped repair (OCC conflict): ${conflict}`);
      }
      if (repairs.length === 0 && conflicts.length === 0) {
        console.log('Nothing to repair: --fix found no fixable issues (SM-2 review fields).');
      }
      console.log();
    }

    // Human report (or the pass line) after any --fix repair summary.
    console.log(formatHuman(issues));

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
