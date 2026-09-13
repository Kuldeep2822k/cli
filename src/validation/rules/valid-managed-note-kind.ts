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
 * Scope: the WALKED note set (vault root, excluding dot-directories —
 * the same set `valid-palee-schema` sees) gets the full classification
 * (no identity, or conflicting kinds, both warn). `.palee/` internal
 * notes never reach the walker, so this rule also classifies them from
 * the collected `sessions`/`sessionIndex`/`hotMemory` snapshot: their
 * kind is fixed by location, so only CROSS-KIND identity conflicts are
 * findings there (a session note also carrying `palee_id`, hot.md
 * carrying `session_id`, the index carrying any identity key) —
 * kind-specific field/shape defects stay with the memory rules
 * (`valid-session-schema` owns session shape; the schema-version
 * policy is `valid-palee-schema`'s pattern, session-side). Severity is
 * `warning` (issue #27: never a fatal command error — the note is
 * still versioned data; a human decides its kind).
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

    // Internal notes (`.palee/…`) never reach the walker, so the kind
    // rule classifies them from the collected memory snapshot. Their
    // KIND is fixed by location — the ambiguity #27 reports there is
    // a note claiming SEVERAL kinds at once (e.g. a session note also
    // carrying `palee_id`, or the index also carrying `session_id`),
    // which no kind-specific rule could be trusted to apply. Missing
    // identity/shape defects stay with the memory rules (#41 owns
    // session shape; #28-style version policy is the schema rules').
    const internal: Array<{
      fm: Record<string, unknown>;
      path: string;
      indexMarker: boolean;
    }> = [];
    for (const session of context.sessions) {
      if (session.readError !== undefined || session.frontmatter === null) continue;
      internal.push({
        fm: session.frontmatter,
        path: session.path,
        indexMarker: session.frontmatter.type === INDEX_TYPE,
      });
    }
    if (context.sessionIndex.state === 'ok' && context.sessionIndex.frontmatter) {
      const indexFm = context.sessionIndex.frontmatter;
      internal.push({
        fm: indexFm,
        path: '.palee/index.md',
        indexMarker: indexFm.type === INDEX_TYPE,
      });
    }
    if (context.hotMemory.state === 'ok' && context.hotMemory.frontmatter) {
      // Type-safe access: `ok` state guarantees frontmatter is non-null
      // (the guard above narrows it), and HotMemoryData's fields are a
      // subset of Record<string, unknown> — read `type` without a cast.
      const hotFm: Record<string, unknown> = { ...context.hotMemory.frontmatter };
      internal.push({
        fm: hotFm,
        path: '.palee/hot.md',
        indexMarker: hotFm.type === INDEX_TYPE,
      });
    }
    for (const note of internal) {
      // The note's location implies exactly one kind: a session note is
      // a session, hot.md is hot memory, the index is the index. The
      // expected key for that kind MERGES with the location (a session
      // note carrying only `session_id` is canonical); every OTHER
      // identity key, or the index marker on a non-index note, is a
      // cross-kind claim that conflicts with the location.
      const isIndex = note.path === '.palee/index.md';
      const expectedKey = isIndex ? null : note.path === '.palee/hot.md' ? 'memory_id' : 'session_id';
      const foreign = IDENTITY_KEYS.filter(
        (key) => Object.hasOwn(note.fm, key) && key !== expectedKey
      );
      if (isIndex) {
        // Index: the marker IS its identity; ANY identity key conflicts.
        if (foreign.length > 0) {
          issues.push({
            ruleId: 'valid-managed-note-kind',
            severity: 'warning',
            message: `Managed note ${note.path} declares conflicting identities (${[...foreign, 'type: session_index'].join(', ')}); kind cannot be determined`,
            file: note.path,
            field: 'palee_schema',
            details: { identities: [...foreign], indexMarker: true },
          });
        }
        continue;
      }
      if (foreign.length > 0 || note.indexMarker) {
        const claims: string[] = [...foreign];
        if (note.indexMarker) claims.push('type: session_index');
        issues.push({
          ruleId: 'valid-managed-note-kind',
          severity: 'warning',
          message: `Managed note ${note.path} declares conflicting identities (${claims.join(', ')}); kind cannot be determined`,
          file: note.path,
          field: 'palee_schema',
          details: {
            identities: [...foreign],
            indexMarker: note.indexMarker,
          },
        });
      }
    }

    return issues.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  },
};
