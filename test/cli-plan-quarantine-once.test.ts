import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { findPrerequisiteBlocked } from '../src/application/get-next-topics';
import type { TopicNode } from '../src/types';

/**
 * `plan` used to quarantine the dependency graph twice: `findPrerequisiteBlocked`
 * enumerated cycles for the prerequisite gate, then the plan sections rebuilt
 * adjacency and ran Tarjan again over the same graph (#565 P2-08). Cycle
 * enumeration is the most expensive pass in the command — it can walk up to
 * 1000 enumerated cycles — and the two results were necessarily identical.
 *
 * The gate now accepts the acyclic subgraph its caller already computed. The
 * census below keeps plan at one call site; the behavioural case proves that an
 * injected subgraph is the one the gate evaluates rather than a recomputed one.
 * The mirror risk — the gate ignoring the parameter and quarantining anyway —
 * is exactly what the second test would stop noticing, so it asserts a
 * deliberately narrowed subgraph instead of the natural answer.
 */
describe('plan quarantines the dependency graph once per run (#565 P2-08)', () => {
  const planSource = fs.readFileSync(path.resolve(__dirname, '../src/cli/plan.ts'), 'utf8');
  // Comments routinely name these functions with their parentheses; count calls,
  // not prose.
  const planCode = planSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('plan runs the cycle enumeration exactly once', () => {
    const calls = planCode.match(/\bquarantineCyclicTopics\s*\(/g) ?? [];
    assert.strictEqual(calls.length, 1, `plan must call quarantineCyclicTopics once; found ${calls.length}`);
  });

  test('the prerequisite gate is handed the quarantine plan already computed', () => {
    // The pre-fix shape called the gate with two arguments and let it
    // quarantine the graph itself, so requiring a third `<local>.acyclic`
    // argument is what makes this fail on a revert. Deliberately blind to the
    // local's name and the array spelling so a rename is not a red test.
    assert.match(
      planCode,
      /findPrerequisiteBlocked\([\s\S]{0,200}?,[\s\S]{0,120}?,\s*[A-Za-z_$][\w$]*\.acyclic\s*\)/,
      'the prerequisite gate must receive the acyclic subgraph plan already computed'
    );
  });

  test('the gate evaluates the injected acyclic subgraph, not a fresh one', () => {
    const child: TopicNode = {
      palee_id: 'T-child',
      title: 'Child',
      path: 'child.md',
      topic_mastery: 0,
      depends_on: ['T-prereq'],
    };
    const prereq: TopicNode = {
      palee_id: 'T-prereq',
      title: 'Prereq',
      path: 'prereq.md',
      topic_mastery: 0,
      depends_on: [],
    };

    // Precondition: with the gate quarantining for itself, the unmastered
    // prerequisite blocks the child.
    const computed = findPrerequisiteBlocked([child, prereq], 0.5);
    assert.ok(computed.has('T-child'), 'precondition: the child is blocked when the gate computes the quarantine');

    // A subgraph that does not contain the child must decide the verdict: the
    // child drops out only if the caller's map is the one iterated.
    const provided = findPrerequisiteBlocked([child, prereq], 0.5, new Map([['T-prereq', prereq]]));
    assert.ok(
      !provided.has('T-child'),
      'the gate must evaluate the provided acyclic subgraph rather than recomputing one'
    );
  });
});
