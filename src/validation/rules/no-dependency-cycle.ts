/**
 * no-dependency-cycle rule (#35 prerequisite — behavior-preserving port)
 *
 * @remarks
 * Reports every distinct dependency cycle in the topic graph, one finding
 * per cycle, with its exact canonicalized path — matching the engine's
 * `detectCycles` enumeration rather than `detectCycle`'s first-only search.
 * Issue #171 finding 3 requires exhaustive cycle reporting: a graph with
 * two disjoint loops must surface both, not just the lex-first one.
 */

import type { ValidationRule } from '../types';
import { detectCycles } from '../../engine/dependency';
import type { TopicNode } from '../../types';

/** Reports every dependency cycle in the topic graph as a distinct finding. */
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

    const cycles = detectCycles(topics);
    return cycles.map((cycle) => ({
      ruleId: 'no-dependency-cycle',
      severity: 'error' as const,
      message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
      topicId: cycle[0],
      details: { path: cycle },
    }));
  },
};
