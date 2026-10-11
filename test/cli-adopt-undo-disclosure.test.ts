import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';
import adoptUndoCommand from '../src/cli/adopt-undo';

/**
 * The disclosure and refusal paths of `palee adopt --undo` (#299).
 *
 * @remarks
 * The main suite pins what survives a reversal. This file pins the other half of
 * the promise: that a reversal *says* what it declined to do. Every skip category
 * below exists because silently leaving a note alone is indistinguishable from
 * having reversed it, and `--undo` runs across a whole vault — so the verbose
 * report, the batch dry-run summary and the usage refusals are behaviour, not
 * decoration.
 *
 * The last test drives the handler in process, because the conflict it pins happens
 * between two reads inside one run and cannot be timed from a child process.
 */

const ADOPTED = [
  '---',
  'palee_id: T-alpha',
  'palee_schema: 1',
  'difficulty: beginner',
  'topic_mastery: 0.4',
  'assessed_at: null',
  'ease_factor: 2.5',
  'interval_days: 4',
  'repetition: 2',
  'lapses: 0',
  'last_quality: 4',
  'last_reviewed_at: 2026-01-02',
  'due_at: 2026-01-06',
  'title: "Alpha"',
  '# My own key: 17',
  '---',
  '',
  '# Alpha',
  '',
  'Body text that adoption must not touch.',
  '',
].join('\n');

/** A note with owned keys but no identity: nothing here names a topic. */
const ORPHAN_OWNED = ['---', 'palee_schema: 1', 'ease_factor: 2.5', '---', '', '# Orphan', ''].join('\n');

/** `palee_id` present but not a string, which the tool must not guess at. */
const UNUSABLE_ID = ['---', 'palee_id: 12345', 'palee_schema: 1', '---', '', '# Numbered', ''].join('\n');

/** Frontmatter that never closes. */
const UNTERMINATED = ['---', 'palee_id: T-open', 'title: "Never closed"'].join('\n');

/** Frontmatter that opens and closes but is not parseable YAML. */
const UNPARSEABLE = ['---', 'palee_id: [T-bracket', '---', '', '# Bracket', ''].join('\n');

/** An ordinary unadopted note. */
const PLAIN = ['# Plain', '', 'Nothing adopted here.', ''].join('\n');

