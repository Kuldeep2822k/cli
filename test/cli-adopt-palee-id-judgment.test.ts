import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PALEE_CMD } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { FileCache, loadTopics, type LoadedTopic } from '../src/storage';

describe('CLI adopt: one judgment for a present-but-unusable palee_id (P3-13, B7)', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-id-judgment-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Runs the real CLI through the shared launch command (`PALEE_CMD`: the
   * prebuilt dist entry normally, the TypeScript sources behind tsx under
   * coverage) with `PALEE_CONFIG_DIR` pointed at {@link configDir}; captures
   * exit status, stdout and stderr instead of throwing on a non-zero exit.
   * Args containing glob/space characters are shell-quoted.
   */
  function runCLI(args: string[], configDir: string): { status: number; stdout: string; stderr: string } {
    try {
      const escapedArgs = args.map((arg) => (/[*?[\]\s,]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
      const stdout = execSync(`${PALEE_CMD} ${escapedArgs.join(' ')}`, {
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

  /** Creates a fresh vault with the given relPath -> content files and points config at it. */
  function freshVault(files: Record<string, string>): { vaultDir: string; configDir: string } {
    const vaultDir = fs.mkdtempSync(path.join(tempDir, 'vault-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(vaultDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const configDir = fs.mkdtempSync(path.join(tempDir, 'cfg-'));
    const setResult = runCLI(['config', 'set-vault', vaultDir], configDir);
    assert.strictEqual(setResult.status, 0, `set-vault failed: ${setResult.stderr}`);
    return { vaultDir, configDir };
  }

  /** A note carrying the truthy non-string id the whole issue is about. */
  const NUMERIC_NOTE = ['---', 'palee_id: 12345', 'palee_schema: 1', 'title: Numeric', '---', '', '# Numeric', ''].join('\n');

  /**
   * The repair path every reporter of this condition must print (P3-13): the
   * same sentence, so no surface can send the learner to a different fix.
   */
  const REPAIR = /Repair: make `palee_id` a non-empty string or delete the key, then re-run `palee adopt`\./;

  test('single-file adoption refuses a numeric palee_id with the shared repair path, never "already adopted"', () => {
    const { vaultDir, configDir } = freshVault({ 'numeric.md': NUMERIC_NOTE });
    const before = fs.readFileSync(path.join(vaultDir, 'numeric.md'), 'utf8');

    const result = runCLI(['adopt', 'numeric.md'], configDir);
    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /has a palee_id that is not a usable string \(12345\)/);
    assert.match(result.stderr, REPAIR, 'the one repair path is named');
    assert.doesNotMatch(
      result.stderr,
      /already adopted/,
      'a numeric id is not an adopted topic — the old verdict contradicted the loader'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(vaultDir, 'numeric.md'), 'utf8'),
      before,
      'a present-but-unusable id is never rewritten'
    );
  });

  test('single-file adoption still refuses a genuinely adopted note as already adopted', () => {
    const { configDir } = freshVault({
      'real.md': ['---', 'palee_id: T-real-id', 'palee_schema: 1', 'title: Real', '---', '', '# Real', ''].join('\n'),
    });

    const result = runCLI(['adopt', 'real.md'], configDir);
    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /already adopted as topic T-real-id/);
    assert.doesNotMatch(result.stderr, /not a usable string/);
  });

  test('a plain batch skips a numeric palee_id with the counted B7 reason, not under "Already Adopted"', () => {
    const { vaultDir, configDir } = freshVault({
      'MOD/01-numeric.md': NUMERIC_NOTE,
      'MOD/02-fresh.md': '# Fresh\n',
    });
    const before = fs.readFileSync(path.join(vaultDir, 'MOD/01-numeric.md'), 'utf8');

    const result = runCLI(['adopt', 'MOD', '--verbose', '-y'], configDir);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    // The counted skip with its repair path — previously `--auto-chain`-only,
    // so a plain batch filed the note under "Already Adopted" instead.
    assert.match(result.stdout, /Invalid palee_id: 1 notes \(not adopted, not chained\)/);
    assert.match(result.stdout, REPAIR, 'the one repair path is named');
    assert.match(result.stdout, /palee_id is not a usable string \(B7\):[\s\S]*MOD\/01-numeric\.md/);
    assert.match(result.stdout, /Already Adopted:\s+0 notes/, 'an unusable id is not an adopted topic');
    assert.match(result.stdout, /Ready to Adopt:\s+1 notes/, 'the rest of the batch is untouched by the skip');
    // The skipped note keeps its frontmatter exactly as found.
    assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'MOD/01-numeric.md'), 'utf8'), before);
    // ...and the fresh sibling still adopts.
    const fresh = parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MOD/02-fresh.md'), 'utf8'));
    assert.ok(typeof fresh.frontmatter?.palee_id === 'string' && fresh.frontmatter.palee_id.startsWith('T-'));
  });

  test('under --auto-chain the same judgment holds and the dependent is never chained to the unusable id', () => {
    const { vaultDir, configDir } = freshVault({
      'MOD/01-numeric.md': NUMERIC_NOTE,
      'MOD/02-fresh.md': '# Fresh\n',
    });

    const result = runCLI(['adopt', 'MOD', '--auto-chain', '--verbose', '-y'], configDir);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Invalid palee_id: 1 notes \(not adopted, not chained\)/);
    assert.match(result.stdout, REPAIR);
    const fresh = parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MOD/02-fresh.md'), 'utf8'));
    assert.deepStrictEqual(fresh.frontmatter?.depends_on, [], 'nothing may gate on an id the loader cannot resolve');
    assert.strictEqual(
      parseFrontmatter(fs.readFileSync(path.join(vaultDir, 'MOD/01-numeric.md'), 'utf8')).frontmatter?.palee_id,
      12345,
      'the numeric id survives untouched'
    );
  });

  test('batch --undo reports the same repair path for an unusable id and leaves the note alone', () => {
    const { vaultDir, configDir } = freshVault({ 'numeric.md': NUMERIC_NOTE });
    const before = fs.readFileSync(path.join(vaultDir, 'numeric.md'), 'utf8');

    const result = runCLI(['adopt', '--all', '--undo', '--verbose', '--yes'], configDir);
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Unusable palee_id:\s+1 notes/);
    assert.match(result.stdout, REPAIR, 'reversal names the one repair path the adopt scans print');
    assert.strictEqual(fs.readFileSync(path.join(vaultDir, 'numeric.md'), 'utf8'), before);
  });

  test('loadTopics judges by the same predicate: a numeric id is not a topic, a usable id is', () => {
    const { vaultDir } = freshVault({
      'numeric.md': NUMERIC_NOTE,
      'real.md': ['---', 'palee_id: T-real-id', 'palee_schema: 1', 'title: Real', '---', '', '# Real', ''].join('\n'),
    });

    // Isolated cache so the suite never writes the shared loader state.
    const topics = loadTopics(vaultDir, { cache: new FileCache<LoadedTopic>() });
    const ids = topics.map((t) => t.palee_id).sort();
    assert.deepStrictEqual(ids, ['T-real-id'], 'only ids the shared predicate accepts load');
  });
});
