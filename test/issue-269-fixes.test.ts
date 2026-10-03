/**
 * Issue #269 regression tests — one group per fix.
 *
 * Covers: config temp entropy, atomic-write stray reap, roadmap ".md"
 * rejection + re-ID gate, TOC junction paths, assess provenance/force/dry-run,
 * adopt hand-authored preservation.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { saveConfig, loadConfig } from '../src/cli/config';
import { reapStaleTempFiles, atomicWrite } from '../src/storage/atomic-write';
import { isValidRoadmapTopicPath } from '../src/cli/roadmap';
import roadmapCommand from '../src/cli/roadmap';
import { assessCommand } from '../src/cli/assess';
import adoptCommand from '../src/cli/adopt';
import { deriveTocEnumeration } from '../src/storage/toc';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { walkVault, ensureVaultDirectory } from '../src/storage/vault-walker';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Temp vault + PALEE_CONFIG_DIR pointing at it. */
async function withVault(
  files: Record<string, string>,
  fn: (vault: string, dir: string) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(vault, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ vaultPath: vault }));
  const prevDir = process.env.PALEE_CONFIG_DIR;
  const prevExit = process.exitCode;
  process.env.PALEE_CONFIG_DIR = dir;
  try {
    await fn(vault, dir);
  } finally {
    if (prevDir !== undefined) process.env.PALEE_CONFIG_DIR = prevDir;
    else delete process.env.PALEE_CONFIG_DIR;
    process.exitCode = prevExit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function silence(): () => string {
  const chunks: string[] = [];
  const out = console.log;
  const err = console.error;
  console.log = (...a: unknown[]): void => { chunks.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]): void => { chunks.push(a.map(String).join(' ')); };
  return () => {
    console.log = out;
    console.error = err;
    return chunks.join('\n');
  };
}

function note(id: string, title: string, extra = ''): string {
  return ['---', 'palee_schema: 1', `palee_id: ${id}`, `title: ${title}`, 'depends_on: []', 'topic_mastery: 0',
    'conceptual: 0', 'practical: 0', 'debug: 0', 'feynman: 0', extra, '---', '', `# ${title}`, ''].join('\n');
}

