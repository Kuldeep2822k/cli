/**
 * valid-palee-schema rule (#28)
 *
 * @remarks
 * Every PALEE-managed note must declare a supported `palee_schema` version.
 * Phase 1 supports only version 1. The rule never guesses the meaning of
 * unversioned or future-versioned managed data — it errors so migrations
 * and mutations can refuse to touch it. Notes that are not PALEE-managed
 * (no identity keys) are never reported.
 *
 * A note is managed when the SHARED predicate (`src/validation/managed-note.ts`,
 * #324) says so: a managed identity KEY is present (`palee_id`/`session_id`/
 * `memory_id`) or it carries `type: "session_index"` — regardless of the key's
 * value type. `palee_id: 123` is malformed PALEE identity data, not a user
 * note, so it must still fail schema validation rather than bypass it. The
 * bare `palee_schema` marker alone is NOT managed here: a schema-only note has
 * no identity, and #324 aligns this rule with the topic-id and kind rules on a
 * single definition so they can never disagree about what is managed.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { SUPPORTED_SCHEMA_VERSION } from '../../engine/topic-id';
import { isManagedNote } from '../managed-note';

/** Reports managed notes with missing or unsupported schema versions. */
export const validPaleeSchemaRule: ValidationRule = {
  id: 'valid-palee-schema',
  description: 'Every PALEE-managed note must declare a supported palee_schema version',
  severity: 'error',
  fixable: 'manual',
  run(context): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const note of context.notes) {
      if (note.parseError !== undefined || note.frontmatter === null) continue;
      const fm = note.frontmatter as Record<string, unknown>;

      if (!isManagedNote(fm)) continue;

      const actual = fm.palee_schema;
      if (actual === undefined || actual === null) {
        issues.push({
          ruleId: 'valid-palee-schema',
          severity: 'error',
          message: `Managed note ${note.relativePath} is missing palee_schema (expected ${SUPPORTED_SCHEMA_VERSION})`,
          file: note.relativePath,
          field: 'palee_schema',
          details: { actual: null },
        });
        continue;
      }

      if (typeof actual !== 'number' || !Number.isInteger(actual)) {
        issues.push({
          ruleId: 'valid-palee-schema',
          severity: 'error',
          message: `Invalid palee_schema on ${note.relativePath}: expected integer ${SUPPORTED_SCHEMA_VERSION}, got ${JSON.stringify(actual)}`,
          file: note.relativePath,
          field: 'palee_schema',
          details: { actual },
        });
        continue;
      }

      if (actual !== SUPPORTED_SCHEMA_VERSION) {
        issues.push({
          ruleId: 'valid-palee-schema',
          severity: 'error',
          message: `Unsupported palee_schema ${actual} on ${note.relativePath} (supported: ${SUPPORTED_SCHEMA_VERSION})`,
          file: note.relativePath,
          field: 'palee_schema',
          details: { actual },
        });
      }
    }

    return issues.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  },
};
