import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';

/**
 * #565 P3-16: ci.yml's `docs-check` job builds the documentation on Node 24 in
 * every pull request, while `deploy-docs.yml` rebuilt the same site on Node
 * 22.23.4 — so every docs merge built twice on different runtimes, and the
 * runtime that actually serves GitHub Pages was never exercised by a PR check.
 * The fix pins both builds to the same Node version spec; these assertions are
 * the fitness function that keeps the two files from drifting apart again.
 */
describe('docs build Node version parity (#565 P3-16)', () => {
  const readSetupNodeVersion = (workflowFile: string, jobId: string): string | undefined => {
    const workflowPath = path.resolve(__dirname, '../.github/workflows', workflowFile);
    const doc = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
      jobs: Record<string, { steps?: Array<{ uses?: string; with?: { 'node-version'?: string } }> }>;
    };
    const setup = (doc.jobs[jobId]?.steps ?? []).find((step) =>
      (step.uses ?? '').startsWith('actions/setup-node'),
    );
    return setup?.with?.['node-version'];
  };

  const ciDocsNode = readSetupNodeVersion('ci.yml', 'docs-check');
  const deployNode = readSetupNodeVersion('deploy-docs.yml', 'build');

  test('deploy-docs builds the site on the Node version the PR docs gate runs', () => {
    assert.ok(ciDocsNode, 'precondition: ci.yml docs-check must pin a Node version');
    assert.ok(deployNode, 'deploy-docs.yml build must pin a Node version at all');
    assert.strictEqual(
      deployNode,
      ciDocsNode,
      `deploy-docs.yml must build on the Node version ci.yml gates (${String(ciDocsNode)}), got ${String(deployNode)}`,
    );
  });

  test('the shared docs build runtime is Node 24', () => {
    // The parity assertion alone would let both files drift down together
    // (22 in ci.yml and deploy-docs.yml alike), which quietly re-opens the
    // audit finding: the PR gate would then cover a runtime nothing ships on.
    assert.match(
      ciDocsNode ?? '',
      /^24\./,
      'the docs build runtime both workflows pin must be Node 24',
    );
  });
});