describe('palee adopt --undo discloses every refusal and skip (#299)', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-undo-disclosure-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'sub'), { recursive: true });
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

  beforeEach(() => {
    for (const entry of fs.readdirSync(vaultDir)) {
      fs.rmSync(path.join(vaultDir, entry), { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(vaultDir, 'sub'), { recursive: true });
  });

  function write(name: string, content: string): void {
    fs.writeFileSync(path.join(vaultDir, name), content, 'utf8');
  }

  /** The frontmatter keys of a note, in the order they sit on disk. */
  function frontmatterKeys(content: string): string[] {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!block) return [];
    return block[1]
      .split(/\r?\n/)
      .filter((line) => /^[A-Za-z_][\w-]*:|^#.+:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
  }

  function runCLI(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /** Populates the vault with one note from every category the report distinguishes. */
  function seedCategories(): void {
    write('alpha.md', ADOPTED);
    write('plain.md', PLAIN);
    write('orphan.md', ORPHAN_OWNED);
    write('numbered.md', UNUSABLE_ID);
    write('open.md', UNTERMINATED);
    write('bracket.md', UNPARSEABLE);
    write(path.join('sub', 'nested.md'), ADOPTED.replace('T-alpha', 'T-nested'));
  }

  test('--undo --verbose names each skip category and the notes it will touch', () => {
    seedCategories();

    const res = runCLI(['adopt', '--all', '--undo', '--yes', '--verbose', '--dry-run']);
    assert.equal(res.status, 0, res.stderr);

    // Every category has its own heading, so "left alone" is never silent.
    assert.match(res.stdout, /Notes to un-adopt:/);
    assert.match(res.stdout, /• alpha\.md \(T-alpha\)/);
    assert.match(res.stdout, /Not adopted:/);
    assert.match(res.stdout, /= plain\.md/);
    assert.match(res.stdout, /Skipped: palee_id is not a usable string \(left alone\):/);
    assert.match(res.stdout, /! numbered\.md/);
    assert.match(res.stdout, /Skipped: PALEE-owned keys with no topic id \(left alone\):/);
    assert.match(res.stdout, /! orphan\.md/);
    assert.match(res.stdout, /Skipped: the frontmatter block is never closed \(left alone\):/);
    assert.match(res.stdout, /! open\.md/);
    assert.match(res.stdout, /Skipped: frontmatter will not parse \(not rewritten\):/);
    assert.match(res.stdout, /\? bracket\.md/);
    // An unreadable note is also reported outside the verbose lists, because a
    // skipped note is exactly the case a reviewer must not have to dig for.
    assert.match(res.stderr, /Skipped bracket\.md: frontmatter will not parse/);
  });

  test('--undo --verbose reports the pattern and tag filters that excluded notes', () => {
    write('alpha.md', ADOPTED);
    write('keep.md', ADOPTED.replace('T-alpha', 'T-keep'));
    write('untagged.md', ADOPTED.replace('T-alpha', 'T-untagged'));

    const excluded = runCLI(['adopt', '--all', '--undo', '--yes', '--verbose', '--dry-run', '--exclude', 'keep.md']);
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.match(excluded.stdout, /Skipped by pattern filter:/);
    assert.match(excluded.stdout, /- keep\.md/);

    const tagged = runCLI(['adopt', '--all', '--undo', '--yes', '--verbose', '--dry-run', '--tag', 'only-some']);
    assert.equal(tagged.status, 0, tagged.stderr);
    assert.match(tagged.stdout, /Skipped by tag filter:/);
    assert.match(tagged.stdout, /~ .*\.md/);
  });

  test('a batch --undo --dry-run summarises the plan and changes no bytes', () => {
    write('alpha.md', ADOPTED);
    write('beta.md', ADOPTED.replace('T-alpha', 'T-beta'));
    const beforeBytes = fs.readFileSync(path.join(vaultDir, 'alpha.md'));
    const beforeBeta = fs.readFileSync(path.join(vaultDir, 'beta.md'));

    const res = runCLI(['adopt', '--all', '--undo', '--dry-run']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Dry run: would un-adopt 2 notes and remove their PALEE-owned keys\./);
    assert.match(res.stdout, /Dry-run complete\. No files were modified\./);
    assert.deepEqual(fs.readFileSync(path.join(vaultDir, 'alpha.md')), beforeBytes);
    assert.deepEqual(fs.readFileSync(path.join(vaultDir, 'beta.md')), beforeBeta);
  });

  test('a dry run over a scope with nothing adopted says so and still writes nothing', () => {
    write('plain.md', PLAIN);

    const res = runCLI(['adopt', '--all', '--undo', '--dry-run']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Dry run: nothing to un-adopt in this scope\./);
    assert.match(res.stdout, /Dry-run complete\. No files were modified\./);
    assert.equal(fs.readFileSync(path.join(vaultDir, 'plain.md'), 'utf8'), PLAIN);
  });

  test('a non-markdown target is refused with the wording that fits the target', () => {
    write('notes.txt', 'not a note\n');
    write('alpha.md', ADOPTED);

    const txt = runCLI(['adopt', 'notes.txt', '--undo', '--yes']);
    assert.equal(txt.status, 2, txt.stderr);
    assert.match(txt.stderr, /Error: Not a markdown note: .*notes\.txt — pass a \.md file or a directory to un-adopt/);

    // A `.md` file passed alongside the directory scan is its own refusal, and it
    // names the way out: pass the note alone, or pass a directory.
    const nested = runCLI(['adopt', '--all', '--undo', '--yes', 'alpha.md']);
    assert.equal(nested.status, 2, nested.stderr + nested.stdout);
    assert.match(
      nested.stderr,
      /alpha\.md is a file — drop --undo's directory scan by passing it alone, or pass a directory/,
    );
    // Neither run touched the adopted note.
    assert.equal(fs.readFileSync(path.join(vaultDir, 'alpha.md'), 'utf8'), ADOPTED);
  });

  test('a directory with no markdown stops before the scan with a plain statement', () => {
    const res = runCLI(['adopt', 'sub', '--undo', '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /No markdown files found to un-adopt\./);
  });

  test('a batch reversal with --drop-title says so, and removes the minted title', () => {
    write('alpha.md', ADOPTED);
    write('beta.md', ADOPTED.replace('T-alpha', 'T-beta'));

    const res = runCLI(['adopt', '--all', '--undo', '--drop-title', '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Successfully removed PALEE tracking from 2 notes\./);
    assert.match(res.stdout, /`title` was removed too, as --drop-title asked\./);
    assert.doesNotMatch(res.stdout, /was left in place/);

    const keys = frontmatterKeys(fs.readFileSync(path.join(vaultDir, 'alpha.md'), 'utf8'));
    assert.ok(!keys.includes('palee_id'), keys.join(','));
    assert.ok(!keys.includes('title'), keys.join(','));
    // The opt-out still cannot reach an authored key.
    assert.ok(keys.includes('# My own key'), keys.join(','));
    assert.match(fs.readFileSync(path.join(vaultDir, 'alpha.md'), 'utf8'), /Body text that adoption must not touch\./);
  });

  test('a conflict over five notes names the first five and counts the rest', async () => {
    for (let i = 0; i < 6; i++) {
      write(`n${i}.md`, ADOPTED.replace('T-alpha', `T-n${i}`).replace('# My own key: 17', ''));
    }

    const driftNames = new Set(Array.from({ length: 6 }, (_, i) => `n${i}.md`));
    const realRead = fs.readFileSync;
    const seen = new Map<string, number>();
    // Every note is modified after the plan read, so the refusal must list five and
    // summarise the sixth rather than truncate silently or dump the whole set.
    // Matched on basename: the CLI canonicalises the vault, so on macOS these paths
    // arrive as `/private/var/...` while the suite's are `/var/...`, and a path
    // comparison would silently never fire there.
    (fs as any).readFileSync = (...args: unknown[]): unknown => {
      const target = args[0];
      if (typeof target === 'string' && driftNames.has(path.basename(target))) {
        const n = (seen.get(target) ?? 0) + 1;
        seen.set(target, n);
        if (n >= 2) return Buffer.from(`${realRead(target).toString('utf8')}\n<!-- drifted -->\n`, 'utf8');
      }
      return (realRead as (...a: unknown[]) => unknown)(...args);
    };

    const priorExit = process.exitCode;
    process.exitCode = 0;
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await adoptUndoCommand(undefined, { undo: true, all: true, yes: true });
    } finally {
      console.error = realErr;
      (fs as any).readFileSync = realRead;
    }
    const exit = process.exitCode;
    process.exitCode = priorExit;

    // The stub must have actually fired, or this test proves nothing: on a platform
    // where the CLI's canonical path differs from the suite's, a path-keyed match
    // would leave every read untouched and the exit code would be 0 for the wrong
    // reason.
    assert.equal(seen.size, 6, `expected all six notes re-read, saw ${[...seen.keys()].join(', ')}`);
    assert.ok([...seen.values()].every((n) => n >= 2), 'each note must be read at plan time and again before commit');
    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(logged.some((l) => /OCC conflict: 6 note\(s\) were modified/.test(l)), logged.join(' | '));
    assert.ok(logged.some((l) => /… and 1 more/.test(l)), logged.join(' | '));
    for (const name of driftNames) {
      const p = path.join(vaultDir, name);
      assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /drifted/, `${name} must be untouched`);
    }
  });

  test('notes modified while the run was planning abort the batch at exit 4, writing nothing', async () => {
    write('alpha.md', ADOPTED);
    write('beta.md', ADOPTED.replace('T-alpha', 'T-beta'));
    const alphaBefore = fs.readFileSync(path.join(vaultDir, 'alpha.md'));
    const betaBefore = fs.readFileSync(path.join(vaultDir, 'beta.md'));

    // The window this pins is inside one run: the plan is built from the bytes read
    // during the scan, and every note is re-read immediately before the pre-commit
    // gate. A child process cannot be timed to change a note in that gap, so the
    // second read of one note is made to return different bytes here — and nothing
    // may be written, because the plan no longer describes the vault.
    const alphaPath = path.join(vaultDir, 'alpha.md');
    const realRead = fs.readFileSync;
    let readsOfAlpha = 0;
    const tampered = Buffer.from(
      realRead(alphaPath).toString('utf8').replace('interval_days: 4', 'interval_days: 9'),
      'utf8',
    );
    (fs as any).readFileSync = (...args: unknown[]): unknown => {
      // Basename-keyed, for the same macOS canonical-path reason as the test above.
      if (typeof args[0] === 'string' && path.basename(args[0]) === path.basename(alphaPath)) {
        readsOfAlpha += 1;
        if (readsOfAlpha >= 2) return tampered;
      }
      return (realRead as (...a: unknown[]) => unknown)(...args);
    };

    const priorExit = process.exitCode;
    process.exitCode = 0;
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await adoptUndoCommand(undefined, { undo: true, all: true, yes: true });
    } finally {
      console.error = realErr;
      (fs as any).readFileSync = realRead;
    }
    const exit = process.exitCode;
    process.exitCode = priorExit;

    assert.ok(
      readsOfAlpha >= 2,
      `expected the note to be read at plan time and again before commit, got ${readsOfAlpha} reads`,
    );
    assert.equal(exit, 4, `expected the OCC exit code, logged: ${logged.join(' | ')}`);
    assert.ok(
      logged.some((line) => /OCC conflict: 1 note\(s\) were modified while this run was planning; nothing was un-adopted\./.test(line)),
      logged.join(' | '),
    );
    assert.ok(logged.some((line) => /Re-run to plan against the current bytes\./.test(line)), logged.join(' | '));
    // The decisive part: neither note moved, including the one that was never touched.
    assert.deepEqual(fs.readFileSync(path.join(vaultDir, 'alpha.md')), alphaBefore);
    assert.deepEqual(fs.readFileSync(path.join(vaultDir, 'beta.md')), betaBefore);
  });
});
