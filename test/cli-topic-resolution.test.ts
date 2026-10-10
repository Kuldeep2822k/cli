import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewCommand } from '../src/cli/review';
import { progressCommand } from '../src/cli/progress';
import { parseFrontmatter } from '../src/storage';

/**
 * Isolated temp vault + PALEE config, mirroring `cli-assess.test.ts`:
 * `loadConfig()` honors `PALEE_CONFIG_DIR`, so the handlers under test resolve
 * the vault without touching the developer's real configuration.
 */
async function runInTempVault(
  files: Record<string, string>,
  fn: (vaultPath: string) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-topic-resolution-'));
  const vaultPath = path.join(tempDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(vaultPath, name), body);
  }
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ vaultPath }, null, 2));

  const origConfigDir = process.env.PALEE_CONFIG_DIR;
  const origExitCode = process.exitCode;
  process.env.PALEE_CONFIG_DIR = tempDir;
  try {
    await fn(vaultPath);
  } finally {
    if (origConfigDir !== undefined) process.env.PALEE_CONFIG_DIR = origConfigDir;
    else delete process.env.PALEE_CONFIG_DIR;
    process.exitCode = origExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** A note with valid SM-2 state, so a review never trips the corrupt-state guard. */
function note(title: string, id: string): string {
  return [
    '---',
    'palee_schema: 1',
    `palee_id: ${id}`,
    `title: ${title}`,
    'depends_on: []',
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

/** Captures stdout and stderr while `fn` runs. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return chunks.join('\n');
}

describe('topic query resolution (#347, #348)', () => {
  test('review records the topic it was given, not the neighbour that contains it', async () => {
    // `T-math` is a substring of `T-math-2`, so review's flat OR matched both and
    // refused to record either — the learner named the topic precisely and got an
    // ambiguity error that wrote nothing.
    const files = { 'math2.md': note('Math Two', 'T-math-2'), 'math.md': note('Math Basics', 'T-math') };
    await runInTempVault(files, async (vaultPath) => {
      const neighbourBefore = fs.readFileSync(path.join(vaultPath, 'math2.md'), 'utf8');
      const output = await captureOutput(() => reviewCommand('T-math', '5'));

      assert.match(output, /Review recorded for Math Basics/, output);
      assert.strictEqual(process.exitCode ?? 0, 0, output);
      assert.strictEqual(
        fs.readFileSync(path.join(vaultPath, 'math2.md'), 'utf8'),
        neighbourBefore,
        'the neighbour was not touched'
      );
      assert.notStrictEqual(
        fs.readFileSync(path.join(vaultPath, 'math.md'), 'utf8'),
        files['math.md'],
        'the named topic was written'
      );
    });
  });

  test('review still refuses a genuinely ambiguous query', async () => {
    await runInTempVault(
      { 'a.md': note('Linear Algebra', 'T-la'), 'b.md': note('Logic And Sets', 'T-las') },
      async (vaultPath) => {
        const output = await captureOutput(() => reviewCommand('T-l', '5'));
        assert.match(output, /Multiple topics match "T-l"/, output);
        assert.strictEqual(process.exitCode ?? 0, 2, output);
        assert.strictEqual(fs.readFileSync(path.join(vaultPath, 'a.md'), 'utf8'), note('Linear Algebra', 'T-la'));
      }
    );
  });

  test('progress reports the exactly-named topic even when a neighbour loads first', async () => {
    // The neighbour is created first on purpose: `.find()` returned the first
    // substring hit, so load order decided which topic `--topic T-math` described.
    await runInTempVault(
      { 'math2.md': note('Math Two', 'T-math-2'), 'math.md': note('Math Basics', 'T-math') },
      async () => {
        const output = await captureOutput(() => progressCommand({ topic: 'T-math' }));
        assert.match(output, /Progress for: Math Basics/, output);
        assert.match(output, /ID: T-math\r?\n/, 'must not report the T-math-2 neighbour');
        assert.strictEqual(process.exitCode ?? 0, 0, output);
      }
    );
  });

  test('progress refuses an ambiguous --topic instead of guessing', async () => {
    await runInTempVault(
      { 'alpha.md': note('Alpha Basics', 'T-alpha'), 'beta.md': note('Alphabet', 'T-beta') },
      async () => {
        const output = await captureOutput(() => progressCommand({ topic: 'alph' }));
        assert.match(output, /Multiple topics match "alph"/, output);
        assert.strictEqual(process.exitCode ?? 0, 2, output);
      }
    );
  });

  test('progress --json refuses an ambiguous --topic with the candidate ids', async () => {
    await runInTempVault(
      { 'alpha.md': note('Alpha Basics', 'T-alpha'), 'beta.md': note('Alphabet', 'T-beta') },
      async () => {
        const output = await captureOutput(() => progressCommand({ topic: 'alph', json: true }));
        const payload = JSON.parse(output);
        assert.match(payload.error, /Multiple topics match: alph/);
        assert.deepStrictEqual([...payload.matches].sort(), ['T-alpha', 'T-beta']);
        assert.strictEqual(process.exitCode ?? 0, 2, output);
      }
    );
  });

  test('progress --json still resolves a single exact match', async () => {
    await runInTempVault(
      { 'math2.md': note('Math Two', 'T-math-2'), 'math.md': note('Math Basics', 'T-math') },
      async () => {
        const output = await captureOutput(() => progressCommand({ topic: 'T-math', json: true }));
        const payload = JSON.parse(output);
        assert.strictEqual(payload.id, 'T-math');
        assert.strictEqual(payload.title, 'Math Basics');
        assert.strictEqual(process.exitCode ?? 0, 0, output);
      }
    );
  });

  test('the resolver treats palee_id and the loaded id as the same key', async () => {
    // `progress` matched on `t.id`, `review` on `t.palee_id`; the loader sets both
    // from one value, and the shared helper must keep matching either spelling.
    const { frontmatter } = parseFrontmatter(note('Spelling Check', 'T-spell'));
    assert.strictEqual(frontmatter!.palee_id, 'T-spell');
    await runInTempVault({ 'spell.md': note('Spelling Check', 'T-spell') }, async () => {
      const output = await captureOutput(() => progressCommand({ topic: 'T-spell' }));
      assert.match(output, /Progress for: Spelling Check/, output);
    });
  });
});
