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
import { validPaleeSchemaRule } from './rules/valid-palee-schema';
import { validTopicIdFormatRule } from './rules/valid-topic-id-format';
import { validTopicStatusRule } from './rules/valid-topic-status';
import { validAssessmentFieldsRule } from './rules/valid-assessment-fields';
import { validTopicMasteryRule } from './rules/valid-topic-mastery';
import { validReviewFieldsRule } from './rules/valid-review-fields';
import { validReviewDatesRule } from './rules/valid-review-dates';
import { validDependencyListRule } from './rules/valid-dependency-list';
import { validManagedNoteKindRule } from './rules/valid-managed-note-kind';
import { validSessionSchemaRule } from './rules/valid-session-schema';
import { noSessionUnknownTopicRule } from './rules/no-session-unknown-topic';
import { validSessionIndexRule } from './rules/valid-session-index';
import { noDuplicateTopicIdRule } from './rules/no-duplicate-topic-id';
import { noMissingDependencyRule } from './rules/no-missing-dependency';
import { noDependencyCycleRule } from './rules/no-dependency-cycle';
import type {
  ValidationSeverity,
  ValidationFixability,
  ValidationIssue,
  ValidationContext,
  ValidationRule,
} from './types';

export {
  // Vault collection & rule execution
  collectVault,
  runRules,

  // Output formatting
  formatHuman,
  formatJson,

  // Rule catalog (registration order mirrors src/cli/validate.ts)
  parseFrontmatterRule,
  readFailureRule,
  validPaleeSchemaRule,
  validTopicIdFormatRule,
  validTopicStatusRule,
  noDuplicateTopicIdRule,
  noMissingDependencyRule,
  noDependencyCycleRule,
  validAssessmentFieldsRule,
  validTopicMasteryRule,
  validReviewFieldsRule,
  validReviewDatesRule,
  validDependencyListRule,
  validManagedNoteKindRule,
  validSessionSchemaRule,
  noSessionUnknownTopicRule,
  validSessionIndexRule,
};

export type {
  ValidationSeverity,
  ValidationFixability,
  ValidationIssue,
  ValidationContext,
  ValidationRule,
  CollectVaultOptions,
  FormatCounts,
};
