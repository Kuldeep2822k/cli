/**
 * #565 P3-18 — agent instructions must be discoverable.
 *
 * `agent.md` was the only conventions document (~20 KB) and nothing pointed at
 * it: no root `AGENTS.md` existed for tooling that expects one, and README's
 * Contributing section still ended on "Detailed contribution guidelines will be
 * added with the implementation source." The fix adds a root `AGENTS.md`
 * pointer to `agent.md` and replaces the placeholder with the real
 * clone-to-green loop. These assertions are the fitness function for that
 * state, so the fix cannot silently rot:
 *
 * - the root `AGENTS.md` pointer exists and links `agent.md` (deleting the
 *   pointer, or unlinking it from its target, fails here);
 * - the conventions document the pointer names still exists and still carries
 *   the verification loop it promises (the pointer cannot outlive its target);
 * - README's Contributing section no longer defers the guidelines to the
 *   future and documents the real clone-to-green steps;
 * - every `npm run <name>` the two docs mention resolves to a script
 *   `package.json` actually defines, and the Node floor the docs state matches
 *   `engines.node` — so a renamed script or a moved floor is a loud
 *   documentation failure instead of silent drift.
 *
 * Modeled on the repo-docs censuses (test/docs-command-matrix.test.ts,
 * test/planning-invariant-ids.test.ts): the docs are read from disk and
 * compared against the artifact that owns the facts (package.json here).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const AGENTS_FILE = path.join(root, 'AGENTS.md');
const AGENT_MD_FILE = path.join(root, 'agent.md');
const README_FILE = path.join(root, 'README.md');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  engines: { node: string };
};

/**
 * The Contributing section alone, sliced at the next heading so the Quick
 * Start `npm install -g` line stays outside the predicate.
 */
function contributingSection(): string {
  const readme = fs.readFileSync(README_FILE, 'utf8');
  const start = readme.indexOf('## Contributing');
  assert.ok(start !== -1, 'README.md no longer has a Contributing section');
  const next = readme.indexOf('\n## ', start + 1);
  assert.ok(
    next !== -1,
    'the Contributing section is the last in README.md — adjust the slicer in this test',
  );
  return readme.slice(start, next);
}

/** The script names the text invokes as `npm run <name>`, in document order. */
function npmRunNames(text: string): string[] {
  return [...text.matchAll(/npm run ([^\s`|;&"'()]+)/g)].map((match) => {
    const name = match[1];
    assert.ok(name !== undefined);
    return name;
  });
}

describe('agent instructions are discoverable (#565 P3-18)', () => {
  it('the root AGENTS.md pointer exists and points at agent.md', () => {
    assert.ok(
      fs.existsSync(AGENTS_FILE),
      'root AGENTS.md is gone — the agent-instructions pointer (#565 P3-18) was removed',
    );
    const text = fs.readFileSync(AGENTS_FILE, 'utf8');
    assert.match(
      text,
      /\[agent\.md\]\(agent\.md\)/,
      'AGENTS.md no longer links agent.md — the pointer is dangling',
    );
  });

  it('the conventions document the pointer names still exists', () => {
    assert.ok(
      fs.existsSync(AGENT_MD_FILE),
      'agent.md is gone — AGENTS.md points at nothing',
    );
    const text = fs.readFileSync(AGENT_MD_FILE, 'utf8');
    assert.ok(
      text.includes('## Verification loop'),
      'agent.md lost its verification loop — the AGENTS.md pointer promises conventions this file no longer carries',
    );
  });

  it('README Contributing no longer defers the guidelines to the future', () => {
    const section = contributingSection();
    assert.doesNotMatch(
      section,
      /will be added with the implementation source/i,
      'the "guidelines will be added" placeholder is back — the clone-to-green steps were reverted',
    );
  });

  it('README Contributing documents the real clone-to-green loop', () => {
    const section = contributingSection();
    for (const step of ['npm ci', 'npm run check', 'npm test']) {
      assert.ok(
        section.includes(step),
        `README Contributing no longer documents "${step}" — the clone-to-green loop was reverted`,
      );
    }
    assert.ok(
      Object.hasOwn(pkg.scripts, 'test'),
      'package.json no longer defines the "test" script the Contributing loop tells people to run',
    );
    assert.ok(
      section.includes(pkg.engines.node),
      `README Contributing no longer states the Node floor ${pkg.engines.node} — re-sync the docs with package.json engines`,
    );
  });

  it('every npm script the docs name actually exists in package.json', () => {
    const named = [
      ...npmRunNames(contributingSection()),
      ...npmRunNames(fs.readFileSync(AGENTS_FILE, 'utf8')),
    ];
    assert.ok(
      named.length >= 3,
      `the docs name too few scripts (${named.length}) to be a real loop — this census would be asserting over nothing`,
    );
    const missing = [...new Set(named)].filter(
      (name) => !Object.hasOwn(pkg.scripts, name),
    );
    assert.deepStrictEqual(
      missing,
      [],
      `npm run names missing from package.json scripts: ${missing.join(', ')}`,
    );
  });
});
