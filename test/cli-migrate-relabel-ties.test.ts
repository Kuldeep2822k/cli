import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';
import migrateCommand, { predecessorIntact, type StoredTie } from '../src/cli/migrate';

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

  /**
   * Runs the real CLI in a child process against an isolated config dir.
   *
   * @param args - Arguments after `bin/palee.ts`
   * @param configDir - Value of `PALEE_CONFIG_DIR` for the run
   * @returns The exit status with captured stdout and stderr
   */
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

  /**
   * Writes hand-made pre-#234 frontmatter into a temp vault and points a temp
   * config at it, so the tests exercise stored state `adopt` would never write.
   *
   * @param files - Vault-relative paths to note contents
   * @returns The vault and config directories for the CLI to run against
   *
   * @remarks
   * The vault is returned canonicalized (`realpathSync`): the loader walks
   * from a resolved root, so on a machine whose temp dir passes through a
   * symlink (macOS `/var` → `/private/var`) the walked note paths would
   * otherwise never `===` a path joined onto the unresolved temp dir — and
   * the `fs`-patching tests below compare exactly that.
   */
  function freshVault(files: Record<string, string>): { vaultDir: string; configDir: string } {
    const vaultDir = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, 'vault-')));
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

  /**
   * Reads one note's frontmatter back through the same parser the vault uses.
   *
   * @param vaultDir - The temp vault root
   * @param rel - Vault-relative note path
   * @returns The parsed frontmatter, or null when the note has none
   */
  function frontmatterOf(vaultDir: string, rel: string): Record<string, unknown> | null {
    return parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8')).frontmatter;
  }

  /**
   * Returns the ids `palee plan` currently considers ready to learn.
   *
   * @param configDir - The temp config pointing at the vault under test
   * @returns Ids on the ready list, so gating is asserted as state, not assumed
   */
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

  test('a predecessor renamed into a numbering-decided slot is left gated', () => {
    // A tie is a claim about a pair, so the pass asks the vault what the pair
    // looks like now instead of trusting anything it printed earlier. Here the
    // sibling moves from `02-a` to `01-a`: the numbering now genuinely orders the
    // two, which is precisely the edge that has to keep gating.
    const { vaultDir, configDir } = freshVault(tiedPair);
    fs.renameSync(path.join(vaultDir, 'm', '02-a.md'), path.join(vaultDir, 'm', '01-a.md'));

    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Prerequisite labels:/,
      '01-a → 02-b is decided by the numbers, so it is not a stale tie');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered');
    assert.ok(!readyIds(configDir).includes('T-b'), 'and the note stays behind its prerequisite');
  });

  test('a dependent re-pointed at another earlier sibling is relabelled, not skipped', () => {
    // Three same-rank notes chained a → b → c. Every one of those edges is an
    // alphabetical tie, so all qualify together: a pass that carried a remembered
    // predecessor id forward would drop `02-c` the moment its edge named someone
    // other than the note it first looked at, exit 0, and leave it gated.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First sibling', [], 'numbered'),
      'm/02-b.md': storedNote('T-b', 'Second sibling', ['T-a'], 'numbered'),
      'm/02-c.md': storedNote('T-c', 'Third sibling', ['T-b'], 'numbered'),
    });

    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Relabelled 2 of 2 notes/,
      `both ties in a chained run are found in one pass:\n${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on_source, 'tie',
      'a qualifying edge must never be passed over because its predecessor moved');
    assert.deepStrictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on, ['T-b'],
      'and its prerequisite list is untouched');
  });

  test('the predecessor check follows identity, not bytes or inode', () => {
    // What the derivation relied on is that this id still lives at this path.
    // Everything else about the predecessor is beside the point: which of the
    // two notes the numbering puts first depends on their names and directory, so
    // an edit is not drift — and this pass makes exactly that edit as it walks a
    // chained run of ties, which is why checking bytes or inode here made
    // `02-a → 02-b → 02-c` unfinishable (each write invalidated the next check).
    const dir = fs.mkdtempSync(path.join(tempDir, 'predecessor-'));
    const pred = path.join(dir, '02-a.md');
    const tie: StoredTie = {
      filePath: path.join(dir, '02-b.md'),
      predecessorPath: '02-a.md',
      predecessorFilePath: pred,
      noteFingerprint: 'not consulted by this check',
      predecessorId: 'T-a',
    };
    fs.writeFileSync(pred, storedNote('T-a', 'First of the pair', [], 'numbered'));
    assert.ok(predecessorIntact(dir, tie), 'the same id at the same path is the pair it decided on');

    fs.writeFileSync(pred, storedNote('T-a', 'First of the pair, rewritten', [], 'numbered'));
    assert.ok(predecessorIntact(dir, tie), 'an edit is not a rename; the ranking is unchanged');

    fs.writeFileSync(pred, storedNote('T-impostor', 'A different note', [], 'numbered'));
    assert.ok(!predecessorIntact(dir, tie), 'another topic behind that name is a different pair');

    fs.renameSync(pred, path.join(dir, '01-a.md'));
    assert.ok(!predecessorIntact(dir, tie),
      'a renamed predecessor is the drift that flips a tie into a numbering decision');
  });

  test('a note whose ids carry surrounding whitespace is still relabelled', () => {
    // The loader trims `palee_id` and each `depends_on` entry, so ` T-a ` and
    // `T-a` are the same topic to it. A check that parses the frontmatter by hand
    // sees ` T-a ` and concludes the predecessor became some other note — the
    // note that needed no fixing at all is then passed over, and the vault keeps
    // a gate the pass was invoked to relax.
    /** A note as a hand-edited vault stores it: ids and entries wrapped in spaces. */
    const padded = (id: string, title: string, deps: string[]): string => [
      '---', `palee_id: " ${id} "`, 'palee_schema: 1', `title: ${title}`,
      `depends_on: ["${deps.join('", "')}"]`, 'depends_on_source: numbered',
      'topic_mastery: 0', '---', '', `# ${title}`, '',
    ].join('\n');
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': padded('T-a', 'First of the pair', []),
      'm/02-b.md': padded('T-b', 'Second of the pair', [' T-a ']),
    });

    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Relabelled 1 of 1 notes/,
      `a padded id is the same topic, not drift:\n${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie');
    assert.ok(readyIds(configDir).includes('T-b'), 'and the note comes off the gated side');
  });

  /**
   * Runs the pass with every `console.log` and `console.error` line collected.
   *
   * @param run - The call to make while the streams are redirected
   * @returns The collected output, stdout and stderr interleaved as printed
   */
  async function withCapturedOutput(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]): void => { lines.push(args.join(' ')); };
    console.error = (...args: unknown[]): void => { lines.push(args.join(' ')); };
    try {
      await run();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    return lines.join('\n');
  }

  test('a note deleted before its write is reported as gone, not as a failed write', async () => {
    // ENOENT here was counted as a write error, so the command closed with
    // "1 relabel write(s) failed. The notes remain gated." under exit `5` — a
    // direction to repair a note that no longer exists, about a vault in which
    // nothing is gated any more. The saved exit code makes the run look like a
    // crash rather than a note that moved on.
    const { vaultDir, configDir } = freshVault(tiedPair);
    const notePath = path.join(vaultDir, 'm', '02-b.md');
    const originalRead = fs.readFileSync;
    const savedConfigDir = process.env.PALEE_CONFIG_DIR;
    const savedExitCode = process.exitCode;
    let noteReads = 0;
    try {
      process.env.PALEE_CONFIG_DIR = configDir;
      (fs as unknown as { readFileSync: unknown }).readFileSync = ((
        target: fs.PathLike | number,
        options?: unknown
      ) => {
        // Read #1 is the scan's, read #2 is the write loop's re-read: removing the
        // note between them is exactly the race the pass has to survive, and the
        // file really is gone by the time the pass asks.
        if (target === notePath && ++noteReads === 2) {
          fs.rmSync(notePath, { force: true });
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${notePath}'`), {
            code: 'ENOENT',
          });
        }
        return Reflect.apply(originalRead, fs, [target, options]);
      }) as typeof fs.readFileSync;

      const output = await withCapturedOutput(async () => {
        await migrateCommand({ relabelTies: true });
      });

      assert.match(output, /02-b\.md: the note no longer exists/, 'the note is named, not lumped in');
      assert.match(output, /\(1 no longer exist: nothing to relabel\)/, 'and the summary counts it apart');
      assert.match(output, /Relabelled 0 of 1 notes/, 'the pass still reports what it did');
      assert.notStrictEqual(process.exitCode, 5, 'a note that is gone is not a crashed migration');
      assert.notStrictEqual(process.exitCode, 4, 'and it is not a conflict to re-run either');
    } finally {
      (fs as unknown as { readFileSync: unknown }).readFileSync = originalRead;
      process.exitCode = savedExitCode;
      if (savedConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = savedConfigDir;
    }
    assert.match(
      fs.readFileSync(path.join(vaultDir, 'm', '02-a.md'), 'utf8'),
      /depends_on_source: numbered/,
      'the surviving note is left alone: only the vanished one was a candidate'
    );
  });

  test('an ENOENT from the write is still a write error when the note exists', async () => {
    // The vanished classification keys on the note being gone, not on the error
    // code: a parent directory removed under `atomicWrite`, or a temp-file race in
    // its rename, raises ENOENT while the note sits there untouched — and a note
    // that exists still has its relabel to do. Calling that "nothing to relabel"
    // and exiting 0 tells the learner their vault is settled when it is not.
    const { vaultDir, configDir } = freshVault(tiedPair);
    const notePath = path.join(vaultDir, 'm', '02-b.md');
    const originalRename = fs.renameSync;
    const savedConfigDir = process.env.PALEE_CONFIG_DIR;
    const savedExitCode = process.exitCode;
    try {
      process.env.PALEE_CONFIG_DIR = configDir;
      (fs as unknown as { renameSync: unknown }).renameSync = ((from: string, to: string) => {
        if (to === notePath) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), {
            code: 'ENOENT',
          });
        }
        return originalRename(from, to);
      }) as typeof fs.renameSync;

      const output = await withCapturedOutput(async () => {
        await migrateCommand({ relabelTies: true });
      });

      assert.match(output, /\(1 write error\(s\)\)/, 'the note that still exists is a failed write');
      assert.doesNotMatch(output, /no longer exist/, 'and it is not reported as gone');
      assert.strictEqual(process.exitCode, 5, 'a real write failure still fails the run');
    } finally {
      (fs as unknown as { renameSync: unknown }).renameSync = originalRename;
      process.exitCode = savedExitCode;
      if (savedConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = savedConfigDir;
    }
  });

  test('a locked note is counted in the summary, not only on stderr', async () => {
    // The conflict set `hadConflict` and nothing else, so stdout read "Relabelled
    // 1 of 2 notes" with no hint that a note had been refused, and the reason
    // lived only on stderr — where a caller diffing the summary would never look.
    const { vaultDir, configDir } = freshVault(tiedPair);
    const notePath = path.join(vaultDir, 'm', '02-b.md');
    const originalRename = fs.renameSync;
    const savedConfigDir = process.env.PALEE_CONFIG_DIR;
    const savedExitCode = process.exitCode;
    try {
      process.env.PALEE_CONFIG_DIR = configDir;
      (fs as unknown as { renameSync: unknown }).renameSync = ((from: string, to: string) => {
        if (to === notePath) {
          throw Object.assign(new Error('Lock conflict: held by another process'), {
            code: 'ECONFLICT',
          });
        }
        return originalRename(from, to);
      }) as typeof fs.renameSync;

      const output = await withCapturedOutput(async () => {
        await migrateCommand({ relabelTies: true });
      });

      assert.match(output, /\(1 locked: re-run to retry\)/, 'the summary has to say a note was refused');
      assert.match(output, /OCC conflict or active lock detected/, 'and point at the retry');
      assert.strictEqual(process.exitCode, 4, 'the conflict exit code is unchanged');
      assert.strictEqual(
        parseFrontmatter(fs.readFileSync(notePath, 'utf8')).frontmatter?.depends_on_source,
        'numbered',
        'the refused note keeps its label'
      );
    } finally {
      (fs as unknown as { renameSync: unknown }).renameSync = originalRename;
      process.exitCode = savedExitCode;
      if (savedConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = savedConfigDir;
    }
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

  test('a note that moves between the scan and its write is refused and reported', async () => {
    // The pass decides from one scan and writes from it, so the bytes on disk at the
    // moment of promotion are a second opinion. This is the seam no CLI run can reach:
    // the loader reads the note once (`src/storage/loader.ts:229`), the write loop
    // re-reads it (`reportStoredTies`), and `atomicWrite` reads it a third time for its
    // own OCC check — so the second read is the gap between the decision and the write.
    // Tamper that read and the note must not be relabelled from bytes nothing judged.
    //
    // Removing the fingerprint re-check makes this fail two ways: the loop proceeds,
    // `atomicWrite`'s OCC check still matches (the disk is pristine), and the tampered
    // label lands on the note while the command exits 0.
    const { vaultDir, configDir } = freshVault(tiedPair);
    const notePath = path.join(vaultDir, 'm', '02-b.md');
    const originalRead = fs.readFileSync;
    const savedConfigDir = process.env.PALEE_CONFIG_DIR;
    const savedExitCode = process.exitCode;
    let noteReads = 0;
    let tampered = false;
    try {
      process.env.PALEE_CONFIG_DIR = configDir;
      (fs as unknown as { readFileSync: unknown }).readFileSync = ((
        target: fs.PathLike | number,
        options?: unknown
      ) => {
        const out = Reflect.apply(originalRead, fs, [target, options]) as string | Buffer;
        if (target === notePath && typeof out === 'string') {
          noteReads++;
          if (noteReads === 2 && out.includes('depends_on_source: numbered')) {
            tampered = true;
            return out.replace('depends_on_source: numbered', 'depends_on_source: tie');
          }
        }
        return out;
      }) as typeof fs.readFileSync;

      await migrateCommand({ relabelTies: true });
      assert.strictEqual(tampered, true, 'the write loop must have re-read the note');
      assert.strictEqual(process.exitCode, 4, 'drift under the pass is a conflict, not a success');
    } finally {
      (fs as unknown as { readFileSync: unknown }).readFileSync = originalRead;
      process.exitCode = savedExitCode;
      if (savedConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = savedConfigDir;
    }
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbered',
      'the note keeps the label the vault stored, not one derived from bytes nothing read');
  });
  test('a same-rank name in another directory is not this pass to relabel', () => {
    // Two notes whose filenames tie are only a tie inside one directory: the order
    // between `m/` and `n/` is decided by the directories or not at all, so a
    // cross-directory edge labelled `numbered` is not a claim the chain made.
    // Deleting the dirname test in findStoredTies relabels this note and demotes an
    // edge nobody can account for, which is the harm the guard exists to prevent.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-ma', 'Note in the first directory', [], 'numbered'),
      'n/02-b.md': storedNote('T-nb', 'Note in the second directory', ['T-ma'], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Prerequisite labels:/,
      `a cross-directory pair is not a stored tie:
${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'n/02-b.md')?.depends_on_source, 'numbered',
      'the label is left exactly as the vault stored it');
  });

  test('a note whose predecessor no longer resolves is counted, not guessed at', () => {
    // With the id gone there is no pair left to rank, so this pass cannot tell a
    // stored tie from a numbering-decided edge. It says the note is there, hands it
    // to the report that names the missing id, and leaves the label alone.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First of the pair', [], 'numbered'),
      'm/02-b.md': storedNote('T-b', 'Second of the pair', ['T-a'], 'numbered'),
      'm/03-c.md': storedNote('T-c', 'Depends on a deleted note', ['T-gone'], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 note\(s\) labelled `numbered` depend on an id/,
      `the unresolvable edge must be counted:
${result.stdout}`);
    assert.match(result.stdout, /palee validate` reports those edges/,
      `and name the report that owns it:
${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/03-c.md')?.depends_on_source, 'numbered',
      'an edge to a missing note is not this pass to demote');
    // The genuine tie in the same vault is still judged on its own merits.
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie');
  });

  test('an edge that skips a sibling still on disk is not this pass to demote', () => {
    // The chain links neighbours: three same-rank notes get `02-b → 02-a` and
    // `02-c → 02-b`, never `02-c → 02-a`. So an edge that steps over `02-b` while
    // `02-b` sits in the directory was not written by the chain, and demoting it
    // unlocks a note the learner meant to hold behind two prerequisites. Deleting
    // the `survivingSiblingBetween` call in findStoredTies relabels `02-c` here and
    // puts it on the ready list, which is the harm the guard exists to prevent.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First sibling', [], 'numbered'),
      'm/02-b.md': storedNote('T-b', 'Second sibling', ['T-a'], 'numbered'),
      'm/02-c.md': storedNote('T-c', 'Third sibling, skipping one', ['T-a'], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie',
      `the neighbour edge still qualifies:
${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on_source, 'numbered',
      'the skipping edge is left exactly as stored');
    const ready = readyIds(configDir);
    assert.ok(ready.includes('T-b'), 'and the demoted note is offered');
    assert.ok(!ready.includes('T-c'), 'while the skipping note stays gated');
  });

  test('the nearest surviving sibling is demoted when the middle note is gone', () => {
    // The same `02-c → 02-a` edge with `02-b` absent is exactly what the chain
    // wrote before the learner deleted the middle note, so the rule is about what
    // sits between them now, not about adjacency in the original numbering. An
    // immediate-predecessor test instead of this one would strand the note gated
    // forever — the false negative this pass was built to remove.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First sibling', [], 'numbered'),
      'm/02-c.md': storedNote('T-c', 'Third sibling, alone after a deletion', ['T-a'], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Relabelled 1 of 1 notes/,
      `a non-adjacent edge with nothing between is the chain's own:
${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on_source, 'tie');
    assert.ok(readyIds(configDir).includes('T-c'), 'and the note is unlocked');
  });

  test('a skipping edge does not strand the neighbours chained behind it', () => {
    // One refusal per note, on that note's own merits: `02-b` and `02-d` name their
    // nearest survivor and qualify, `02-c` steps over `02-b` and does not. A guard
    // that bailed out of the whole directory, or keyed the check on the note rather
    // than the edge, would leave `02-d` gated behind an edge the chain did write.
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': storedNote('T-a', 'First sibling', [], 'numbered'),
      'm/02-b.md': storedNote('T-b', 'Second sibling', ['T-a'], 'numbered'),
      'm/02-c.md': storedNote('T-c', 'Third sibling, skipping one', ['T-a'], 'numbered'),
      'm/02-d.md': storedNote('T-d', 'Fourth sibling', ['T-c'], 'numbered'),
    });
    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Relabelled 2 of 2 notes/,
      `both neighbour edges are written in one pass:
${result.stdout}`);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on_source, 'numbered');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-d.md')?.depends_on_source, 'tie',
      'a skipped candidate does not stop the pass where it stands');
  });

  test('a dry run lists every candidate while the audit keeps its preview limit', () => {
    // The dry run is the preview of exactly what `--relabel-ties` would touch,
    // so truncating it hides notes the user is about to approve. The audit-only
    // report keeps its five-path limit; only the dry run lists everything.
    // Removing the `previewAll` branch truncates the dry run back to five and
    // fails the bullet count below.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const files: Record<string, string> = {
      'm/02-a.md': storedNote('T-a', 'First of the chain', [], 'numbered'),
    };
    let prev = 'T-a';
    for (const letter of ids.slice(1)) {
      const id = `T-${letter}`;
      files[`m/02-${letter}.md`] = storedNote(id, `Note ${letter}`, [prev], 'numbered');
      prev = id;
    }
    const { vaultDir, configDir } = freshVault(files);

    const audit = runCLI(['migrate'], configDir);
    assert.strictEqual(audit.status, 0, audit.stdout + audit.stderr);
    assert.match(audit.stdout, /Prerequisite labels:\s+6 note/);
    assert.match(audit.stdout, /\.\.\. and 1 more/, 'the audit preview stays truncated');
    assert.strictEqual(audit.stdout.match(/→/g)?.length ?? 0, 5,
      'the audit lists five paths, not six');

    const dry = runCLI(['migrate', '--relabel-ties', '--dry-run'], configDir);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Dry run: would relabel 6 note/);
    assert.doesNotMatch(dry.stdout, /\.\.\. and/, 'a dry run must not truncate its preview');
    for (const letter of ids.slice(1)) {
      assert.match(dry.stdout, new RegExp(`02-${letter}\\.md`),
        `the dry run must name 02-${letter}.md`);
    }
    assert.strictEqual(dry.stdout.match(/→/g)?.length ?? 0, 6,
      'the dry run lists every candidate');
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-g.md')?.depends_on_source, 'numbered',
      '--dry-run still writes nothing');
  });

  test('a mastered prerequisite stays mastered and out of the ready list through a relabel', () => {
    // #237's readiness claim is about notes that already crossed the threshold, and
    // every other test here runs at `topic_mastery: 0` — where the gate is what
    // decides, so the mastered path in `getReadyTopics` is never taken. With `02-a`
    // at 0.9 the prerequisite is skipped before `depends_on` is consulted at all, so
    // this is the case that shows a label rewrite cannot disturb a note the learner
    // has finished.
    const mastered = ['---', 'palee_id: T-a', 'palee_schema: 1', 'title: Foundations',
      'difficulty: beginner', 'topic_mastery: 0.9', '---', '', '# Foundations', ''].join('\n');
    const { vaultDir, configDir } = freshVault({
      'm/02-a.md': mastered,
      'm/02-b.md': storedNote('T-b', 'Second of the pair', ['T-a'], 'numbered'),
    });
    const before = readyIds(configDir);
    assert.ok(before.includes('T-b'), 'a mastered prerequisite already satisfies the gate');
    assert.ok(!before.includes('T-a'), 'and is itself past the ready list');

    const result = runCLI(['migrate', '--relabel-ties'], configDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie',
      'the tie is still demoted, which is the whole point of the pass');
    assert.strictEqual(Number(frontmatterOf(vaultDir, 'm/02-a.md')?.topic_mastery), 0.9,
      'the mastered note is not written at all');

    const after = readyIds(configDir);
    assert.ok(!after.includes('T-a'), 'a mastered note never re-enters the ready list');
    assert.deepStrictEqual(after, before, "and the relabel changes nobody else's readiness");
  });

  /**
   * #266: the population `--help` promised but never reached.
   *
   * A note adopted by the shipped 0.5.2 auto-chain carries an edge and **no**
   * `depends_on_source` key at all, because that label did not exist yet, and an
   * absent label gates by design. `findStoredTies` asked only for the exact
   * `numbered` string, so `--relabel-ties` exited 0 in silence over exactly the
   * vaults it advertises. These run the unlabeled route behind its opt-in flag;
   * the shape of the frontmatter is what that build wrote (see the `v0.5.2`
   * auto-chain commit, whose `palee adopt --auto-chain` emits this field set).
   */
  describe('#266 the unlabeled v0.5.x population (--include-unlabeled-ties)', () => {
    /** The same note as {@link storedNote} with no label key — the 0.5.2 shape. */
    function unlabeledNote(id: string, title: string, deps: string[]): string {
      return [
        '---',
        `palee_id: ${id}`,
        'palee_schema: 1',
        `title: ${title}`,
        'difficulty: beginner',
        `depends_on: [${deps.join(', ')}]`,
        'topic_mastery: 0',
        'ease_factor: 2.5',
        'interval_days: 1',
        'repetition: 0',
        'lapses: 0',
        '---',
        '',
        `# ${title}`,
        '',
      ].join('\n');
    }

    /** A tied pair as the 0.5.2 auto-chain left it: an edge, no label. */
    const unlabeledTiedPair = {
      'm/02-a.md': unlabeledNote('T-a', 'First of the pair', []),
      'm/02-b.md': unlabeledNote('T-b', 'Second of the pair', ['T-a']),
    };

    test('an unlabeled tie keeps gating without the opt-in', () => {
      // The default must not change: opening this route silently on upgrade would
      // rewrite user frontmatter nobody asked to touch, which is the defect class
      // this release already carries (#257/#258/#259).
      const { vaultDir, configDir } = freshVault(unlabeledTiedPair);
      const before = fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8');

      const result = runCLI(['migrate', '--relabel-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/,
        `the opt-in is the only route to an unlabeled note:\n${result.stdout}`);
      assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8'), before,
        'and the default pass writes nothing at all');
      assert.ok(!readyIds(configDir).includes('T-b'), 'so the note stays blocked');
    });

    test('--include-unlabeled-ties demotes the v0.5.x tie and unlocks the note', () => {
      const { vaultDir, configDir } = freshVault(unlabeledTiedPair);
      const storedBefore = frontmatterOf(vaultDir, 'm/02-b.md');
      assert.ok(!readyIds(configDir).includes('T-b'), 'the unlabeled edge must gate before');

      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Relabelled 1 of 1 notes/,
        `the route the --help promised must actually reach the note:\n${result.stdout}`);

      const fm = frontmatterOf(vaultDir, 'm/02-b.md');
      assert.strictEqual(fm?.depends_on_source, 'tie', 'the note gains the advisory label');
      assert.deepStrictEqual(fm?.depends_on, ['T-a'], 'depends_on is never changed');
      assert.ok(readyIds(configDir).includes('T-b'), 'and the note comes off the gated side');

      // Label-only: every key the 0.5.2 build wrote must come back unchanged.
      const onlyLabelAdded = Object.entries({ ...(fm as Record<string, unknown>) })
        .filter(([key]) => key !== 'depends_on_source')
        .sort(([a], [b]) => a.localeCompare(b));
      const storedRest = Object.entries({ ...(storedBefore as Record<string, unknown>) })
        .filter(([key]) => key !== 'depends_on_source')
        .sort(([a], [b]) => a.localeCompare(b));
      assert.deepStrictEqual(onlyLabelAdded, storedRest,
        'palee_id, schema, title, difficulty, depends_on, mastery and the SRS fields survive untouched');
    });

    test('the audit reports unlabeled candidates only when they are asked for', () => {
      const { vaultDir, configDir } = freshVault(unlabeledTiedPair);
      const before = fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8');

      const result = runCLI(['migrate', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Prerequisite labels:\s+1 note/,
        `the preview must name the unlabeled note:\n${result.stdout}`);
      assert.match(result.stdout, /m[\\/]02-b\.md → m\/02-a\.md/);
      assert.match(result.stdout, /no `depends_on_source` key/,
        `and must say which population it is describing:\n${result.stdout}`);
      assert.match(result.stdout, /palee migrate --relabel-ties --include-unlabeled-ties/,
        `and the tip must name both flags:\n${result.stdout}`);
      assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'm', '02-b.md'), 'utf8'), before,
        'a preview run without --relabel-ties writes nothing');
    });

    test('a dry run previews every unlabeled candidate before anything is written', () => {
      // This path rewrites notes the CLI did not label, so the preview has to be
      // the whole blast radius — the same rule #239 established for `numbered`.
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const files: Record<string, string> = {
        'm/02-a.md': unlabeledNote('T-a', 'First of the chain', []),
      };
      let prev = 'T-a';
      for (const letter of ids.slice(1)) {
        const id = `T-${letter}`;
        files[`m/02-${letter}.md`] = unlabeledNote(id, `Note ${letter}`, [prev]);
        prev = id;
      }
      const { vaultDir, configDir } = freshVault(files);

      const dry = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties', '--dry-run'], configDir);
      assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
      assert.match(dry.stdout, /Dry run: would relabel 6 note/);
      assert.doesNotMatch(dry.stdout, /\.\.\. and/, 'a dry run must not truncate its preview');
      assert.doesNotMatch(dry.stdout, /Relabelled /, 'a dry run must not claim to have written');
      for (const letter of ids.slice(1)) {
        assert.match(dry.stdout, new RegExp(`02-${letter}\\.md`), `the dry run must name 02-${letter}.md`);
      }
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-g.md')?.depends_on_source, undefined,
        '--dry-run still writes nothing');
      assert.ok(!readyIds(configDir).includes('T-g'), 'and the note stays gated');
    });

    test('the stored `numbered` population still demotes beside the opt-in', () => {
      // Opting into the unlabeled route must not narrow the route that already
      // worked: one run, both populations, each judged by the same planner rule.
      const { vaultDir, configDir } = freshVault({
        ...tiedPair,
        'n/02-p.md': unlabeledNote('T-p', 'First of the unlabelled pair', []),
        'n/02-q.md': unlabeledNote('T-q', 'Second of the unlabelled pair', ['T-p']),
      });

      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Relabelled 2 of 2 notes/,
        `both populations are demoted in one pass:\n${result.stdout}`);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie');
      assert.strictEqual(frontmatterOf(vaultDir, 'n/02-q.md')?.depends_on_source, 'tie');
    });

    test('an unlabeled forward edge is refused', () => {
      // Nothing in the chain produces `02-a → 02-b`: the enumeration puts `02-a`
      // first, so this edge runs against it and only a person typed it.
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-a', 'First of the pair', ['T-b']),
        'm/02-b.md': unlabeledNote('T-b', 'Second of the pair', []),
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/,
        `a reversed edge is not the chain's:\n${result.stdout}`);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-a.md')?.depends_on_source, undefined,
        'and the note keeps no label');
      assert.ok(!readyIds(configDir).includes('T-a'), 'so it keeps gating');
    });

    test('an unlabeled edge into another directory is refused', () => {
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-ma', 'Note in the first directory', []),
        'n/02-b.md': unlabeledNote('T-nb', 'Note in the second directory', ['T-ma']),
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/);
      assert.strictEqual(frontmatterOf(vaultDir, 'n/02-b.md')?.depends_on_source, undefined);
      assert.ok(!readyIds(configDir).includes('T-nb'), 'and the cross-directory gate holds');
    });

    test('an unlabeled note with two prerequisites is refused', () => {
      // One label covers the whole list, and the chain wrote one edge per note, so
      // a second entry is a person's doing and demoting it would make their real
      // prerequisite advisory.
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-a', 'First sibling', []),
        'm/02-c.md': unlabeledNote('T-c', 'Third sibling', ['T-a', 'T-gone']),
        'm/02-d.md': unlabeledNote('T-d', 'Fourth sibling', ['T-c']),
      });
      fs.writeFileSync(path.join(vaultDir, 'm', '02-b.md'), unlabeledNote('T-b', 'Second sibling', ['T-a']));
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on_source, undefined,
        'the two-edge list is not this pass to relabel');
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie',
        'while the neighbour edge still qualifies');
    });

    test('an unlabeled edge that steps over a surviving sibling is refused', () => {
      // #251's rule is the pass's own: the chain links neighbours, so `02-c → 02-a`
      // with `02-b` on disk was never written by the planner — whoever typed it
      // meant a two-deep gate.
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-a', 'First sibling', []),
        'm/02-b.md': unlabeledNote('T-b', 'Second sibling', ['T-a']),
        'm/02-c.md': unlabeledNote('T-c', 'Third sibling, skipping one', ['T-a']),
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie');
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-c.md')?.depends_on_source, undefined,
        'the skipping edge is left exactly as the vault stored it');
      const ready = readyIds(configDir);
      assert.ok(ready.includes('T-b'), 'the demoted neighbour is offered');
      assert.ok(!ready.includes('T-c'), 'while the skipping note stays gated');
    });

    test('an unlabeled note carrying the legacy dependencies alias is refused', () => {
      // `normalizeDependencies` unions `dependencies` into `depends_on` at
      // src/storage/loader.ts:246, so a loaded one-entry list does not prove the
      // note states one edge: the alias is a person's or a pre-auto-chain build's
      // spelling, and the chain never wrote it. Indistinguishable means refused.
      const aliasBoth = ['---', 'palee_id: T-b', 'palee_schema: 1', 'title: Second',
        'difficulty: beginner', 'depends_on: [T-a]', 'dependencies: [T-a]', 'topic_mastery: 0',
        '---', '', '# Second', ''].join('\n');
      const aliasOnly = ['---', 'palee_id: T-d', 'palee_schema: 1', 'title: Fourth',
        'difficulty: beginner', 'depends_on: []', 'dependencies: [T-c]', 'topic_mastery: 0',
        '---', '', '# Fourth', ''].join('\n');
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-a', 'First of the pair', []),
        'm/02-b.md': aliasBoth,
        'm/02-c.md': unlabeledNote('T-c', 'Third of the pair', []),
        'm/02-d.md': aliasOnly,
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/,
        `a legacy alias makes the edge unattributable:
${result.stdout}`);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, undefined);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-d.md')?.depends_on_source, undefined);
      const ready = readyIds(configDir);
      assert.ok(!ready.includes('T-b') && !ready.includes('T-d'), 'and both stay gated');
    });

    test('an unlabeled note whose label is present but unrecognized is refused', () => {
      // `normalizeDependsOnSource` fails closed: an unrecognized value loads as
      // `undefined`, the same value a key that was never written loads as. Only
      // the raw frontmatter tells them apart, and a typo is not an absent label.
      const typo = ['---', 'palee_id: T-b', 'palee_schema: 1', 'title: Second',
        'difficulty: beginner', 'depends_on: [T-a]', 'depends_on_source: numbering',
        'topic_mastery: 0', '---', '', '# Second', ''].join('\n');
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-a', 'First of the pair', []),
        'm/02-b.md': typo,
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'numbering',
        'a typo is left exactly as written, never overwritten with `tie`');
      assert.ok(!readyIds(configDir).includes('T-b'), 'and it keeps gating');
    });

    test('an unlabeled note the planner never chained is refused', () => {
      // Tier-0 hygiene removes `index`/`license` from the plan entirely, so an
      // edge between two of them cannot be one the chain wrote, however the
      // filenames rank. This is the shipped `classifyNoteForChain` predicate, not
      // a restatement of it.
      const plain = (id: string, file: string, deps: string[]): string => [
        '---', `palee_id: ${id}`, 'palee_schema: 1', `title: ${file}`, 'difficulty: beginner',
        `depends_on: [${deps.join(', ')}]`, 'topic_mastery: 0', '---', '', `# ${file}`, '',
      ].join('\n');
      const { vaultDir, configDir } = freshVault({
        'm/index.md': plain('T-i', 'index', []),
        'm/license.md': plain('T-l', 'license', ['T-i']),
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/,
        `an excluded note is not a chain member:
${result.stdout}`);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/license.md')?.depends_on_source, undefined);
      assert.ok(!readyIds(configDir).includes('T-l'), 'and its gate stands');
    });

    test('an unlabeled note with an unresolvable prerequisite is left to validate', () => {
      // With no id to rank against there is no pair to judge, and the unresolved
      // report is worded for the `numbered` population, which this note is not.
      const { vaultDir, configDir } = freshVault({
        'm/02-a.md': unlabeledNote('T-a', 'Depends on a deleted note', ['T-gone']),
      });
      const result = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /Prerequisite labels:/);
      assert.doesNotMatch(result.stdout, /depend on an id/,
        `the \`numbered\` wording must not claim this note:\n${result.stdout}`);
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-a.md')?.depends_on_source, undefined);
    });

    test('the unlabeled route is idempotent', () => {
      const { vaultDir, configDir } = freshVault(unlabeledTiedPair);
      runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      const again = runCLI(['migrate', '--relabel-ties', '--include-unlabeled-ties'], configDir);
      assert.strictEqual(again.status, 0, again.stdout + again.stderr);
      assert.doesNotMatch(again.stdout, /Prerequisite labels:/, 'a demoted note is never a candidate twice');
      assert.strictEqual(frontmatterOf(vaultDir, 'm/02-b.md')?.depends_on_source, 'tie',
        'and the label is not rewritten again');
    });
  });
});
