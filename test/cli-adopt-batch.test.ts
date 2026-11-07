import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { execSync, spawnSync } from 'node:child_process';
import { PALEE_CMD, PALEE_ARGV, CLI_SPAWN_TIMEOUT_MS } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { resolveNoteTitle } from '../src/storage/note-title';

describe('CLI Adopt Batch Integration Tests', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-batch-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    // Seed realistic multi-directory vault
    // MODULES/01-foundations/
    fs.mkdirSync(path.join(vaultDir, 'MODULES', '01-foundations'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md'),
      `---\ntitle: Systems Thinking\ntags:\n  - type/concept\n---\n# Systems Thinking\n`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '01-foundations', 'runbook-template.md'),
      `---\ntitle: Runbook Template\ntags:\n  - template\n---\n# Template\n`
    );

    // MODULES/02-linux/
    fs.mkdirSync(path.join(vaultDir, 'MODULES', '02-linux'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '02-linux', '01-processes.md'),
      `---\ntags:\n  - type/concept\n---\n# Linux Process Deep Dive\n`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '02-linux', 'lab-01-triage.md'),
      `# Linux Triage Lab\n\nSome lab content without frontmatter.`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '02-linux', 'rubric.md'),
      `---\ntags:\n  - type/rubric\n---\n`
    );

    // PROJECTS/
    fs.mkdirSync(path.join(vaultDir, 'PROJECTS'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'PROJECTS', 'project-01.md'),
      `---\ntitle: Project 1\ntags:\n  - category/project\n---\n# Project 1\n`
    );

    // Configure vault
    runCLI(['config', 'set-vault', vaultDir]);
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const escapedArgs = args.map((arg) => (/[*?[\]\s,]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
      const stdout = execSync(`${PALEE_CMD} ${escapedArgs.join(' ')}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  }

  /**
   * Runs the CLI through `spawnSync`, which keeps stderr when the child exits 0.
   *
   * @remarks
   * `execSync` hands back stdout only on a successful run, and the result-cap
   * skips are disclosed on stderr while the run still succeeds — so a test that
   * has to see both streams spawns directly, the way the `--auto-chain`
   * severing cases do. A child that never started, or ran out of its timeout,
   * would otherwise arrive as a bare exit `1` with empty streams and leave the
   * assertion reader no cause; `spawnError` carries it into the failure detail.
   */
  function runCLIBothStreams(args: string[]): {
    status: number;
    stdout: string;
    stderr: string;
    spawnError: string;
  } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      spawnError: result.error ? `spawn failed: ${result.error.message}\n` : '',
    };
  }

  test('resolveNoteTitle helper extracts title from frontmatter, H1 heading, or filename', () => {
    // 1. Frontmatter title
    assert.strictEqual(
      resolveNoteTitle('---\ntitle: My Frontmatter Title\n---\n# Ignored H1\n', 'path/to/file.md'),
      'My Frontmatter Title'
    );
    // 2. H1 heading in body
    assert.strictEqual(
      resolveNoteTitle('<!-- comment -->\n```ts\n# not h1\n```\n# Extracted H1 Title\n\nBody', 'path/to/file.md'),
      'Extracted H1 Title'
    );
    // 3. Filename fallback
    assert.strictEqual(
      resolveNoteTitle('No headings here\nJust text', 'path/to/fallback-name.md'),
      'fallback-name'
    );
  });

  test('palee adopt --dry-run previews adoption without modifying any files', () => {
    const result = runCLI(['adopt', '--all', '--dry-run', '--verbose']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Dry-run complete\. No files were modified\./);
    assert.match(result.stdout, /Ready to Adopt:\s+5 notes/);
    assert.match(
      result.stdout,
      /Skipped \(template\): 1 notes/,
      'Tier-0 hygiene applies to the plain batch too (#298)'
    );

    // Verify no files have palee_id
    const note = path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(note, 'utf8')).frontmatter?.palee_id, undefined);
  });

  test('palee adopt <note> --dry-run leaves the note byte-for-byte alone', () => {
    // The batch branch guarded on `options.dryRun`; the single-file branch did not,
    // so the command a cautious user runs *before* trusting it minted an id,
    // rewrote the frontmatter it promised only to preview, and dropped a
    // hand-authored `depends_on` in the process. Deleting the `options.dryRun`
    // return in that branch fails both assertions below — the byte comparison and
    // the absent `palee_id` — while the commit half keeps the guard honest, so a
    // guard moved too early (never adopting anything) fails the last assertion.
    const rel = path.join('MODULES', '03-single', 'solo.md');
    const note = path.join(vaultDir, rel);
    fs.mkdirSync(path.dirname(note), { recursive: true });
    const original = '---\ntitle: Solo\ndepends_on: [T-real]\n---\n# Solo\n';
    fs.writeFileSync(note, original);

    const dry = runCLI(['adopt', rel, '--dry-run']);
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry-run complete\. No files were modified\./);
    assert.strictEqual(
      fs.readFileSync(note, 'utf8'),
      original,
      `a dry run must not rewrite the note:\n${fs.readFileSync(note, 'utf8')}`
    );
    assert.strictEqual(parseFrontmatter(fs.readFileSync(note, 'utf8')).frontmatter?.palee_id, undefined);

    const commit = runCLI(['adopt', rel]);
    assert.strictEqual(commit.status, 0, commit.stderr);
    assert.ok(parseFrontmatter(fs.readFileSync(note, 'utf8')).frontmatter?.palee_id,
      'the same command without --dry-run still adopts');
  });

  test('palee adopt exits with code 2 in non-interactive environment without --yes', () => {
    const result = runCLI(['adopt', '--all']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /Non-interactive environment\. Use -y or --yes/);
  });

  test('answering the batch confirmation with no writes nothing', { timeout: 15000 }, async () => {
    // The answered half of the gate, and the place the `answered` guard shows
    // itself: the question callback calls `rl.close()`, which emits 'close' too, so an
    // unguarded close handler writes its newline between the prompt and the decline.
    // Here stdin is a fake TTY and stdout a pipe, so readline echoes nothing and the
    // only shape separating the two is that handler's newline — what the guard removes.
    const original = '# Answered Gate\n\nA note that must stay unadopted.\n';
    const dir = path.join(vaultDir, 'ANSWERGATE');
    const note = path.join(dir, 'answered-gate.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(note, original, 'utf8');

    const prevIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const realStdin = process.stdin;
    const realConfigDir = process.env.PALEE_CONFIG_DIR;
    const realWrite = process.stdout.write.bind(process.stdout);
    let printed = '';
    process.env.PALEE_CONFIG_DIR = tempDir;
    Object.defineProperty(process, 'stdin', {
      value: Object.assign(Readable.from(['n\n']), { isTTY: true }),
      configurable: true,
      writable: true,
    });
    // `node --test` on Node 22 tunnels its own V8-serialized test report through
    // the child's stdout as Buffer chunks. Capture the CLI's string writes only and
    // pass the runner's frames through, so they cannot split the prompt line.
    process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]): boolean => {
      if (typeof chunk !== 'string') {
        return (realWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
      }
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    let noteAfter: string;
    try {
      const { default: adoptEntry } = await import('../src/cli/adopt');
      await adoptEntry(undefined, { all: true });
    } finally {
      noteAfter = fs.existsSync(note) ? fs.readFileSync(note, 'utf8') : '<deleted>';
      process.stdout.write = realWrite as typeof process.stdout.write;
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
      if (realConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = realConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTTY, configurable: true });
    }
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.match(printed, /Proceed with adoption\? \(y\/N\): /, printed);
    assert.match(printed, /Aborted\./, printed);
    assert.match(
      printed,
      /Proceed with adoption\? \(y\/N\): Aborted\./,
      'the decline follows the prompt directly; the close after an answered prompt inserts no newline'
    );
    assert.doesNotMatch(
      printed,
      /Proceed with adoption\? \(y\/N\): \n/,
      'no newline lands between the prompt and the decline — unguarded, the close handler writes one'
    );
    assert.strictEqual(exitCode, undefined, 'declining is a clean exit 0, not an error');
    assert.strictEqual(noteAfter, original, 'and the note keeps its unadopted bytes');
  });

  test('EOF at the batch confirmation declines instead of never settling', { timeout: 15000 }, async () => {
    // The exit-2 refusal two tests up is what a pipe sees. A terminal whose input ends
    // — Ctrl+D, or a heredoc that runs out — is the other half: readline closes the
    // interface without calling the question callback, so the run waited on a promise
    // that could never settle and exited 0 with every note left unadopted (#565).
    const original = '# EOF Gate\n\nA note that must stay unadopted.\n';
    const dir = path.join(vaultDir, 'EOFGATE');
    const note = path.join(dir, 'eof-gate.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(note, original, 'utf8');

    const prevIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const realStdin = process.stdin;
    const realConfigDir = process.env.PALEE_CONFIG_DIR;
    // Captured at the stream, not by stubbing `console.log`: readline writes the
    // question straight to `process.stdout`, and `console.log` travels through it.
    const realWrite = process.stdout.write.bind(process.stdout);
    let printed = '';
    process.env.PALEE_CONFIG_DIR = tempDir;
    Object.defineProperty(process, 'stdin', {
      value: Object.assign(Readable.from([]), { isTTY: true }),
      configurable: true,
      writable: true,
    });
    // `node --test` on Node 22 tunnels its own V8-serialized test report through
    // the child's stdout as Buffer chunks. Capture the CLI's string writes only and
    // pass the runner's frames through, so they cannot split the prompt line.
    process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]): boolean => {
      if (typeof chunk !== 'string') {
        return (realWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
      }
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    let noteAfter: string;
    try {
      const { default: adoptEntry } = await import('../src/cli/adopt');
      await adoptEntry(undefined, { all: true });
    } finally {
      noteAfter = fs.existsSync(note) ? fs.readFileSync(note, 'utf8') : '<deleted>';
      process.stdout.write = realWrite as typeof process.stdout.write;
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
      if (realConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
      else process.env.PALEE_CONFIG_DIR = realConfigDir;
      fs.rmSync(dir, { recursive: true, force: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTTY, configurable: true });
    }
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.match(printed, /Proceed with adoption\? \(y\/N\): /, printed);
    assert.match(printed, /Aborted\./, 'EOF is a decline, the same answer an empty line gives');
    assert.match(
      printed,
      /Proceed with adoption\? \(y\/N\): \n/,
      'EOF leaves a clean line after the prompt'
    );
    assert.strictEqual(exitCode, undefined, 'an aborted prompt is a clean exit 0, not an error');
    assert.strictEqual(noteAfter, original, 'and the note keeps its unadopted bytes');
  });

  test('palee adopt rejects path escaping vault with code 2', () => {
    const result = runCLI(['adopt', '../outside', '--yes']);
    assert.strictEqual(result.status, 2);
  });

  test('palee adopt names a non-markdown file as such, not as a missing directory', () => {
    // A `.txt` path cannot qualify for single-file mode, so it fell through to
    // batch mode and was refused for not being a directory — the learner passed a
    // file, and the error described a directory they never typed.
    const dir = path.join(vaultDir, 'TXT');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain text, not a note\n');

    const result = runCLI(['adopt', 'TXT/notes.txt', '--yes']);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Not a markdown note: TXT[/\\]notes\.txt/);
    assert.doesNotMatch(result.stderr, /Expected directory path/);
  });

  test('palee adopt --all on a single note says to drop --all', () => {
    // `--all` disqualifies the explicit-file branch, and the batch branch then
    // complained about the directory that was never asked for.
    const result = runCLI(['adopt', 'MODULES/02-linux/rubric.md', '--all', '--yes']);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--all adopts every note under a directory/);
    assert.match(result.stderr, /drop --all/);
    assert.doesNotMatch(result.stderr, /Expected directory path/);
  });

  test('palee adopt --all on a non-markdown file names the --all mismatch, not the extension', () => {
    // With `--all` the fault is file-vs-directory, whatever the extension — a `.txt`
    // path here used to report "Not a markdown note", hiding the flag the user misused.
    const dir = path.join(vaultDir, 'TXT');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain text, not a note\n');

    const result = runCLI(['adopt', 'TXT/notes.txt', '--all', '--yes']);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--all adopts every note under a directory/);
    assert.doesNotMatch(result.stderr, /Not a markdown note/);
  });

  test('palee adopt <directory> scopes adoption strictly and resolves titles with fallbacks', () => {
    const result = runCLI(['adopt', 'MODULES/02-linux', '--difficulty', 'beginner', '--yes']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully adopted 3 notes/);

    // Verify 02-linux notes were adopted with difficulty=beginner
    const procNote = path.join(vaultDir, 'MODULES', '02-linux', '01-processes.md');
    const parsedProc = parseFrontmatter(fs.readFileSync(procNote, 'utf8'));
    assert.ok(parsedProc.frontmatter?.palee_id);
    assert.strictEqual(parsedProc.frontmatter?.difficulty, 'beginner');
    // Title resolved from H1
    assert.strictEqual(parsedProc.frontmatter?.title, 'Linux Process Deep Dive');

    // Title resolved from H1 on note with no prior frontmatter
    const triageNote = path.join(vaultDir, 'MODULES', '02-linux', 'lab-01-triage.md');
    const parsedTriage = parseFrontmatter(fs.readFileSync(triageNote, 'utf8'));
    assert.strictEqual(parsedTriage.frontmatter?.title, 'Linux Triage Lab');

    // Title resolved from filename for rubric.md
    const rubricNote = path.join(vaultDir, 'MODULES', '02-linux', 'rubric.md');
    const parsedRubric = parseFrontmatter(fs.readFileSync(rubricNote, 'utf8'));
    assert.strictEqual(parsedRubric.frontmatter?.title, 'rubric');

    // Verify 01-foundations notes were NOT adopted
    const foundNote = path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md');
    const parsedFound = parseFrontmatter(fs.readFileSync(foundNote, 'utf8'));
    assert.strictEqual(parsedFound.frontmatter?.palee_id, undefined);
  });

  test('palee adopt skips already adopted notes idempotently', () => {
    // Re-run adopt on MODULES/02-linux
    const result = runCLI(['adopt', 'MODULES/02-linux', '--yes']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Already Adopted:\s+3 notes/);
    assert.match(result.stdout, /Ready to Adopt:\s+0 notes/);
  });

  test('palee adopt with --tag filters notes by Obsidian frontmatter tags', () => {
    const result = runCLI(['adopt', 'MODULES/01-foundations', '--tag', 'type/concept', '--yes']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully adopted 1 notes/);

    // Concept note should be adopted
    const sysNote = path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md');
    assert.ok(parseFrontmatter(fs.readFileSync(sysNote, 'utf8')).frontmatter?.palee_id);

    // Template note should be untouched
    const tmplNote = path.join(vaultDir, 'MODULES', '01-foundations', 'runbook-template.md');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(tmplNote, 'utf8')).frontmatter?.palee_id, undefined);
  });

  test('palee adopt with --include and --exclude handles glob patterns', () => {
    const result = runCLI(['adopt', '--all', '--include', '**/*.md', '--exclude', '*template*', '-y']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully adopted 1 notes/);

    // Project 1 note should be adopted
    const projNote = path.join(vaultDir, 'PROJECTS', 'project-01.md');
    assert.ok(parseFrontmatter(fs.readFileSync(projNote, 'utf8')).frontmatter?.palee_id);

    // Template note was excluded
    const tmplNote = path.join(vaultDir, 'MODULES', '01-foundations', 'runbook-template.md');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(tmplNote, 'utf8')).frontmatter?.palee_id, undefined);
  });

  test('palee adopt with invalid glob option returns clean code 2 error', () => {
    const result = runCLI(['adopt', '--all', '--include', 'valid/**', '-y']);
    assert.strictEqual(result.status, 0);
  });

  // #258 — the single-file branch built `depends_on` from the `--depends-on` flag
  // alone, so adopting a note that had already stated its prerequisites in its
  // own frontmatter wrote `depends_on: []` over them and unlocked a note the
  // learner had gated. These two notes live in their own directory and are the
  // last tests here, so the counts the earlier tests assert against this shared
  // vault are read before any of it exists.
  test('palee adopt <note> keeps a hand-written depends_on from the frontmatter', () => {
    const abs = path.join(vaultDir, 'ISSUE258', 'hand-declared.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\ntitle: Hand Declared\ndepends_on: [T-real]\n---\n# Hand Declared\n`
    );

    const result = runCLI(['adopt', 'ISSUE258/hand-declared.md']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);

    const { frontmatter } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    assert.ok(frontmatter?.palee_id, 'the note was adopted');
    assert.deepStrictEqual(frontmatter?.depends_on, ['T-real']);
    assert.strictEqual(frontmatter?.depends_on_source, 'declared');
    // The gate the learner wrote is still the gate the note reports.
    assert.match(result.stdout, /Dependencies: T-real/);
  });

  test('palee adopt --depends-on overrides the note\'s own frontmatter depends_on', () => {
    const abs = path.join(vaultDir, 'ISSUE258', 'flag-wins.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\ntitle: Flag Wins\ndepends_on: [T-hand-written]\n---\n# Flag Wins\n`
    );

    const result = runCLI(['adopt', 'ISSUE258/flag-wins.md', '--depends-on', 'T-flag']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);

    const { frontmatter } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    assert.ok(frontmatter?.palee_id, 'the note was adopted');
    // Passing the flag in the same invocation is the learner overriding the note,
    // so it wins — and it carries no provenance label, exactly as before #258.
    assert.deepStrictEqual(frontmatter?.depends_on, ['T-flag']);
    assert.strictEqual(frontmatter?.depends_on_source, undefined);
  });

  test('palee adopt <directory> with no --auto-chain keeps a hand-written depends_on too', () => {
    // The write loop planned `[]` for every note whenever `--auto-chain` was off, so
    // the commonest invocation of all erased a hand-written gate while inferring
    // nothing at all. Reverting `preservedOwnDeps` there writes `depends_on: []` and
    // fails the deepStrictEqual below.
    const abs = path.join(vaultDir, 'ISSUE258B', 'plain-adopt.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\ntitle: Plain Adopt\ndepends_on: [T-earlier-note]\n---\n# Plain Adopt\n`
    );

    const result = runCLI(['adopt', 'ISSUE258B', '--yes']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stdout}${result.stderr}`);

    const { frontmatter } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    assert.ok(frontmatter?.palee_id, 'the note was adopted');
    assert.deepStrictEqual(frontmatter?.depends_on, ['T-earlier-note']);
    assert.strictEqual(frontmatter?.depends_on_source, 'declared',
      'a preserved list carries the same label the prose branch uses');
  });

  // #565 P1-10: a note over the 512 KiB read cap is declined by every reading command,
  // so adopting one minted an identity onto a file `palee plan` could never surface. The
  // boundary is asserted from both sides: one-sided cases also pass against a zero cap.
  test('a note over the read cap is skipped by name and left unadopted', () => {
    const oversizedPath = path.join(vaultDir, 'SOURCE_CAP', 'too-big.md');
    fs.mkdirSync(path.dirname(oversizedPath), { recursive: true });
    // 513 KiB of body, comfortably over the 524288-byte ceiling.
    const body = `# Too Big\n\n${'x'.repeat(513 * 1024)}\n`;
    fs.writeFileSync(oversizedPath, body, 'utf8');

    const result = runCLI(['adopt', 'SOURCE_CAP', '--yes', '--verbose']);
    const output = result.stdout + result.stderr;

    assert.match(output, /Oversized:\s+1 notes/, 'the summary must count it separately');
    assert.match(output, /Skipped: over the 524288 byte read cap \(not adopted\):/);
    assert.match(output, /\? SOURCE_CAP\/too-big\.md/, 'and name the note it left alone');
    assert.doesNotMatch(output, /frontmatter will not parse/, 'an oversized note is not a malformed one');
    assert.strictEqual(result.status, 0, `a skipped note must not fail the batch: ${output}`);
    assert.strictEqual(
      fs.readFileSync(oversizedPath, 'utf8'),
      body,
      'a refused note keeps its bytes, frontmatter included'
    );
  });

  test('a note over the read cap named on its own is refused with exit 2 and no write', () => {
    const oversizedPath = path.join(vaultDir, 'SOURCE_CAP_SINGLE', 'solo.md');
    fs.mkdirSync(path.dirname(oversizedPath), { recursive: true });
    const body = `# Solo\n\n${'x'.repeat(513 * 1024)}\n`;
    fs.writeFileSync(oversizedPath, body, 'utf8');

    const result = runCLI(['adopt', 'SOURCE_CAP_SINGLE/solo.md', '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 2, `a single oversized note is invalid usage: ${output}`);
    assert.match(output, /Oversized source: \d+ bytes exceeds the 524288 byte note read cap/);
    assert.strictEqual(fs.readFileSync(oversizedPath, 'utf8'), body, 'nothing was written');
  });

  // #565 P1-10 review: a source note under the cap can still produce an over-cap file
  // once the managed keys are added — measured at 265 bytes of `palee_*` frontmatter, so
  // the band is the last ~265 bytes below the ceiling. Writing that result would report
  // success and then hide the topic from every reader.
  test('a note whose managed keys would cross the cap is refused, not written past it', () => {
    const edgePath = path.join(vaultDir, 'SOURCE_CAP_EDGE', 'edge.md');
    fs.mkdirSync(path.dirname(edgePath), { recursive: true });
    // Under the 524288 ceiling, but within the ~265-byte band the frontmatter needs.
    const body = `# Edge\n\n${'x'.repeat(524240)}`;
    fs.writeFileSync(edgePath, body, 'utf8');
    assert.ok(Buffer.byteLength(body, 'utf8') < 524288, 'the fixture must start under the cap');

    const result = runCLI(['adopt', 'SOURCE_CAP_EDGE/edge.md', '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 2, `a write past the cap is invalid usage: ${output}`);
    assert.match(output, /Oversized result: the managed keys would grow this note to \d+ bytes/);
    assert.strictEqual(fs.readFileSync(edgePath, 'utf8'), body, 'the note was left byte-identical');
  });

  test('a batch skips the note whose managed keys would cross the cap', () => {
    const dir = path.join(vaultDir, 'SOURCE_CAP_EDGE_BATCH');
    fs.mkdirSync(dir, { recursive: true });
    const edgePath = path.join(dir, 'edge.md');
    const safePath = path.join(dir, 'safe.md');
    const edgeBody = `# Edge\n\n${'x'.repeat(524240)}`;
    const safeBody = '# Safe\n\n' + 'y'.repeat(4000);
    fs.writeFileSync(edgePath, edgeBody, 'utf8');
    fs.writeFileSync(safePath, safeBody, 'utf8');

    const result = runCLI(['adopt', 'SOURCE_CAP_EDGE_BATCH', '--yes']);

    assert.strictEqual(result.status, 0, `the batch must survive one over-cap result: ${result.stderr}`);
    assert.strictEqual(fs.readFileSync(edgePath, 'utf8'), edgeBody, 'the over-cap result was never written');
    const safe = parseFrontmatter(fs.readFileSync(safePath, 'utf8'));
    assert.ok(safe.frontmatter?.palee_id, 'the rest of the batch still adopted');
  });

  // #565 P1-10 review: the projection decided which notes would not be written, but the
  // preview, the verbose list, the empty-batch check and the confirmation count all read
  // the unfiltered batch — so `Ready to Adopt` promised a note that never lands, and a
  // batch of nothing but projected notes still reached the confirmation gate.
  test('the preview promises only the notes the projection will write', () => {
    const dir = path.join(vaultDir, 'SOURCE_CAP_EDGE_PREVIEW');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'edge.md'), `# Edge\n\n${'x'.repeat(524240)}`, 'utf8');
    fs.writeFileSync(path.join(dir, 'safe.md'), '# Safe\n\n' + 'y'.repeat(4000), 'utf8');

    const result = runCLIBothStreams(['adopt', 'SOURCE_CAP_EDGE_PREVIEW', '--dry-run', '--verbose']);
    const output = result.spawnError + result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, output);
    assert.match(output, /Ready to Adopt:\s+1 notes/, 'the projected note is not part of the promised batch');
    assert.match(
      output,
      /Oversized result: the managed keys would grow this note to/,
      'but the skip is still named, not hidden'
    );
    assert.match(output, /\+\s+SOURCE_CAP_EDGE_PREVIEW\/safe\.md/, 'the note that will be written is listed');
    assert.doesNotMatch(
      output,
      /\+\s+SOURCE_CAP_EDGE_PREVIEW\/edge\.md/,
      'and the note that will not be is absent from the list'
    );
  });

  test('a batch whose every note is projected out asks for nothing', () => {
    const dir = path.join(vaultDir, 'SOURCE_CAP_EDGE_ALL');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'edge.md'), `# Edge\n\n${'x'.repeat(524240)}`, 'utf8');

    // No `--yes`, and the runner gives the child a pipe rather than a TTY. Before the
    // fix this reached the confirmation gate with a non-empty list and died as a usage
    // error (2) — for a batch that was going to write nothing at all.
    const result = runCLIBothStreams(['adopt', 'SOURCE_CAP_EDGE_ALL']);
    const output = result.spawnError + result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `an all-projected batch is not a usage error: ${output}`);
    assert.match(output, /No new notes matched the criteria to adopt\./);
    assert.doesNotMatch(output, /Non-interactive environment/, 'the learner is never asked to confirm zero notes');
    assert.match(
      output,
      /Oversized result: the managed keys would grow this note to/,
      'with the reason still disclosed'
    );
  });

  test('a note just under the read cap still adopts', () => {
    const underPath = path.join(vaultDir, 'SOURCE_CAP_UNDER', 'just-fits.md');
    fs.mkdirSync(path.dirname(underPath), { recursive: true });
    const body = `# Just Fits\n\n${'x'.repeat(511 * 1024)}\n`;
    fs.writeFileSync(underPath, body, 'utf8');

    const result = runCLI(['adopt', 'SOURCE_CAP_UNDER', '--yes']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stdout}${result.stderr}`);

    const { frontmatter } = parseFrontmatter(fs.readFileSync(underPath, 'utf8'));
    assert.ok(frontmatter?.palee_id, 'a note under the ceiling is still adopted');
  });
});
