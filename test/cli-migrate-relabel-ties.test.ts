import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';
import migrateCommand, { tieStillHolds } from '../src/cli/migrate';

/**
 * A note adopted before #234 stores an alphabetical tiebreak as
 * `depends_on_source: numbered`, and `numbered` gates. Nothing rewrites an
 * already-adopted note, so the lockout outlives the fix — these run the real CLI
 * against frontmatter written by hand, because `adopt` on this tip would label
 * the same pair `tie` and the defect would never appear.
 */
describe('CLI Migrate stored tie labels (PAL-205 #237)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-relabel-ties-'));
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

  /** An adopted note as an older build wrote it: an explicit id, deps and label. */
  function storedNote(id: string, title: string, deps: string[], source: string): string {
    return [
      '---',
      `palee_id: ${id}`,
      'palee_schema: 1',
      `title: ${title}`,
      `difficulty: beginner`,
      `depends_on: [${deps.join(', ')}]`,
      `depends_on_source: ${source}`,
      'topic_mastery: 0',
      '---',
      '',
      `# ${title}`,
      '',
    ].join('\n');
  }

  function frontmatterOf(vaultDir: string, rel: string): Record<string, unknown> | null {
    return parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8')).frontmatter;
  }

  function readyIds(configDir: string): string[] {
    const result = runCLI(['plan', '--json'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout) as { ready_to_learn: { id: string }[] };
    return payload.ready_to_learn.map((t) => t.id);
  }

  /** `02-a` and `02-b` carry the same number, so only the alphabet ordered them. */
  const tiedPair = {
    'm/02-a.md': storedNote('T-a', 'First of the pair', [], 'numbered'),
    'm/02-b.md': storedNote('T-b', 'Second of the pair', ['T-a'], 'numbered'),
  };

  test('the audit names a stored tie and writes nothing without the flag', () => {
    const { vaultDir, configDir } = freshVault(tiedPair);
    const before = fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8');

    const result = runCLI(['migrate'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Prerequisite labels:\s+1 note/, `the tie must be reported:\n${result.stdout}`);
    assert.match(result.stdout, /m[\\/]02-b\.md → m\/02-a\.md/);
    assert.match(result.stdout, /palee migrate --relabel-ties/);
    assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8'), before,
      'a scan must not touch the note');
  });

  test('--relabel-ties demotes the label and unlocks the note', () => {
    const { vaultDir, configDir } = freshVault(tiedPair);
    const storedBefore = frontmatterOf(vaultDir, 'm/02-b.md');

    // Gated first, so the unlock is a change of state rather than an assumption.
    assert.ok(!readyIds(configDir).includes('T-b'), 'the stored `numbered` edge must gate before');

    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Relabelled 1 of 1 notes/);

    const fm = frontmatterOf(vaultDir, 'm/02-b.md');
    assert.strictEqual(fm?.depends_on_source, 'tie', 'the label must now read `tie`');
    assert.deepStrictEqual(fm?.depends_on, ['T-a'], 'depends_on must be untouched');
    assert.ok(readyIds(configDir).includes('T-b'), 'a tie must not hold the note off the ready list');

    // The pass is label-only: every other key the older build stored must come
    // back unchanged, or this is a rewrite wearing a small name.
    const onlyLabelChanged = Object.entries({ ...(fm as Record<string, unknown>) })
      .filter(([key]) => key !== 'depends_on_source')
      .sort(([a], [b]) => a.localeCompare(b));
    const storedRest = Object.entries({ ...(storedBefore as Record<string, unknown>) })
      .filter(([key]) => key !== 'depends_on_source')
      .sort(([a], [b]) => a.localeCompare(b));
    assert.deepStrictEqual(onlyLabelChanged, storedRest,
      'palee_id, schema, title, difficulty, depends_on and mastery must all survive untouched');
  });

  test('--dry-run reports the blast radius and writes nothing', () => {
    const { vaultDir, configDir } = freshVault(tiedPair);
    const before = fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8');

    const result = runCLI(['migrate', '--relabel-ties', '--dry-run'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Prerequisite labels:\s+1 note/, `the audit must still run:\n${result.stdout}`);
    assert.match(result.stdout, /Dry run: would relabel 1 note/);
    assert.doesNotMatch(result.stdout, /Relabelled /, 'a dry run must not claim to have written');
    assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8'), before,
      '--dry-run writes nothing, even beside --relabel-ties');
    assert.ok(!readyIds(configDir).includes('T-b'), 'and so the note stays gated');
  });

  test('a second run finds nothing left to relabel', () => {
    const { configDir } = freshVault(tiedPair);
    runCLI(['migrate', '--relabel-ties'], configDir);
    const again = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(again.status, 0, again.stdout + again.stderr);
    assert.doesNotMatch(again.stdout, /Prerequisite labels:/, 'the pass must be idempotent');
  });

  test('an edge the numbering really did decide is left gating', () => {
    // `01-a` → `02-b`: different numbers, so the tree chose this order and the
    // label is correct. Relabelling it would drop a genuine gate, which is the
    // one mistake this pass cannot be allowed to make.
    const { vaultDir, configDir } = freshVault({
      'm/01-a.md': storedNote('T-a', 'Foundations', [], 'numbered'),
      'm/02-b.md': storedNote('T-b', 'Later lesson', ['T-a'], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Prerequisite labels:/);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered');
    assert.ok(!readyIds(configDir).includes('T-b'), 'a decided edge must still gate');
  });

  test('a note with more than one stored prerequisite is not touched', () => {
    // One label covers the whole list, so relabelling a note whose list holds a
    // second edge would make that edge advisory too. `adopt` never writes a
    // multi-entry list under `numbered`, so a vault that has one was edited.
    const { vaultDir, configDir } = freshVault({
      'm/00-x.md': storedNote('T-x', 'Another sibling', [], 'numbered'),
      ...tiedPair,
      'm/01-a.md': storedNote('T-a2', 'A decided predecessor', [], 'numbered'),
    });
    fs.writeFileSync(
      path.join(vaultDir, 'm', '02-b.md'),
      storedNote('T-b', 'Second of the pair', ['T-a', 'T-a2'], 'numbered')
    );
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Prerequisite labels:/, 'a two-edge list must not be demoted');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered');
  });

  test('a note the learner authored is never re-labelled', () => {
    // An absent label means the learner wrote the list, and that gates by design
    // whatever the filenames look like.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First of the pair', [], 'numbered'),
      'm/02-b.md': ['---', 'palee_id: T-b', 'palee_schema: 1', 'title: Second',
        'depends_on: [T-a]', 'topic_mastery: 0', '---', '', '# Second', ''].join('\n'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Prerequisite labels:/);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, undefined);
  });

  test('an edge running against the enumeration is the learner’s, not a tie', () => {
    // `02-b → 02-a` is what the planner writes for a tied pair. This is the same
    // two equal-rank filenames pointed the other way, so rank equality alone
    // cannot tell the two apart — and nothing in the chain ever produces it. A
    // `numbered` label here was set by somebody on purpose, and demoting it
    // would silently unlock a note the learner meant to keep gated.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First of the pair', ['T-b'], 'numbered'),
      'm/02-b.md': storedNote('T-b', 'Second of the pair', [], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Prerequisite labels:/, 'a reversed edge is not a stale tie');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-a.md')?.depends_on_source, 'numbered');
    assert.ok(!readyIds(configDir).includes('T-a'), 'and it must still gate');
  });

  test('the write-time recheck refuses a note that no longer matches the scan', () => {
    // The audit and the write are separated, so a decision made against the scan
    // must be re-made against the bytes about to be written. No single-process
    // run can edit a note inside that window, which is why the predicate is
    // tested directly rather than through the CLI.
    const scanned = storedNote('T-b', 'Second of the pair', ['T-a'], 'numbered');
    assert.ok(tieStillHolds(scanned, 'T-a'), 'the scanned shape still holds');
    assert.ok(!tieStillHolds(scanned, 'T-z'), 'a different predecessor is not the same edge');
    assert.ok(!tieStillHolds(scanned.replace('depends_on_source: numbered', 'depends_on_source: tie'), 'T-a'),
      'a label already changed by someone else is not ours to rewrite');
    assert.ok(!tieStillHolds(scanned.replace('depends_on: [T-a]', 'depends_on: [T-a, T-c]'), 'T-a'),
      'a list that grew since the scan covers an edge we never classified');
    assert.ok(!tieStillHolds(scanned.replace('depends_on: [T-a]', 'depends_on: []'), 'T-a'),
      'a list emptied since the scan gates nothing');
  });

  test('a write error fails the command instead of reporting success', async () => {
    // A permission or disk failure has to be visible to a caller: exiting 0 with
    // the note still gated is how an incomplete migration reads as a done one.
    const { vaultDir, configDir } = freshVault(tiedPair);
    const notePath = path.join(vaultDir, 'm', '02-b.md');
    const originalRename = fs.renameSync;
    const savedConfigDir = process.env.PALEE_CONFIG_DIR;
    const savedExitCode = process.exitCode;
    try {
      process.env.PALEE_CONFIG_DIR = configDir;
      (fs as unknown as { renameSync: unknown }).renameSync = ((
        from: string,
        to: string
      ) => {
        if (to === notePath) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return originalRename(from, to);
      }) as typeof fs.renameSync;

      await migrateCommand({ relabelTies: true });
      assert.strictEqual(process.exitCode, 5, 'a non-conflict write failure must not exit 0');
    } finally {
      (fs as unknown as { renameSync: unknown }).renameSync = originalRename;
      process.exitCode = savedExitCode;
      if (savedConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = savedConfigDir;
    }
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered',
      'the failed note stays exactly as it was');
  });
});
