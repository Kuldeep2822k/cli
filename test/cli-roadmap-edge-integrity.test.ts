import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * A roadmap import that fails partway still leaves the notes it *did* write
 * holding `depends_on` entries that point at the topic which failed: chain
 * synthesis and pre-import validation both run against the declared topic list,
 * not against write success. The dependent note then vanishes from
 * `palee plan`'s ready list permanently, while `palee validate` reports it only
 * as a warning and exits 0 — so nothing along the path tells the learner the
 * note is gone or why.
 */
describe('roadmap import reports edges to notes that do not exist', () => {
  let tempDir: string;
  let vaultDir: string;
  let origConfigDir: string | undefined;

  before(() => {
    origConfigDir = process.env.PALEE_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-edge-integrity-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'n'), { recursive: true });
    process.env.PALEE_CONFIG_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }, null, 2),
      'utf8'
    );
  });

  after(() => {
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs the CLI in a child process against this suite's vault. */
  function runCLI(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve(__dirname, '../bin/palee.ts'), ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  test('a partial import names the dangling edge and still exits 1', () => {
    // A directory in the topic's place makes exactly one write fail (EISDIR),
    // so T-2 is declared and validated but never lands on disk.
    fs.mkdirSync(path.join(vaultDir, 'n', '2.md'));
    const yamlPath = path.join(tempDir, 'roadmap.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-1',
        '    title: One',
        '    path: n/1.md',
        '  - id: T-2',
        '    title: Two',
        '    path: n/2.md',
        '  - id: T-3',
        '    title: Three',
        '    path: n/3.md',
        '    depends_on: [T-1, T-2]',
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 1, `partial import must exit 1: ${output}`);
    // The directory in the note's path is refused by the `lstat` guard before the
    // write is attempted, so the report line is a skip rather than a failed write.
    // Either way T-2 does not land, which is what the rest of this test needs.
    assert.match(output, /Skipped T-2: n\/2\.md is not a regular file/, 'the refused note must be reported');
    assert.match(
      output,
      /dependency edge\(s\) point at topics that do not exist/,
      'the dangling edge must be named, not left for validate to warn about'
    );
    assert.match(output, /T-3 → T-2/, 'the report must give the exact edge');
    assert.doesNotMatch(output, /T-3 → T-1/, 'an edge whose target was written must not be reported');
    assert.match(output, /palee validate/, 'the report must point at the remedy');

    // The defect is real on disk: this is what the report exists to surface.
    const written = fs.readFileSync(path.join(vaultDir, 'n', '3.md'), 'utf8');
    assert.ok(written.includes('T-2'), 'the dangling depends_on is what the learner is left with');
  });

  test('a fully successful import reports no dangling edges', () => {
    const yamlPath = path.join(tempDir, 'clean.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-a',
        '    title: A',
        '    path: clean/a.md',
        '  - id: T-b',
        '    title: B',
        '    path: clean/b.md',
        '    depends_on: [T-a]',
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `clean import must succeed: ${output}`);
    assert.doesNotMatch(
      output,
      /dependency edge\(s\) point at topics that do not exist/,
      'a complete import must not raise the warning'
    );
  });

  test('an import that would retire an adopted id is refused before any write', () => {
    // The note at `repl-1.md` already answers to T-old, and an edge elsewhere in
    // the vault names it. Writing T-new over that path retired T-old: the
    // dependent note then resolved its prerequisite to nothing, which keeps it
    // out of `palee plan` for good, while `palee validate` counts a missing
    // dependency as a warning and exits 0. The learner learned about it from a
    // stderr list after the writes landed. INV-32 makes it a validation error
    // instead, so the roadmap is corrected before the vault is touched.
    fs.writeFileSync(
      path.join(vaultDir, 'repl-1.md'),
      ['---', 'palee_schema: 1', 'palee_id: T-old', 'title: Old One', 'depends_on: []', 'topic_mastery: 0', '---', '', '# Old', ''].join('\n')
    );
    const yamlPath = path.join(tempDir, 'roadmap-replace.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-new',
        '    title: New One',
        '    path: repl-1.md',
        '  - id: T-dep',
        '    title: Dependent',
        '    path: repl-2.md',
        '    depends_on: [T-old]',
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;
    assert.strictEqual(result.status, 3, `a retiring import must be refused: ${output}`);
    assert.match(output, /already adopted as "T-old"/, 'the id it would retire is named');
    assert.match(output, /Topic "T-new"/, 'along with the id that would replace it');
    assert.match(output, /repl-1\.md/, 'and the note whose identity is at stake');

    assert.strictEqual(
      fs.existsSync(path.join(vaultDir, 'repl-2.md')),
      false,
      'refusal writes nothing, so the dependent note does not appear either'
    );
    const untouched = fs.readFileSync(path.join(vaultDir, 'repl-1.md'), 'utf8');
    assert.match(untouched, /palee_id: T-old/, 'and the incumbent keeps its id');
  });

  test('an overwrite declared by absolute path is refused on the same grounds', () => {
    // Matching the incumbent note against a declaration is what makes this check
    // work. Comparing the loader's vault-relative path against an absolute
    // in-vault declaration — which the write path accepts — is a different
    // spelling of the same note, and both sides go through one canonicalizer so
    // the two spellings meet.
    fs.writeFileSync(
      path.join(vaultDir, 'abs-1.md'),
      ['---', 'palee_schema: 1', 'palee_id: T-old-abs', 'title: Old Abs', 'depends_on: []', 'topic_mastery: 0', '---', '', '# Old', ''].join('\n')
    );
    const yamlPath = path.join(tempDir, 'roadmap-abs.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-new-abs',
        '    title: New Abs',
        `    path: ${path.join(vaultDir, 'abs-1.md')}`,
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;
    assert.strictEqual(result.status, 3, `an absolute declaration must be matched too: ${output}`);
    assert.match(output, /already adopted as "T-old-abs"/);
    assert.match(
      fs.readFileSync(path.join(vaultDir, 'abs-1.md'), 'utf8'),
      /palee_id: T-old-abs/,
      'the note keeps the id it was adopted with'
    );
  });

  test('re-importing a roadmap under the ids its notes already carry still writes', () => {
    // The refusal must not become a ban on importing twice. The ordinary second
    // run declares the same id for the same path, and lands as it always did.
    const yamlPath = path.join(tempDir, 'roadmap-same-id.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-old',
        '    title: Old One Renamed',
        '    path: repl-1.md',
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;
    assert.strictEqual(result.status, 0, `a same-id re-import must succeed: ${output}`);
    assert.match(
      fs.readFileSync(path.join(vaultDir, 'repl-1.md'), 'utf8'),
      /title: Old One Renamed/,
      'and the rest of the entry is applied'
    );
  });

  test('an edge from a note the same batch later overwrote is not reported', () => {
    // Two spellings of one path — `dup.md` and `./dup.md` — resolve to the same
    // note, which the declared-path duplicate check cannot see. The first writer
    // puts an edge onto a topic whose own write then fails; the second writer
    // replaces that note outright, so the edge is on no file on disk. Reporting it
    // sends the learner to fix a dependency that exists nowhere.
    fs.mkdirSync(path.join(vaultDir, 'ghost.md'), { recursive: true });
    const yamlPath = path.join(tempDir, 'roadmap-dup.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-ghost',
        '    title: Ghost',
        '    path: ghost.md',
        '  - id: T-first',
        '    title: First Writer',
        '    path: dup.md',
        '    depends_on: [T-ghost]',
        '  - id: T-second',
        '    title: Second Writer',
        '    path: ./dup.md',
        '    depends_on: []',
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;
    assert.strictEqual(result.status, 1, output);
    assert.match(output, /Skipped T-ghost: ghost\.md is not a regular file/, 'precondition: T-ghost did not land');
    assert.doesNotMatch(
      output,
      /T-first → T-ghost/,
      'T-first no longer exists on disk, so its edge must not be reported'
    );
  });

  test('an id this batch wrote and then overwrote is not a known edge target', () => {
    // The mirror of the case above. `T-was` lands on disk, then a second spelling
    // of the same path rewrites that note under `T-now`, so `T-was` exists nowhere
    // once the batch finishes. It was still written, though, so a known-set built
    // from every id the batch touched counted it as a target and hid the edge
    // naming it — the same lockout the report exists to surface, one write earlier.
    const yamlPath = path.join(tempDir, 'roadmap-retired.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'topics:',
        '  - id: T-was',
        '    title: Written First',
        '    path: retired.md',
        '  - id: T-now',
        '    title: Written Last',
        '    path: ./retired.md',
        '  - id: T-after',
        '    title: Points At The Retired Id',
        '    path: retired-dep.md',
        '    depends_on: [T-was]',
        '',
      ].join('\n')
    );

    const result = runCLI(['roadmap', '--from', yamlPath, '--yes']);
    const output = result.stdout + result.stderr;
    assert.strictEqual(result.status, 0, output);
    assert.match(output, /T-after → T-was/, 'a retired id must not count as a written topic');

    // The defect is on disk, not just in the report: the note the learner is left
    // with depends on an id no file carries.
    const written = fs.readFileSync(path.join(vaultDir, 'retired-dep.md'), 'utf8');
    assert.ok(written.includes('T-was'), 'the dangling depends_on is what the learner is left with');
    const survivor = fs.readFileSync(path.join(vaultDir, 'retired.md'), 'utf8');
    assert.ok(survivor.includes('T-now') && !survivor.includes('T-was'), 'T-was was retired by the overwrite');
  });
});
