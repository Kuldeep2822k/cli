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
   */
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
});