describe('issue #269: config temp entropy', () => {
  test('saveConfig round-trips and leaves no temp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-cfg-'));
    const prev = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = dir;
    try {
      saveConfig({ vaultPath: '/tmp/v' });
      assert.deepStrictEqual(loadConfig().vaultPath, '/tmp/v');
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      if (prev !== undefined) process.env.PALEE_CONFIG_DIR = prev;
      else delete process.env.PALEE_CONFIG_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('issue #269: atomic-write stray reap', () => {
  test('reaps dead-pid and ancient temps, keeps a live fresh write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-reap-'));
    try {
      const deadPid = 2147483647;
      const dead = path.join(dir, `note.md.tmp.${deadPid}.abcdef01`);
      fs.writeFileSync(dead, 'stray');
      const ancient = new Date(Date.now() - 3600_000);
      fs.utimesSync(dead, ancient, ancient);

      const live = path.join(dir, `live.md.tmp.${process.pid}.abcdef02`);
      fs.writeFileSync(live, 'in-flight');

      const removed = reapStaleTempFiles(dir, 30_000);
      assert.strictEqual(removed, 1);
      assert.ok(!fs.existsSync(dead));
      assert.ok(fs.existsSync(live));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('walkVault (the load path) reaps strays without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-walk-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.md'), '# A\n');
      const stray = path.join(dir, `a.md.tmp.2147483646.abcdef03`);
      fs.writeFileSync(stray, 'stray');
      const ancient = new Date(Date.now() - 3600_000);
      fs.utimesSync(stray, ancient, ancient);
      const found = walkVault(dir);
      assert.ok(found.some((f) => f.endsWith('a.md')));
      assert.ok(!fs.existsSync(stray), 'load-path walk should have reaped the stray');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('atomicWrite still cleans its own temp on success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-aw-'));
    try {
      fs.mkdirSync(path.join(dir, '.palee', 'locks'), { recursive: true });
      const target = path.join(dir, 'n.md');
      await atomicWrite(dir, target, '# N\n');
      const temps = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
      assert.deepStrictEqual(temps, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('issue #269: roadmap degenerate path', () => {
  test('isValidRoadmapTopicPath rejects .md in any casing', () => {
    assert.strictEqual(isValidRoadmapTopicPath('.md'), false);
    assert.strictEqual(isValidRoadmapTopicPath('.MD'), false);
    assert.strictEqual(isValidRoadmapTopicPath('notes/.md'), false);
    assert.strictEqual(isValidRoadmapTopicPath('notes/a.md'), true);
    assert.strictEqual(isValidRoadmapTopicPath('a.md'), true);
  });

  test('ensureVaultDirectory treats .md as a file, not a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-ensure-'));
    try {
      const vault = path.join(dir, 'vault');
      fs.mkdirSync(vault, { recursive: true });
      const canonical = ensureVaultDirectory(vault, path.join(vault, '.md'));
      assert.strictEqual(canonical, fs.realpathSync(vault));
      assert.ok(!fs.existsSync(path.join(vault, '.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('roadmap --from with path .md fails validation with no writes', async () => {
    await withVault({}, async (vault, dir) => {
      const yaml = path.join(dir, 'bad.yaml');
      fs.writeFileSync(yaml, ['topics:', '  - id: T-x', '    title: X', '    path: .md', ''].join('\n'));
      const restore = silence();
      await roadmapCommand({ from: yaml, yes: true });
      const output = restore();
      assert.strictEqual(process.exitCode, 3);
      assert.match(output, /invalid path/);
      assert.ok(!fs.existsSync(path.join(vault, '.md')));
    });
  });
});

describe('issue #269: roadmap re-ID gate', () => {
  test('declaring a fresh id over an adopted note is refused with zero writes', async () => {
    await withVault(
      {
        'repl-1.md': note('T-old', 'Old One'),
        'repl-2.md': note('T-dep', 'Dependent'),
      },
      async (vault, dir) => {
        const before = fs.readFileSync(path.join(vault, 'repl-1.md'), 'utf8');
        const yaml = path.join(dir, 'reid.yaml');
        fs.writeFileSync(
          yaml,
          ['topics:', '  - id: T-new', '    title: New One', '    path: repl-1.md',
            '  - id: T-dep', '    title: Dependent', '    path: repl-2.md', '    depends_on: [T-old]', ''].join('\n')
        );
        const restore = silence();
        await roadmapCommand({ from: yaml, yes: true });
        const output = restore();
        assert.strictEqual(process.exitCode, 3);
        assert.match(output, /re-ID|overwrite adopted/i);
        assert.strictEqual(fs.readFileSync(path.join(vault, 'repl-1.md'), 'utf8'), before);
      }
    );
  });

  test('same id over the same path still imports', async () => {
    await withVault({ 'same.md': note('T-keep', 'Keep') }, async (vault, dir) => {
      const yaml = path.join(dir, 'same.yaml');
      fs.writeFileSync(yaml, ['topics:', '  - id: T-keep', '    title: Keep Updated', '    path: same.md', ''].join('\n'));
      const restore = silence();
      await roadmapCommand({ from: yaml, yes: true });
      restore();
      assert.strictEqual(process.exitCode, 0);
      assert.ok(fs.readFileSync(path.join(vault, 'same.md'), 'utf8').includes('T-keep'));
    });
  });
});

describe('issue #269: toc junction paths', () => {
  test('enumeration through a symlinked root stays vault-relative', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-tocreal-'));
    const link = path.join(os.tmpdir(), `palee-269-toclink-${Date.now()}`);
    fs.symlinkSync(real, link, LINK_TYPE);
    try {
      fs.writeFileSync(path.join(real, 'README.md'), '- [a](sub/a.md)\n');
      fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(real, 'sub', 'a.md'), '# A\n');
      const found = deriveTocEnumeration(link);
      assert.ok(found.documentOrder.includes('sub/a.md'));
      for (const rel of [...found.documentOrder, ...found.tocFiles]) {
        assert.ok(!rel.startsWith('..'), `escaped vault: ${rel}`);
        assert.ok(!rel.includes('\\'));
      }
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('issue #269: assess provenance and lowering guard', () => {
  test('a write stamps assessment_source manual', async () => {
    await withVault({ 'solo.md': note('T-solo', 'Solo') }, async (vault) => {
      const restore = silence();
      await assessCommand('Solo', { conceptual: '0.8', practical: '0.7', debug: '0.9', feynman: '0.85' });
      restore();
      assert.strictEqual(process.exitCode ?? 0, 0);
      assert.strictEqual(parseFrontmatter(fs.readFileSync(path.join(vault, 'solo.md'), 'utf8')).frontmatter?.assessment_source, 'manual');
    });
  });

  test('lowering that hides a dependent needs --force; dry-run previews', async () => {
    const files = {
      'strong.md': note('T-strong', 'Strong').replace('topic_mastery: 0', 'topic_mastery: 1')
        .replaceAll('conceptual: 0', 'conceptual: 1').replaceAll('practical: 0', 'practical: 1')
        .replaceAll('debug: 0', 'debug: 1').replaceAll('feynman: 0', 'feynman: 1'),
      'gated.md': ['---', 'palee_schema: 1', 'palee_id: T-gated', 'title: Gated', 'depends_on: [T-strong]',
        'topic_mastery: 0', 'conceptual: 0', 'practical: 0', 'debug: 0', 'feynman: 0', '---', '', '# Gated', ''].join('\n'),
    };
    await withVault(files, async (vault) => {
      const before = fs.readFileSync(path.join(vault, 'strong.md'), 'utf8');
      let restore = silence();
      await assessCommand('Strong', { conceptual: '0', practical: '0', debug: '0', feynman: '0' });
      const refused = restore();
      assert.strictEqual(process.exitCode, 2);
      assert.match(refused, /--force|--dry-run/);
      assert.strictEqual(fs.readFileSync(path.join(vault, 'strong.md'), 'utf8'), before);

      process.exitCode = 0;
      restore = silence();
      await assessCommand('Strong', { conceptual: '0', practical: '0', debug: '0', feynman: '0', dryRun: true });
      const preview = restore();
      assert.strictEqual(process.exitCode ?? 0, 0);
      assert.match(preview, /Dry-run/i);
      assert.strictEqual(fs.readFileSync(path.join(vault, 'strong.md'), 'utf8'), before);

      process.exitCode = 0;
      restore = silence();
      await assessCommand('Strong', { conceptual: '0', practical: '0', debug: '0', feynman: '0', force: true });
      restore();
      assert.strictEqual(process.exitCode ?? 0, 0);
      assert.strictEqual(parseFrontmatter(fs.readFileSync(path.join(vault, 'strong.md'), 'utf8')).frontmatter?.topic_mastery, 0);
    });
  });
});

describe('issue #269: adopt preserves hand-authored fields', () => {
  test('single-file adoption keeps difficulty, mastery, and pillars', async () => {
    await withVault(
      {
        'hand.md': ['---', 'title: Hand', 'difficulty: beginner', 'topic_mastery: 0.68',
          'conceptual: 0.7', 'practical: 0.7', 'debug: 0.7', 'feynman: 0.6', '---', '', '# Hand', ''].join('\n'),
      },
      async (vault) => {
        const restore = silence();
        await adoptCommand('hand.md', { yes: true });
        restore();
        assert.strictEqual(process.exitCode ?? 0, 0);
        const fm = parseFrontmatter(fs.readFileSync(path.join(vault, 'hand.md'), 'utf8')).frontmatter ?? {};
        assert.strictEqual(fm.difficulty, 'beginner');
        assert.strictEqual(fm.topic_mastery, 0.68);
        assert.strictEqual(fm.conceptual, 0.7);
        assert.strictEqual(fm.feynman, 0.6);
      }
    );
  });

  test('single-file adoption mints no zero pillars on a bare note', async () => {
    await withVault({ 'bare.md': '# Bare\n' }, async (vault) => {
      const restore = silence();
      await adoptCommand('bare.md', { yes: true });
      restore();
      const fm = parseFrontmatter(fs.readFileSync(path.join(vault, 'bare.md'), 'utf8')).frontmatter ?? {};
      assert.strictEqual(fm.difficulty, 'intermediate');
      assert.strictEqual(fm.topic_mastery, 0);
      assert.ok(!('conceptual' in fm), 'absent pillars must stay absent');
    });
  });

  test('an explicit --difficulty still wins over the stored one', async () => {
    await withVault({ 'adv.md': '---\ndifficulty: beginner\n---\n# Adv\n' }, async (vault) => {
      const restore = silence();
      await adoptCommand('adv.md', { yes: true, difficulty: 'advanced' });
      restore();
      assert.strictEqual(parseFrontmatter(fs.readFileSync(path.join(vault, 'adv.md'), 'utf8')).frontmatter?.difficulty, 'advanced');
    });
  });
});
