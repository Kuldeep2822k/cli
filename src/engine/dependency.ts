/**
 * Dependency Graph Engine
 * Validates topic dependencies, detects cycles, computes learning order
 */

import { TopicNode, ValidationError, ValidationResult } from '../types';



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

    const deps = topic.depends_on || [];
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

function areDependenciesSatisfied(topic: TopicNode, topics: Map<string, TopicNode>, threshold: number = 0.7): boolean {
  const deps = topic.depends_on || [];

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

function getReadyTopics(topics: Map<string, TopicNode>, threshold: number = 0.7): TopicNode[] {
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

function validateDependencyGraph(topics: Map<string, TopicNode>): ValidationResult {
  const errors: ValidationError[] = [];

  // Check for missing dependencies
  for (const [id, topic] of topics) {
    const deps = topic.depends_on || [];
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
      message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export {
  detectCycle,
  getReadyTopics,
  validateDependencyGraph,
};
