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

  // The excluded note used to be named `template.md`, which Tier-0 hygiene also
  // drops — so the fixture could not tell which of the two mechanisms bridged it
  // over, and read like a test of the template rule while exercising `--exclude`.
  // A name hygiene leaves alone makes the exclusion the only possible cause.
  test('excluded notes are bridged over in the chain', () => {
    const { vaultDir, configDir } = freshVault({
      ...chainFiles,
      'MODULES/01-foundations/appendix-notes.md': '# Notes\n',
    });
    const result = runCLI(
      ['adopt', 'MODULES', '--auto-chain', '--exclude', '*appendix-notes*', '-y'],
      configDir
    );
    assert.strictEqual(result.status, 0, result.stderr);
    const ids = idToPath(vaultDir);
    // `ids` is keyed by palee_id with paths as values, so `ids.has(path)` could
    // never be true and asserted nothing. Check the values, and the note itself:
    // an adopted note carries a `palee_id`.
    assert.ok(
      ![...ids.values()].includes('MODULES/01-foundations/appendix-notes.md'),
      '--exclude was ignored and the note was adopted'
    );
    assert.ok(
      !parseFrontmatter(
        fs.readFileSync(path.join(vaultDir, 'MODULES/01-foundations/appendix-notes.md'), 'utf8')
      ).frontmatter?.palee_id,
      'the excluded note was adopted anyway'
    );
    // Proof it was `--exclude` and not hygiene: hygiene would have counted the
    // note as skipped, and reports a skip it acted on.
    assert.match(result.stdout, /Skipped \(meta\): 0 notes/);
    assert.match(result.stdout, /Skipped \(template\): 0 notes/);
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

  // ── PAL-205-C: TOC tier, --chain-tier strict|toc|full, depends_on_source ──

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
    const result = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    // The refusal is keyed on edges written, so a plan with TOC edges in it must
    // not reach that branch — otherwise dropping that one condition from
    // `chainRefused` would keep the whole suite green while the CLI told the
    // learner to go and write a roadmap for a chain it had just built.
    assert.doesNotMatch(result.stdout, /0 edges \(no numbered layout/);
    assert.match(result.stdout, /Auto-chain:\s+enabled \(full tier — 2 edge\(s\) written: 0 numbered, 2 toc\)/);
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

  test('an enumeration-chained vault still offers every note to palee plan', () => {
    // The blast radius of a false edge: `intro → core → wrapup` is the README's
    // order, not a prerequisite claim, and nothing in v0.5.x raises
    // `topic_mastery`, so gating on it left the head of the chain as the only
    // note the learner could ever be shown.
    const { vaultDir, configDir } = freshVault(tocFiles);
    const adopted = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
    assert.strictEqual(adopted.status, 0, adopted.stderr);
    assert.strictEqual(dependsOnSource(vaultDir, 'guide/wrapup.md'), 'toc', 'the edges really are enumeration-made');
    // All three chained notes are leaves, and the TOC tier still walks its spine
    // through them — which is what made `Leaves: … (attached, never gate)` a
    // false claim before the edges they author became advisory. Pinned here
    // because the line is only true as long as nothing a leaf precedes is gated.
    assert.match(adopted.stdout, /Leaves:\s+3 notes \(attached, never gate\)/);

    const ids = idToPath(vaultDir);
    const plan = runCLI(['plan', '--json'], configDir);
    assert.strictEqual(plan.status, 0, plan.stdout + plan.stderr);
    const ready: string[] = JSON.parse(plan.stdout).ready_to_learn.map((t: { id: string }) => t.id);

    for (const rel of ['guide/intro.md', 'guide/core.md', 'guide/wrapup.md']) {
      const id = [...ids.entries()].find(([, p]) => p === rel)?.[0];
      assert.ok(id, `${rel} adopted`);
      assert.ok(ready.includes(id), `${rel} is hidden from the plan by an edge the README invented`);
    }
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
    // Positive rather than a matched absence: this run writes exactly one
    // numbered edge, so any report other than `enabled … 1 numbered` is a lie,
    // whichever refusal wording the CLI reached for.
    assert.match(result.stdout, /enabled \(strict tier — 1 edge\(s\) written: 1 numbered, 0 toc\)/);
  });

  test('strict tier never consumes TOC edges', () => {
    const { vaultDir, configDir } = freshVault(tocFiles);
    const result = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'strict', '-y'], configDir);
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
    const result = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
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
      /0 edges \(no numbered layout, no chainable order signal\) — consider palee roadmap/
    );
    const commit = runCLI(['adopt', '--all', '--auto-chain', '-y'], configDir);
    assert.strictEqual(commit.status, 0, commit.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'notes/loose-b.md'), []);
  });

  test('tier advice is withheld when the other tiers would refuse too', () => {
    // The advice was keyed on the enumeration having links, so a README whose only
    // link is a note no tier will chain told the learner to `try --chain-tier toc`
    // — and toc refuses there for exactly the same reason, while the roadmap
    // pointer that does apply was suppressed.
    const unchainable = runCLI(
      ['adopt', '--all', '--auto-chain', '--dry-run'],
      freshVault({
        'README.md': '# Course\n\n- [Appendix](solution/appendix.md)\n',
        'solution/appendix.md': '# Appendix\n',
      }).configDir
    );
    assert.strictEqual(unchainable.status, 0, unchainable.stdout + unchainable.stderr);
    assert.doesNotMatch(
      unchainable.stdout,
      /does not read a README enumeration/,
      'switching tiers cannot help when no tier can chain what the README lists'
    );
    assert.match(unchainable.stdout, /no chainable order signal\) — consider palee roadmap/);

    // The advice a chainable enumeration does earn.
    const chainable = runCLI(
      ['adopt', '--all', '--auto-chain', '--dry-run'],
      freshVault(tocFiles).configDir
    );
    assert.strictEqual(chainable.status, 0, chainable.stdout + chainable.stderr);
    assert.match(chainable.stdout, /does not read a README enumeration\) — try --chain-tier toc/);
  });

  test('an unchainable README link is a refusal, not a silent zero-edge success', () => {
    // The README does enumerate something, and the tier still chains nothing:
    // a phase-subtree note is a leaf the TOC tier will not order. Reporting
    // `enabled … 0 edge(s) written` told the learner chaining had worked and
    // withheld the roadmap pointer that this vault actually needs.
    const { vaultDir, configDir } = freshVault({
      'README.md': '# Course\n\n- [Appendix](solution/appendix.md)\n',
      'solution/appendix.md': '# Appendix\n',
    });
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(
      dry.stdout,
      /0 edges \(no numbered layout, no chainable order signal\) — consider palee roadmap/,
      'a plan that writes nothing must not claim chaining is enabled'
    );
    assert.doesNotMatch(dry.stdout, /Auto-chain:\s+enabled/);
    const commit = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
    assert.strictEqual(commit.status, 0, commit.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'solution/appendix.md'), []);
  });

  test('a same-number tie is named in the warning instead of passing as numbering', () => {
    // `02-a` before `02-b` reads as a decision the learner made by numbering.
    // Both carry `02`, so the order between them came from their filenames and
    // the edge gates — the old report said nothing, because the tie is invisible
    // to `alphabeticalNotes` (both notes are numbered) and to
    // `directoryOrderAlphabetical` (there is only one directory).
    const { configDir } = freshVault({
      'm/02-a.md': '# A\n',
      'm/02-b.md': '# B\n',
    });
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(
      dry.stdout,
      /1 of 2 planned notes have the same number or phase as the note before them, so the order between them is alphabetical/
    );
    assert.match(dry.stdout, /e\.g\. m\/02-b\.md/);
    assert.ok(
      plannedEdges(dry.stdout).some((e) => e.path === 'm/02-b.md' && e.dependsOn === 'm/02-a.md'),
      'the tie still produces the edge; only the reporting was missing'
    );
  });

  test('notes the enumeration placed are not reported as a name tie', () => {
    // The composition recomposes both alphabetical claims: a README that
    // orders `02-a` before `02-b` has stated that order, so warning about the
    // filenames would contradict the edge list printed beside it.
    const { configDir } = freshVault({
      'README.md': '- [B](m/02-b.md)\n- [A](m/02-a.md)\n',
      'm/02-b.md': '# B\n',
      'm/02-a.md': '# A\n',
    });
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'toc', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.doesNotMatch(dry.stdout, /share a number or phase/);
  });

  test('a numbered layout with nothing left to chain is not called a missing signal', () => {
    // One note says "I am a numbered curriculum" and has no pair to order, so
    // the honest line is `enabled … 0 edge(s) written`. The `hasNumberedLayout`
    // conjunct is what keeps the refusal from claiming a numbered vault states
    // no order — remove it and every single-note module reports a missing
    // signal.
    const { vaultDir, configDir } = freshVault({ '01-only.md': '# Only\n' });
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.doesNotMatch(dry.stdout, /0 edges \(no numbered layout/);
    assert.match(dry.stdout, /Auto-chain:\s+enabled \(strict tier — 0 edge\(s\) written: 0 numbered, 0 toc\)/);
    const commit = runCLI(['adopt', '--all', '--auto-chain', '-y'], configDir);
    assert.strictEqual(commit.status, 0, commit.stderr);
    assert.doesNotMatch(commit.stdout, /0 edges \(no numbered layout/);
    assert.deepStrictEqual(dependsOn(vaultDir, '01-only.md'), []);
  });

  test('the hygiene report counts each skip reason it claims to count', () => {
    // No test anywhere asserted a single `Skipped (…)` line, so the whole
    // per-reason block was unobserved. `countFor` unions two sources — notes the
    // scan dropped on the way to adoption, and notes the planner excluded among
    // paths already adopted — and the second term is reachable only through an
    // already-adopted note, so nothing exercised it. Silencing the plan side
    // under-counts a learner's dropped files, which is the failure this report
    // exists to prevent.
    const { vaultDir, configDir } = freshVault({
      '01-a/01-x.md': '# X\n',
      '01-a/02-y.md': '# Y\n',
      'LICENSE.md': '# MIT\n',
      'README.ko-KR.md': '# Korean copy\n',
      'template.md': '# Starter\n',
      '02-b/template.md': adoptedNote('Starter', 'T-starter'),
    });
    const result = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Already Adopted:\s+1 notes/);
    assert.match(result.stdout, /Skipped \(meta\): 1 notes/);
    assert.match(result.stdout, /Skipped \(translations\): 1 notes/);
    assert.match(result.stdout, /Skipped \(template\): 2 notes/, 'one from the scan, one already adopted');
    assert.match(result.stdout, /Excluded total: 4 notes/);
    assert.match(result.stdout, /Backbone:\s+2 notes \(may gate the chain\)/);

    const ids = idToPath(vaultDir);
    for (const dropped of ['LICENSE.md', 'README.ko-KR.md', 'template.md']) {
      assert.ok(
        ![...ids.values()].includes(dropped),
        `${dropped} is reported as skipped but was adopted anyway`
      );
    }
    assert.strictEqual(ids.size, 3, 'the two lessons plus the pre-adopted starter');
  });

  test('a lone chainable note in the enumeration does not earn the tier advice', () => {
    // One candidate is a chain head, so `--chain-tier toc` would write no edge
    // here either; pointing at it instead of the roadmap sends the learner to a
    // second identical refusal.
    const { configDir } = freshVault({
      'README.md': '# Course\n\n- [Only](guide/only.md)\n',
      'guide/only.md': '# Only\n',
    });
    const strict = runCLI(['adopt', '--all', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(strict.status, 0, strict.stdout + strict.stderr);
    assert.doesNotMatch(strict.stdout, /does not read a README enumeration/);
    assert.match(strict.stdout, /no chainable order signal\) — consider palee roadmap/);

    const toc = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'toc', '--dry-run'], configDir);
    assert.strictEqual(toc.status, 0, toc.stdout + toc.stderr);
    assert.match(toc.stdout, /no chainable order signal\) — consider palee roadmap/);
  });

  test('unknown --auto-chain tier is a usage error (exit 2)', () => {
    const { configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES', '--auto-chain', '--chain-tier', 'banana', '--dry-run'], configDir);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /expects one of: strict, toc, full/);
  });

  test('bare --auto-chain chains the numbered tree and leaves the TOC alone', () => {
    // The default is `strict`, not `full`: enumeration order from a listing
    // document was 76% non-prerequisites in the measured corpora, and a false
    // edge hides a note from `palee plan`. The numbered tree is measured at
    // 0.00% false, so it is what chaining alone now buys you; the README
    // enumeration has to be asked for.
    const { configDir } = freshVault(tocFiles);
    const bare = runCLI(['adopt', '--all', '--auto-chain', '--dry-run'], configDir);
    assert.strictEqual(bare.status, 0, bare.stderr);
    assert.doesNotMatch(bare.stdout, /Auto-chain:.*full tier/, 'a bare --auto-chain is not the full tier');
    assert.match(
      bare.stdout,
      /0 edges \(no numbered layout; --chain-tier strict does not read a README enumeration\) — try --chain-tier toc/,
      'strict must name itself as the reason, not send the learner to palee roadmap'
    );
    assert.match(bare.stdout, /Planned dependency chain \(0 edges to write\)/);

    const asked = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '--dry-run'], configDir);
    assert.strictEqual(asked.status, 0, asked.stderr);
    assert.match(asked.stdout, /Auto-chain:.*full tier — 2 edge\(s\) written: 0 numbered, 2 toc/);
  });

  // The tier is a separate option precisely because an optional-value flag
  // takes the next token: with `--auto-chain [tier]`, the path in
  // `--auto-chain MODULES` was read as a tier and the run exited 2 having
  // adopted nothing — a form this command has always accepted.
  test('--auto-chain does not consume the adoption path that follows it', () => {
    const { vaultDir, configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', '--auto-chain', 'MODULES', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(
      parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MODULES/01-foundations/01-a.md'), 'utf8'))
        .frontmatter?.palee_id,
      'the scanned directory was adopted, not swallowed as a tier'
    );
    assert.match(result.stdout, /Auto-chain:.*strict tier/);
  });

  test('a directory named after a tier is still treated as the path', () => {
    const { vaultDir, configDir } = freshVault({
      'toc/01-a.md': '# A\n',
      'toc/02-b.md': '# B\n',
    });
    const result = runCLI(['adopt', '--auto-chain', 'toc', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(
      parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'toc/01-a.md'), 'utf8')).frontmatter
        ?.palee_id,
      'the directory called `toc` was adopted'
    );
  });

  test('--chain-tier without --auto-chain is a usage error (exit 2)', () => {
    const { configDir } = freshVault(chainFiles);
    const result = runCLI(['adopt', 'MODULES', '--chain-tier', 'strict', '--dry-run'], configDir);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--chain-tier requires --auto-chain/);
  });

  test('C5 round trip: an old-reader parse of a depends_on_source file still loads the topic', () => {
    const { vaultDir, configDir } = freshVault(tocFiles);
    const result = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
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

  // An already-adopted note is planner input, so the scan's filters have to
  // gate it as well. Running the filters only on the notes to be written let
  // `--exclude` drop a note that the next lesson then depended on — persisting
  // an edge to the exact file the user asked to leave alone.
  test('--exclude keeps an already-adopted note out of the chain plan', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/01-foundations/01-draft.md': adoptedNote('Draft', 'T-draft-1'),
      'MODULES/01-foundations/02-next.md': '# Next\n',
    });

    const dry = runCLI(
      ['adopt', 'MODULES', '--auto-chain', '--exclude', '*draft*', '--dry-run'],
      configDir
    );
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.deepStrictEqual(
      plannedEdges(dry.stdout),
      [{ path: 'MODULES/01-foundations/02-next.md', dependsOn: null }],
      'the excluded adopted note must be stepped over, not used as a predecessor'
    );

    const commit = runCLI(
      ['adopt', 'MODULES', '--auto-chain', '--exclude', '*draft*', '-y'],
      configDir
    );
    assert.strictEqual(commit.status, 0, commit.stdout + commit.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/02-next.md'), []);
  });

  test('the alphabetical-order warning counts the notes it describes', () => {
    // A fully numbered curriculum that happens to carry a module README: the
    // README has no number in its name, but its position is fixed by rule, so
    // nothing here was ordered by alphabetical accident. The old message called
    // this "0 of 3 planned notes are not numbered lessons".
    const numbered = freshVault({
      'MODULES/01-foundations/README.md': '# Overview\n',
      'MODULES/01-foundations/01-a.md': '# A\n',
      'MODULES/01-foundations/02-b.md': '# B\n',
    });
    const clean = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], numbered.configDir);
    assert.strictEqual(clean.status, 0, clean.stdout + clean.stderr);
    assert.doesNotMatch(clean.stdout, /alphabetical order/);

    // Ad-hoc unnumbered siblings really do order by name, and the warning has to
    // name them — that is the stop sign telling the learner to use `--exclude`.
    const adhoc = freshVault({
      'MODULES/01-foundations/01-a.md': '# A\n',
      'MODULES/01-foundations/for-teachers.md': '# For Teachers\n',
      'MODULES/01-foundations/how-to-run.md': '# How To Run\n',
    });
    const warn = runCLI(['adopt', 'MODULES', '--auto-chain', '--dry-run'], adhoc.configDir);
    assert.strictEqual(warn.status, 0, warn.stdout + warn.stderr);
    assert.match(
      warn.stdout,
      /Warning: 2 of 3 planned notes have no number or phase in their name and chain in alphabetical order\./
    );
    assert.match(warn.stdout, /e\.g\. MODULES\/01-foundations\/for-teachers\.md/);
    assert.ok(
      !/e\.g\. MODULES\/01-foundations\/01-a\.md/.test(warn.stdout),
      'a numbered lesson must not be offered as an example of an unnumbered one'
    );
  });

  // INV-46: a locale-suffixed repo-meta name is a translation copy, so it
  // leaves the plan entirely rather than being adopted as a leaf.
  test('a locale-suffixed repo-meta copy is reported and never adopted', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/README.md': '# Overview\n',
      'MODULES/README.ko-KR.md': '# 개요\n',
      'MODULES/01-a.md': '# A\n',
    });
    const run = runCLI(['adopt', 'MODULES', '--auto-chain', '-y'], configDir);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Skipped \(translations\): 1 notes/);
    const { frontmatter } = parseFrontmatter(
      fs.readFileSync(path.join(vaultDir, 'MODULES', 'README.ko-KR.md'), 'utf8')
    );
    assert.ok(!frontmatter?.palee_id, 'a translation copy must not gain PALEE frontmatter');
    assert.ok(
      parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MODULES', 'README.md'), 'utf8'))
        .frontmatter?.palee_id,
      'the English README is still adopted'
    );
  });

  // The README says zeta, alpha, middle — not alphabetical order. Before the
  // composition fix the same screen warned that they "chain in alphabetical
  // order" and hinted at `--exclude`, contradicting the edge list it printed
  // three lines later.
  test('TOC-ordered notes are never reported as alphabetical', () => {
    const { vaultDir, configDir } = freshVault({
      'README.md': '- [Zeta](guide/zeta.md)\n- [Alpha](guide/alpha.md)\n- [Middle](guide/middle.md)\n',
      'guide/zeta.md': '# Z\n',
      'guide/alpha.md': '# A\n',
      'guide/middle.md': '# M\n',
    });
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.doesNotMatch(dry.stdout, /alphabetical order/);
    assert.doesNotMatch(dry.stdout, /⚠ Warning/);
    assert.match(dry.stdout, /Auto-chain:.*0 numbered, 2 toc\)/);
    assert.deepStrictEqual(
      plannedEdges(dry.stdout),
      [
        { path: 'README.md', dependsOn: null },
        { path: 'guide/zeta.md', dependsOn: null },
        { path: 'guide/alpha.md', dependsOn: 'guide/zeta.md' },
        { path: 'guide/middle.md', dependsOn: 'guide/alpha.md' },
      ],
      'the chain follows the README, not the filenames'
    );

    const commit = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '-y'], configDir);
    assert.strictEqual(commit.status, 0, commit.stdout + commit.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/alpha.md').length, 1);
    assert.deepStrictEqual(dependsOn(vaultDir, 'guide/zeta.md'), [], 'the enumerated head has no dep');
  });

  test('a genuinely unnumbered sibling still warns alongside a TOC chain', () => {
    const { configDir } = freshVault({
      'README.md': '- [Zeta](guide/zeta.md)\n- [Alpha](guide/alpha.md)\n',
      'guide/zeta.md': '# Z\n',
      'guide/alpha.md': '# A\n',
      'notes/loose.md': '# L\n',
    });
    const dry = runCLI(['adopt', '--all', '--auto-chain', '--chain-tier', 'full', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Warning: 1 of 4 planned notes have no number or phase/);
    assert.match(dry.stdout, /e\.g\. notes\/loose\.md/);
    assert.ok(
      !/e\.g\. guide\//.test(dry.stdout),
      'the two enumerated notes must not be offered as alphabetical examples'
    );
  });
});
