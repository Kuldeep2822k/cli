/**
 * no-session-unknown-topic rule (#42)
 *
 * @remarks
 * Reports session records whose `topic_id` references a topic that
 * does not exist in the vault. A session pointing at a missing topic
 * cannot be connected back to the learning graph — and the current
 * `session end` fallback has historically minted phantom `T-general`
 * sessions, which makes session memory less trustworthy.
 *
 * Severity is `warning` (issue #42: "can start as warning while
 * existing data may contain `T-general`"): the session is still a
 * valid historical record of studying SOMETHING; the missing link
 * is a data-quality gap, not corruption that blocks rebuilds.
 * `--strict` escalates it for CI use.
 *
 * `T-general` gets no exemption — the issue text says "T-general is
 * reported unless a real topic with that ID exists", which is
 * exactly the general rule applied to that ID; special-casing it
 * would hide the phantom-session bug the rule exists to surface.
 *
 * Scope guards (no double-reporting, no false positives):
 * - Sessions whose frontmatter failed to parse, lack `topic_id`, or
 *   fail the schema rule's shape checks are skipped — #41 owns those
 *   findings; judging a dangling reference against a garbage `topic_id`
 *   would be speculation.
 * - Drafts follow the same policy (issue: no explicit exemption).
 * - A vault with `readIncomplete` set may have lost the very topic
 *   note a session references — findings stay warnings either way,
 *   and the read-failure warning reports the provisional snapshot.
 */

import type { ValidationRule, ValidationIssue } from '../types';
import type { LoadedSession } from '../../storage/sessions';

/** True when the session's topic_id is shape-safe enough to judge. */
function isJudgable(session: LoadedSession): boolean {
  if (session.frontmatter === null) return false;
  const topicId = session.frontmatter.topic_id;
  return typeof topicId === 'string' && topicId.trim() !== '';
}

/**
 * Reports sessions referencing topic IDs that do not exist in the
 * vault.
 */
export const noSessionUnknownTopicRule: ValidationRule = {
  id: 'no-session-unknown-topic',
  description: 'Every session topic_id must reference an existing topic note',
  severity: 'warning',
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    const topicIds = new Set<string>(context.topics.map((topic) => topic.palee_id));

    for (const session of context.sessions) {
      if (!isJudgable(session)) continue; // #41 owns shape findings
      const topicId = (session.frontmatter?.topic_id as string).trim();

      if (topicIds.has(topicId)) continue;

      issues.push({
        ruleId: 'no-session-unknown-topic',
        severity: 'warning',
        message: `Session ${session.sessionId} references unknown topic ${topicId}`,
        file: session.path,
        sessionId: session.sessionId,
        topicId,
        details: { topicId },
      });
    }

    return issues;
  },
};
