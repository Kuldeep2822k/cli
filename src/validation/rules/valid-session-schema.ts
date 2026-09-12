/**
 * valid-session-schema rule (#41)
 *
 * @remarks
 * Validates the canonical session notes under `.palee/sessions/` —
 * the durable source of learning history. If their frontmatter is
 * malformed, `hot.md` and `index.md` cannot be rebuilt reliably, so
 * shape defects are `error` severity.
 *
 * Contract (what `writeSessionNote` / `writeDraftCheckpoint`
 * persist, `BaseSessionRecord`/`CompletedSessionRecord`/
 * `DraftSessionRecord` in `src/types.ts`):
 * - Parseable frontmatter (YAML failure = one error, the note is
 *   never silently skipped).
 * - Required fields: `palee_schema: 1`, `session_id`, `topic_id`,
 *   `started_at`; completed sessions add `ended_at` + `status:
 *   'completed'`, drafts carry `status: 'draft'` + `ended_at: null`.
 * - `session_id` must match the filename stem (`S-…`/`DRAFT-S-…`) —
 *   the rebuild paths key on the filename, so a mismatched ID
 *   breaks draft recovery and index regeneration.
 * - Draft/filename coherence: a `S-*.md` file whose frontmatter
 *   says `draft` (or vice versa) is reported — the two naming
 *   conventions drive different lifecycle behavior.
 * - Timestamps: `started_at`/`ended_at` must be parseable ISO
 *   timestamps (the writers emit `toISOString()` output); for
 *   completed sessions `ended_at` must not precede `started_at`.
 *
 * The rule reads RAW frontmatter (no normalization — the rebuild
 * paths cast with `as string`, so any shape drift is silent at
 * runtime; validation is the only place it becomes visible).
 */

import type { ValidationRule, ValidationIssue } from '../types';

/** Required fields every session note must carry. */
const REQUIRED_FIELDS = ['session_id', 'topic_id', 'started_at'] as const;

/** Allowed session statuses. */
const ALLOWED_STATUSES = ['completed', 'draft'] as const;

/** Renders a frontmatter value for diagnostics without JSON.stringify's non-finite quirk. */
function displayValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

/** True when the value is a parseable ISO-family timestamp string. */
function isParseableTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Reports session notes whose frontmatter violates the canonical
 * session schema.
 */
export const validSessionSchemaRule: ValidationRule = {
  id: 'valid-session-schema',
  description:
    'Session notes must carry the canonical schema: required fields, completed/draft status, matching session_id, ordered ISO timestamps',
  severity: 'error',
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const session of context.sessions) {
      // Deterministic per-note report order: parse, required fields,
      // session_id match, status, timestamps.

      if (session.frontmatter === null) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path} has malformed frontmatter${session.parseError !== undefined ? `: ${session.parseError}` : ''}`,
          file: session.path,
          sessionId: session.sessionId,
          details: { actual: session.parseError ?? null },
        });
        continue;
      }
      const fm = session.frontmatter;

      for (const field of REQUIRED_FIELDS) {
        if (!Object.hasOwn(fm, field) || fm[field] === undefined) {
          issues.push({
            ruleId: 'valid-session-schema',
            severity: 'error',
            message: `Session note ${session.path} is missing required field ${field}`,
            file: session.path,
            sessionId: session.sessionId,
            field,
            details: { actual: undefined },
          });
        }
      }

      // session_id must exist as a string and match the filename stem.
      const idValue = fm.session_id;
      if (idValue !== undefined) {
        if (typeof idValue !== 'string' || idValue.trim() === '') {
          issues.push({
            ruleId: 'valid-session-schema',
            severity: 'error',
            message: `Session note ${session.path}: session_id must be a non-empty string, got ${JSON.stringify(displayValue(idValue))}`,
            file: session.path,
            sessionId: session.sessionId,
            field: 'session_id',
            details: { actual: displayValue(idValue) },
          });
        } else if (idValue !== session.sessionId) {
          issues.push({
            ruleId: 'valid-session-schema',
            severity: 'error',
            message: `Session note ${session.path}: session_id ${JSON.stringify(idValue)} does not match the filename stem ${JSON.stringify(session.sessionId)}`,
            file: session.path,
            sessionId: session.sessionId,
            field: 'session_id',
            details: { actual: idValue, expected: session.sessionId },
          });
        }
      }

      // Status: one of the two lifecycle values, coherent with the
      // filename's draft/confirmed convention.
      const status = fm.status;
      if (status !== 'completed' && status !== 'draft') {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: status must be one of ${ALLOWED_STATUSES.join(', ')}, got ${JSON.stringify(displayValue(status))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'status',
          details: { actual: displayValue(status), allowed: [...ALLOWED_STATUSES] },
        });
      } else if (
        (session.isDraft && status === 'completed') ||
        (!session.isDraft && status === 'draft')
      ) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: status ${JSON.stringify(status)} conflicts with the ${session.isDraft ? 'DRAFT-' : 'S-'}filename convention`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'status',
          details: { actual: status, filenameIsDraft: session.isDraft },
        });
      }

      // ended_at: null for drafts, a parseable ISO timestamp for
      // completed sessions.
      const ended = fm.ended_at;
      if (ended === undefined) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path} is missing required field ended_at (null for drafts, an ISO timestamp for completed sessions)`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'ended_at',
          details: { actual: undefined },
        });
      } else if (ended === null) {
        if (status !== 'draft') {
          issues.push({
            ruleId: 'valid-session-schema',
            severity: 'error',
            message: `Session note ${session.path}: ended_at must be an ISO timestamp for completed sessions, got null`,
            file: session.path,
            sessionId: session.sessionId,
            field: 'ended_at',
            details: { actual: null },
          });
        }
      } else if (status === 'draft') {
        // The typed contract pins drafts to ended_at: null — a draft
        // carrying an end timestamp is not a state any writer emits,
        // and recovery treats drafts as open-ended.
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: ended_at must be null for draft sessions, got ${JSON.stringify(displayValue(ended))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'ended_at',
          details: { actual: displayValue(ended) },
        });
      } else if (!isParseableTimestamp(ended)) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: ended_at must be a parseable ISO timestamp or null, got ${JSON.stringify(displayValue(ended))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'ended_at',
          details: { actual: displayValue(ended) },
        });
      }

      // started_at shape (presence was checked above).
      const started = fm.started_at;
      if (started !== undefined && !isParseableTimestamp(started)) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: started_at must be a parseable ISO timestamp, got ${JSON.stringify(displayValue(started))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'started_at',
          details: { actual: displayValue(started) },
        });
      }

      // Chronology: only decidable when both timestamps are valid.
      if (
        status === 'completed' &&
        isParseableTimestamp(started) &&
        isParseableTimestamp(ended) &&
        new Date(ended).getTime() < new Date(started).getTime()
      ) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: ended_at (${String(ended)}) precedes started_at (${String(started)})`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'ended_at',
          details: { started_at: started, ended_at: ended },
        });
      }
    }

    return issues;
  },
};
