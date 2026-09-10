/**
 * valid-topic-status rule (#31)
 *
 * @remarks
 * Validates the operational status stored on topic notes against the
 * four-value lifecycle: not_started | learning | paused | archived.
 * Pseudo-statuses (`completed`, `done`) are errors — mastery is derived,
 * never stored as a status. Missing status is tolerated: the loader
 * normalizes absent status to the adopt default (`not_started`), so the
 * normalized view the rule sees is valid by construction; the rule
 * therefore only reports values that are PRESENT and wrong.
 *
 * Present-and-wrong includes explicit `null` and every non-string type
 * (numbers, booleans, YAML lists). YAML `status:` (empty value) is an
 * explicit null, not a missing key — it is a stored defect, never emitted
 * by any PALEE writer, and the allowlist lookup runs only on validated
 * strings so a non-string can never coerce into an allowed word (e.g.
 * `String(['learning'])`).
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { ALLOWED_TOPIC_STATUSES } from '../../engine/topic-id';

const ALLOWED = new Set<string>(ALLOWED_TOPIC_STATUSES);

/** Reports topic notes whose stored status is not a lifecycle value. */
export const validTopicStatusRule: ValidationRule = {
  id: 'valid-topic-status',
  description: 'Topic status must be one of the four lifecycle values',
  severity: 'error',
  fixable: 'manual',
  run(context): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      // Only a PRESENT-and-invalid raw value is an error. The loader's
      // default (not_started) for a MISSING status key is the adopt
      // contract, not a vault defect — never reported. Everything else
      // that is present — including explicit null — must be a valid
      // lifecycle string; non-strings are rejected before the allowlist
      // lookup so no value can coerce its way in.
      const raw = (topic.frontmatter as Record<string, unknown>).status;
      if (raw === undefined) continue;
      if (typeof raw === 'string' && ALLOWED.has(raw)) continue;

      issues.push({
        ruleId: 'valid-topic-status',
        severity: 'error',
        message: `Invalid status on ${topic.path}: ${JSON.stringify(raw) ?? String(raw)} (allowed: ${ALLOWED_TOPIC_STATUSES.join(', ')})`,
        file: topic.path,
        topicId: topic.palee_id,
        field: 'status',
        details: {
          actual: raw as unknown,
          allowed: [...ALLOWED_TOPIC_STATUSES],
        },
      });
    }

    return issues.sort((a, b) => (a.topicId! < b.topicId! ? -1 : a.topicId! > b.topicId! ? 1 : 0));
  },
};
