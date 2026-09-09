/**
 * no-duplicate-topic-id rule (#30)
 *
 * @remarks
 * Groups collected topics by `palee_id` and reports one error per ID that
 * appears in more than one note, with every file in the group. Output is
 * deterministic: issues sorted by topic ID, files sorted by path.
 */

import type { ValidationRule } from '../types';

/** Reports each topic ID that exists in more than one note. */
export const noDuplicateTopicIdRule: ValidationRule = {
  id: 'no-duplicate-topic-id',
  description: 'No two topic notes may share the same palee_id',
  severity: 'error',
  fixable: false,
  run(context) {
    const byId = new Map<string, string[]>();
    for (const topic of context.topics) {
      const files = byId.get(topic.palee_id);
      if (files) {
        files.push(topic.path);
      } else {
        byId.set(topic.palee_id, [topic.path]);
      }
    }

    const issues = [];
    for (const [topicId, files] of byId) {
      if (files.length > 1) {
        files.sort();
        issues.push({
          ruleId: 'no-duplicate-topic-id',
          severity: 'error' as const,
          message: `Duplicate topic ID: ${topicId} found in ${files.length} notes`,
          topicId,
          details: { files },
        });
      }
    }

    // Map iteration follows insertion order; sort by topic ID for
    // deterministic output across runs.
    issues.sort((a, b) => (a.topicId! < b.topicId! ? -1 : a.topicId! > b.topicId! ? 1 : 0));
    return issues;
  },
};
