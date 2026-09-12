/**
 * valid-session-index rule (#44)
 *
 * @remarks
 * Validates `.palee/index.md` as a rebuildable derived view of the
 * canonical sessions. The index helps navigation, but the session
 * notes under `.palee/sessions/` remain the source of truth
 * (VERDICT decision 4: derived-view problems are ALWAYS `warning`,
 * never `error` — `session end` self-heals the index via
 * `regenerateIndex`, and a corrupt or stale projection must never
 * gate validation).
 *
 * Findings (all `warning`):
 * - `corrupt` index (frontmatter failed to parse): the index cannot
 *   be interpreted — but the canonical sessions are untouched, and a
 *   rebuild restores it.
 * - A `[[S-…]]` wikilink referencing a session that does not exist
 *   as a confirmed session note: a stale or broken index entry. Only
 *   refs to missing CONFIRMED sessions are findings — links to
 *   DRAFT-… files are never emitted by `regenerateIndex` (drafts are
 *   excluded there), so a draft-shaped link is reported as unknown
 *   rather than silently blessed.
 * - An index that references zero sessions while confirmed sessions
 *   exist is NOT reported: an empty index is a legal state
 *   ("No confirmed sessions recorded.") and staleness-by-omission
 *   cannot be distinguished from a legitimately empty vault without
 *   ordering heuristics the issue text explicitly defers ("staleness
 *   detection is deterministic once the index format is finalized").
 *   Missing refs (the per-entry check above) are the deterministic
 *   half; completeness is deferred with it.
 *
 * A missing index never fails validation (fresh vaults have none).
 */

import type { ValidationRule, ValidationIssue } from '../types';

/**
 * Reports stale or broken derived session-index state without ever
 * gating the exit code.
 */
export const validSessionIndexRule: ValidationRule = {
  id: 'valid-session-index',
  description:
    'The session index must be parseable and its session references must point at existing confirmed sessions',
  severity: 'warning',
  fixable: 'safe', // the index is fully rebuildable from canonical sessions
  run(context) {
    const issues: ValidationIssue[] = [];
    const index = context.sessionIndex;

    if (index.state === 'missing') return issues;

    if (index.state === 'corrupt') {
      issues.push({
        ruleId: 'valid-session-index',
        severity: 'warning',
        message: `.palee/index.md has malformed frontmatter (${index.parseError}); it is a rebuildable derived view — run a session end or rebuild to regenerate it`,
        file: '.palee/index.md',
        details: { parseError: index.parseError },
      });
      return issues;
    }

    // Only confirmed session notes are index candidates.
    const confirmed = new Set(
      context.sessions.filter((s) => !s.isDraft).map((s) => s.sessionId)
    );

    for (const ref of index.refs) {
      if (confirmed.has(ref)) continue;
      issues.push({
        ruleId: 'valid-session-index',
        severity: 'warning',
        message: `Session index references unknown session ${ref} (no confirmed session note exists; the index is stale — rebuildable from canonical sessions)`,
        file: '.palee/index.md',
        details: { missingSession: ref },
      });
    }

    return issues;
  },
};
