import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Adoption writes identity and assessment data into a note the learner authored.
 * Three ways it took back what the learner had (issue #269, "loss of
 * user-authored state"): a note whose frontmatter will not parse aborted the
 * whole batch with no filename, a hand-authored `difficulty` was overwritten by
 * the command's own default, and every pillar the note lacked was stored as `0`
 * — which then read back as mastery the learner never reported.
 */
describe('adoption preserves what the note already declares', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-preserve-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }, null, 2),
      'utf8'
    );
  });

  after(() => {
    delete process.env.PALEE_CONFIG_DIR;
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

  /** Writes one note into the vault root and returns its vault-relative path. */
  function writeNote(name: string, body: string): string {
    fs.writeFileSync(path.join(vaultDir, name), body, 'utf8');
    return name;
  }

  beforeEach(() => {
    for (const entry of fs.readdirSync(vaultDir)) {
      fs.rmSync(path.join(vaultDir, entry), { recursive: true, force: true });
    }
  });

  test('one unreadable note is skipped by name instead of ending the batch', () => {
    // `updateFrontmatter` rejects a note whose YAML will not parse, and the batch
    // had no per-note guard ahead of it: one bad note threw out of Phase 1, the
    // run exited 5, and the message was `Malformed frontmatter: <yaml line>` with
    // no filename and nothing adopted — including the notes that were fine.
    const good = writeNote('good.md', '---\ntitle: Good\n---\n# Good\n');
    const broken = writeNote(
      'broken.md',
      '---\npalee_id: T-mine-1\ndepends_on: [unclosed\ntitle: Broken\n---\n# Broken\n'
    );
    const brokenBefore = fs.readFileSync(path.join(vaultDir, broken), 'utf8');

    const result = runCLI(['adopt', '--all', '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `a malformed note must not fail the run: ${output}`);
    assert.match(output, /broken\.md/, 'the note has to be named');
    assert.match(output, /frontmatter will not parse/, 'and the reason stated');

    const adopted = fs.readFileSync(path.join(vaultDir, good), 'utf8');
    assert.match(adopted, /palee_id: T-/, 'the healthy note is still adopted');
    assert.strictEqual(
      fs.readFileSync(path.join(vaultDir, broken), 'utf8'),
      brokenBefore,
      'an unreadable note keeps its own bytes, including the id inside them'
    );
  });

  test('a hand-authored difficulty survives adoption unless the flag overrides it', () => {
    const kept = writeNote(
      'kept.md',
      '---\ntitle: Kept\ndifficulty: beginner\n---\n# Kept\n'
    );
    const plain = writeNote('plain.md', '---\ntitle: Plain\n---\n# Plain\n');

    const result = runCLI(['adopt', kept, '--yes']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const keptFm = fs.readFileSync(path.join(vaultDir, kept), 'utf8');
    assert.match(keptFm, /difficulty: beginner/, 'the note decides its own difficulty');
    assert.match(result.stdout, /Difficulty: beginner/, 'and the report says so');

    const overridden = writeNote(
      'overridden.md',
      '---\ntitle: Overridden\ndifficulty: beginner\n---\n# Overridden\n'
    );
    runCLI(['adopt', overridden, '--difficulty', 'advanced', '--yes']);
    assert.match(
      fs.readFileSync(path.join(vaultDir, overridden), 'utf8'),
      /difficulty: advanced/,
      '--difficulty still wins'
    );

    // A note that declares nothing keeps the previous default.
    runCLI(['adopt', plain, '--yes']);
    assert.match(
      fs.readFileSync(path.join(vaultDir, plain), 'utf8'),
      /difficulty: intermediate/,
      'an absent difficulty still defaults to intermediate'
    );
  });

  test('adoption writes no pillar the note does not carry, and leaves no mastery drift', () => {
    // Four `0` pillars made `topic_mastery: 0.68` inconsistent with the weighted
    // formula the rule computes (INV-21), so every later `validate` reported
    // `stored topic_mastery 0.68 does not match computed 0` — while `validate
    // --fix` answers "Nothing to repair", because it repairs SM-2 fields only.
    const note = writeNote(
      'assessed.md',
      '---\ntitle: Assessed\ntopic_mastery: 0.68\n---\n# Assessed\n'
    );

    const adopt = runCLI(['adopt', note, '--yes']);
    assert.strictEqual(adopt.status, 0, adopt.stdout + adopt.stderr);
    const written = fs.readFileSync(path.join(vaultDir, note), 'utf8');
    assert.doesNotMatch(written, /conceptual:/, 'no pillar is minted');
    assert.doesNotMatch(written, /\bpractical:/, 'no pillar is minted');
    assert.doesNotMatch(written, /feynman:/, 'no pillar is minted');
    assert.match(written, /topic_mastery: 0\.68/, 'the stored score is preserved');

    const validate = runCLI(['validate', '--json']);
    assert.doesNotMatch(
      validate.stdout,
      /valid-topic-mastery/,
      'and the note is not left in drift the fixer cannot clear'
    );
  });

  test('a batch adopts each note on its own terms', () => {
    // The single-file and batch passes duplicate the write, so the batch needed
    // the same two rules: a per-note difficulty and no fabricated pillars.
    writeNote('a-beginner.md', '---\ntitle: A\ndifficulty: beginner\n---\n# A\n');
    writeNote('b-plain.md', '---\ntitle: B\n---\n# B\n');

    const result = runCLI(['adopt', '--all', '--yes']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);

    assert.match(
      fs.readFileSync(path.join(vaultDir, 'a-beginner.md'), 'utf8'),
      /difficulty: beginner/
    );
    assert.match(
      fs.readFileSync(path.join(vaultDir, 'b-plain.md'), 'utf8'),
      /difficulty: intermediate/
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(vaultDir, 'a-beginner.md'), 'utf8'),
      /debug:/,
      'a batch adoption invents no assessment pillar either'
    );
  });
});
