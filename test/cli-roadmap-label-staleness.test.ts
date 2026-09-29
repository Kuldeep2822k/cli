import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';

describe('Roadmap import must not inherit a stale depends_on_source (#223 greptile P1)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-label-staleness-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs the real CLI against an isolated config dir; never throws on non-zero exit. */
  function runCLI(args: string[], configDir: string): { status: number; stdout: string; stderr: string } {
    try {
      const escapedArgs = args.map((arg) => (/[*?[\]\s,]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
      const stdout = execSync(`npx tsx bin/palee.ts ${escapedArgs.join(' ')}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: configDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  }

  /** Creates a fresh vault with the given relPath -> content files and points config at it. */
  function freshVault(files: Record<string, string>): { vaultDir: string; configDir: string } {
    const vaultDir = fs.mkdtempSync(path.join(tempDir, 'vault-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(vaultDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const configDir = fs.mkdtempSync(path.join(tempDir, 'cfg-'));
    const setResult = runCLI(['config', 'set-vault', vaultDir], configDir);
    assert.strictEqual(setResult.status, 0, `set-vault failed: ${setResult.stderr}`);
    return { vaultDir, configDir };
  }

  function frontmatterOf(vaultDir: string, rel: string): Record<string, unknown> {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    return frontmatter || {};
  }

  const TOC_VAULT: Record<string, string> = {
    'README.md': ['# Course', '', '1. [Alpha](guide/alpha.md)', '2. [Beta](guide/beta.md)', ''].join('\n'),
    'guide/alpha.md': '# Alpha\n',
    'guide/beta.md': '# Beta\n',
    // A learner-authored prerequisite, deliberately unmastered: anything gating
    // on it must stay out of the ready list.
    'gate.md': [
      '---', 'palee_schema: 1', 'palee_id: T-gate', 'title: The Gate',
      'depends_on: []', 'topic_mastery: 0', '---', '', '# Gate', '',
    ].join('\n'),
  };

  /** Adopts the vault through the TOC tier and returns Beta's id. */
  function adoptChained(vaultDir: string, configDir: string): string {
    const adopted = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
    assert.strictEqual(adopted.status, 0, adopted.stderr);
    const beta = frontmatterOf(vaultDir, 'guide/beta.md');
    assert.strictEqual(beta.depends_on_source, 'toc', 'precondition: Beta really is TOC-chained');
    return String(beta.palee_id);
  }

  /** Writes a roadmap outside the vault that re-parents `betaId` onto T-gate. */
  function writeRoadmap(betaId: string): string {
    const file = path.join(tempDir, `roadmap-${betaId}.yaml`);
    fs.writeFileSync(
      file,
      ['topics:', `  - id: ${betaId}`, '    title: Beta', '    path: guide/beta.md', '    depends_on:', '      - T-gate', ''].join('\n')
    );
    return file;
  }

  test('a roadmap prerequisite gates, even on a note the TOC tier had chained', () => {
    const { vaultDir, configDir } = freshVault(TOC_VAULT);
    const betaId = adoptChained(vaultDir, configDir);

    const imported = runCLI(['roadmap', '--from', writeRoadmap(betaId), '--yes'], configDir);
    assert.strictEqual(imported.status, 0, imported.stdout + imported.stderr);

    const beta = frontmatterOf(vaultDir, 'guide/beta.md');
    assert.deepStrictEqual(beta.depends_on, ['T-gate'], 'the import must replace the edge list');
    assert.strictEqual(
      beta.depends_on_source,
      undefined,
      'the stale `toc` label survives, so the roadmap prerequisite is treated as advisory'
    );

    const plan = runCLI(['plan', '--json'], configDir);
    assert.strictEqual(plan.status, 0, plan.stderr);
    const ready: string[] = JSON.parse(plan.stdout).ready_to_learn.map((t: { id: string }) => t.id);
    assert.ok(!ready.includes(betaId), 'Beta must be gated behind the unmastered T-gate');
    assert.ok(ready.includes('T-gate'), 'the gate itself is reachable');
  });

  test('a roadmap import that writes no prerequisites leaves an existing label alone', () => {
    // The removal is scoped to the write: a note whose `depends_on` this import
    // does not touch keeps whatever authored it. Clearing it unconditionally
    // would quietly make a TOC-chained note's edges authored-by-nothing.
    const { vaultDir, configDir } = freshVault(TOC_VAULT);
    const betaId = adoptChained(vaultDir, configDir);

    const file = path.join(tempDir, `roadmap-title-only-${betaId}.yaml`);
    fs.writeFileSync(file, ['topics:', `  - id: ${betaId}`, '    title: Beta Renamed', '    path: guide/beta.md', ''].join('\n'));
    const imported = runCLI(['roadmap', '--from', file, '--yes'], configDir);
    assert.strictEqual(imported.status, 0, imported.stdout + imported.stderr);

    const beta = frontmatterOf(vaultDir, 'guide/beta.md');
    assert.strictEqual(beta.title, 'Beta Renamed', 'the import ran');
    assert.strictEqual(beta.depends_on_source, 'toc', 'an untouched edge list keeps its author');
  });
});
