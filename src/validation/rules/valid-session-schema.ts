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
 * - Timestamps: `started_at`/`ended_at` must be ISO 8601 strings
 *   with an explicit timezone designator (`Z` or `±HH:MM` — the
 *   writers emit `toISOString()`'s `Z` form; `writeSessionNote`
 *   persists caller-supplied strings and its tests use offset forms);
 *   date-only and timezone-less strings fail. For completed sessions
 *   `ended_at` must not precede `started_at` (compared as instants).
 *
 * The rule reads RAW frontmatter (no normalization — the rebuild
 * paths cast with `as string`, so any shape drift is silent at
 * runtime; validation is the only place it becomes visible).
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { SUPPORTED_SCHEMA_VERSION } from '../../engine/topic-id';
import { isRealCalendarDate } from './assessed-at';
import type { LoadedSession } from '../../storage/sessions';

/** Required fields every session note must carry. */
const REQUIRED_FIELDS = ['session_id', 'topic_id', 'started_at'] as const;

/** Allowed session statuses. */
const ALLOWED_STATUSES = ['completed', 'draft'] as const;

/** Renders a frontmatter value for diagnostics without JSON.stringify's non-finite quirk. */
function displayValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

/**
 * True when a session note carries no OTHER schema defect besides its
 * `topic_id` reference — the shape contract #41 enforces, evaluated
 * without the required-field loop so #42 can skip notes #41 already
 * reported (no double-reporting).
 *
 * @remarks A session failing any #41 check has an unreliable view of
 * its own topic reference; reporting a dangling topic on top of the
 * schema error would be noise. `topic_id` itself is checked by the
 * caller (a missing/blank/non-string topic_id is #41's finding too).
 */
export function isSessionSchemaClean(session: LoadedSession): boolean {
  if (session.readError !== undefined) return false; // read-failure rule's finding
  // Parse failures are #41's findings: check parseError explicitly, not
  // only frontmatter === null, so a future parse path that leaves
  // partial values alongside an error can never be schema-judged (Kilo).
  if (session.parseError !== undefined || session.frontmatter === null) return false;
  const fm: Record<string, unknown> = session.frontmatter;

  // palee_schema: integer 1 (the version check above).
  const schemaVersion = fm.palee_schema;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion !== SUPPORTED_SCHEMA_VERSION
  ) {
    return false;
  }

  // session_id: non-empty string matching the filename stem.
  const idValue = fm.session_id;
  if (typeof idValue !== 'string' || idValue.trim() === '' || idValue !== session.sessionId) {
    return false;
  }

  // status: a lifecycle value coherent with the filename convention.
  const status = fm.status;
  if (
    status !== 'completed' &&
    status !== 'draft'
  ) {
    return false;
  }
  if ((session.isDraft && status === 'completed') || (!session.isDraft && status === 'draft')) {
    return false;
  }

  // started_at: parseable ISO timestamp (presence is #41's).
  const started = fm.started_at;
  if (typeof started !== 'string' || !isCanonicalTimestamp(started)) return false;

  // ended_at: null for drafts, a parseable timestamp for completed.
  const ended = fm.ended_at;
  if (status === 'draft') {
    if (ended !== null) return false;
  } else {
    if (typeof ended !== 'string' || !isCanonicalTimestamp(ended)) return false;
    if (new Date(ended).getTime() < new Date(started).getTime()) return false;
  }

  return true;
}

