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

import type { ValidationRule, ValidationIssue } from '../types';
import { detectCyclesBounded } from '../../engine/dependency';
import type { TopicNode } from '../../types';

/**
 * Reports every dependency cycle in the topic graph as a distinct finding.
 *
 * @remarks
 * Uses the bounded enumeration (detectCyclesBounded, cap 1000) so dense-but-
 * valid graphs cannot stall validation. When enumeration is truncated, a
 * separate finding is emitted so callers cannot mistake the sample for
 * completeness.
 */
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
          // The engine reads a missing `depends_on` as "no prerequisites"
          // (`getTopicDependencies` falls back to `[]`), so normalize here.
          depends_on: topic.depends_on ?? [],
          topic_mastery: topic.topic_mastery,
        });
      }
    }

    const { cycles, truncated } = detectCyclesBounded(topics);
    const findings: ValidationIssue[] = cycles.map((cycle) => {
      // A reported cycle always leads with a node ID; the spread keeps the
      // type honest rather than asserting it, and an absent ID simply omits
      // the field (`ValidationIssue.topicId` is optional).
      const lead = cycle[0];
      return {
        ruleId: 'no-dependency-cycle',
        severity: 'error' as const,
        message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
        ...(lead === undefined ? {} : { topicId: lead }),
        details: { path: cycle },
      };
    });

    if (truncated) {
      // A reported cycle always leads with a node ID; the fallback chain
      // keeps the type honest rather than asserting it.
      const leadTopic = cycles[0]?.[0] ?? context.topics[0]?.palee_id ?? '';
      findings.push({
        ruleId: 'no-dependency-cycle',
        severity: 'error' as const,
        message: 'Dependency cycle enumeration truncated at 1000 cycles — additional cycles may exist',
        topicId: leadTopic,
        details: { truncated: true },
      });
    }

    return findings;
  },
};
