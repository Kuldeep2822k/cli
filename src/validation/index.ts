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