/**
 * Strict ISO 8601 timestamp shape: `YYYY-MM-DDTHH:MM:SS(.sss)?(Z|±HH:MM)`.
 *
 * @remarks `new Date()` accepts far more than ISO 8601 — space
 * separators, human-readable strings, `GMT+…` forms — and silently
 * normalizes impossible calendar dates and hour 24 into valid instants
 * (Greptile P1 / CodeRabbit). The writers only ever produce strict
 * ISO (the `Z` form from `toISOString()`, or caller-supplied offset
 * forms persisted unchanged). The check therefore (a) pins the exact
 * syntactic shape, (b) validates the calendar date is real via the
 * shared `isRealCalendarDate` (same policy as the #39/#36 date rules),
 * and (c) requires an explicit timezone designator.
 */
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** True when the value is a strict ISO 8601 timestamp with a real calendar date. */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const match = ISO_TIMESTAMP_PATTERN.exec(value.trim());
  if (match === null) return false;
  // Impossible calendar dates (2026-02-30) and rolled-over times
  // (hour 24, minute 60) are normalized by Date — reject them with the
  // shared real-calendar validator and explicit range checks instead.
  const [year, month, day, hour, minute, second] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (!isRealCalendarDate(year, month, day)) return false;
  // Last guard: an out-of-range offset (+99:99) is syntactically two
  // digits but not a real instant — a final Date parse catches it
  // (everything else is already validated, so this cannot normalize a
  // rejected form into passing).
  return !Number.isNaN(new Date(value.trim()).getTime());
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

      // Read failures are the read-failure rule's findings — the note
      // was never read, so its frontmatter cannot be schema-judged.
      if (session.readError !== undefined) continue;

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

      // Schema version: the canonical writers emit `palee_schema: 1`
      // and the rebuild paths default missing versions silently —
      // validation is the only place a foreign/missing version on
      // canonical data becomes visible (#28 policy, session side).
      const schemaVersion = fm.palee_schema;
      if (schemaVersion === undefined || schemaVersion === null) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path} is missing palee_schema (expected ${SUPPORTED_SCHEMA_VERSION})`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'palee_schema',
          details: { actual: null },
        });
      } else if (
        typeof schemaVersion !== 'number' ||
        !Number.isInteger(schemaVersion)
      ) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Invalid palee_schema on ${session.path}: expected integer ${SUPPORTED_SCHEMA_VERSION}, got ${JSON.stringify(displayValue(schemaVersion))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'palee_schema',
          details: { actual: displayValue(schemaVersion) },
        });
      } else if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Unsupported palee_schema ${schemaVersion} on ${session.path} (supported: ${SUPPORTED_SCHEMA_VERSION})`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'palee_schema',
          details: { actual: schemaVersion },
        });
      }

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

      // topic_id must be a well-shaped non-empty string: #42 skips
      // sessions whose topic reference is malformed, so without this
      // check a null/empty/non-string topic_id would produce no
      // finding anywhere (CodeRabbit).
      const topicValue = fm.topic_id;
      if (topicValue !== undefined && !(typeof topicValue === 'string' && topicValue.trim() !== '')) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: topic_id must be a non-empty string, got ${JSON.stringify(displayValue(topicValue))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'topic_id',
          details: { actual: displayValue(topicValue) },
        });
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
      } else if (!isCanonicalTimestamp(ended)) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: ended_at must be an ISO 8601 timestamp with an explicit timezone (Z or ±HH:MM, e.g. 2026-09-12T10:00:00.000Z) or null, got ${JSON.stringify(displayValue(ended))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'ended_at',
          details: { actual: displayValue(ended) },
        });
      }

      // started_at shape (presence was checked above).
      const started = fm.started_at;
      if (started !== undefined && !isCanonicalTimestamp(started)) {
        issues.push({
          ruleId: 'valid-session-schema',
          severity: 'error',
          message: `Session note ${session.path}: started_at must be an ISO 8601 timestamp with an explicit timezone (Z or ±HH:MM, e.g. 2026-09-12T10:00:00.000Z), got ${JSON.stringify(displayValue(started))}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'started_at',
          details: { actual: displayValue(started) },
        });
      }

      // Chronology: only decidable when both timestamps are valid
      // (both are strict ISO at this point, so the Date comparison is
      // safe — the strict-shape check already rejected normalized forms).
      if (
        status === 'completed' &&
        isCanonicalTimestamp(started) &&
        isCanonicalTimestamp(ended) &&
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
