import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV, CLI_SPAWN_TIMEOUT_MS } from './palee-cli';
import { MAX_NOTE_SOURCE_BYTES } from '../src/storage/source-cap';

/**
 * #565 P1-10 review — a cap-refused topic skips after the graph was cleared.
 *
 * `palee roadmap --from` cycle-checks the *declared* graph and then, in the write
 * loop, fails any topic whose managed frontmatter would push its note past the
 * 512 KiB read cap. A failed topic keeps the `depends_on` it already carries on
 * disk, which is not the list the roadmap declared for it and not the one the
 * check cleared. So one stored backward hop closes a loop the validator never
 * saw: an earlier note has already been written, the cap-refused note still
 * points back at it, and the command exits `1` over a vault `palee validate`
 * reports as cyclic — the state INV-46 says must mean exit `3` and no writes.
 *
 * The pre-write check therefore models the projected write failure too. These
 * fixtures keep every note 40 bytes under the ceiling, so validation and the
 * planner both accept them while any managed block crosses the cap.
 */
describe('a roadmap result that crosses the read cap cannot leave a cycle', () => {
  const created: string[] = [];
  const origConfigDir = process.env.PALEE_CONFIG_DIR;

  after(() => {
    if (origConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
    else process.env.PALEE_CONFIG_DIR = origConfigDir;
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the CLI in a child process against a throwaway vault. */
  function runCLI(configDir: string, args: string[]): { status: number | null; out: string } {
    const result = spawnSync(
      process.execPath,
      [...PALEE_ARGV, ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: configDir },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: CLI_SPAWN_TIMEOUT_MS,
      }
    );
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  /**
   * A note whose *source* is legal — `slack` bytes under the ceiling — so every
   * read path loads it, while the managed keys an import adds push it over.
   *
   * @param id - The `palee_id` the note declares
   * @param title - Its title, in frontmatter and as an H1
   * @param storedDeps - The `depends_on` the note already carries
   * @param slack - Bytes of headroom below the cap
   */
  function noteAtTheCapEdge(id: string, title: string, storedDeps: string[], slack = 40): string {
    const head = [
      '---',
      'palee_schema: 1',
      `palee_id: ${id}`,
      `title: ${title}`,
      ...(storedDeps.length > 0 ? ['depends_on:', ...storedDeps.map((dep) => `  - ${dep}`)] : ['depends_on: []']),
      'topic_mastery: 0',
      '---',
      '',
      `# ${title}`,
      '',
    ].join('\n');
    const pad = MAX_NOTE_SOURCE_BYTES - slack - Buffer.byteLength(head, 'utf8');
    assert.ok(pad > 0, 'the fixture head must leave room for the padding');
    return head + 'x'.repeat(pad);
  }

  /** An ordinary adopted note, far below the cap. */
  function adoptedNote(id: string, title: string, storedDeps: string[] = []): string {
    return [
      '---',
      'palee_schema: 1',
      `palee_id: ${id}`,
      `title: ${title}`,
      ...(storedDeps.length > 0 ? ['depends_on:', ...storedDeps.map((dep) => `  - ${dep}`)] : ['depends_on: []']),
      'topic_mastery: 0',
      '---',
      '',
      `# ${title}`,
      '',
    ].join('\n');
  }

  /**
   * Builds `<base>/vault` and `<base>/config.json` plus the roadmap file the case
   * declares, so every note's exact bytes are under the test's control.
   */
  function makeVault(
    name: string,
    notes: Record<string, string>,
    roadmapLines: string[]
  ): { base: string; vault: string; yaml: string } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `palee-cap-result-${name}-`)));
    created.push(base);
    const vault = path.join(base, 'vault');
    fs.mkdirSync(path.join(vault, 'n'), { recursive: true });
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ vaultPath: vault }, null, 2), 'utf8');
    for (const [rel, content] of Object.entries(notes)) {
      const abs = path.join(vault, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    const yaml = path.join(base, 'roadmap.yaml');
    fs.writeFileSync(yaml, roadmapLines.join('\n'), 'utf8');
    return { base, vault, yaml };
  }

  test('a skip whose held edge closes the loop refuses the import and writes nothing', () => {
    // Declared, the graph is T-bravo → T-alpha and T-alpha → nothing: acyclic,
    // validated. Written, T-alpha is refused for crossing the cap and keeps its
    // stored T-bravo edge while T-bravo lands holding T-alpha: a cycle, with
    // every byte already on disk.
    const aBefore = noteAtTheCapEdge('T-alpha', 'One', ['T-bravo']);
    const bBefore = adoptedNote('T-bravo', 'Two');
    assert.ok(Buffer.byteLength(aBefore, 'utf8') < MAX_NOTE_SOURCE_BYTES, 'T-alpha must start under the cap');

    const { base, vault, yaml } = makeVault('cycle', { 'n/a.md': aBefore, 'n/b.md': bBefore }, [
      'topics:',
      '  - id: T-alpha',
      '    title: One',
      '    path: n/a.md',
      '    depends_on: []',
      '  - id: T-bravo',
      '    title: Two',
      '    path: n/b.md',
      '    depends_on: [T-alpha]',
      '',
    ]);

    const result = runCLI(base, ['roadmap', '--from', yaml, '--yes']);

    assert.strictEqual(result.status, 3, `a skip that invalidates the verdict is a validation refusal: ${result.out}`);
    assert.match(result.out, /refusing to import/, 'the refusal has to say what it is');
    assert.match(
      result.out,
      /T-alpha \(would be written past the read cap\)/,
      'the reason the plan changed must be named, not just the id'
    );
    assert.match(
      result.out,
      /Cycle the skipped notes would leave behind: .*T-alpha.*T-bravo/,
      'the cycle that would have landed must be printed'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(vault, 'n/a.md'), 'utf8'),
      aBefore,
      'the cap-refused note keeps its bytes, stored edge included'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(vault, 'n/b.md'), 'utf8'),
      bBefore,
      'not one note may be rewritten once the plan is known to differ from the validated graph'
    );
  });

  test('a cap-refused topic that closes no loop still costs only its own topic', () => {
    // The boundary of the fix: the pre-write check refuses only when the graph
    // that would land is cyclic. A cap-refused note nothing depends on still
    // costs its own topic and exits `1`, as the partial import always has.
    const aBefore = noteAtTheCapEdge('T-alpha', 'One', []);
    const bBefore = adoptedNote('T-bravo', 'Two');

    const { base, vault, yaml } = makeVault('nocycle', { 'n/a.md': aBefore, 'n/b.md': bBefore }, [
      'topics:',
      '  - id: T-alpha',
      '    title: One',
      '    path: n/a.md',
      '    depends_on: []',
      '  - id: T-bravo',
      '    title: Two Imported',
      '    path: n/b.md',
      '',
    ]);

    const result = runCLI(base, ['roadmap', '--from', yaml, '--yes']);

    assert.strictEqual(result.status, 1, `a partial import still exits 1: ${result.out}`);
    assert.match(
      result.out,
      /Oversized result: the managed keys would grow this note/,
      'the skip is still reported per topic'
    );
    assert.match(result.out, /Failed to import 1 topics/);
    assert.strictEqual(
      fs.readFileSync(path.join(vault, 'n/a.md'), 'utf8'),
      aBefore,
      'a note that cannot be rewritten is left byte-identical'
    );
    assert.match(
      fs.readFileSync(path.join(vault, 'n/b.md'), 'utf8'),
      /Two Imported/,
      'the readable topic is still written'
    );
  });
});
