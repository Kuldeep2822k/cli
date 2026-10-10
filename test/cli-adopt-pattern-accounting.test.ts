import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PALEE_CMD } from './palee-cli';

/**
 * #312 — a batch run reported only `Excluded (Pattern): N`, and `matchesPattern`
 * OR-folded the patterns, so a filter that worked and found nothing to exclude read
 * exactly like a pattern that names no file in this scope. Three parts are covered
 * here: per-pattern accounting that names a dead pattern (and stays silent about a
 * live one), repeatable `--include`/`--exclude` flags, and the comma list still
 * working the same way.
 */
describe('CLI adopt pattern accounting and repeatable filters (#312)', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-patterns-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'MODULES'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'drafts'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '01-lesson.md'),
      '---\ntitle: Lesson One\n---\n# Lesson One\n'
    );
    fs.writeFileSync(
      path.join(vaultDir, 'drafts', '01-draft.md'),
      '---\ntitle: Draft\n---\n# Draft\n'
    );
    fs.writeFileSync(
      path.join(vaultDir, 'templates', 'runbook-template.md'),
      '---\ntitle: Runbook Template\n---\n# Runbook Template\n'
    );
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

  /** Every run below is `--dry-run`, so nothing is written and the counts stay comparable. */
  function dryRun(...filterArgs: string[]): { status: number; stdout: string } {
    const result = runCLI(['adopt', '--all', '--dry-run', ...filterArgs]);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    return result;
  }

  test('a pattern that matched no file is named, not hidden in an aggregate zero', () => {
    // The issue's repro: `a/*.md` contains `/`, so it is anchored at the vault root and
    // addresses a directory this scope does not hold — while the notes the learner meant
    // to drop stay in scope.
    const { stdout } = dryRun('--exclude', 'a/*.md');
    assert.match(stdout, /Excluded \(Pattern\):\s+0 notes/, 'the aggregate line stays: ' + stdout);
    assert.match(
      stdout,
      /⚠ Warning: --exclude 'a\/\*\.md' matched no file in this scope/,
      `a dead pattern must be named by text: ${stdout}`
    );
    assert.match(stdout, /vault-relative path from the root/, `the warning must teach the anchoring rule: ${stdout}`);
  });

  test('a pattern that matched a file produces no dead-pattern warning', () => {
    // The negative case: without it the warning would fire on every filtered run and the
    // learner would learn to ignore it.
    const { stdout } = dryRun('--exclude', '*lesson*');
    assert.match(stdout, /Excluded \(Pattern\):\s+1 notes/, stdout);
    assert.doesNotMatch(stdout, /matched no file in this scope/, stdout);
  });

  test('a repeated --exclude applies every value, not just the last', () => {
    // As plain `<patterns>` strings the second occurrence overwrote the first, so only
    // the template was dropped and the draft was adopted.
    const { stdout } = dryRun('--exclude', '*draft*', '--exclude', '*template*');
    assert.match(stdout, /Excluded \(Pattern\):\s+2 notes/, stdout);
    assert.match(stdout, /Ready to Adopt:\s+1 notes/, `both patterns must apply: ${stdout}`);
    assert.doesNotMatch(stdout, /matched no file in this scope/, `both patterns are live: ${stdout}`);
  });

  test('a repeated --include unions every value', () => {
    const { stdout } = dryRun('--include', 'MODULES/*', '--include', 'drafts/*');
    assert.match(stdout, /Ready to Adopt:\s+2 notes/, `both patterns must apply: ${stdout}`);
    assert.doesNotMatch(stdout, /matched no file in this scope/, stdout);
  });

  test('a repeated flag with one dead value names only the dead pattern', () => {
    const { stdout } = dryRun('--exclude', '*template*', '--exclude', 'zzz/*.md');
    assert.match(stdout, /Excluded \(Pattern\):\s+1 notes/, stdout);
    assert.match(stdout, /--exclude 'zzz\/\*\.md' matched no file in this scope/, stdout);
    assert.doesNotMatch(stdout, /--exclude '\*template\*' matched no file/, stdout);
  });

  test('one comma-separated --exclude still behaves exactly as before', () => {
    // The accumulator joins repeated values on commas, so the list the filters read is
    // the same shape either way.
    const { stdout } = dryRun('--exclude', '*draft*,*template*');
    assert.match(stdout, /Ready to Adopt:\s+1 notes/, stdout);
    assert.match(stdout, /Excluded \(Pattern\):\s+2 notes/, stdout);
    assert.doesNotMatch(stdout, /matched no file in this scope/, stdout);
  });

  test('a dead --include is named too, and --verbose lists each pattern\'s own count', () => {
    const result = runCLI(['adopt', '--all', '--dry-run', '--verbose', '--exclude', '*draft*', '--exclude', 'a/*.md']);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Pattern filter accounting:/, result.stdout);
    assert.match(result.stdout, /--exclude '\*draft\*': 1 of 3 files/, result.stdout);
    assert.match(result.stdout, /--exclude 'a\/\*\.md': 0 of 3 files/, result.stdout);
  });
});
