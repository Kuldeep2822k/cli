/**
 * validate --strict: end-to-end CLI wiring (#25)
 *
 * Contracts under test (Greptile P2 on PR #162):
 * - `palee validate --strict` works through the real Commander
 *   registration in bin/palee.ts — not just the in-process handler —
 *   so flag-registration or argument-wiring regressions are caught.
 * - A warnings-only vault exits 3 through the packaged CLI with
 *   `--strict`, and 0 without it.
 * - `--strict --json` composes: JSON contract intact, exit code escalated.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault } from './test-env';

describe('validate --strict: e2e CLI wiring (#25)', () => {
  let env: ReturnType<typeof createTestVault>;

  beforeEach(() => {
    env = createTestVault('palee-strict-e2e-');
  });

  afterEach(() => {
    env.cleanup();
  });

  test('warnings-only vault: exit 0 without --strict, exit 3 with --strict', () => {
    env.createTopic('good.md', { palee_id: 'T-good', title: 'Good' });
    // Malformed frontmatter — a parse-frontmatter warning, never an error.
    fs.writeFileSync(
      path.join(env.vaultDir, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );

    const plain = env.run(['validate']);
    assert.strictEqual(plain.status, 0);
    assert.match(plain.stdout, /Found 1 PALEE topics/);

    const strict = env.run(['validate', '--strict']);
    assert.strictEqual(strict.status, 3);
    assert.match(strict.stdout, /warning/);
  });

  test('--strict --json composes: contract intact, exit code escalated', () => {
    env.createTopic('good.md', { palee_id: 'T-good', title: 'Good' });
    fs.writeFileSync(
      path.join(env.vaultDir, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );

    const result = env.run(['validate', '--strict', '--json']);
    assert.strictEqual(result.status, 3);

    const jsonLine = result.stdout
      .split('\n')
      .find((line) => line.includes('"valid"'));
    assert.ok(jsonLine, 'expected a JSON output line');
    const parsed = JSON.parse(jsonLine) as { valid: boolean; warning_count: number };
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.warning_count, 1);
  });

  test('clean vault exits 0 with --strict through the CLI', () => {
    env.createTopic('good.md', { palee_id: 'T-good', title: 'Good' });

    const result = env.run(['validate', '--strict']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /no errors found/);
  });
});
