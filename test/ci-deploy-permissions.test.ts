import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';

/**
 * The docs deploy job is the one place holding a Pages write token and OIDC.
 * Workflow-wide `pages: write` + `id-token: write` also handed both to the
 * build job, which installs and executes the third-party VitePress/Mermaid/Katex
 * toolchain (#565 P2-07) — a compromised install or postinstall would inherit a
 * token that can publish and an identity provider that can be exchanged for a
 * cloud credential. These assertions keep the grant on the deploy job alone.
 *
 * A YAML workflow has no other fitness function, and the deploy leg runs only
 * on pushes to `main` that touch docs paths, so drift here would otherwise be
 * noticed by an incident rather than a pull request.
 */
describe('deploy-docs workflow scopes Pages and OIDC to the deploy job (#565)', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-docs.yml');
  const doc = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
    permissions?: Record<string, string>;
    jobs: Record<string, { permissions?: Record<string, string> }>;
  };

  /** The grant a job actually runs with: job-level permissions replace workflow-level ones. */
  function effectiveGrant(job: string): Record<string, string> {
    return doc.jobs[job]?.permissions ?? doc.permissions ?? {};
  }

  test('the workflow-level grant is `contents: read` only', () => {
    assert.deepStrictEqual(doc.permissions, { contents: 'read' });
  });

  test('no job except deploy holds `pages: write` or an OIDC token', () => {
    for (const name of Object.keys(doc.jobs)) {
      if (name === 'deploy') continue;
      const grant = effectiveGrant(name);
      assert.notStrictEqual(grant['pages'], 'write', `${name} must not hold pages: write`);
      assert.notStrictEqual(grant['id-token'], 'write', `${name} must not hold id-token: write`);
    }
  });

  test('the deploy job keeps exactly the two writes it needs', () => {
    assert.deepStrictEqual(doc.jobs['deploy']?.permissions, {
      pages: 'write',
      'id-token': 'write',
    });
  });
});
