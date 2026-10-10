import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PALEE_CMD } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * #303 — `--include`, `--exclude` and `--tag` select notes out of a directory walk.
 * Single-file mode has no walk: the learner already named the note. Their syntax was
 * validated and then dropped, so `palee adopt "a/fresh.md" --exclude 'a/*.md'` exited
 * 0 having adopted exactly the note the flag excluded, and nothing in the output said
 * so. The ruling is an honest refusal at exit 2, naming the flag and the mode.
 */
describe('CLI adopt refuses batch filters in single-file mode (#303)', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-single-filter-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'a'), { recursive: true });
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

  /** A fresh, untracked note under `a/`, so each test runs against the same starting state. */
  function freshNote(name: string): { rel: string; abs: string } {
    const rel = `a/${name}`;
    const abs = path.join(vaultDir, 'a', name);
    fs.writeFileSync(abs, `---\ntitle: ${name}\n---\n# ${name}\n`);
    return { rel, abs };
  }

  /** The `grep -c "^palee_id:"` of the issue's repro: how many identities the note carries. */
  function adoptedIdCount(abs: string): number {
    return (fs.readFileSync(abs, 'utf8').match(/^palee_id:/gm) ?? []).length;
  }

  for (const flag of ['--exclude', '--include', '--tag'] as const) {
    test(`palee adopt <note> ${flag} refuses with exit 2 and leaves the note unwritten`, () => {
      const { rel, abs } = freshNote(`fresh-${flag.slice(2)}.md`);
      assert.strictEqual(adoptedIdCount(abs), 0, 'the note starts unadopted');

      const pattern = flag === '--tag' ? 'type/concept' : 'a/*.md';
      const result = runCLI(['adopt', rel, flag, pattern]);

      assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
      assert.match(
        result.stderr,
        new RegExp(`--${flag.slice(2)} does not apply when a single path is given`),
        `the refusal must name ${flag}: ${result.stderr}`
      );
      assert.strictEqual(
        adoptedIdCount(abs),
        0,
        `${flag} was ignored and the excluded note was adopted:\n${fs.readFileSync(abs, 'utf8')}`
      );
      assert.strictEqual(parseFrontmatter(fs.readFileSync(abs, 'utf8')).frontmatter?.palee_id, undefined);
    });
  }

  test('palee adopt <note> --dry-run --exclude refuses too, before previewing anything', () => {
    // A dry run is the cautious user's first call; exiting 0 there would advertise the
    // same flag as honoured and then refuse the commit run.
    const { rel, abs } = freshNote('fresh-dry.md');
    const result = runCLI(['adopt', rel, '--dry-run', '--exclude', 'a/*.md']);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Dry run: would adopt/, `${result.stdout}`);
    assert.strictEqual(adoptedIdCount(abs), 0);
  });

  test('palee adopt <note> still adopts when no batch filter is passed', () => {
    // The control: the exit 2 above is the flag's doing, not single-file mode breaking.
    const { rel, abs } = freshNote('fresh-control.md');
    const result = runCLI(['adopt', rel]);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /✓ Adopted as topic/);
    assert.ok(parseFrontmatter(fs.readFileSync(abs, 'utf8')).frontmatter?.palee_id, 'the note was adopted');
  });
});
