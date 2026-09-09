/**
 * no-missing-dependency rule (#34 prerequisite — behavior-preserving port)
 *
 * @remarks
 * Ports the engine's missing-dependency finding into the rule framework.
 * The engine stays the single source of truth for graph semantics: this
 * rule maps `LoadedTopic`s into the engine's `TopicNode` shape and reports
 * exactly what `validateDependencyGraph` would find. Severity stays
 * `error` for now (matching the current CLI contract); the warning policy
 * from the framework verdict lands with #34.
 */

import { ValidationRule } from '../types';
import { validateDependencyGraph } from '../../engine/dependency';
import type { TopicNode } from '../../types';

/** Reports dependencies that reference non-existent topic IDs. */
export const noMissingDependencyRule: ValidationRule = {
  id: 'no-missing-dependency',
  description: 'Every dependency reference must point to an existing topic ID',
  severity: 'error',
  fixable: false,
  run(context) {
    const topics = new Map<string, TopicNode>();
    for (const topic of context.topics) {
      // Duplicates already have their own rule; the first occurrence wins
      // here, mirroring the original CLI's topics-map construction exactly.
      if (!topics.has(topic.palee_id)) {
        topics.set(topic.palee_id, {
          palee_id: topic.palee_id,
          depends_on: topic.depends_on,
          topic_mastery: topic.topic_mastery,
        });
      }
    }

    const { errors } = validateDependencyGraph(topics);

    return errors
      .filter((error) => error.type === 'missing_dependency')
      .map((error) => ({
        ruleId: 'no-missing-dependency',
        severity: 'error' as const,
        message: error.message ?? `Topic ${error.topic} depends on missing topic ${error.missing}`,
        topicId: error.topic,
        details: { missing: error.missing },
      }))
      // The engine reports in map insertion order; sort for determinism
      // independent of how the context was assembled.
      .sort((a, b) => {
        const byTopic = a.topicId! < b.topicId! ? -1 : a.topicId! > b.topicId! ? 1 : 0;
        if (byTopic !== 0) return byTopic;
        const am = a.details?.missing as string;
        const bm = b.details?.missing as string;
        return am < bm ? -1 : am > bm ? 1 : 0;
      });
  },
};
