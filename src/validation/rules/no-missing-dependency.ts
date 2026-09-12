/**
 * no-missing-dependency rule (#34 — vault-scan severity policy)
 *
 * @remarks
 * Ports the engine's missing-dependency finding into the rule
 * framework. The engine stays the single source of truth for graph
 * semantics: this rule maps `LoadedTopic`s into the engine's
 * `TopicNode` shape and reports exactly what the engine's
 * {@link findMissingDependencies} finds (without paying for the
 * cycle detection that `validateDependencyGraph` also runs).
 *
 * Severity (VERDICT decision 1, `planning/invariants.md`: "Missing
 * dependencies block a topic and produce a warning"): `warning` in
 * vault scans. The engine treats a missing prerequisite as having
 * 0.0 mastery, which gracefully quarantines the dependent topic from
 * `palee plan`/`next` without corrupting vault data — failing an
 * incremental vault scan with exit 3 because a note is being written
 * mid-flight would punish exactly the users validation exists to
 * protect. Roadmap pre-validation keeps its own separate error path
 * (`src/cli/roadmap.ts` rejects imports with missing targets before
 * mutating anything), so an import-time dangling reference is still
 * a hard stop — severity is scan-context policy, not a global
 * downgrade.
 *
 * Read-failure interaction: findings stay warning-severity and never
 * depend on unrelated vault state; when a read failure did occur, the
 * read-failure rule reports it alongside, so a spurious-looking
 * warning always comes with its explanation and a re-run settles it.
 */

import type { ValidationRule } from '../types';
import { findMissingDependencies } from '../../engine/dependency';
import type { TopicNode } from '../../types';

/** Reports dependencies that reference non-existent topic IDs. */
export const noMissingDependencyRule: ValidationRule = {
  id: 'no-missing-dependency',
  description: 'Every dependency reference must point to an existing topic ID',
  severity: 'warning',
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

    const errors = findMissingDependencies(topics);

    return errors
      .map((error) => ({
        ruleId: 'no-missing-dependency',
        severity: 'warning' as const,
        message: error.message ?? `Topic ${error.topic} depends on missing topic ${error.missing}`,
        topicId: error.topic,
        details: { missing: error.missing },
      }))
      // Engine reports in map insertion order; sort for determinism
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
