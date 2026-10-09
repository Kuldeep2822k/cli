import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Issue #267 — a skipped topic can leave the vault in a cycle the validator rejected.
 *
 * `palee roadmap --from` cycle-checks the *declared* graph and then, in the write
 * loop, continues past any topic whose existing note it cannot read. A note that is
 * skipped keeps the `depends_on` it already carries on disk, which is not the list the
 * roadmap declared for it and not the one the check cleared. So the plan that was
 * validated is not the plan that lands: an earlier note has already been written, the
 * skipped note still points back at it, and the command exits `1` over a vault that
 * `palee validate` reports as cyclic — the state INV-46 says must mean exit `3` and no
 * writes.
 *
 * The fixture needs only two notes and one directory, so it runs on every platform:
 * T-1 is an ordinary adopted note, T-2's real note sits at `n/2-real.md` and carries a
 * backward edge, and the roadmap declares T-2 at `n/2.md` — where a directory stands in
 * the note's place, which is the #264 guard's own refuse path. Declared, the graph is
 * T-1 → T-2 and T-2 → nothing: acyclic, validated. Written, T-2 is skipped and its
 * stored edge survives: T-1 → T-2 → T-1.
 */
describe('a roadmap skip that closes a cycle writes nothing', () => {
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
      ['--import', 'tsx', path.resolve(__dirname, '../bin/palee.ts'), ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: configDir },
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  /**
   * Builds `<base>/vault` — T-1 on disk, T-2's real note carrying `backwardEdge`, and a
   * directory standing in for the path the roadmap names for T-2 — plus the roadmap file
   * that declares T-1 → T-2 and an empty list for T-2.
   *
   * @param name - Prefix for this case's temp directory, so cases never share a vault
   * @param backwardEdge - What T-2's *stored* note depends on
   */
  function makeVault(name: string, backwardEdge: string[]): { base: string; vault: string; yaml: string } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `palee-skip-cycle-${name}-`)));
    created.push(base);
    const vault = path.join(base, 'vault');
    fs.mkdirSync(path.join(vault, 'n'), { recursive: true });
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ vaultPath: vault }, null, 2), 'utf8');

    fs.writeFileSync(
      path.join(vault, 'n', '1.md'),
      ['---', 'palee_schema: 1', 'palee_id: T-1', 'title: One', 'depends_on: []', 'topic_mastery: 0', '---', '', '# One', ''].join('\n')
    );
    fs.writeFileSync(
      path.join(vault, 'n', '2-real.md'),
      [
        '---',
        'palee_schema: 1',
        'palee_id: T-2',
        'title: Two',
        ...(backwardEdge.length > 0 ? ['depends_on:', ...backwardEdge.map((e) => `  - ${e}`)] : ['depends_on: []']),
        'topic_mastery: 0',
        '---',
        '',
        '# Two',
        '',
      ].join('\n')
    );
    // The path the roadmap declares: a directory, so the import cannot read it.
    fs.mkdirSync(path.join(vault, 'n', '2.md'), { recursive: true });

    const yaml = path.join(base, 'roadmap.yaml');
    fs.writeFileSync(
      yaml,
      [
        'topics:',
        '  - id: T-1',
        '    title: One',
        '    path: n/1.md',
        '    depends_on: [T-2]',
        '  - id: T-2',
        '    title: Two',
        '    path: n/2.md',
        '    depends_on: []',
        '',
      ].join('\n')
    );
    return { base, vault, yaml };
  }

  test('a skip whose stored edge closes the loop refuses the import and writes nothing', () => {
    const { base, vault, yaml } = makeVault('cycle', ['T-1']);
    const before = fs.readFileSync(path.join(vault, 'n', '1.md'), 'utf8');

    const result = runCLI(base, ['roadmap', '--from', yaml, '--yes']);

    assert.strictEqual(result.status, 3, `a skip that invalidates the verdict is a validation refusal: ${result.out}`);
    assert.match(result.out, /refusing to import/, 'the refusal has to say what it is');
    assert.match(result.out, /T-2/, 'the unreadable id is the reason the plan changed and must be named');
    assert.match(result.out, /T-1 → T-2/, 'the cycle that would have landed must be printed');
    assert.strictEqual(
      fs.readFileSync(path.join(vault, 'n', '1.md'), 'utf8'),
      before,
      'not one note may be rewritten once the plan is known to differ from the validated graph'
    );
  });

  test('a skip that closes no loop still imports the rest, exactly as before', () => {
    // The boundary of the fix. Refusing every unreadable note would have been the
    // simpler rule, and it would throw away a partial import the user can act on
    // along with the dangling-edge report that exists to name it.
    const { base, vault, yaml } = makeVault('nocycle', []);

    const result = runCLI(base, ['roadmap', '--from', yaml, '--yes']);

    assert.match(result.out, /Skipped T-2: n\/2\.md is not a regular file/, 'the skip is still reported per topic');
    assert.strictEqual(result.status, 1, `a partial import still exits 1: ${result.out}`);
    assert.match(
      fs.readFileSync(path.join(vault, 'n', '1.md'), 'utf8'),
      /T-2/,
      'the readable topic is still written, with its edge dangling and reported'
    );
  });
});
