/**
 * Validate Command Handler
 * Validates vault integrity
 */

import { loadConfig } from './config';
import { isJsonOutput, validateVaultPath } from './onboarding';
import { ExitCode, exitCodeFor } from './exit-codes';
import { ValidateOptions } from '../types';
import { collectVault } from '../validation/collect-vault';
import { runRules } from '../validation/run-rules';
import { formatHuman, formatJson } from '../validation/format';
import { VALIDATION_RULES } from '../validation';
import { repairReviewFields } from '../validation/rules/valid-review-fields';
import { displayValue } from '../validation/rules/diagnostic-value';
import type { ValidationContext, ValidationIssue, ValidationRule } from '../validation/types';
import {
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  isConflictError,
  rebuildHotAndIndex,
} from '../storage';
import type { LoadedTopic } from '../storage';
import { computeTopicMastery } from '../engine/mastery';

/** One field-level repair performed by `--fix` (additive JSON report entry). */
interface Sm2RepairEntry {
  topic_id: string;
  file: string;
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * One derived-projection rebuild performed by `--fix` (additive JSON report
 * entry).
 *
 * @remarks
 * Separate from {@link Sm2RepairEntry} because a rebuild has no owning topic
 * and no single field: `.palee/hot.md` and `.palee/index.md` are wholesale
 * projections of the canonical session notes, so the repair is the rebuild
 * itself (`field`-shaped entries would have to invent a before/after value
 * that no such repair has).
 */
interface DerivedViewRepairEntry {
  /** Relative vault path of the rebuilt derived projection */
  derived_view: string;
  /** Machine-readable name of the repair that ran */
  repair: 'rebuild_from_canonical_sessions';
  /** Rule ids whose findings this rebuild addressed */
  rules: string[];
}

/** Any repair performed by `--fix`, as reported in `repairs[]`. */
type RepairEntry = Sm2RepairEntry | DerivedViewRepairEntry;

/** The repair implementations `--fix` can execute. */
type RepairerId = 'rebuild_derived_views' | 'recompute_topic_mastery' | 'reset_review_fields';

/**
 * Implemented repairs keyed by the rule id whose findings they clear.
 *
 * @remarks
 * This table is the capability side of the dispatch; the rule's own `fixable`
 * metadata is the permission side (see {@link planRepairs}). A rule listed
 * here is only ever repaired when its metadata admits it — so adding a repair
 * implementation can never, on its own, start mutating a vault entity the
 * rule contract says is a human decision (#323).
 */
const REPAIRERS: Readonly<Record<string, RepairerId | undefined>> = {
  // Derived views: both rules are findings about the same rebuildable
  // projections, and `rebuildHotAndIndex` regenerates both in one pass.
  'valid-session-index': 'rebuild_derived_views',
  'valid-hot-memory': 'rebuild_derived_views',
  'valid-topic-mastery': 'recompute_topic_mastery',
  // `'manual'` in the metadata, admitted through EXPLICIT_MANUAL_REPAIRS below.
  'valid-review-fields': 'reset_review_fields',
};

/**
 * `'manual'` findings `--fix` repairs anyway, as an explicitly listed
 * best-effort reset.
 *
 * @remarks
 * `valid-review-fields` has always been offered by `--fix` (BUG-003) while
 * staying declared `fixable: 'manual'`: resetting an `ease_factor` of 1.3
 * after dozens of lapses back to the adopt default of 2.5 throws away real
 * scheduling history, which is a human call about study data, not a
 * data-loss-free rebuild. Rather than relabel the metadata — 14 assertions
 * across `test/validation-*.test.ts` pin the declared values, so a relabel is
 * a contract change — the engine lists the exception where the exception is.
 */
const EXPLICIT_MANUAL_REPAIRS: readonly string[] = ['valid-review-fields'];

/** Derived projections rebuilt by the `rebuild_derived_views` repair. */
const DERIVED_VIEW_LABELS = ['.palee/hot.md', '.palee/index.md'];

/** Assessment pillar fields, in `computeTopicMastery`'s argument order. */
const MASTERY_PILLARS = ['conceptual', 'practical', 'debug', 'feynman'] as const;

/**
 * Which repairs a `--fix` pass may run, resolved from rule metadata.
 */
interface RepairPlan {
  /** Rule ids to repair, bucketed by the repair that clears them, in catalog order */
  steps: Map<RepairerId, string[]>;
  /** Rule ids whose metadata declares a safe repair the engine cannot serve */
  unservable: string[];
}

/**
 * Resolves the `--fix` repair set by dispatching off each rule's own
 * `fixable` metadata (#323).
 *
 * @param rules - Rule catalog whose metadata drives the dispatch
 * @param issues - Findings from a run over the same catalog
 * @returns Repair steps bucketed by implementation, plus declared-safe rules
 * with no implemented repair
 * @remarks
 * A rule joins the pass only when its metadata admits it: `fixable: 'safe'`
 * with an implemented repair, or `fixable: 'manual'` plus an entry in
 * {@link EXPLICIT_MANUAL_REPAIRS}. `fixable: false` and unlisted `'manual'`
 * rules are never repaired, whatever else the engine can do.
 */
function planRepairs(rules: ValidationRule[], issues: ValidationIssue[]): RepairPlan {
  const reported = new Set(issues.map((issue) => issue.ruleId));
  const steps = new Map<RepairerId, string[]>();
  const unservable: string[] = [];

  const admit = (repairer: RepairerId, ruleId: string): void => {
    const existing = steps.get(repairer);
    if (existing) {
      existing.push(ruleId);
    } else {
      steps.set(repairer, [ruleId]);
    }
  };

  for (const rule of rules) {
    if (!reported.has(rule.id)) continue;
    const repairer = REPAIRERS[rule.id];

    if (rule.fixable === 'safe') {
      // Metadata promises a loss-free repair; a missing implementation is a
      // gap in the engine, not a reason to say nothing (#323's root cause).
      if (repairer) admit(repairer, rule.id);
      else unservable.push(rule.id);
      continue;
    }

    if (repairer && EXPLICIT_MANUAL_REPAIRS.includes(rule.id)) {
      admit(repairer, rule.id);
    }
  }

  return { steps, unservable };
}

/**
 * True for a field-level repair entry (as opposed to a derived-view rebuild).
 *
 * @param entry - Repair entry to classify
 * @returns Whether the entry carries `topic_id`/`field`/`from`/`to`
 */
function isFieldRepair(entry: RepairEntry): entry is Sm2RepairEntry {
  return 'field' in entry;
}

/**
 * Renders one repair entry in the CLI's plain console style.
 *
 * @param entry - Repair entry to render
 * @returns Single-line `✓` summary
 */
function formatRepair(entry: RepairEntry): string {
  if (isFieldRepair(entry)) {
    return `✓ Repaired ${entry.topic_id}: ${entry.field} ${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)} (${entry.file})`;
  }
  return `✓ Repaired derived view ${entry.derived_view}: rebuilt from canonical sessions (${entry.rules.join(', ')})`;
}

/**
 * Repairs `valid-review-fields` corruption in collected topics by resetting
 * each invalid field to its adopt default.
 *
 * @remarks
 * Writes go through `updateFrontmatter` + `atomicWrite` with OCC
 * fingerprinting, mirroring `palee review`; a concurrent modification on one
 * note is skipped (reported as a conflict) while the remaining notes are
 * still repaired.
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
): Promise<{ repairs: RepairEntry[]; conflicts: string[] }> {
  const corruptTopicIds = new Set(
    issues
      .filter((issue) => issue.ruleId === 'valid-review-fields')
      .map((issue) => issue.topicId)
  );
  const repairs: RepairEntry[] = [];
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
 * Restores drifted stored `topic_mastery` to the value the engine derives from
 * the note's own assessment pillars.
 *
 * @remarks
 * The repair recomputes through `computeTopicMastery` — the single writer of
 * mastery (`src/engine/mastery.ts`) — instead of copying a number out of the
 * finding, so a repaired note carries exactly what an `adopt`/`review` write
 * would have produced. Pillar normalization mirrors
 * `valid-topic-mastery`'s own eligibility gate (a shaped score feeds the
 * formula, anything else is the documented adopt default `0`), and the rule
 * only reports topics that passed that gate, so the recomputed value is the
 * one the rule expects.
 *
 * Writes take the same `updateFrontmatter` + `atomicWrite` OCC path as the
 * review-field repair: a note modified since collection conflicts, is reported,
 * and stays untouched.
 *
 * @param vaultPath - Resolved vault root
 * @param topics - Collected topics (raw frontmatter and content available)
 * @param issues - Validation issues from the same collection pass
 * @returns Per-field repair entries and OCC conflict messages
 */
async function applyMasteryRepairs(
  vaultPath: string,
  topics: LoadedTopic[],
  issues: ValidationIssue[]
): Promise<{ repairs: RepairEntry[]; conflicts: string[] }> {
  const driftedTopicIds = new Set(
    issues
      .filter((issue) => issue.ruleId === 'valid-topic-mastery')
      .map((issue) => issue.topicId)
  );
  const repairs: RepairEntry[] = [];
  const conflicts: string[] = [];

  for (const topic of topics) {
    if (!driftedTopicIds.has(topic.palee_id)) continue;

    const pillars = MASTERY_PILLARS.map((field) => {
      const value: unknown = topic.frontmatter[field];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : 0;
    });
    const expected = computeTopicMastery(pillars[0], pillars[1], pillars[2], pillars[3]);

    const stored: unknown = topic.frontmatter.topic_mastery;
    if (stored === expected) continue;

    try {
      const updatedContent = updateFrontmatter(topic.content, { topic_mastery: expected });
      await atomicWrite(vaultPath, topic.filePath, updatedContent, computeFingerprint(topic.content));
      repairs.push({
        topic_id: topic.palee_id,
        file: topic.path,
        field: 'topic_mastery',
        from: displayValue(stored ?? null),
        to: expected,
      });
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
 * Rebuilds the derived memory views (`.palee/hot.md`, `.palee/index.md`) from
 * the canonical session notes.
 *
 * @remarks
 * Delegates wholesale to `rebuildHotAndIndex`, the storage layer's own rebuild
 * entry point: it owns the session scan, the newest-session selection, the
 * word-cap truncation and — through `updateHotMemory`/`regenerateIndex` →
 * `atomicWrite` — the target `Lock` plus OCC fingerprint for both files. A
 * second writer here would be a second copy of that policy to fall out of sync.
 *
 * Refusals, both reported through the conflict channel rather than skipped:
 * - an incomplete snapshot (`readIncomplete`): a session note that could not
 *   be read is missing from the projection the rebuild would write, so the
 *   rebuild would bake a transient read failure into derived state;
 * - an OCC/lock conflict from the rebuild itself.
 *
 * @param vaultPath - Resolved vault root
 * @param context - Collection snapshot the findings were derived from
 * @param ruleIds - Memory rule ids whose findings motivated the rebuild
 * @returns Rebuild entries and conflict messages
 */
async function applyDerivedViewRebuild(
  vaultPath: string,
  context: ValidationContext,
  ruleIds: string[]
): Promise<{ repairs: RepairEntry[]; conflicts: string[] }> {
  const label = DERIVED_VIEW_LABELS.join(' + ');

  if (context.readIncomplete) {
    return {
      repairs: [],
      conflicts: [
        `${label}: rebuild skipped — the vault snapshot is incomplete (a note could not be read), so the canonical sessions are not a safe basis for a rebuild`
      ],
    };
  }

  try {
    await rebuildHotAndIndex(vaultPath);
  } catch (e: unknown) {
    if (isConflictError(e)) {
      return { repairs: [], conflicts: [`${label}: ${(e as Error).message}`] };
    }
    throw e;
  }

  const repairs: RepairEntry[] = DERIVED_VIEW_LABELS.map((derivedView) => ({
    derived_view: derivedView,
    repair: 'rebuild_from_canonical_sessions' as const,
    rules: ruleIds,
  }));
  return { repairs, conflicts: [] };
}

/**
 * Runs the `--fix` repair pass over one collection snapshot.
 *
 * @param vaultPath - Resolved vault root
 * @param context - Collected vault state the findings came from
 * @param issues - Findings from `runRules(context, rules)`
 * @param rules - Rule catalog whose `fixable` metadata authorizes each repair
 * @returns Every repair entry and conflict message from the pass
 * @remarks
 * Steps run in a fixed order — rebuild, recompute, then field resets — and the
 * derived-view rebuild runs at most once per pass even though two rules
 * (`valid-session-index`, `valid-hot-memory`) route to it, because one
 * `rebuildHotAndIndex` restores both projections. A conflict inside one step
 * never aborts the others, matching the per-note isolation the review-field
 * repair has always had.
 */
async function applyFixes(
  vaultPath: string,
  context: ValidationContext,
  issues: ValidationIssue[],
  rules: ValidationRule[]
): Promise<{ repairs: RepairEntry[]; conflicts: string[] }> {
  const { steps, unservable } = planRepairs(rules, issues);
  const repairs: RepairEntry[] = [];
  const conflicts: string[] = [];

  for (const ruleId of unservable) {
    conflicts.push(
      `${ruleId}: metadata declares this finding fixable 'safe', but no repair is implemented — resolve it manually`
    );
  }

  const merge = (result: { repairs: RepairEntry[]; conflicts: string[] }): void => {
    repairs.push(...result.repairs);
    conflicts.push(...result.conflicts);
  };

  const memoryRuleIds = steps.get('rebuild_derived_views') ?? [];
  if (memoryRuleIds.length > 0) {
    merge(await applyDerivedViewRebuild(vaultPath, context, memoryRuleIds));
  }
  if ((steps.get('recompute_topic_mastery') ?? []).length > 0) {
    merge(await applyMasteryRepairs(vaultPath, context.topics, issues));
  }
  if ((steps.get('reset_review_fields') ?? []).length > 0) {
    merge(await applyReviewFieldRepairs(vaultPath, context.topics, issues));
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
 * `--fix` dispatches over the rule catalog by each rule's own `fixable`
 * metadata (#323) and reports what it did in `repairs[]` /
 * `repair_conflicts[]`; it never changes `valid`, `error_count`, or the
 * warning counts — the pass re-collects from fresh disk state, so the payload
 * and exit code describe what actually remains after the repairs.
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

    let repairs: RepairEntry[] = [];
    let conflicts: string[] = [];
    if (options.fix) {
      const repairResult = await applyFixes(vaultPath, context, issues, VALIDATION_RULES);
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
        console.log(formatRepair(repair));
      }
      for (const conflict of conflicts) {
        console.error(`⚠ Skipped repair: ${conflict}`);
      }
      if (repairs.length === 0 && conflicts.length === 0) {
        console.log('Nothing to repair: --fix found no fixable issues.');
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
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export { validateCommand };
export default validateCommand;
