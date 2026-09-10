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
 *
 * Topic-note eligibility is decided WITHOUT consulting `palee_id`'s value:
 * a note is a topic note when it carries `palee_schema` or `palee_id`
 * among its keys AND is not a session note (`session_id`), hot memory
 * (`memory_id`), or the session index (`type: "session_index"`). Using the
 * key's presence alone as the gate would skip exactly the malformed notes
 * the rule exists to catch (#29: missing IDs fail); using it as the only
 * marker would swallow absent-ID topic notes. Session/hot-memory/index
 * notes never carry topic IDs by design, so they are out of scope.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { isValidTopicId } from '../../engine/topic-id';

/** Keys that mark a note as a non-topic PALEE record (never subject to the topic ID policy). */
const NON_TOPIC_KEYS = ['session_id', 'memory_id'] as const;

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

      // Topic-note eligibility, independent of palee_id's presence or
      // value: PALEE-managed (schema or id key present) and not one of the
      // non-topic record kinds. An absent palee_id on an eligible note is
      // itself the #29 "missing ID" failure — it must reach the validator,
      // not be skipped by the eligibility gate.
      const isTopicNote =
        (Object.hasOwn(fm, 'palee_id') || Object.hasOwn(fm, 'palee_schema')) &&
        !NON_TOPIC_KEYS.some((key) => Object.hasOwn(fm, key)) &&
        fm.type !== 'session_index';
      if (!isTopicNote) continue;

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
