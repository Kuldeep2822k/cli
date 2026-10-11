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
 * Topic-note eligibility comes from the SHARED predicate
 * (`src/validation/managed-note.ts`, #324): a note is a topic note only when
 * it declares the `palee_id` identity key and no other managed kind (session,
 * hot memory, or the session index). Presence of the key — not its value —
 * marks eligibility, so an absent/malformed `palee_id` on an eligible note is
 * itself the #29 "missing or non-string ID" failure and must still reach the
 * validator. Crucially, the `palee_schema` marker alone no longer makes a note
 * a topic: a schema-only note has no identity to judge, and reporting it here
 * was the #324 false positive that failed the vault at exit 3 — the kind rule
 * surfaces it once, as a warning instead. Session/hot-memory/index notes never
 * carry topic IDs by design, so they are out of scope.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { isValidTopicId } from '../../engine/topic-id';
import { isTopicNote } from '../managed-note';

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

      // Topic-note eligibility comes from the shared #324 predicate: the
      // note carries the `palee_id` identity key and no conflicting kind.
      // The `palee_schema` marker alone is NOT eligibility — a schema-only
      // note has no identity to judge, and the kind rule reports it as a
      // warning. An absent/malformed `palee_id` on an ELIGIBLE note is still
      // the #29 "missing or non-string ID" failure and reaches the validator.
      if (!isTopicNote(fm)) continue;

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
