import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';

describe('CLI Adopt --auto-chain Integration (Issue #73, INV-46)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-autochain-'));
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

  /** Maps palee_id -> vault-relative path for every adopted note under dir. */
  function idToPath(vaultDir: string): Map<string, string> {
    const map = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.name.endsWith('.md')) {
          const { frontmatter } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
          if (frontmatter?.palee_id) {
            map.set(String(frontmatter.palee_id), path.relative(vaultDir, abs).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(vaultDir);
    return map;
  }

  function dependsOn(vaultDir: string, rel: string): string[] {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    const deps = frontmatter?.depends_on;
    return Array.isArray(deps) ? deps.map(String) : [];
  }

  const chainFiles: Record<string, string> = {
    'MODULES/01-foundations/01-a.md': '# A\n',
    'MODULES/01-foundations/02-b.md': '# B\n',
    'MODULES/02-linux/01-c.md': '# C\n',
    'MODULES/02-linux/lab-01.md': '# Lab\n',
  };

  test('--dry-run prints the edge plan, writes nothing, exits 0', () => {
    const { vaultDir, configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /01-foundations\/02-b\.md depends on MODULES\/01-foundations\/01-a\.md/);
    assert.match(result.stdout, /02-linux\/01-c\.md depends on MODULES\/01-foundations\/02-b\.md/);
    assert.match(result.stdout, /01-a\.md \(chain head\)/);
    assert.match(result.stdout, /Dry-run complete\. No files were modified\./);
    for (const rel of Object.keys(chainFiles)) {
      const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
      assert.strictEqual(frontmatter?.palee_id, undefined, `${rel} must not be modified`);
    }
  });

  test('wires the exact depends_on chain within and across modules', () => {
    const { vaultDir, configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Auto-chained: 3 dependency edges wired across 4 notes\./);

    const ids = idToPath(vaultDir);
    const pathOf = (id: string): string => {
      const p = ids.get(id);
      assert.ok(p, `unknown id ${id}`);
      return p;
    };

    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/01-a.md'), []);
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/01-foundations/02-b.md').map(pathOf),
      ['MODULES/01-foundations/01-a.md']
    );
    // Cross-module bridge: module 02 entry depends on module 01 exit
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/02-linux/01-c.md').map(pathOf),
      ['MODULES/01-foundations/02-b.md']
    );
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/02-linux/lab-01.md').map(pathOf),
      ['MODULES/02-linux/01-c.md']
    );
  });

  test('already-adopted notes keep their hand-written depends_on', () => {
    const { vaultDir, configDir } = freshVault(chainFiles);
    // Pre-adopt one note in single-file mode with an explicit dep
    const single = runCLI(
      ['adopt', 'MODULES/01-foundations/01-a.md', '--depends-on', 'T-manual'],
      configDir
    );
    assert.strictEqual(single.status, 0, single.stderr);

    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/01-a.md'), ['T-manual']);

    // The rest of the chain routes around the adopted note: b becomes a head
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/02-b.md'), []);
  });

  test('pre-existing vault cycle blocks the commit with exit 3 and zero writes', () => {
    const { vaultDir, configDir } = freshVault({
      'old/a.md': '# A\n',
      'old/b.md': '# B\n',
      'new/01-x.md': '# X\n',
      'new/02-y.md': '# Y\n',
    });
    const adopted = runCLI(['adopt', 'old', '-y'], configDir);
    assert.strictEqual(adopted.status, 0, adopted.stderr);

    // Hand-wire a cycle between the two adopted notes
    const ids = idToPath(vaultDir);
    const idA = [...ids.entries()].find(([, p]) => p === 'old/a.md')?.[0];
    const idB = [...ids.entries()].find(([, p]) => p === 'old/b.md')?.[0];
    assert.ok(idA && idB);
    for (const [rel, dep] of [['old/a.md', idB], ['old/b.md', idA]] as const) {
      const abs = path.join(vaultDir, rel);
      const content = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, content.replace('depends_on: []', `depends_on: [${dep}]`));
    }

    const result = runCLI(['adopt', 'new', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 3, result.stdout);
    assert.match(result.stderr, /auto-chain dependency graph contains cycles/);
    for (const rel of ['new/01-x.md', 'new/02-y.md']) {
      const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
      assert.strictEqual(frontmatter?.palee_id, undefined, `${rel} must not be adopted`);
    }
  });

  test('--depends-on conflicts with --auto-chain (exit 2)', () => {
    const { configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '--depends-on', 'T-x', '-y'], configDir);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /conflicts with --depends-on/);
  });

  test('--auto-chain rejects single-file mode (exit 2)', () => {
    const { configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES/01-foundations/01-a.md', '--auto-chain'], configDir);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /batch-only/);
  });

  test('excluded notes are bridged over in the chain', () => {
    const { vaultDir, configDir } = freshVault({
      ...chainFiles,
      'MODULES/01-foundations/template.md': '# Template\n',
    });
    const result = runCLI(
      ['adopt', 'MODULES', '--auto-chain', '--exclude', '*template*', '-y'],
      configDir
    );
    assert.strictEqual(result.status, 0, result.stderr);
    const ids = idToPath(vaultDir);
    assert.ok(!ids.has('MODULES/01-foundations/template.md'));
    // 02-b still chains to 01-a; the excluded template is skipped, not a gap
    const bDeps = dependsOn(vaultDir, 'MODULES/01-foundations/02-b.md');
    assert.strictEqual(bDeps.length, 1);
    assert.strictEqual(ids.get(bDeps[0]), 'MODULES/01-foundations/01-a.md');
  });
});
