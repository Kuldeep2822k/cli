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
describe('roadmap import reports edges to notes it did not write', () => {
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
    assert.match(output, /Failed T-2/, 'the failed write must still be reported');
    assert.match(
      output,
      /dependency edge\(s\) point at topics that were not written/,
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
      /dependency edge\(s\) point at topics that were not written/,
      'a complete import must not raise the warning'
    );
  });

  test('an id this import superseded counts as a dangling edge target', () => {
    // The note at `repl-1.md` already carries T-old. This import writes T-new
    // over the same path, so T-old exists nowhere — but the pre-import scan
    // still held it, and treating it as known hid the edge pointing at it,
    // which is exactly the case this report exists to catch.
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
    assert.strictEqual(result.status, 0, output);
    assert.match(output, /T-dep → T-old/, 'the superseded id must be named');

    // Scoped to the note actually overwritten: an edge onto a topic this same
    // batch wrote must stay unreported.
    const keep = path.join(tempDir, 'roadmap-keep.yaml');
    fs.writeFileSync(
      keep,
      [
        'topics:',
        '  - id: T-fresh',
        '    title: Fresh',
        '    path: keep-1.md',
        '  - id: T-fresh-dep',
        '    title: Fresh Dependent',
        '    path: keep-2.md',
        '    depends_on: [T-fresh]',
        '',
      ].join('\n')
    );
    const second = runCLI(['roadmap', '--from', keep, '--yes']);
    const secondOutput = second.stdout + second.stderr;
    assert.strictEqual(second.status, 0, secondOutput);
    assert.doesNotMatch(secondOutput, /edge\(s\) point at topics that were not written/);
  });
});
