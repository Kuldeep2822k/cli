/**
 * Validation Rule Framework tests (#25)
 *
 * Contracts under test:
 * - `runRules(context, rules)` runs every rule in registration order and
 *   concatenates their issues deterministically.
 * - `ValidationIssue` carries `ruleId`, `severity`, and `message`; optional
 *   locator fields survive the round trip.
 * - Rules receive the exact `ValidationContext` the runner was given.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runRules } from '../src/validation/run-rules';
import type {
  ValidationContext,
  ValidationIssue,
  ValidationRule,
} from '../src/validation/types';

/** Builds a minimal empty-vault context for rule tests. */
function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    vaultPath: '/tmp/palee-vault',
    files: [],
    topics: [],
    notes: [],
    memoryReadErrors: [],
    readIncomplete: false,
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: { state: 'missing', frontmatter: null, body: '' },
    ...overrides,
  };
}

/** Rule stub that reports a fixed set of issues. */
function staticRule(
  id: string,
  issues: ValidationIssue[],
  severity: 'error' | 'warning' = 'error'
): ValidationRule {
  const rule: ValidationRule = {
    id,
    description: `test rule ${id}`,
    severity,
    run() {
      return issues;
    },
  };
  return rule;
}

describe('Validation framework: runRules (#25)', () => {
  test('concatenates issues from every rule in registration order', () => {
    const first = staticRule('rule-a', [
      { ruleId: 'rule-a', severity: 'error', message: 'a1' },
      { ruleId: 'rule-a', severity: 'error', message: 'a2' },
    ]);
    const second = staticRule('rule-b', [
      { ruleId: 'rule-b', severity: 'error', message: 'b1' },
    ]);

    const issues = runRules(makeContext(), [first, second]);

    assert.deepStrictEqual(
      issues.map((i) => i.message),
      ['a1', 'a2', 'b1']
    );
  });

  test('returns an empty array when no rule reports issues', () => {
    const rules = [staticRule('clean', [])];
    assert.deepStrictEqual(runRules(makeContext(), rules), []);
  });

  test('returns an empty array when the rule list is empty', () => {
    assert.deepStrictEqual(runRules(makeContext(), []), []);
  });

  test('preserves severity on reported issues', () => {
    const warn = staticRule(
      'warn-rule',
      [{ ruleId: 'warn-rule', severity: 'warning', message: 'heads up' }],
      'warning'
    );
    const err = staticRule(
      'err-rule',
      [{ ruleId: 'err-rule', severity: 'error', message: 'broken' }],
      'error'
    );

    const issues = runRules(makeContext(), [warn, err]);

    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[1].severity, 'error');
  });

  test('passes the same context object to every rule', () => {
    const context = makeContext({ vaultPath: '/vault/x' });
    const seen: string[] = [];
    const probe: ValidationRule = {
      id: 'probe',
      description: 'captures context',
      severity: 'warning',
      run(ctx) {
        seen.push(ctx.vaultPath);
        return [];
      },
    };

    runRules(context, [probe]);

    assert.deepStrictEqual(seen, ['/vault/x']);
  });

  test('issues keep optional locator fields (file, topicId, details)', () => {
    const rule = staticRule('locator-rule', [
      {
        ruleId: 'locator-rule',
        severity: 'error',
        message: 'topic problem',
        file: 'notes/git.md',
        topicId: 'T-git-rebase',
        details: { files: ['notes/git.md', 'notes/git-2.md'] },
      },
    ]);

    const issues = runRules(makeContext(), [rule]);

    assert.strictEqual(issues[0].file, 'notes/git.md');
    assert.strictEqual(issues[0].topicId, 'T-git-rebase');
    assert.deepStrictEqual(issues[0].details, { files: ['notes/git.md', 'notes/git-2.md'] });
  });

  describe('Exception safety (#171.10)', () => {
    test('catches Error thrown by a rule and converts it to a validation finding', () => {
      const crashingRule: ValidationRule = {
        id: 'no-dependency-cycle',
        description: 'Detects cycles',
        severity: 'error',
        run() {
          throw new Error('cycle detected in graph traversal');
        },
      };

      const issues = runRules(makeContext(), [crashingRule]);

      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].ruleId, 'no-dependency-cycle');
      assert.strictEqual(issues[0].severity, 'error');
      assert.strictEqual(
        issues[0].message,
        'Validation rule no-dependency-cycle threw an unexpected error: cycle detected in graph traversal'
      );
      assert.strictEqual(issues[0].file, '');
      assert.strictEqual(issues[0].topicId, '');
      assert.strictEqual(issues[0].field, 'rule-execution');
    });

    test('catches non-Error thrown by a rule and converts it to a validation finding', () => {
      const throwingRule: ValidationRule = {
        id: 'crashing-rule',
        description: 'Throws non-error',
        severity: 'error',
        run() {
          throw 'unexpected string crash';
        },
      };

      const issues = runRules(makeContext(), [throwingRule]);

      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].ruleId, 'crashing-rule');
      assert.strictEqual(issues[0].severity, 'error');
      assert.strictEqual(
        issues[0].message,
        'Validation rule crashing-rule threw an unexpected error: unexpected string crash'
      );
      assert.strictEqual(issues[0].file, '');
      assert.strictEqual(issues[0].topicId, '');
      assert.strictEqual(issues[0].field, 'rule-execution');
    });

    test('continues executing subsequent rules when an earlier rule throws', () => {
      const crashingRule: ValidationRule = {
        id: 'first-rule',
        description: 'Crashes',
        severity: 'error',
        run() {
          throw new Error('boom');
        },
      };
      const normalRule = staticRule('second-rule', [
        { ruleId: 'second-rule', severity: 'warning', message: 'all good' },
      ]);

      const issues = runRules(makeContext(), [crashingRule, normalRule]);

      assert.strictEqual(issues.length, 2);
      assert.strictEqual(issues[0].ruleId, 'first-rule');
      assert.strictEqual(issues[0].severity, 'error');
      assert.strictEqual(issues[0].field, 'rule-execution');
      assert.strictEqual(issues[1].ruleId, 'second-rule');
      assert.strictEqual(issues[1].message, 'all good');
    });
  });
});
