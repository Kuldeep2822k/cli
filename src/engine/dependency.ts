/**
 * Dependency Graph Engine
 *
 * @remarks
 * Analyzes topic prerequisite dependency graphs, executes depth-first cycle detection,
 * verifies prerequisite satisfaction thresholds, and determines which topics are ready for study.
 */

import { TopicNode, ValidationError, ValidationResult } from '../types';
import { MASTERY_THRESHOLD } from './mastery';

/**
 * Normalizes and extracts prerequisite dependency IDs from a topic node,
 * transparently supporting both `depends_on` and `dependencies` aliases.
 *
 * @param topic - Topic node
 * @returns Array of unique prerequisite topic ID strings
 */
function getTopicDependencies(
  topic?: Partial<TopicNode> | { depends_on?: unknown; dependencies?: unknown } | null
): string[] {
  if (!topic) return [];
  const rawDependsOn = topic.depends_on;
  const rawDependencies = (topic as { dependencies?: unknown }).dependencies;

  const extract = (val: unknown): string[] => {
    if (Array.isArray(val)) {
      return val.map((d) => String(d).trim()).filter(Boolean);
    }
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.split(',').map((d) => d.trim()).filter(Boolean);
    }
    return [];
  };

  const combined = [...extract(rawDependsOn), ...extract(rawDependencies)];
  return Array.from(new Set(combined));
}

/**
 * Detects cyclic dependencies within the topic graph using depth-first search (DFS) with a 3-color visiting state.
 *
 * @remarks
 * Recursively explores prerequisites. If an active ancestor node on the current path stack
 * is re-encountered, a cycle path is constructed and returned.
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns Array of topic IDs representing the cycle loop (e.g. `['A', 'B', 'C', 'A']`), or `null` if acyclic
 *
 * @example
 * ```typescript
 * const cycle = detectCycle(topicMap);
 * if (cycle) {
 *   console.error(`Dependency cycle: ${cycle.join(' -> ')}`);
 * }
 * ```
 */
function detectCycle(topics: Map<string, TopicNode>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const pathStack: string[] = [];

  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      // Found cycle - return path from cycle start
      const cycleStart = pathStack.indexOf(id);
      return pathStack.slice(cycleStart).concat(id);
    }
    if (visited.has(id)) return null;

    const topic = topics.get(id);
    if (!topic) return null;

    visiting.add(id);
    pathStack.push(id);

    const deps = getTopicDependencies(topic);
    for (const depId of deps) {
      const cycle = visit(depId);
      if (cycle) return cycle;
    }

    pathStack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of topics.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }

  return null;
}

/**
 * Checks whether all prerequisite dependencies for a given topic exist and meet or exceed the mastery threshold.
 *
 * @param topic - The topic node whose dependencies are being evaluated
 * @param topics - Map of all known topic nodes in the vault
 * @param threshold - Minimum mastery score required (default: {@link MASTERY_THRESHOLD} = 0.70)
 * @returns `true` if all prerequisite dependencies exist and have `topic_mastery >= threshold`, otherwise `false`
 */
function areDependenciesSatisfied(
  topic: TopicNode,
  topics: Map<string, TopicNode>,
  threshold: number = MASTERY_THRESHOLD
): boolean {
  const deps = getTopicDependencies(topic);

  for (const depId of deps) {
    const depTopic = topics.get(depId);
    if (!depTopic) {
      return false; // Missing dependency
    }

    const mastery = depTopic.topic_mastery || 0;
    if (mastery < threshold) {
      return false; // Dependency not mastered
    }
  }

  return true;
}

/**
 * Identifies unmastered topics whose prerequisite dependencies are fully satisfied and ready for study.
 *
 * @remarks
 * Filters topics where:
 * 1. `topic_mastery < threshold` (not yet mastered)
 * 2. Every prerequisite dependency has `topic_mastery >= threshold`
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @param threshold - Mastery threshold score (default: {@link MASTERY_THRESHOLD} = 0.70)
 * @returns Array of {@link TopicNode} objects ready for immediate learning
 *
 * @example
 * ```typescript
 * const ready = getReadyTopics(topicMap);
 * console.log(`Ready to study: ${ready.map(t => t.title).join(', ')}`);
 * ```
 */
function getReadyTopics(
  topics: Map<string, TopicNode>,
  threshold: number = MASTERY_THRESHOLD
): TopicNode[] {
  const ready: TopicNode[] = [];

  for (const [, topic] of topics) {
    const mastery = topic.topic_mastery || 0;

    // Skip if already mastered
    if (mastery >= threshold) continue;

    // Check dependencies
    if (areDependenciesSatisfied(topic, topics, threshold)) {
      ready.push(topic);
    }
  }

  return ready;
}

/**
 * Validates the topological integrity of the complete dependency graph.
 *
 * @remarks
 * Performs two verification checks:
 * 1. Missing dependencies: Ensures all referenced prerequisite IDs (supporting both `depends_on` and `dependencies` aliases) exist in the vault.
 * 2. Cycles: Runs {@link detectCycle} to ensure the dependency graph is a Directed Acyclic Graph (DAG).
 *
 * @param topics - Map of topic ID to {@link TopicNode}
 * @returns {@link ValidationResult} containing boolean status and any detected {@link ValidationError} items
 *
 * @example
 * ```typescript
 * const result = validateDependencyGraph(topicMap);
 * if (!result.valid) {
 *   console.error('Validation errors found:', result.errors);
 * }
 * ```
 */
function validateDependencyGraph(topics: Map<string, TopicNode>): ValidationResult {
  const errors: ValidationError[] = [];

  // Check for missing dependencies
  for (const [id, topic] of topics) {
    const deps = getTopicDependencies(topic);
    for (const depId of deps) {
      if (!topics.has(depId)) {
        errors.push({
          type: 'missing_dependency',
          topic: id,
          missing: depId,
          message: `Topic ${id} depends on missing topic ${depId}`,
        });
      }
    }
  }

  // Check for cycles
  const cycle = detectCycle(topics);
  if (cycle) {
    errors.push({
      type: 'cycle',
      path: cycle,
      message: `Circular dependency detected: ${cycle.join(' -> ')}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export {
  detectCycle,
  areDependenciesSatisfied,
  getReadyTopics,
  validateDependencyGraph,
  getTopicDependencies,
};
