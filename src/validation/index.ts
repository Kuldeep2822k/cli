/**
 * Validation Subsystem - Public API
 *
 * @remarks
 * Bundles the vault validation capabilities of PALEE:
 * - **Vault Collection**: `collectVault` — one read pass, malformed files
 *   never abort a scan
 * - **Deterministic Rule Runner**: `runRules`
 * - **Output Formatters**: `formatHuman`, `formatJson`
 * - **Rule Catalog**: parse/read, schema, topic identity, and graph rules
 *   registered by `palee validate` (see `src/cli/validate.ts`)
 * - **Shared Contract Types**: `ValidationRule`, `ValidationIssue`,
 *   `ValidationContext`
 */

import { collectVault, type CollectVaultOptions } from './collect-vault';
import { runRules } from './run-rules';
import { formatHuman, formatJson, type FormatCounts } from './format';
import { parseFrontmatterRule, readFailureRule } from './rules/parse-frontmatter';
import { validManagedNoteKindRule } from './rules/valid-managed-note-kind';
import { validPaleeSchemaRule } from './rules/valid-palee-schema';
import { validTopicIdFormatRule } from './rules/valid-topic-id-format';
import { validTopicStatusRule } from './rules/valid-topic-status';
import { noDuplicateTopicIdRule } from './rules/no-duplicate-topic-id';
import { validDependencyListRule } from './rules/valid-dependency-list';
import { noMissingDependencyRule } from './rules/no-missing-dependency';
import { noDependencyCycleRule } from './rules/no-dependency-cycle';
import { validAssessmentFieldsRule } from './rules/valid-assessment-fields';
import { validTopicMasteryRule } from './rules/valid-topic-mastery';
import { validReviewFieldsRule } from './rules/valid-review-fields';
import { validReviewDatesRule } from './rules/valid-review-dates';
import { validSessionSchemaRule } from './rules/valid-session-schema';
import { noSessionUnknownTopicRule } from './rules/no-session-unknown-topic';
import { validSessionIndexRule } from './rules/valid-session-index';
import { validHotMemoryRule } from './rules/valid-hot-memory';
import { safeVaultPathsRule } from './rules/safe-vault-paths';
import type {
  ValidationSeverity,
  ValidationFixability,
  ValidationIssue,
  ValidationContext,
  ValidationRule,
  MemoryReadError,
} from './types';

export {
  // Vault collection & rule execution
  collectVault,
  runRules,

  // Output formatting
  formatHuman,
  formatJson,

  // Individual rules (symbol re-exports for direct named import; the
  // executed/ordered catalog is VALIDATION_RULES below)
  parseFrontmatterRule,
  readFailureRule,
  validManagedNoteKindRule,
  validPaleeSchemaRule,
  validTopicIdFormatRule,
  validTopicStatusRule,
  noDuplicateTopicIdRule,
  validDependencyListRule,
  noMissingDependencyRule,
  noDependencyCycleRule,
  validAssessmentFieldsRule,
  validTopicMasteryRule,
  validReviewFieldsRule,
  validReviewDatesRule,
  validSessionSchemaRule,
  noSessionUnknownTopicRule,
  validSessionIndexRule,
  validHotMemoryRule,
  safeVaultPathsRule,
};

/**
 * Canonical ordered rule catalog executed by `palee validate`.
 *
 * @remarks
 * Single source of truth for both the CLI runner (`src/cli/validate.ts`
 * imports this exact array) and the public barrel. The order IS the
 * deterministic validation output order:
 * - Parse and read findings first (they explain why a note may be
 *   missing from the collected topic set).
 * - Kind classification (#27) before the schema rule: it explains WHICH
 *   managed entity each note is; schema errors then read with the kind
 *   in hand.
 * - Identity and schema checks, then the raw-shape dependency gate (#33)
 *   before the graph rules, then the graph rules.
 * - Assessment/mastery consistency, then SM-2 state in VERDICT tier
 *   order (R13 #38 numeric shape -> R14 #39 dates).
 * - Memory subsystem (#41/#42/#44): schema shape first, then
 *   cross-references, then the derived index/hot views (never gate).
 * - Path boundary audit (#45) last: it reads the collected paths of
 *   every managed entity in one pass.
 */
export const VALIDATION_RULES: ValidationRule[] = [
  parseFrontmatterRule,
  readFailureRule,
  validManagedNoteKindRule,
  validPaleeSchemaRule,
  validTopicIdFormatRule,
  validTopicStatusRule,
  noDuplicateTopicIdRule,
  validDependencyListRule,
  noMissingDependencyRule,
  noDependencyCycleRule,
  validAssessmentFieldsRule,
  validTopicMasteryRule,
  validReviewFieldsRule,
  validReviewDatesRule,
  validSessionSchemaRule,
  noSessionUnknownTopicRule,
  validSessionIndexRule,
  validHotMemoryRule,
  safeVaultPathsRule,
];

export type {
  ValidationSeverity,
  ValidationFixability,
  ValidationIssue,
  ValidationContext,
  ValidationRule,
  MemoryReadError,
  CollectVaultOptions,
  FormatCounts,
};
