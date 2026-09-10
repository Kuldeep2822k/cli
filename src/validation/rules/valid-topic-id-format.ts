/**
 * valid-topic-id-format rule (#29)
 *
 * @remarks
 * Enforces the centralized topic ID policy (`src/engine/topic-id.ts`): a
 * topic ID must be `T-` plus kebab-style slug segments. The rule is
 * read-only — legacy snake-case IDs remain readable by migration and
 * resolution; validation reports them without mutating anything.
 *
 * The rule iterates raw scanned notes, not the loader's normalized topic
 * set: `loadTopics` silently drops notes whose `palee_id` is missing,
 * non-string, or blank, so those malformed IDs would never be seen — and
 * never reported — through `context.topics`. Every raw `palee_id` value is
 * validated exactly as stored, with no coercion, per the #29 acceptance
 * criteria ("missing or non-string IDs fail for topic notes"). Notes with
 * parse errors are skipped; parse-frontmatter owns those.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { isValidTopicId } from '../../engine/topic-id';

/** Reports topic notes whose raw palee_id violates the ID policy. */
export const validTopicIdFormatRule: ValidationRule = {
  id: 'valid-topic-id-format',
  description: 'Topic IDs must be T- prefixed kebab-case slugs (centralized policy)',
  severity: 'error',
  fixable: false,
  run(context): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const note of context.notes) {
      if (note.parseError !== undefined || note.frontmatter === null) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      // Topic notes only — session notes (session_id), hot memory
      // (memory_id), and the session index are not subject to the topic
      // ID policy.
      if (!Object.hasOwn(fm, 'palee_id')) continue;

      const raw = fm.palee_id;
      if (typeof raw === 'string' && isValidTopicId(raw)) continue;

      issues.push({
        ruleId: 'valid-topic-id-format',
        severity: 'error',
        message: `Invalid topic ID format on ${note.relativePath}: ${JSON.stringify(raw) ?? String(raw)} (expected T- plus lowercase kebab-case slug)`,
        file: note.relativePath,
        ...(typeof raw === 'string' ? { topicId: raw } : {}),
        field: 'palee_id',
        details: {
          expected: 'T- prefix plus lowercase kebab-case slug segments',
          actual: raw,
        },
      });
    }

    return issues.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  },
};
