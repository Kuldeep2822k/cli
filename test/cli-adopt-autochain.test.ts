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

  /** Reads the `depends_on` id array from a note's YAML frontmatter. */
  function dependsOn(vaultDir: string, rel: string): string[] {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    const deps = frontmatter?.depends_on;
    return Array.isArray(deps) ? deps.map(String) : [];
  }

  /** YAML frontmatter of an already-adopted note with a fixed id and no deps. */
  function adoptedNote(title: string, id: string): string {
    return ['---', `palee_id: ${id}`, 'palee_schema: 1', `title: ${title}`, 'depends_on: []', '---', '', `# ${title}`, ''].join('\n');
  }

  /**
   * Parses a dry-run's `Planned dependency chain` section into the write plan
   * it promises: one entry per note the commit will touch.
   */
  function plannedEdges(stdout: string): { path: string; dependsOn: string | null }[] {
    const lines = stdout.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith('Planned dependency chain'));
    assert.ok(start >= 0, `dry-run must print a Planned dependency chain section:\n${stdout}`);
    const edges: { path: string; dependsOn: string | null }[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') {
        break;
      }
      const dep = /^ {2}• (\S+) depends on (\S+)$/.exec(line);
      if (dep) {
        edges.push({ path: dep[1], dependsOn: dep[2] });
        continue;
      }
      const head = /^ {2}• (\S+) \(chain head\)$/.exec(line);
      if (head) {
        edges.push({ path: head[1], dependsOn: null });
        continue;
      }
      break;
    }
    return edges;
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

    // Plan 006 variant A: the chain no longer restarts at the batch boundary —
    // b bridges onto a's existing on-disk id rather than becoming a head.
    const ids = idToPath(vaultDir);
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/01-foundations/02-b.md').map((id) => ids.get(id)),
      ['MODULES/01-foundations/01-a.md']
    );
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

  // Regression (#73, plan 006 variant A, INV-46): an already-adopted note inside
  // the scanned scope must become the chain predecessor of the first new note
  // that follows it, instead of the chain restarting at every batch. The
  // adopted note itself is used but never rewritten.
  test('already-adopted notes in scope are bridged over and never rewritten', () => {
    const sysFixture = [
      '---',
      'palee_id: T-EXISTING-1',
      'palee_schema: 1',
      'title: Systems',
      'depends_on: []',
      '---',
      '',
      '# Systems',
      '',
    ].join('\n');

    const { vaultDir, configDir } = freshVault({
      'MODULES/01-foundations/01-sys.md': sysFixture,
      'MODULES/01-foundations/02-lab.md': '# Lab\n',
      'MODULES/02-linux/01-kern.md': '# Kernel\n',
    });

    // A3: the dry-run is how a user checks the bridge before committing, so it
    // must preview the edge onto the already-adopted note, not just the edges
    // between notes being written.
    const dry = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /01-sys/);
    assert.match(
      dry.stdout,
      /01-foundations\/02-lab\.md depends on MODULES\/01-foundations\/01-sys\.md/
    );
    assert.strictEqual(
      fs.readFileSync(path.join(vaultDir, 'MODULES/01-foundations/02-lab.md'), 'utf8'),
      '# Lab\n',
      'dry-run must not adopt 02-lab.md'
    );

    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);

    // The bridge: the first new note depends on the already-adopted note's
    // existing id — not on a freshly minted one.
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/02-lab.md'), ['T-EXISTING-1']);

    // And the chain continues from there across the module boundary.
    const ids = idToPath(vaultDir);
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/02-linux/01-kern.md').map((id) => ids.get(id)),
      ['MODULES/01-foundations/02-lab.md']
    );

    // Only the two unadopted notes are written, so the edge count stays honest.
    assert.match(result.stdout, /Successfully adopted 2 notes/);
    assert.match(result.stdout, /Auto-chained: 2 dependency edges wired across 2 notes\./);

    // "Never rewritten", asserted at byte level: the pre-adopted note is
    // bit-for-bit the fixture, with its hand-written id intact.
    assert.strictEqual(
      fs.readFileSync(path.join(vaultDir, 'MODULES/01-foundations/01-sys.md'), 'utf8'),
      sysFixture
    );
    assert.strictEqual(ids.get('T-EXISTING-1'), 'MODULES/01-foundations/01-sys.md');
    assert.strictEqual(ids.size, 3);
  });

  // What this actually guards: `planAutoChain` is fed the *whole vault* merged
  // with the batch, so a cycle that already exists on disk between two adopted
  // notes is visible to the check and must fail adoption closed — exit 3, zero
  // writes. The cycle here (T-SYS <-> T-LAB) is pre-existing fixture data; the
  // test passes whether or not plan 006's new -> existing bridge is emitted, so
  // it is not bridge coverage. The bridge itself is covered by the test at line
  // 214 ('already-adopted notes in scope are bridged over and never rewritten').
  //
  // A cycle created *by* a bridge edge is unconstructible, so there is no test
  // to write for it: the new note's id is minted at plan time from
  // `crypto.randomBytes`, so no pre-existing on-disk `depends_on` can name it,
  // and `buildEdgeMap` drops edges to unknown ids. Do not spend time trying.
  test('a pre-existing vault cycle blocks adoption with exit 3 and zero writes', () => {
    const cycleFiles: Record<string, string> = {
      'MODULES/01-foundations/01-sys.md': [
        '---',
        'palee_id: T-SYS',
        'palee_schema: 1',
        'title: Systems',
        'depends_on: [T-LAB]',
        '---',
        '',
        '# Systems',
        '',
      ].join('\n'),
      'MODULES/01-foundations/02-lab.md': [
        '---',
        'palee_id: T-LAB',
        'palee_schema: 1',
        'title: Lab',
        'depends_on: [T-SYS]',
        '---',
        '',
        '# Lab',
        '',
      ].join('\n'),
      'MODULES/02-linux/01-kern.md': '# Kernel\n',
      'MODULES/02-linux/02-drivers.md': '# Drivers\n',
    };

    const { vaultDir, configDir } = freshVault(cycleFiles);

    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 3, `expected exit 3, got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /auto-chain dependency graph contains cycles/);
    // The cycle is attributed to the two adopted notes it actually runs through.
    assert.match(result.stderr, /T-SYS/);
    assert.match(result.stderr, /T-LAB/);
    assert.doesNotMatch(result.stdout, /Successfully adopted/);

    // Zero writes: every note in scope is still byte-for-byte the fixture.
    for (const [rel, text] of Object.entries(cycleFiles)) {
      assert.strictEqual(
        fs.readFileSync(path.join(vaultDir, rel), 'utf8'),
        text,
        `${rel} must not be modified`
      );
    }
  });

  // #73 review item 1: the dry-run preview used to print
  // `chainPlan.predecessorOf`, which spans every note in the scanned scope —
  // including already-adopted ones the commit never rewrites. On a mixed vault
  // it listed 7 edges that would never be applied, indistinguishable from the 2
  // real ones. The preview is now the write plan, with bridged notes broken out.
  test('dry-run previews exactly the edges it will write, and matches the commit', () => {
    const adopted: Record<string, string> = {
      'MODULES/01-foundations/01-a.md': adoptedNote('A', 'T-ADP-1'),
      'MODULES/01-foundations/02-b.md': adoptedNote('B', 'T-ADP-2'),
      'MODULES/01-foundations/03-c.md': adoptedNote('C', 'T-ADP-3'),
      'MODULES/01-foundations/04-d.md': adoptedNote('D', 'T-ADP-4'),
      'MODULES/01-foundations/05-e.md': adoptedNote('E', 'T-ADP-5'),
      'MODULES/02-linux/01-f.md': adoptedNote('F', 'T-ADP-6'),
      'MODULES/02-linux/02-g.md': adoptedNote('G', 'T-ADP-7'),
    };
    const newRel = ['MODULES/02-linux/03-h.md', 'MODULES/03-labs/01-i.md'];
    const { vaultDir, configDir } = freshVault({
      ...adopted,
      'MODULES/02-linux/03-h.md': '# H\n',
      'MODULES/03-labs/01-i.md': '# I\n',
    });

    const dry = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stderr);

    const edges = plannedEdges(dry.stdout);
    assert.strictEqual(
      edges.length,
      2,
      `7 already-adopted notes must not appear as edges; got ${JSON.stringify(edges)}`
    );
    assert.deepStrictEqual(edges.map((e) => e.path), newRel);
    // The bridge onto the adopted tail, then the chain continuing past it.
    assert.strictEqual(edges[0].dependsOn, 'MODULES/02-linux/02-g.md');
    assert.strictEqual(edges[1].dependsOn, 'MODULES/02-linux/03-h.md');

    // Adopted notes are still disclosed — as bridged predecessors, not as writes.
    assert.match(dry.stdout, /Bridged over/);
    const bridged = dry.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('  = '))
      .map((line) => line.slice(4));
    assert.deepStrictEqual(bridged.sort(), Object.keys(adopted).sort());

    // A dry run stays a dry run.
    for (const rel of newRel) {
      assert.strictEqual(
        fs.readFileSync(path.join(vaultDir, rel), 'utf8'),
        rel.endsWith('h.md') ? '# H\n' : '# I\n',
        `${rel} must not be modified by --dry-run`
      );
    }

    // The preview is the plan: commit and compare what actually landed.
    const committed = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(committed.status, 0, committed.stderr);
    const ids = idToPath(vaultDir);
    const written = [...ids.entries()]
      .filter(([, rel]) => !Object.keys(adopted).includes(rel))
      .map(([, rel]) => ({
        path: rel,
        dependsOn: dependsOn(vaultDir, rel).map((depId) => ids.get(depId) ?? null)[0] ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    assert.deepStrictEqual(written, [...edges].sort((a, b) => a.path.localeCompare(b.path)));
  });

  // #73 review item 2: the fail-closed cycle report is the only thing a user
  // sees, and opaque `T-...` ids are undiagnosable in a 300-note vault.
  test('cycle diagnostics name vault-relative paths and point at palee validate', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/01-foundations/01-sys.md': [
        '---',
        'palee_id: T-SYS',
        'palee_schema: 1',
        'title: Systems',
        'depends_on: [T-LAB]',
        '---',
        '',
        '# Systems',
        '',
      ].join('\n'),
      'MODULES/01-foundations/02-lab.md': [
        '---',
        'palee_id: T-LAB',
        'palee_schema: 1',
        'title: Lab',
        'depends_on: [T-SYS]',
        '---',
        '',
        '# Lab',
        '',
      ].join('\n'),
      'MODULES/02-linux/01-kern.md': '# Kernel\n',
    });

    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 3, `expected exit 3, got ${result.status}: ${result.stdout}`);
    // Paths, with the id kept alongside for cross-referencing validate output.
    assert.match(result.stderr, /MODULES\/01-foundations\/01-sys\.md \(T-SYS\)/);
    assert.match(result.stderr, /MODULES\/01-foundations\/02-lab\.md \(T-LAB\)/);
    assert.match(result.stderr, /palee validate/);
    // The loop is authored data, not something the flag invented.
    assert.match(result.stderr, /pre-existing vault dependencies, not chain-synthesized/);
    assert.doesNotMatch(result.stdout, /Successfully adopted/);
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MODULES/02-linux/01-kern.md'), 'utf8'))
        .frontmatter?.palee_id,
      undefined,
      'zero writes on a cycle'
    );
  });

  // #73 review item 5 + PAL-205-B7. The warning used to say the predecessor
  // "is out of scope", which sent users to the wrong debug path — the
  // predecessor IS in scope, it simply has no `palee_id` that `loadTopics`
  // could resolve (here: a numeric frontmatter id, which the batch scan accepts
  // and the loader rejects).
  //
  // B7 supersedes the diagnostic itself: an unsatisfiable predecessor is now
  // caught at classification time and reported as a counted Tier-0 skip, so it
  // can never silently block whatever chains after it. The assertions item 5
  // existed to protect (accurate wording, exit 0, dependent still adopts with an
  // empty depends_on) are all kept.
  test('unresolvable chain predecessor is a counted Tier-0 skip, not a silent block', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/01-foundations/01-broken.md': [
        '---',
        'palee_id: 12345',
        'palee_schema: 1',
        'title: Broken',
        'depends_on: []',
        '---',
        '',
        '# Broken',
        '',
      ].join('\n'),
      'MODULES/01-foundations/02-next.md': '# Next\n',
    });

    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '--verbose', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Invalid palee_id: 1 notes \(not adopted, not chained\)/);
    assert.match(
      result.stdout,
      /palee_id is not a usable string \(B7\):[\s\S]*MODULES\/01-foundations\/01-broken\.md/
    );
    assert.doesNotMatch(result.stdout, /is out of scope/);
    // The dependent note still adopts, with an empty depends_on as promised.
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/02-next.md'), []);
    // The unsatisfiable note is left exactly as found: never rewritten.
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MODULES/01-foundations/01-broken.md'), 'utf8'))
        .frontmatter?.palee_id,
      12345,
      'an invalid palee_id is reported, not repaired in place'
    );
  });

  // PAL-205-B1..B6: Tier-0 hygiene must keep repo noise, translation copies and
  // phase subtrees out of the written graph, and say so on the dry-run screen.
  test('Tier-0 hygiene excludes noise from the plan and reports per-rule counts', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/LICENSE.md': '# License\n',
      'MODULES/translations/01-setup.es.md': '# Copia\n',
      'MODULES/01-foundations/01-setup.md': '# Setup\n',
      'MODULES/01-foundations/02-first-app.md': '# First app\n',
      'MODULES/01-foundations/for-teachers.md': '# Teachers\n',
      'MODULES/01-foundations/solutions/01-solution.md': '# Solution\n',
    });

    const dry = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run', '--verbose'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Tier-0 hygiene:/);
    assert.match(dry.stdout, /Backbone:\s+\d+ notes \(may gate the chain\)/);
    assert.match(dry.stdout, /Leaves:\s+\d+ notes \(attached, never gate\)/);
    assert.match(dry.stdout, /Phase subtrees: 1 notes collapsed to leaves/);
    assert.match(
      dry.stdout,
      /Skipped by Tier-0 hygiene \(translation\):[\s\S]*translations\/01-setup\.es\.md/
    );

    const run = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);

    // path -> id, derived from the canonical id -> path map.
    const idOf = (rel: string): string => {
      for (const [id, p] of idToPath(vaultDir)) {
        if (p === rel) return id;
      }
      return `missing:${rel}`;
    };
    const adoptedPaths = new Set(idToPath(vaultDir).values());

    assert.ok(adoptedPaths.has('MODULES/01-foundations/01-setup.md'));
    assert.ok(adoptedPaths.has('MODULES/01-foundations/02-first-app.md'));
    assert.ok(adoptedPaths.has('MODULES/01-foundations/for-teachers.md'), 'a leaf is still adopted');
    assert.ok(adoptedPaths.has('MODULES/01-foundations/solutions/01-solution.md'));

    // The gating spine is lesson -> lesson only.
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/01-setup.md'), []);
    assert.deepStrictEqual(
      dependsOn(vaultDir, 'MODULES/01-foundations/02-first-app.md'),
      [idOf('MODULES/01-foundations/01-setup.md')]
    );

    // Nothing may gate the chain off a leaf or a phase subtree.
    const gating = new Set<string>();
    for (const rel of adoptedPaths) {
      for (const dep of dependsOn(vaultDir, rel)) gating.add(dep);
    }
    assert.ok(!gating.has(idOf('MODULES/01-foundations/for-teachers.md')));
    assert.ok(!gating.has(idOf('MODULES/01-foundations/solutions/01-solution.md')));
  });

  // Coverage must never be thrown away silently: when hygiene filters remove
  // everything, the screen still has to account for every scanned file.
  test('hygiene accounts for every note even when nothing survives to chain', () => {
    const { configDir } = freshVault({
      'MODULES/LICENSE.md': '# License\n',
      'MODULES/translations/README.es.md': '# Copia\n',
    });

    const dry = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Ready to Adopt:\s+0 notes/);
    assert.match(dry.stdout, /Tier-0 hygiene:/);
    assert.match(dry.stdout, /Skipped \(meta\): 1 notes/);
    assert.match(dry.stdout, /Skipped \(translations\): 1 notes/);
    assert.match(dry.stdout, /Excluded total: 2 notes/);
    assert.match(dry.stdout, /Nothing left to chain/);
  });

  // ── PAL-205-C: TOC tier, --auto-chain=strict|toc|full, depends_on_source ──

  /** Reads the `depends_on_source` label written for a note (C5). */
  function dependsOnSource(vaultDir: string, rel: string): string | undefined {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    const v = frontmatter?.depends_on_source;
    return typeof v === 'string' ? v : undefined;
  }

  /** An unnumbered curriculum: order lives only in the README enumeration. */
  const tocFiles: Record<string, string> = {
    'README.md': [
      '# Course',
      '1. [Intro](guide/intro.md)',
      '2. [Core](guide/core.md)',
      '3. [Wrap-up](guide/wrapup.md)',
      '',
    ].join('\n'),
    'guide/intro.md': '# Intro\n',
    'guide/core.md': '# Core\n',
    'guide/wrapup.md': '# Wrap\n',
  };

  test('TOC tier chains an unnumbered layout and labels edges toc', () => {
    const { vaultDir, configDir } = freshVault(tocFiles);
    const result = runCLI(['adopt', '--all', '--auto-chain=full', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    const ids = idToPath(vaultDir);
    const pathOf = (id: string): string => {
      const p = ids.get(id);
      assert.ok(p, `unknown id ${id}`);
      return p;
    };
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/intro.md'), []);
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/core.md').map(pathOf), ['guide/intro.md']);
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/wrapup.md').map(pathOf), ['guide/core.md']);
    assert.strictEqual(dependsOnSource(vaultDir, 'guide/core.md'), 'toc');
    assert.strictEqual(dependsOnSource(vaultDir, 'guide/wrapup.md'), 'toc');
    assert.strictEqual(dependsOnSource(vaultDir, 'guide/intro.md'), undefined, 'chain head carries no source label');
    assert.strictEqual(dependsOnSource(vaultDir, 'README.md'), undefined);
  });

  test('C-defect-1: singleton README enumeration keeps the justified edge, no false refusal', () => {
    // The ciu repro shape: root README enumerating exactly one adoptable
    // note at the vault root. Full tier must still write README -> note,
    // labeled numbered, and must NOT print the no-TOC-links refusal.
    const files: Record<string, string> = {
      'README.md': '# Course\n\n- [Resources](programming-language-resources.md)\n',
      'programming-language-resources.md': '# Resources\n',
    };
    const { vaultDir, configDir } = freshVault(files);
    const result = runCLI(['adopt', '--all', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    const ids = idToPath(vaultDir);
    const readmeId = [...ids.entries()].find(([, p]) => p === 'README.md')?.[0];
    assert.ok(readmeId, 'README adopted');
    assert.deepStrictEqual(dependsOn(vaultDir, 'programming-language-resources.md'), [readmeId]);
    assert.strictEqual(dependsOnSource(vaultDir, 'programming-language-resources.md'), 'numbered');
    assert.doesNotMatch(result.stdout, /no README TOC links/);
  });

  test('strict tier never consumes TOC edges', () => {
    const { vaultDir, configDir } = freshVault(tocFiles);
    const result = runCLI(['adopt', '--all', '--auto-chain=strict', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    // Under strict the guide notes are unnumbered-dir leaves; since the
    // PAL-205-B rework an unjustified alphabetical cross-dir transition may
    // not gate, so each opens its own chain. The point stands: no note ever
    // follows the README's intro → core → wrapup order, and nothing carries
    // a `toc` label.
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/core.md'), []);
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/intro.md'), []);
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/wrapup.md'), []);
    assert.notStrictEqual(dependsOnSource(vaultDir, 'guide/core.md'), 'toc', 'no toc labels under strict');
  });

  test('numbering dominance (C2): README order cannot flip numbered edges', () => {
    const files: Record<string, string> = {
      'README.md': [
        '- [second](02-b.md)',
        '- [first](01-a.md)',
      ].join('\n'),
      '01-a.md': '# A\n',
      '02-b.md': '# B\n',
    };
    const { vaultDir, configDir } = freshVault(files);
    const result = runCLI(['adopt', '--all', '--auto-chain=full', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    const ids = idToPath(vaultDir);
    // Numbering says 01-a → 02-b even though the README enumerates backwards.
    assert.deepStrictEqual(dependsOn(vaultDir, '02-b.md').map((id) => ids.get(id)), ['01-a.md']);
    assert.strictEqual(dependsOnSource(vaultDir, '02-b.md'), 'numbered');
  });

  test('honest refusal: zero order signals prints the roadmap pointer and exits 0', () => {
    const files: Record<string, string> = {
      'notes/loose-a.md': '# A\n',
      'notes/loose-b.md': '# B\n',
    };
    const { vaultDir, configDir } = freshVault(files);
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.match(
      dry.stdout,
      /0 edges \(no numbered layout, no README TOC links\) — consider palee roadmap/
    );
    const commit = runCLI(['adopt', '--all', '--auto-chain', '-y'], configDir);
    assert.strictEqual(commit.status, 0, commit.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'notes/loose-b.md'), []);
  });

  test('unknown --auto-chain tier is a usage error (exit 2)', () => {
    const { configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES', '--auto-chain=banana', '--dry-run'], configDir);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /expects one of: strict, toc, full/);
  });

  test('bare --auto-chain stays backward compatible (defaults to full)', () => {
    const { configDir } = freshVault(chainFiles);
    const bare = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /Auto-chain:.*full tier/);
  });

  test('C5 round trip: an old-reader parse of a depends_on_source file still loads the topic', () => {
    const { vaultDir, configDir } = freshVault(tocFiles);
    const result = runCLI(['adopt', '--all', '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    // The old-reader contract: parseFrontmatter (unchanged since before C5)
    // must surface the palee fields and simply carry the unknown key.
    const raw = fs.readFileSync(path.join(vaultDir, 'guide/core.md'), 'utf8');
    const { frontmatter } = parseFrontmatter(raw);
    assert.ok(typeof frontmatter?.palee_id === 'string' && frontmatter.palee_id.length > 0);
    assert.ok(Array.isArray(frontmatter?.depends_on));
    assert.strictEqual(frontmatter?.depends_on_source, 'toc');
    // And a downstream command must still read the vault without tripping.
    const validate = runCLI(['validate'], configDir);
    assert.strictEqual(validate.status, 0, validate.stdout + validate.stderr);
  });
});
