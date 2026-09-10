/**
 * valid-topic-id-format rule (#29)
 *
 * @remarks
 * Enforces the centralized topic ID policy (`src/engine/topic-id.ts`): a
 * topic ID must be `T-` plus kebab-style slug segments. The rule is
 * read-only — legacy snake-case IDs remain readable by migration and
 * resolution; validation reports them without mutating anything.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { isValidTopicId } from '../../engine/topic-id';

/** Reports topic notes whose palee_id violates the ID policy. */
export const validTopicIdFormatRule: ValidationRule = {
  id: 'valid-topic-id-format',
  description: 'Topic IDs must be T- prefixed kebab-case slugs (centralized policy)',
  severity: 'error',
  fixable: false,
  run(context): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      if (isValidTopicId(topic.palee_id)) continue;

      issues.push({
        ruleId: 'valid-topic-id-format',
        severity: 'error',
        message: `Invalid topic ID format on ${topic.path}: ${JSON.stringify(topic.palee_id)} (expected T- plus lowercase kebab-case slug)`,
        file: topic.path,
        topicId: topic.palee_id,
        field: 'palee_id',
        details: {
          expected: 'T- prefix plus lowercase kebab-case slug segments',
          actual: topic.palee_id,
        },
      });
    }

    return issues.sort((a, b) => (a.topicId! < b.topicId! ? -1 : a.topicId! > b.topicId! ? 1 : 0));
  },
};
