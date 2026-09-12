/**
 * valid-managed-note-kind rule (#27)
 *
 * @remarks
 * Classifies every PALEE-managed note by its identity field and
 * reports managed notes whose kind cannot be determined. A note
 * declaring `palee_schema` asserts PALEE owns part of its frontmatter
 * — validation and migration must know WHAT KIND of managed note it
 * is before kind-specific rules run; guessing later is unsafe.
 *
 * Kind discrimination (identity KEYS, presence regardless of value
 * type — the same managed-marking policy as `valid-palee-schema`
 * #28, so the two rules can never disagree about what is managed):
 * - `palee_id` → topic note
 * - `session_id` → session note
 * - `memory_id` → hot memory
 * - `type: "session_index"` → session index
 * - none of the above → ambiguous managed note (warning)
 *
 * Multiple identity keys on one note is ALSO ambiguous: a note
 * carrying both `palee_id` and `session_id` claims to be two kinds
 * at once, and no kind-specific rule can be trusted to apply.
 *
 * Scope: this rule sees the WALKED note set (vault root, excluding
 * dot-directories) — the same set `valid-palee-schema` sees.
 * `.palee/` internal notes (sessions, index, hot) are validated by
 * the memory rules through the collected `sessions`/`sessionIndex`/
 * `hotMemory` snapshot instead. A `palee_schema` note inside the
 * walked set with no identity is the ambiguity this rule reports;
 * severity is `warning` (issue #27: never a fatal command error —
 * the note is still versioned data; a human decides its kind).
 */

import type { ValidationRule, ValidationIssue } from '../types';

/** Identity keys that discriminate managed-note kinds (#28 parity). */
const IDENTITY_KEYS = ['palee_id', 'session_id', 'memory_id'] as const;

/** Index marker value that identifies the session index note. */
const INDEX_TYPE = 'session_index';

/**
 * Reports managed notes whose kind cannot be identified from their
 * identity fields.
 */
export const validManagedNoteKindRule: ValidationRule = {
  id: 'valid-managed-note-kind',
  description:
    'Every PALEE-managed note must carry a recognizable identity: palee_id (topic), session_id (session), memory_id (hot memory), or type: session_index',
  severity: 'warning',
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const note of context.notes) {
      // Unparseable notes are the parse-frontmatter rule's findings —
      // kind cannot be judged on YAML that never parsed.
      if (note.parseError !== undefined || note.frontmatter === null) continue;
      const fm = note.frontmatter as Record<string, unknown>;

      const hasSchema = Object.hasOwn(fm, 'palee_schema');
      if (!hasSchema) continue; // user-owned note, never reported

      const identities = IDENTITY_KEYS.filter((key) => Object.hasOwn(fm, key));
      const isIndex = fm.type === INDEX_TYPE;

      if (identities.length === 1 && !isIndex) continue; // exactly one kind
      if (identities.length === 0 && isIndex) continue; // index marker only
      if (identities.length > 1 || (identities.length === 1 && isIndex)) {
        // Conflicting kinds: an identity key PLUS the index marker
        // claims two kinds at once.
        issues.push({
          ruleId: 'valid-managed-note-kind',
          severity: 'warning',
          message: `Managed note ${note.relativePath} declares conflicting identities (${[...identities, isIndex ? 'type: session_index' : ''].filter(Boolean).join(', ')}); kind cannot be determined`,
          file: note.relativePath,
          field: 'palee_schema',
          details: {
            identities: [...identities],
            indexMarker: isIndex,
          },
        });
        continue;
      }
      if (identities.length === 0) {
        // palee_schema present but no identity field at all.
        issues.push({
          ruleId: 'valid-managed-note-kind',
          severity: 'warning',
          message: `Managed note ${note.relativePath} declares palee_schema but has no recognized identity field (palee_id, session_id, memory_id, or type: session_index); kind cannot be determined`,
          file: note.relativePath,
          field: 'palee_schema',
          details: { identities: [] },
        });
      }
    }

    return issues.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  },
};
