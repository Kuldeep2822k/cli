import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';

/**
 * The matrix is the thing that was wrong, and a workflow file has no other
 * test: eight merges in `v0.5.2..v0.6.0` left `main` red or unverified, every
 * one on a leg no pull request ran. These assertions are the fitness function
 * that keeps the two event types from diverging again.
 */
describe('CI workflow matrix parity (#269 release health)', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/ci.yml');
  const doc = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
    on: { push?: { branches?: string[]; tags?: string[] }; pull_request?: { branches?: string[] } };
    jobs: Record<string, { strategy?: { matrix?: { include?: { os: string; 'node-version': string }[] } & { os?: string[] } } }>;
  };

  test('a pull request runs the same matrix a push to main runs', () => {
    const combos = (doc.jobs['test-matrix'].strategy?.matrix?.include ?? [])
      .map((entry) => `${entry.os}@${entry['node-version']}`)
      .sort();

    // No event-conditional ternary survives: the matrix is one list, so the
    // phrase that used to split the two paths cannot reappear by editing one
    // branch of it and forgetting the other.
    const raw = fs.readFileSync(workflowPath, 'utf8');
    assert.doesNotMatch(
      raw,
      /matrix: >-\s*\$\{\{ fromJSON\(\s*github\.event_name/,
      'the test matrix must not be conditional on the event'
    );

    assert.ok(combos.includes('macos-latest@22.x'), 'macOS runs on a pull request');
    assert.ok(combos.includes('macos-latest@24.x'), 'on both of its supported nodes');
    assert.ok(combos.includes('ubuntu-latest@26.x'), 'node 26 is not main-only');
    assert.ok(combos.includes('windows-latest@22.x'), 'nor the lower windows node');
    assert.strictEqual(combos.length, 7, `every leg main runs:\n${combos.join('\n')}`);
  });

  test('the installed package is smoke-tested on macOS in a pull request too', () => {
    const platforms = doc.jobs['smoke-install'].strategy?.matrix?.os ?? [];
    assert.ok(platforms.includes('macos-latest'), 'npm install -g has to be proven where it ships');
    assert.strictEqual(platforms.length, 3);
  });

  test('a release tag is tested, not only published', () => {
    // `release.yml` is what a `v*.*.*` push triggered, and its test job is
    // ubuntu-only — so the artifact that reached npm had never been run on
    // macOS or Windows at any point before it shipped.
    assert.deepStrictEqual(doc.on.push?.tags, ['v*.*.*']);
    assert.ok(doc.on.push?.branches?.includes('main'));
    assert.ok(doc.on.pull_request?.branches?.includes('main'));
  });
});
