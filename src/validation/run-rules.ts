/**
 * Validation Rule Runner (#25)
 *
 * @remarks
 * Executes validation rules against a collected context in registration
 * order and concatenates their findings deterministically. The runner adds
 * no filtering, severity policy, or formatting — callers own presentation
 * and exit-code mapping.
 */

import type { ValidationContext, ValidationIssue, ValidationRule } from './types';

/**
 * Runs every rule against the context in registration order.
 *
 * @remarks
 * Rule order is the output order: issues from earlier rules precede issues
 * from later rules, and each rule's own issue order is preserved. Rules run
 * unconditionally — one rule's findings never short-circuit later rules.
 *
 * @param context - Fully collected vault state
 * @param rules - Rules in registration order
 * @returns All reported issues, concatenated in deterministic order
 *
 * @example
 * ```typescript
 * const issues = runRules(context, [parseFrontmatterRule, noDuplicateTopicIdRule]);
 * const errors = issues.filter((i) => i.severity === 'error');
 * ```
 */
function runRules(
  context: ValidationContext,
  rules: ValidationRule[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const rule of rules) {
    issues.push(...rule.run(context));
  }
  return issues;
}

export { runRules };
export default runRules;
