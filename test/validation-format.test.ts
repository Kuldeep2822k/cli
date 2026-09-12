/**
 * Validation formatters tests (#25)
 *
 * Contracts under test:
 * - Human formatter groups issues by severity then rule ID, in the
 *   repo's output style (bullets, no colors, ✗/✓/⚠ symbols).
 * - JSON formatter preserves the documented contract keys (`valid`,
 *   `topic_count`, `file_count`, `error_count`, `errors[]`) and adds
 *   warnings additively.
 * - Formatters are pure: no console output, just string/JSON results.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { formatHuman } from '../src/validation/format';
import { formatJson } from '../src/validation/format';
import type { ValidationIssue } from '../src/validation/types';

const ERROR_ISSUE: ValidationIssue = {
  ruleId: 'no-duplicate-topic-id',
  severity: 'error',
  message: 'Duplicate topic ID: T-dup found in 2 notes',
  topicId: 'T-dup',
  details: { files: ['a.md', 'b.md'] },
};

const WARNING_ISSUE: ValidationIssue = {
  ruleId: 'parse-frontmatter',
  severity: 'warning',
  message: 'Malformed frontmatter in broken.md: bad yaml',
  file: 'broken.md',
  details: { parserMessage: 'bad yaml' },
};

const CYCLE_ISSUE: ValidationIssue = {
  ruleId: 'no-dependency-cycle',
  severity: 'error',
  message: 'Dependency cycle detected: T-a -> T-b -> T-a',
  topicId: 'T-a',
  details: { path: ['T-a', 'T-b', 'T-a'] },
};

const MISSING_DEP_ISSUE: ValidationIssue = {
  ruleId: 'no-missing-dependency',
  // Vault-scan severity policy (#34 / VERDICT decision 1): missing
  // dependencies warn; roadmap pre-validation keeps its own error path.
  severity: 'warning',
  message: 'Topic T-broken depends on missing topic T-x',
  topicId: 'T-broken',
  details: { missing: 'T-x' },
};

describe('Human formatter (#25)', () => {
  test('reports pass with no issues', () => {
    const out = formatHuman([]);
    assert.match(out, /✓ Vault validation passed - no errors found/);
  });

  test('reports error count and details per rule', () => {
    const out = formatHuman([ERROR_ISSUE]);
    assert.match(out, /✗ Found 1 validation error\(s\)/);
    assert.match(out, /no-duplicate-topic-id/);
    assert.match(out, /T-dup/);
    assert.match(out, /a\.md, b\.md/);
  });

  test('reports warnings separately from errors', () => {
    const out = formatHuman([WARNING_ISSUE]);
    assert.match(out, /⚠ Found 1 validation warning\(s\)/);
    assert.match(out, /parse-frontmatter/);
    assert.match(out, /broken\.md/);
  });

  test('errors print before warnings', () => {
    const out = formatHuman([WARNING_ISSUE, ERROR_ISSUE]);
    const errorIndex = out.indexOf('no-duplicate-topic-id');
    const warningIndex = out.indexOf('parse-frontmatter');
    assert.ok(errorIndex > -1 && warningIndex > -1);
    assert.ok(errorIndex < warningIndex, 'errors must print before warnings');
  });

  test('renders duplicate, missing dep, and cycle findings across severity blocks', () => {
    const out = formatHuman([ERROR_ISSUE, MISSING_DEP_ISSUE, CYCLE_ISSUE]);

    assert.match(out, /Duplicate topic ID: T-dup/);
    assert.match(out, /T-broken depends on missing topic T-x/);
    assert.match(out, /T-a -> T-b -> T-a/);
    // Missing dep is a warning now: it renders in the warning block
    // while the true errors keep the error block.
    assert.match(out, /✗ Found 2 validation error\(s\)/);
    assert.match(out, /⚠ Found 1 validation warning\(s\)/);
  });

  test('no ANSI color codes in output', () => {
    const out = formatHuman([ERROR_ISSUE]);
    assert.ok(!out.includes('\u001b['), 'expected no ANSI escapes');
  });
});

describe('JSON formatter (#25)', () => {
  test('preserves documented contract keys on a clean vault', () => {
    const payload = formatJson([], { topicCount: 3, fileCount: 7 });
    const data = JSON.parse(payload);

    assert.strictEqual(data.valid, true);
    assert.strictEqual(data.topic_count, 3);
    assert.strictEqual(data.file_count, 7);
    assert.strictEqual(data.error_count, 0);
    assert.deepStrictEqual(data.errors, []);
    assert.strictEqual(data.warning_count, 0);
    assert.deepStrictEqual(data.warnings, []);
  });

  test('errors land in errors[] with rule_id and severity', () => {
    const payload = formatJson([ERROR_ISSUE], { topicCount: 2, fileCount: 5 });
    const data = JSON.parse(payload);

    assert.strictEqual(data.valid, false);
    assert.strictEqual(data.error_count, 1);
    assert.strictEqual(data.errors[0].rule_id, 'no-duplicate-topic-id');
    assert.strictEqual(data.errors[0].severity, 'error');
    assert.strictEqual(data.errors[0].topic_id, 'T-dup');
  });

  test('warnings land in warnings[] and never flip valid', () => {
    const payload = formatJson([WARNING_ISSUE], { topicCount: 1, fileCount: 2 });
    const data = JSON.parse(payload);

    assert.strictEqual(data.valid, true);
    assert.strictEqual(data.error_count, 0);
    assert.strictEqual(data.warning_count, 1);
    assert.strictEqual(data.warnings[0].rule_id, 'parse-frontmatter');
  });

  test('round-trips every locator field', () => {
    const payload = formatJson([CYCLE_ISSUE, WARNING_ISSUE], {
      topicCount: 3,
      fileCount: 3,
    });
    const data = JSON.parse(payload);

    const cycle = data.errors[0];
    assert.strictEqual(cycle.rule_id, 'no-dependency-cycle');
    assert.deepStrictEqual(cycle.path, ['T-a', 'T-b', 'T-a']);
    assert.strictEqual(data.warnings[0].file, 'broken.md');
    assert.ok(data.warnings[0].details.parserMessage);
  });

  test('output is single-line parseable JSON', () => {
    const payload = formatJson([ERROR_ISSUE, WARNING_ISSUE], {
      topicCount: 2,
      fileCount: 5,
    });
    assert.ok(!payload.includes('\n'), 'JSON output must be single-line');
    assert.doesNotThrow(() => JSON.parse(payload));
  });
});
