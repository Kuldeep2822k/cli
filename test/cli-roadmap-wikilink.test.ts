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

  /**
   * Runs the real CLI (`npx tsx bin/palee.ts`) with `PALEE_CONFIG_DIR` pointed
   * at {@link configDir}; captures exit status, stdout and stderr instead of
   * throwing on a non-zero exit. Args containing glob/space characters are
   * shell-quoted.
   */
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

  /** Parses a note's YAML frontmatter, asserting the note actually has one. */
  function frontmatterOf(vaultDir: string, rel: string): Record<string, unknown> {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    assert.ok(frontmatter, `${rel} has no frontmatter`);
    return frontmatter;
  }

  /**
   * Snapshots `relative path -> exact content` for every `.md` under the vault.
   * The whole-vault map (not a single-file probe) is what can actually catch a
   * rewrite: names added, removed, or bytes changed all show up in the diff.
   */
  function snapshotVault(vaultDir: string): Record<string, string> {
    const snapshot: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.name.endsWith('.md')) {
          snapshot[path.relative(vaultDir, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
        }
      }
    };
    walk(vaultDir);
    return snapshot;
  }

  /** Reads the `depends_on` id array from a note's YAML frontmatter. */
  function dependsOn(vaultDir: string, rel: string): string[] {
    const deps = frontmatterOf(vaultDir, rel).depends_on;
    return Array.isArray(deps) ? deps.map(String) : [];
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

  // Two already-adopted notes whose hand-authored `depends_on` graph the
  // reproduction in the issue erased.
  const ADOPTED_ALPHA = `---
palee_id: T-alpha-1
palee_schema: 1
title: Alpha
difficulty: beginner
depends_on: []
ease_factor: 2.1
interval_days: 6
repetition: 2
lapses: 1
due_at: '2026-09-10'
---
# Alpha
`;

  const ADOPTED_BETA = `---
palee_id: T-beta-1
palee_schema: 1
title: Beta
difficulty: intermediate
depends_on: [T-alpha-1]
ease_factor: 2.3
interval_days: 8
repetition: 3
lapses: 0
due_at: '2026-09-12'
---
# Beta
`;

  test('wikilink roadmap chains notes, replaces hand-written deps, preserves SM-2', () => {
    const { vaultDir, configDir } = freshVault({
      'tracks/alpha.md': REVIEWED_ALPHA,
      'tracks/beta.md': '# Beta\n',
      'tracks/gamma.md': '# Gamma\n',
      'roadmap.md': `---\npalee_roadmap: true\n---\n# Roadmap\n\n## Track One\n\n- [[tracks/alpha]]\n- [[Beta]]\n- [[gamma#intro]]\n`,
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
      'roadmap.md': '---\npalee_roadmap: true\n---\n# Roadmap\n\n## Track\n\n- [[tracks/alpha]]\n- [[no-such-note]]\n',
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
      'roadmap.md': '---\npalee_roadmap: true\n---\n# Roadmap\n\n## Track\n\n- [[dup]]\n',
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
    // Honest count (INV-47 / PAL-205-A6): id2->id1 and id3->id2 synthesized;
    // id1 keeps its authored dep and the head counts nothing.
    assert.match(result.stdout, /Auto-chain: 2 chain edge\(s\) synthesized across 3 roadmap topics\./);

    // Explicit non-empty depends_on wins over the chain (points outside the roadmap: no cycle)
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'n/1.md').depends_on, [id0]);
    // Unordered topic keeps file order, appended after ordered ones
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'n/2.md').depends_on, [id1]);
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'n/3.md').depends_on, [id2]);
  });

  // Regression (#73 autofix): `--auto-chain` is scoped to YAML / frontmatter /
  // code-block roadmaps (INV-47, docs/02-1 options table). A wikilink roadmap
  // arrives already chained per `## Track` section, so running the pass over it
  // read each section head's explicit `depends_on: []` as "not chained yet" and
  // hung the second track's head off the first track's tail — silently fusing
  // independent tracks in the vault.
  test('--auto-chain does not fuse independent wikilink tracks', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/01-foundations/01-alpha.md': '# Alpha\n',
      'MODULES/01-foundations/02-beta.md': '# Beta\n',
      'MODULES/02-advanced/01-gamma.md': '# Gamma\n',
      'roadmap.md':
        '---\npalee_roadmap: true\n---\n# Roadmap\n\n' +
        '## Foundations\n\n- [[MODULES/01-foundations/01-alpha]]\n- [[MODULES/01-foundations/02-beta]]\n\n' +
        '## Advanced\n\n- [[MODULES/02-advanced/01-gamma]]\n',
    });
    const result = runCLI(['roadmap', '--from', path.join(vaultDir, 'roadmap.md'), '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Resolved 3 wikilink topics/);

    const alphaId = String(frontmatterOf(vaultDir, 'MODULES/01-foundations/01-alpha.md').palee_id);
    const betaId = String(frontmatterOf(vaultDir, 'MODULES/01-foundations/02-beta.md').palee_id);
    // Track 1 keeps its own chain: beta depends on alpha, nothing more.
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/02-beta.md'), [alphaId]);
    // Both section heads stay independent.
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/01-alpha.md'), []);
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/02-advanced/01-gamma.md'),
      [],
      `01-gamma must stay the head of its own track, but it was chained onto ${betaId} (02-beta)`
    );
    // The pass is not run at all for this format.
    assert.doesNotMatch(result.stdout, /Auto-chain:/);
  });

  // Pins INV-47's other half, reported by the reviewer as a live defect: "an
  // unordered topic must be slotted after ALL ordered ones" (docs/02-1 options
  // table; `RoadmapOptions.autoChain` in src/types.ts).
  //
  // The discriminator is multi-digit `order`: a lexicographic sort of the
  // stringified order would give '10' < '2' < 'zzz' -> T-e10, T-e2, T-eu, so
  // the unordered topic would end up chained onto T-e2. A numeric sort with
  // unordered last gives T-e2, T-e10, T-eu -> the unordered topic chained onto
  // T-e10. These two outcomes are distinguishable only by the assertion on
  // c.md below.
  test('--auto-chain slots unordered topics after all ordered ones (INV-47)', () => {
    const { vaultDir, configDir } = freshVault({
      'e/a.md': '# A\n',
      'e/b.md': '# B\n',
      'e/c.md': '# C\n',
    });
    const yamlPath = path.join(vaultDir, 'order.yaml');
    fs.writeFileSync(
      yamlPath,
      'topics:\n' +
        '  - id: T-e2\n    title: A\n    path: e/a.md\n    order: 2\n' +
        '  - id: T-e10\n    title: B\n    path: e/b.md\n    order: 10\n' +
        '  - id: T-eu\n    title: C\n    path: e/c.md\n'
    );
    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    // 3 topics in one chain = 2 synthesized edges (head counts nothing; INV-47 honest count).
    assert.match(result.stdout, /Auto-chain: 2 chain edge\(s\) synthesized across 3 roadmap topics\./);

    assert.deepStrictEqual(dependsOn(vaultDir, 'e/a.md'), []);
    assert.deepStrictEqual(dependsOn(vaultDir, 'e/b.md'), ['T-e2']);
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'e/c.md'),
      ['T-e10'],
      'the unordered topic must be chained after every ordered one'
    );
  });

  // Regression (#73 autofix): the issue's reproduction, verbatim. `daily-log.md` is
  // an ordinary Obsidian note -- a heading plus two `[[...]]` bullets -- and used to
  // be imported as a curriculum, rewriting `depends_on` on both notes it pointed at.
  test('an ordinary note passed to --from is rejected with exit 2 and zero writes', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/beta.md': ADOPTED_BETA,
      'MODULES/alpha.md': ADOPTED_ALPHA,
      'daily-log.md': '# Daily log\n\n- reviewed [[MODULES/beta]] today\n- recap [[MODULES/alpha]]\n',
    });

    const before = snapshotVault(vaultDir);
    const result = runCLI(['roadmap', '--from', path.join(vaultDir, 'daily-log.md'), '-y'], configDir);

    // A file that was never a roadmap is a usage error (exit 2), not a validation
    // failure (exit 3) -- see the exit code contract in agent.md.
    assert.strictEqual(
      result.status,
      2,
      `expected exit 2, got ${result.status}\n--- stdout ---\n${result.stdout}--- stderr ---\n${result.stderr}`
    );
    assert.match(result.stderr, /Roadmap must have a "topics" array/);

    // The hand-authored prerequisite graph survives: beta still depends on alpha,
    // alpha still depends on nothing. Bullet order used to decide which list got erased.
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/beta.md'), ['T-alpha-1']);
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/alpha.md'), []);

    // And nothing else moved either: same file set, byte-identical content.
    assert.deepStrictEqual(snapshotVault(vaultDir), before);
  });

  // #73 review item 3, the reviewer's reproduction verbatim: `T-C` carries an
  // explicit dep on `T-A`, so chaining the unordered `T-A` onto `T-B` would
  // close A -> B -> C -> A. The flag must drop only that one synthesized edge,
  // warn about it, and let the import proceed with the rest of the chain —
  // rather than failing the whole roadmap closed over an edge nobody wrote.
  test('--auto-chain skips a cycle-closing chain edge and proceeds', () => {
    const { vaultDir, configDir } = freshVault({
      'r/a.md': '# A\n',
      'r/b.md': '# B\n',
      'r/c.md': '# C\n',
    });
    const yamlPath = path.join(vaultDir, 'cyc.yaml');
    fs.writeFileSync(
      yamlPath,
      'topics:\n' +
        '  - id: T-A\n    title: A\n    path: r/a.md\n' +
        '  - id: T-B\n    title: B\n    order: 2\n    path: r/b.md\n' +
        '  - id: T-C\n    title: C\n    order: 1\n    depends_on: [T-A]\n    path: r/c.md\n'
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /chain edge T-A -> T-B skipped: would close a cycle/);

    // The remaining chain survives; only the offending edge is gone.
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/c.md'), ['T-A'], 'authored dep must survive');
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/b.md'), ['T-C'], 'accepted chain edge must land');
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/a.md'), [], 'the skipped topic starts a new chain');
  });

  // PAL-205-A6: the `Auto-chain: … chained` summary used to print
  // `roadmap.topics.length`, inflating the count with the chain head, topics
  // whose authored dep won, and cycle-skipped edges that were never
  // synthesized. INV-47's honest-counting clause pins the summary to exactly
  // the synthesized-edge count, with skips visible separately.
  test('--auto-chain chained count is the honest synthesized-edge count on a cycle-containing vault (PAL-205-A6)', () => {
    const { vaultDir, configDir } = freshVault({
      'r/a.md': '# A\n',
      'r/b.md': '# B\n',
      'r/c.md': '# C\n',
    });
    const yamlPath = path.join(vaultDir, 'cyc-count.yaml');
    fs.writeFileSync(
      yamlPath,
      'topics:\n' +
        '  - id: T-A\n    title: A\n    path: r/a.md\n' +
        '  - id: T-B\n    title: B\n    order: 2\n    path: r/b.md\n' +
        '  - id: T-C\n    title: C\n    order: 1\n    depends_on: [T-A]\n    path: r/c.md\n'
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    // Sorted chain: T-C(1) -> T-B(2) -> T-A(unordered). T-C is the head (0 edges),
    // T-B synthesizes B->C, T-A's edge onto T-B is skipped (would close
    // A -> B -> C -> A). Honest count: exactly 1 synthesized edge.
    assert.match(
      result.stdout,
      /Auto-chain: 1 chain edge\(s\) synthesized across 3 roadmap topics\./
    );
    assert.doesNotMatch(
      result.stdout,
      /Auto-chain: [23] chain edge\(s\) synthesized/,
      'the head and the cycle-skipped edge must never be counted as chained'
    );
    // Skipped edges stay visible in the output even though they are not counted.
    assert.match(result.stdout, /chain edge T-A -> T-B skipped: would close a cycle/);
    assert.match(result.stdout, /1 chain edge\(s\) skipped to keep the graph acyclic\./);
  });

  // #73 review item 3, other half: `Auto-chain: N roadmap topics chained by
  // order.` fired before the graph was validated, so a rejected chain still
  // announced itself as fact. It is now logged only once validation has passed.
  test('--auto-chain logs the chained count only after validation passes', () => {
    const { vaultDir, configDir } = freshVault({
      'r/a.md': '# A\n',
      'r/b.md': '# B\n',
    });
    const yamlPath = path.join(vaultDir, 'authored-cycle.yaml');
    fs.writeFileSync(
      yamlPath,
      'topics:\n' +
        '  - id: T-X\n    title: X\n    order: 1\n    path: r/a.md\n    depends_on: [T-Y]\n' +
        '  - id: T-Y\n    title: Y\n    order: 2\n    path: r/b.md\n    depends_on: [T-X]\n'
    );
    const before = snapshotVault(vaultDir);

    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /Dependency cycle detected: T-X → T-Y → T-X/);
    assert.doesNotMatch(
      result.stdout,
      /chained by order/,
      'a chain the validator rejected must not report itself as chained'
    );
    assert.doesNotMatch(result.stdout, /Roadmap validated successfully/);
    assert.deepStrictEqual(snapshotVault(vaultDir), before, 'zero writes on validation failure');
  });

  // A skipped edge must not fragment the rest of the chain. Here `T-A` is mid
  // list, so its edge onto `T-B` would close A -> B -> C -> A; dropping it makes
  // `T-A` a new head, and the topic after it (`T-D`) still chains onto `T-A`
  // rather than being orphaned or restarting from scratch.
  test('--auto-chain continues the chain past a topic whose edge was skipped', () => {
    const { vaultDir, configDir } = freshVault({});
    const yamlPath = path.join(vaultDir, 'mid.yaml');
    fs.writeFileSync(
      yamlPath,
      'topics:\n' +
        '  - id: T-C\n    title: C\n    order: 1\n    depends_on: [T-A]\n    path: r/c.md\n' +
        '  - id: T-B\n    title: B\n    order: 2\n    path: r/b.md\n' +
        '  - id: T-A\n    title: A\n    order: 3\n    path: r/a.md\n' +
        '  - id: T-D\n    title: D\n    order: 4\n    path: r/d.md\n'
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /chain edge T-A -> T-B skipped: would close a cycle/);
    assert.match(result.stdout, /1 chain edge\(s\) skipped to keep the graph acyclic\./);

    assert.deepStrictEqual(dependsOn(vaultDir, 'r/c.md'), ['T-A']);
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/b.md'), ['T-C']);
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/a.md'), [], 'the skipped topic becomes a head');
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/d.md'), ['T-A'], 'the chain continues from the new head');
  });

  // The chain's own reachability view covers only the roadmap's topics, so a
  // loop that closes through a pre-existing vault note is still caught by the
  // merged-graph validator. When that happens the report must say which hops
  // the flag invented -- the learner authored a single dependency here.
  test('--auto-chain labels synthesized edges in a cycle report', () => {
    const { vaultDir, configDir } = freshVault({
      'r/e.md': [
        '---',
        'palee_id: T-E',
        'palee_schema: 1',
        'title: E',
        'depends_on: [T-C]',
        '---',
        '',
        '# E',
        '',
      ].join('\n'),
    });
    const yamlPath = path.join(vaultDir, 'mixed.yaml');
    fs.writeFileSync(
      yamlPath,
      'topics:\n' +
        '  - id: T-A\n    title: A\n    order: 1\n    path: r/a.md\n    depends_on: [T-E]\n' +
        '  - id: T-B\n    title: B\n    order: 2\n    path: r/b.md\n' +
        '  - id: T-C\n    title: C\n    order: 3\n    path: r/c.md\n'
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /Dependency cycle detected:/);
    assert.match(result.stderr, /synthesized by --auto-chain/);
    assert.match(result.stderr, /T-C → T-B/);
    assert.match(result.stderr, /the rest are authored/);
    assert.doesNotMatch(result.stdout, /chained by order/);
    assert.ok(!fs.existsSync(path.join(vaultDir, 'r/b.md')), 'no roadmap note may be written');
    assert.ok(!fs.existsSync(path.join(vaultDir, 'r/c.md')), 'no roadmap note may be written');
    assert.deepStrictEqual(dependsOn(vaultDir, 'r/e.md'), ['T-C'], 'the pre-existing note is untouched');
  });
});
