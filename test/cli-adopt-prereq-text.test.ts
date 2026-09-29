import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * A note's own `## Prerequisites` section, or a "requires X" sentence, is a
 * statement by the author rather than an inference about where the file sits —
 * so the edge it produces is written, labelled `declared`, and gates. These run
 * the real CLI end to end: the unit tests on the extractor stay green when the
 * write path drops the label or the plan projection drops the field, which is
 * how PAL-205's advisory-gating fix was found to be inert on its own.
 */
describe('CLI Adopt declared-prerequisite edges (PAL-205 WS6)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-prereq-text-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[], configDir: string): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(`npx tsx bin/palee.ts ${args.join(' ')}`, {
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
    const setResult = runCLI(['config', 'set-vault', `"${vaultDir}"`], configDir);
    assert.strictEqual(setResult.status, 0, `set-vault failed: ${setResult.stderr}`);
    return { vaultDir, configDir };
  }

  function frontmatterOf(vaultDir: string, rel: string): Record<string, unknown> | null {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    return frontmatter;
  }

  function dependsOn(vaultDir: string, rel: string): string[] {
    const deps = frontmatterOf(vaultDir, rel)?.depends_on;
    return Array.isArray(deps) ? deps.map(String) : [];
  }

  function idOf(vaultDir: string, rel: string): string {
    const id = frontmatterOf(vaultDir, rel)?.palee_id;
    assert.ok(typeof id === 'string' && id.length > 0, `${rel} was not adopted`);
    return String(id);
  }

  function adopt(vaultDir: string, configDir: string): { status: number; stdout: string; stderr: string } {
    void vaultDir;
    return runCLI(['adopt', '--all', '--auto-chain', '-y'], configDir);
  }

  /** YAML frontmatter of an already-adopted note with a fixed id and no deps. */
  function adoptedNote(title: string, id: string): string {
    return ['---', `palee_id: ${id}`, 'palee_schema: 1', `title: ${title}`, 'depends_on: []', 'topic_mastery: 0', '---', '', `# ${title}`, ''].join('\n');
  }

  /** The `ready_to_learn` ids `palee plan` offers, via its JSON mode. */
  function readyIds(configDir: string): string[] {
    const result = runCLI(['plan', '--json'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout) as { ready_to_learn: { id: string }[] };
    return payload.ready_to_learn.map((t) => t.id);
  }

  test('a declared prerequisite is written, labelled, and replaces the inferred edge', () => {
    // `03-c` would chain onto `02-b` by numbering alone. It says otherwise in its
    // own text, and the statement wins — a note that names its prerequisites has
    // no use for a guess about them.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': '# A\n\nFoundations.\n',
      'm/02-b.md': '# B\n\nNext.\n',
      'm/03-c.md': ['# C', '', '## Prerequisites', '', '- [[m/01-a]]', '', 'The body.'].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.deepStrictEqual(dependsOn(vaultDir, 'm/03-c.md'), [idOf(vaultDir, 'm/01-a.md')]);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/03-c.md')?.depends_on_source, 'declared');
    // The numbered edge is replaced, not joined: one label covers the whole list.
    assert.ok(!dependsOn(vaultDir, 'm/03-c.md').includes(idOf(vaultDir, 'm/02-b.md')));
    // B keeps the edge the tree justified.
    assert.deepStrictEqual(dependsOn(vaultDir, 'm/02-b.md'), [idOf(vaultDir, 'm/01-a.md')]);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered');
    assert.match(
      result.stdout,
      /Declared:\s+1 edge\(s\) from the notes' own prerequisite text/,
      `the report must account for the declared edge:\n${result.stdout}`
    );
  });

  test('a declared edge gates the note out of the ready list', () => {
    // The whole point of treating prose as authorship: the gate holds all the way
    // through `palee plan`, not just in the frontmatter the command wrote.
    const { vaultDir, configDir } = freshVault({
      'm/01-gate.md': '# Gate\n\n',
      'm/02-behind.md': ['# Behind', '', '## Prerequisites', '', '- [[m/01-gate]]'].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    const ready = readyIds(configDir);
    assert.deepStrictEqual(ready, [idOf(vaultDir, 'm/01-gate.md')]);
    assert.ok(!ready.includes(idOf(vaultDir, 'm/02-behind.md')), 'a declared prerequisite must gate');
  });

  test('a name matching several notes is a counted skip and keeps the tree edge', () => {
    // Losing an edge is the safe direction. Inventing one for `README`, where two
    // notes carry that basename, would lock a learner behind a note nobody chose.
    // Both the markdown link and the wikilink here are ambiguous, by a different
    // route, and both are counted.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': '# A\n\n',
      'm/02-b.md': '# B\n\n',
      'm/q1/quiz.md': '# Quiz, first copy\n\n',
      'm/q2/quiz.md': '# Quiz, second copy\n\n',
      'm/03-c.md': [
        '# C',
        '',
        '## Prerequisites',
        '',
        '- [[quiz]]',
        '- [[nothing-names-this]]',
      ].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.deepStrictEqual(dependsOn(vaultDir, 'm/03-c.md'), [idOf(vaultDir, 'm/02-b.md')]);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/03-c.md')?.depends_on_source, 'numbered');
    assert.match(
      result.stdout,
      /Declared:\s+0 edge\(s\) from the notes' own prerequisite text \(2 name\(s\) resolved to no single note\)/,
      `an unread declaration must be counted, not silent:\n${result.stdout}`
    );
  });

  test('a Prerequisites block inside a fenced example declares nothing', () => {
    // Courses document their own template. Reading the example would give a
    // fictional note a real, gating edge.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': '# A\n\n',
      'm/02-b.md': [
        '# B',
        '',
        'Write your prerequisites like this:',
        '',
        '```markdown',
        '## Prerequisites',
        '- [[m/01-a]]',
        '```',
      ].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.doesNotMatch(result.stdout, /Declared:/, 'nothing was declared, so nothing may be claimed');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered');
  });

  test('two declared names fan in to two predecessors', () => {
    // `depends_on` is a list, so an author may name several prerequisites and
    // mean all of them.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': '# A\n\n',
      'm/02-b.md': '# B\n\n',
      'm/03-c.md': ['# C', '', '## Prerequisites', '', '- [[m/01-a]]', '- [[m/02-b]]'].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.deepStrictEqual(
      dependsOn(vaultDir, 'm/03-c.md').sort(),
      [idOf(vaultDir, 'm/01-a.md'), idOf(vaultDir, 'm/02-b.md')].sort()
    );
    assert.match(result.stdout, /Declared:\s+2 edge\(s\)/);
  });

  test('a markdown link resolves against its own note, not its basename', () => {
    // `[setup](01-a.md)` inside `m/03-c.md` names `m/01-a.md`. Reducing it to
    // `01-a` made the directory disappear, so the identical note under `z/`
    // turned a precise declaration into an ambiguous name and the edge was lost.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': '# Setup\n\n',
      'm/02-b.md': '# B\n\n',
      'z/01-a.md': '# An unrelated note with the same name\n\n',
      'm/03-c.md': ['# C', '', '## Prerequisites', '', '[setup](01-a.md)'].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.deepStrictEqual(dependsOn(vaultDir, 'm/03-c.md'), [idOf(vaultDir, 'm/01-a.md')]);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/03-c.md')?.depends_on_source, 'declared');
  });

  test('a note the batch excludes cannot become a declared prerequisite', () => {
    // The chain already honours `--exclude`: a note the learner filtered out is
    // neither adopted nor used as a predecessor. Reading a declaration through a
    // vault-wide index bypassed that, so prose could gate a learner behind the
    // very note they asked to be left alone.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': '# A\n\n',
      'notes/appendix.md': adoptedNote('Appendix', 'T-appendix'),
    });
    const first = runCLI(['adopt', '--all', '-y'], configDir);
    assert.strictEqual(first.status, 0, first.stdout + first.stderr);

    fs.writeFileSync(
      path.join(vaultDir, 'm', '02-b.md'),
      ['# B', '', '## Prerequisites', '', '- [[notes/appendix]]'].join('\n')
    );
    const result = runCLI(['adopt', '--all', '--auto-chain', '--exclude', '*appendix*', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.deepStrictEqual(dependsOn(vaultDir, 'm/02-b.md'), [idOf(vaultDir, 'm/01-a.md')]);
    assert.strictEqual(
      frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source,
      'numbered',
      'an excluded note must not become a declared prerequisite'
    );
    assert.match(result.stdout, /Declared:\s+0 edge\(s\).*\(1 name\(s\) resolved to no single note\)/);
  });

  test('a declared cycle fails closed and writes nothing', () => {
    // Author error, not engine error: two notes each naming the other. The plan
    // is cycle-checked before any write, so the batch refuses with exit 3.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': ['# A', '', '## Prerequisites', '', '- [[m/02-b]]'].join('\n'),
      'm/02-b.md': ['# B', '', '## Prerequisites', '', '- [[m/01-a]]'].join('\n'),
    });
    const result = adopt(vaultDir, configDir);
    assert.strictEqual(result.status, 3, `a declared cycle must exit 3:\n${result.stdout}${result.stderr}`);
    assert.ok(
      !fs.existsSync(path.join(vaultDir, 'm', '01-a.md')) ||
        frontmatterOf(vaultDir, 'm/01-a.md')?.palee_id === undefined,
      'the cycle check runs before any write, so no note is left half-adopted'
    );
  });
});
