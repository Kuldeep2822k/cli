import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';

/**
 * The matrix is the thing that was wrong, and a workflow file has no other
 * test: #269 attributes the merges that left `main` red or unverified between
 * v0.5.2 and v0.6.0 to legs no pull request ran (macOS). These assertions are
 * the fitness function that keeps the two event types from diverging again.
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

    // The whole set, not membership plus a count: dropping windows 22.x while
    // adding a second ubuntu leg satisfies `includes` checks and a length
    // assertion, and would leave `main` running a different matrix than a PR.
    assert.deepStrictEqual(combos, [
      'macos-latest@22.x',
      'macos-latest@24.x',
      'ubuntu-latest@22.x',
      'ubuntu-latest@24.x',
      'ubuntu-latest@26.x',
      'windows-latest@22.x',
      'windows-latest@24.x',
    ]);
  });

  test('the installed package is smoke-tested on macOS in a pull request too', () => {
    // `npm install -g` has to be proven on the set of platforms it ships to, not
    // merely on a set that happens to contain macOS plus two others.
    assert.deepStrictEqual(doc.jobs['smoke-install'].strategy?.matrix?.os ?? [], [
      'ubuntu-latest',
      'windows-latest',
      'macos-latest',
    ]);
  });

  test('a release tag triggers CI as well as publishing', () => {
    assert.deepStrictEqual(doc.on.push?.tags, ['v*.*.*']);
    assert.ok(doc.on.push?.branches?.includes('main'));
    assert.ok(doc.on.pull_request?.branches?.includes('main'));
  });

  test('a tag cannot publish before the platform matrix has passed', () => {
    // CI's own tag run is a separate workflow, and a workflow cannot depend on
    // another's result — so the publish gate has to live in `release.yml`, which
    // means the matrix is written in two files. That duplication is precisely the
    // drift this suite exists to catch, so it is asserted rather than trusted: a
    // release gated on a narrower set than CI runs would gate a smaller claim than
    // the one being made.
    const releasePath = path.resolve(__dirname, '../.github/workflows/release.yml');
    const release = parseDocument(fs.readFileSync(releasePath, 'utf8')).toJSON() as {
      jobs: Record<string, {
        needs?: string | string[];
        strategy?: { matrix?: { include?: unknown[] } };
      }>;
    };

    const ciMatrix = doc.jobs['test-matrix'].strategy?.matrix?.include ?? [];
    const releaseMatrix = release.jobs['test-platforms']?.strategy?.matrix?.include ?? [];
    assert.ok(ciMatrix.length > 0, 'precondition: CI declares a matrix');
    assert.deepStrictEqual(releaseMatrix, ciMatrix);

    const needs = release.jobs['publish-npm']?.needs ?? [];
    const required = Array.isArray(needs) ? needs : [needs];
    assert.ok(required.includes('test-platforms'), 'publishing must wait for the matrix');
    assert.ok(required.includes('verify-and-pack'), 'and for the artifact it publishes');
  });
});
