/**
 * #565 P3-18 — contributor guidance must be discoverable.
 *
 * The repository keeps agent conventions in the root AGENTS.md file and contributor
 * workflow in CONTRIBUTING.md. These checks keep the two entry points present and
 * make sure the documented npm scripts still exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const AGENTS_FILE = path.join(root, 'AGENTS.md');
const CONTRIBUTING_FILE = path.join(root, 'CONTRIBUTING.md');
const README_FILE = path.join(root, 'README.md');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  engines: { node: string };
};

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function npmRunNames(text: string): string[] {
  return [...text.matchAll(/npm run ([^\s`|;&"'()]+)/g)].map((match) => {
    const name = match[1];
    assert.ok(name !== undefined);
    return name;
  });
}

describe('contributor guidance is discoverable (#565 P3-18)', () => {
  it('keeps AGENTS.md as the canonical agent conventions document', () => {
    assert.ok(fs.existsSync(AGENTS_FILE), 'AGENTS.md is missing');
    const text = read(AGENTS_FILE);
    assert.match(text, /^---\r?\n/m, 'AGENTS.md should retain its agent metadata');
    assert.match(text, /## Verification loop/, 'AGENTS.md lost its verification loop');
    assert.ok(!fs.readdirSync(root).includes('agent.md'), 'the old agent.md filename still exists');
  });

  it('keeps the contributor workflow in CONTRIBUTING.md', () => {
    assert.ok(fs.existsSync(CONTRIBUTING_FILE), 'CONTRIBUTING.md is missing');
    const text = read(CONTRIBUTING_FILE);
    assert.match(text, /^# Contributing/m);
    assert.match(text, /## Clone to green/);
    assert.match(text, /npm ci/);
    assert.match(text, /npm run check/);
    assert.match(text, /npm test/);
    assert.ok(text.includes(pkg.engines.node), `CONTRIBUTING.md no longer states ${pkg.engines.node}`);
  });

  it('links to the canonical guidance without duplicating the full workflow', () => {
    const readme = read(README_FILE);
    assert.match(readme, /\[CONTRIBUTING\.md\]\(CONTRIBUTING\.md\)/);
    assert.match(readme, /\[AGENTS\.md\]\(AGENTS\.md\)/);
    assert.doesNotMatch(readme, /git clone https:\/\/github\.com\/Kuldeep2822k\/cli\.git/);
  });

  it('keeps every documented npm script defined by package.json', () => {
    const named = [...npmRunNames(read(CONTRIBUTING_FILE)), ...npmRunNames(read(AGENTS_FILE))];
    assert.ok(named.length >= 3, `the docs name too few scripts (${named.length})`);
    const missing = [...new Set(named)].filter((name) => !Object.hasOwn(pkg.scripts, name));
    assert.deepStrictEqual(missing, [], `missing package.json scripts: ${missing.join(', ')}`);
  });
});
