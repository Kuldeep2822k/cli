/**
 * Validation Output Formatters (#25)
 *
 * @remarks
 * Pure presentation layer: turns a list of {@link ValidationIssue} findings
 * into human-readable console text or the documented machine-readable JSON
 * shape. No console output happens here — formatters return strings so the
 * CLI handler owns all printing, and exit-code policy stays in the handler.
 *
 * Severity policy (adopted from `planning/VALIDATION_FRAMEWORK_VERDICT.md`):
 * errors gate the exit code; warnings never do. Human output lists errors
 * before warnings; JSON keeps the documented contract keys and adds
 * `warning_count`/`warnings[]` additively.
 */

import type { ValidationIssue } from './types';

/**
 * Shape options shared by both formatters.
 */
export interface FormatCounts {
  /** Number of collected PALEE topics */
  topicCount: number;
  /** Number of scanned vault files */
  fileCount: number;
}

/** Legacy `type` key for rules that existed before the framework. */
const LEGACY_TYPES: Record<string, string> = {
  'no-duplicate-topic-id': 'duplicate_id',
  'no-missing-dependency': 'missing_dependency',
  'no-dependency-cycle': 'cycle',
};

/**
 * Renders issues in the repo's plain console style.
 *
 * @remarks
 * Output sections: pass line (no issues), `✗` error block, `⚠` warning
 * block. Errors print before warnings; within a block, runner order is
 * preserved. No ANSI colors — output must stay readable when piped.
 *
 * @param issues - All reported validation issues, in runner order
 * @returns Multi-line human-readable report
 *
 * @example
 * ```typescript
 * console.log(formatHuman(issues));
 * ```
 */
function formatHuman(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return '✓ Vault validation passed - no errors found';
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push(`✗ Found ${errors.length} validation error(s):`);
    lines.push('');
    lines.push(...formatBlock(errors));
  }

  if (warnings.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`⚠ Found ${warnings.length} validation warning(s):`);
    lines.push('');
    lines.push(...formatBlock(warnings));
  }

  return lines.join('\n');
}

/**
 * Renders one severity block as bullet lines.
 *
 * @param block - Issues of a single severity, in runner order
 * @returns Bullet lines for the block
 */
function formatBlock(block: ValidationIssue[]): string[] {
  const lines: string[] = [];
  for (const issue of block) {
    lines.push(`  • ${issue.message}`);
    if (issue.details && Array.isArray(issue.details.files)) {
      lines.push(`    Files: ${(issue.details.files as string[]).join(', ')}`);
    }
    lines.push(`    Rule: ${issue.ruleId}`);
    lines.push('');
  }
  return lines;
}

/**
 * Options for {@link formatJson}.
 */
export interface FormatJsonOptions extends FormatCounts {}

/**
 * Serializes issues into the documented `palee validate --json` contract.
 *
 * @remarks
 * Contract keys are preserved for machine consumers: `valid`, `topic_count`,
 * `file_count`, `error_count`, `errors[]`. Each error entry keeps its legacy
 * `type` key (`duplicate_id` | `missing_dependency` | `cycle`) plus the
 * legacy locator fields (`id`/`files`, `topic`/`missing`, `path`) so
 * existing scripts keep working, and adds `rule_id`/`severity`/`message`.
 * Warnings land in the new additive `warnings[]` array and never affect
 * `valid` or `error_count`. Output is single-line JSON.
 *
 * @param issues - All reported validation issues, in runner order
 * @param options - Counts plus an optional explicit `valid` verdict
 * @returns Single-line JSON string
 *
 * @example
 * ```typescript
 * console.log(formatJson(issues, { topicCount: 3, fileCount: 9 }));
 * ```
 */
function formatJson(issues: ValidationIssue[], options: FormatJsonOptions): string {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const valid = errors.length === 0;

  return JSON.stringify({
    valid,
    topic_count: options.topicCount,
    file_count: options.fileCount,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.map(toJsonEntry),
    warnings: warnings.map(toJsonEntry),
  });
}

/**
 * Maps one issue to the JSON entry shape (legacy keys + rule metadata).
 *
 * @param issue - Issue to serialize
 * @returns JSON-safe plain object
 */
function toJsonEntry(issue: ValidationIssue): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: LEGACY_TYPES[issue.ruleId] ?? issue.ruleId,
    rule_id: issue.ruleId,
    severity: issue.severity,
    message: issue.message,
  };

  if (issue.file !== undefined) entry.file = issue.file;
  if (issue.topicId !== undefined) {
    entry.topic_id = issue.topicId;
    // Legacy locator fields per rule
    if (issue.ruleId === 'no-duplicate-topic-id') entry.id = issue.topicId;
    if (issue.ruleId === 'no-missing-dependency') entry.topic = issue.topicId;
  }
  if (issue.sessionId !== undefined) entry.session_id = issue.sessionId;
  if (issue.field !== undefined) entry.field = issue.field;
  if (issue.details !== undefined) {
    entry.details = issue.details;
    if (Array.isArray(issue.details.files)) entry.files = issue.details.files;
    if (typeof issue.details.missing === 'string') entry.missing = issue.details.missing;
    if (Array.isArray(issue.details.path)) entry.path = issue.details.path;
  }

  return entry;
}

export { formatHuman, formatJson };
