/**
 * no-dependency-cycle rule (#35 prerequisite — behavior-preserving port)
 *
 * @remarks
 * Ports the engine's cycle finding into the rule framework. `detectCycle`
 * stays the single source of truth for cycle semantics: this rule feeds it
 * the collected topics and reports the exact repeated-start path it returns.
 */

import { ValidationRule } from '../types';
import { detectCycle } from '../../engine/dependency';
import type { TopicNode } from '../../types';

/** Reports the first dependency cycle found in the topic graph. */
export const noDependencyCycleRule: ValidationRule = {
  id: 'no-dependency-cycle',
  description: 'Dependency graph must not contain cycles',
  severity: 'error',
  fixable: false,
  run(context) {
    const topics = new Map<string, TopicNode>();
    for (const topic of context.topics) {
      if (!topics.has(topic.palee_id)) {
        topics.set(topic.palee_id, {
          palee_id: topic.palee_id,
          depends_on: topic.depends_on,
          topic_mastery: topic.topic_mastery,
        });
      }
    }

    const cycle = detectCycle(topics);
    if (!cycle) {
      return [];
    }

    return [
      {
        ruleId: 'no-dependency-cycle',
        severity: 'error' as const,
        message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
        topicId: cycle[0],
        details: { path: cycle },
      },
    ];
  },
};
