import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';

describe('CLI Roadmap Wikilink + --auto-chain Integration (Issue #73, INV-47, INV-48)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-roadmap-wikilink-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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
    assert.ok(frontmatter, `${rel} has no frontmatter`);
    return frontmatter;
  }

  const REVIEWED_ALPHA = `---
palee_id: T-alpha-1
palee_schema: 1
title: Alpha
difficulty: intermediate
depends_on: [T-handwritten]
topic_mastery: 0.5
assessed_at: '2026-09-01'
conceptual: 0.6
practical: 0.5
debug: 0.4
feynman: 0.5
ease_factor: 2.1
interval_days: 6
repetition: 2
lapses: 1
last_quality: 4
last_reviewed_at: '2026-09-01'
due_at: '2026-09-10'
---
# Alpha
`;

  test('wikilink roadmap chains notes, replaces hand-written deps, preserves SM-2', () => {
    const { vaultDir, configDir } = freshVault({
      'tracks/alpha.md': REVIEWED_ALPHA,
      'tracks/beta.md': '# Beta\n',
      'tracks/gamma.md': '# Gamma\n',
      'roadmap.md': `# Roadmap\n\n## Track One\n\n- [[tracks/alpha]]\n- [[Beta]]\n- [[gamma#intro]]\n`,
    });
    const result = runCLI(['roadmap', '--from', path.join(vaultDir, 'roadmap.md'), '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Resolved 3 wikilink topics/);

    const alpha = frontmatterOf(vaultDir, 'tracks/alpha.md');
    // Chain head: hand-written dep replaced with explicit []
    assert.deepStrictEqual(alpha.depends_on, []);
    // SM-2 state preserved byte-for-byte
    for (const [key, value] of Object.entries({
      ease_factor: 2.1,
      interval_days: 6,
      repetition: 2,
      lapses: 1,
      last_quality: 4,
      last_reviewed_at: '2026-09-01',
      due_at: '2026-09-10',
      topic_mastery: 0.5,
    })) {
      assert.strictEqual(alpha[key], value, `SM-2 field ${key} must be preserved`);
    }

    const beta = frontmatterOf(vaultDir, 'tracks/beta.md');
    assert.deepStrictEqual(beta.depends_on, ['T-alpha-1']);
    assert.ok(/^T-/.test(String(beta.palee_id)), 'unadopted note gets a minted id');

    const gamma = frontmatterOf(vaultDir, 'tracks/gamma.md');
    assert.deepStrictEqual(gamma.depends_on, [String(beta.palee_id)]);
  });

  test('unresolvable wikilink fails closed with exit 3 and zero writes', () => {
    const { vaultDir, configDir } = freshVault({
      'tracks/alpha.md': '# Alpha\n',
      'roadmap.md': '# Roadmap\n\n## Track\n\n- [[tracks/alpha]]\n- [[no-such-note]]\n',
    });
    const result = runCLI(['roadmap', '--from', path.join(vaultDir, 'roadmap.md'), '-y'], configDir);
    assert.strictEqual(result.status, 3);
    assert.match(result.stderr, /Unresolved wikilink/);
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'tracks/alpha.md'), 'utf8'));
    assert.strictEqual(frontmatter?.palee_id, undefined, 'no notes may be written');
  });

  test('ambiguous wikilink fails closed with exit 3 listing candidates', () => {
    const { vaultDir, configDir } = freshVault({
      'a/dup.md': '# Dup A\n',
      'b/dup.md': '# Dup B\n',
      'roadmap.md': '# Roadmap\n\n## Track\n\n- [[dup]]\n',
    });
    const result = runCLI(['roadmap', '--from', path.join(vaultDir, 'roadmap.md'), '-y'], configDir);
    assert.strictEqual(result.status, 3);
    assert.match(result.stderr, /Ambiguous wikilink/);
  });

  test('--auto-chain chains a YAML roadmap by order; explicit deps win', () => {
    const { vaultDir, configDir } = freshVault({
      'n/0.md': '# N0\n',
      'n/1.md': '# N1\n',
      'n/2.md': '# N2\n',
      'n/3.md': '# N3\n',
    });
    const adopted = runCLI(['adopt', 'n', '-y'], configDir);
    assert.strictEqual(adopted.status, 0, adopted.stderr);
    const idOf = (rel: string): string =>
      String(frontmatterOf(vaultDir, rel).palee_id);
    const [id0, id1, id2, id3] = [idOf('n/0.md'), idOf('n/1.md'), idOf('n/2.md'), idOf('n/3.md')];

    const yamlPath = path.join(vaultDir, 'rm.yaml');
    fs.writeFileSync(
      yamlPath,
      `topics:\n  - id: ${id2}\n    title: N2\n    path: n/2.md\n    order: 2\n  - id: ${id3}\n    title: N3\n    path: n/3.md\n  - id: ${id1}\n    title: N1\n    path: n/1.md\n    order: 1\n    depends_on: [${id0}]\n`
    );
    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Auto-chain: 3 roadmap topics chained by order\./);

    // Explicit non-empty depends_on wins over the chain (points outside the roadmap: no cycle)
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'n/1.md').depends_on, [id0]);
    // Unordered topic keeps file order, appended after ordered ones
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'n/2.md').depends_on, [id1]);
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'n/3.md').depends_on, [id2]);
  });
});
