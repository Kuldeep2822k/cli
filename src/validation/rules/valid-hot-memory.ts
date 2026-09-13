/**
 * valid-hot-memory rule (#43)
 *
 * @remarks
 * Validates `.palee/hot.md` as a rebuildable derived view of the
 * learning context — the note that orients `session start` when the
 * user resumes. The canonical session notes and topic notes are the
 * source of truth; hot memory is a projection, so findings are
 * `warning` and never gate the exit code (VERDICT decision 4 — the
 * same derived-view policy as `valid-session-index` #44). A rebuild
 * (`rebuildHotAndIndex`) restores correctness from canonical data.
 *
 * Findings (all `warning`):
 * - `schema-invalid` read state: the frontmatter parsed but does not
 *   carry a supported `palee_schema` version — the view cannot be
 *   interpreted. (One warning; tolerant fields are NOT re-validated —
 *   a version we cannot interpret has no contract to check against.)
 * - Broken references: `last_session` naming a session that does not
 *   exist, or `active_topic` naming a topic that does not exist. The
 *   resumed context would point at vanished data.
 * - Body over the 250-word cap (`MAX_HOT_WORDS`): the writer
 *   truncates to the cap, so an over-cap body means hand-edited or
 *   drifted content. Counted with the same whitespace-delimited
 *   `countWords` the writer's truncation uses, excluding frontmatter.
 *
 * Never reports:
 * - `missing` hot memory (fresh vault, or not yet rebuilt).
 * - `no-frontmatter` / `corrupt` states: these are unreadable-as-data
 *   and owned by the read/parse surface — a rebuildable projection
 *   with unparsable content is rebuilt, not diagnosed field-by-field.
 * - `readIncomplete` vaults: the referenced session/topic may be the
 *   very note that failed to read, so reference findings would be
 *   speculation. The word-cap and version checks still run (they are
 *   local to the file).
 */

import type { ValidationRule, ValidationIssue } from '../types';
import { MAX_HOT_WORDS, countWords } from '../../storage/memory';

/** Fixed identifier the hot-memory writer stamps (`H-active`). */
const MEMORY_ID = 'H-active';

/**
 * Reports hot-memory state that would misorient `session start`.
 */
export const validHotMemoryRule: ValidationRule = {
  id: 'valid-hot-memory',
  description:
    'Hot memory must carry its identity and a body within the word cap; its session/topic references must point at existing notes',
  severity: 'warning',
  fixable: 'safe', // fully rebuildable from canonical session notes
  run(context): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const hot = context.hotMemory;

    if (hot.state === 'missing') return issues;

    if (hot.state === 'schema-invalid') {
      issues.push({
        ruleId: 'valid-hot-memory',
        severity: 'warning',
        message: `.palee/hot.md carries an unsupported palee_schema version (${String(
          hot.frontmatter?.palee_schema
        )}); it is a rebuildable derived view — run a session end or rebuild to regenerate it`,
        file: '.palee/hot.md',
        field: 'palee_schema',
        details: { actual: hot.frontmatter?.palee_schema ?? null },
      });
      return issues;
    }

    if (hot.state !== 'ok' || !hot.frontmatter) return issues;

    const fm: Record<string, unknown> = { ...hot.frontmatter };

    // Identity: the writer stamps memory_id: H-active. A missing or
    // foreign memory_id means this is not the derived view PALEE
    // wrote — report the identity gap (the note claims to be hot
    // memory by location).
    const memoryId = fm.memory_id;
    if (memoryId !== MEMORY_ID) {
      issues.push({
        ruleId: 'valid-hot-memory',
        severity: 'warning',
        message: `.palee/hot.md must carry memory_id ${JSON.stringify(MEMORY_ID)}, got ${JSON.stringify(memoryId ?? null)}`,
        file: '.palee/hot.md',
        field: 'memory_id',
        details: { actual: memoryId ?? null, expected: MEMORY_ID },
      });
    }

    // Word cap: the writer truncates at MAX_HOT_WORDS, so an over-cap
    // body is hand-edited or drifted. Same whitespace-delimited count
    // the writer's truncation uses; frontmatter is excluded (readHotMemory
    // returns only the body).
    const wordCount = countWords(hot.body);
    if (wordCount > MAX_HOT_WORDS) {
      issues.push({
        ruleId: 'valid-hot-memory',
        severity: 'warning',
        message: `.palee/hot.md body exceeds the ${MAX_HOT_WORDS}-word cap (${wordCount} words); the writer truncates to the cap — rebuild to restore the derived view`,
        file: '.palee/hot.md',
        field: 'body',
        details: { wordCount, maxWords: MAX_HOT_WORDS },
      });
    }

    // Reference checks: only decidable on a complete snapshot — the
    // referenced session/topic note may be exactly the one that failed
    // to read (a provisional-scan warning would be speculation).
    if (context.readIncomplete) return issues;

    const sessionIds = new Set(context.sessions.map((s) => s.sessionId));
    const topicIds = new Set(context.topics.map((t) => t.palee_id));

    const lastSession = fm.last_session;
    if (typeof lastSession === 'string' && lastSession.trim() !== '' && !sessionIds.has(lastSession)) {
      issues.push({
        ruleId: 'valid-hot-memory',
        severity: 'warning',
        message: `Hot memory references unknown session ${lastSession} (no session note exists; hot.md is rebuildable from canonical sessions)`,
        file: '.palee/hot.md',
        field: 'last_session',
        details: { missingSession: lastSession },
      });
    }

    const activeTopic = fm.active_topic;
    if (typeof activeTopic === 'string' && activeTopic.trim() !== '' && !topicIds.has(activeTopic)) {
      issues.push({
        ruleId: 'valid-hot-memory',
        severity: 'warning',
        message: `Hot memory references unknown topic ${activeTopic} (no topic note exists; hot.md is rebuildable from canonical sessions)`,
        file: '.palee/hot.md',
        field: 'active_topic',
        details: { missingTopic: activeTopic },
      });
    }

    return issues;
  },
};
