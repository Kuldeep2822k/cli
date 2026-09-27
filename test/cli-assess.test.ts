import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assessCommand } from '../src/cli/assess';
import { planCommand } from '../src/cli/plan';
import { parseFrontmatter } from '../src/storage';

/**
 * Isolated temp vault + PALEE config, mirroring `cli-mastery-fallback.test.ts`:
 * `loadConfig()` honors `PALEE_CONFIG_DIR`, so the handlers under test resolve
 * the vault without touching the developer's real configuration.
 */
async function runInTempVault(
  files: Record<string, string>,
  fn: (vaultPath: string) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-assess-'));
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

/** A note with the four pillars and an optional prerequisite list. */
function note(title: string, deps: string[] = [], mastery = 0, pillars = '0'): string {
  return [
    '---',
    'palee_schema: 1',
    `palee_id: T-${title.toLowerCase().replace(/\s+/g, '-')}`,
    `title: ${title}`,
    `depends_on: [${deps.join(', ')}]`,
    `topic_mastery: ${mastery}`,
    `conceptual: ${pillars}`,
    `practical: ${pillars}`,
    `debug: ${pillars}`,
    `feynman: ${pillars}`,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

function readFrontmatter(vaultPath: string, filename: string): Record<string, unknown> {
  const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultPath, filename), 'utf8'));
  return frontmatter || {};
}

/**
 * Runs `palee plan --json` in-process and returns the ids it reports as ready.
 * The ready list is the whole point of the command under test — a mastery score
 * that never moved the list would not have made anything reachable.
 */
async function readyIds(): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await planCommand({ json: true });
  } finally {
    console.log = original;
  }
  const payload = JSON.parse(lines.join('\n'));
  return (payload.ready_to_learn as { id: string }[]).map((t) => t.id);
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

describe('CLI assess — making topic_mastery reachable', () => {
  test('assessing a prerequisite moves its dependent from hidden to ready', async () => {
    // The defect: nothing in v0.5.x ever raises `topic_mastery`, so a single
    // prerequisite below 0.70 hides its dependents permanently — `palee plan`
    // shows one topic and stays there forever.
    await runInTempVault(
      {
        'prereq.md': note('Prerequisites'),
        'gated.md': note('Gated Lesson', ['T-prerequisites']),
      },
      async (vaultPath) => {
        assert.deepStrictEqual(await readyIds(), ['T-prerequisites']);

        const output = await captureOutput(() =>
          assessCommand('Prerequisites', {
            conceptual: '0.8',
            practical: '0.7',
            debug: '0.9',
            feynman: '0.85',
          })
        );
        assert.strictEqual(process.exitCode ?? 0, 0, output);
        assert.match(output, /mastery\s+0 → 0\.82/);
        assert.match(output, /Mastered \(≥ 0\.70\)/);
        assert.match(output, /1 topic\(s\) gated behind it are now reachable/);

        assert.deepStrictEqual(
          await readyIds(),
          ['T-gated-lesson'],
          'the unlock must change which note is offered, not merely the counts'
        );
        assert.strictEqual(readFrontmatter(vaultPath, 'prereq.md').topic_mastery, 0.82);
      }
    );
  });

  test('exactly 0.70 satisfies the gate, which is a >= comparison', async () => {
    // (0.5 + 0.5 + 0.5 + 2*1) / 5 = 0.70 — the boundary the prerequisite rule
    // uses. An off-by-one to `>` would keep this note's dependent locked.
    await runInTempVault(
      {
        'prereq.md': note('Prerequisites'),
        'gated.md': note('Gated Lesson', ['T-prerequisites']),
      },
      async (vaultPath) => {
        const output = await captureOutput(() =>
          assessCommand('Prerequisites', {
            conceptual: '0.5',
            practical: '0.5',
            debug: '0.5',
            feynman: '1',
          })
        );
        assert.match(output, /Mastered \(≥ 0\.70\)/);
        assert.strictEqual(readFrontmatter(vaultPath, 'prereq.md').topic_mastery, 0.7);
        assert.deepStrictEqual(
          await readyIds(),
          ['T-gated-lesson'],
          'a prerequisite at exactly the threshold must unlock its dependent'
        );
      }
    );
  });

  test('an all-zero assessment takes a mastered note back below the gate', async () => {
    // `resolveTopicMastery({ precedence: 'pillars-first' })` treats "every
    // pillar is 0" as "no assessment data" and keeps the existing value. That is
    // right for `review`, which is not trying to record a score, and wrong here:
    // an assessment is exactly the act of stating the pillars.
    await runInTempVault(
      {
        'strong.md': note('Strong Topic', [], 0.9, '0.9'),
        'gated.md': note('Gated Lesson', ['T-strong-topic']),
      },
      async (vaultPath) => {
        const output = await captureOutput(() =>
          assessCommand('Strong Topic', {
            conceptual: '0',
            practical: '0',
            debug: '0',
            feynman: '0',
          })
        );
        assert.match(output, /mastery\s+0\.9 → 0/);
        assert.strictEqual(readFrontmatter(vaultPath, 'strong.md').topic_mastery, 0);
        assert.deepStrictEqual(
          await readyIds(),
          ['T-strong-topic'],
          'a demoted prerequisite must re-lock what depended on it'
        );
      }
    );
  });

  test('unmentioned pillars keep their stored values and say so', async () => {
    await runInTempVault(
      { 'mixed.md': note('Mixed Topic', [], 0, '0.4') },
      async (vaultPath) => {
        const output = await captureOutput(() =>
          assessCommand('Mixed Topic', { feynman: '1' })
        );
        assert.match(output, /conceptual\s+0\.4 \(unchanged\)/);
        assert.match(output, /feynman\s+1\s*$/m);

        const fm = readFrontmatter(vaultPath, 'mixed.md');
        assert.strictEqual(fm.conceptual, 0.4);
        assert.strictEqual(fm.practical, 0.4);
        assert.strictEqual(fm.debug, 0.4);
        assert.strictEqual(fm.feynman, 1);
        // (0.4 + 0.4 + 0.4 + 2*1) / 5 = 0.64
        assert.strictEqual(fm.topic_mastery, 0.64);
        assert.strictEqual(typeof fm.assessed_at, 'string');
        assert.match(String(fm.assessed_at), /^\d{4}-\d{2}-\d{2}T.*Z$/);
        assert.deepStrictEqual(fm.depends_on, [], 'the write must not disturb other keys');
      }
    );
  });

  test('a score outside 0-1 is rejected rather than clamped', async () => {
    // `normalizeScore` clamps, which is correct for reading disk and wrong for a
    // number the learner typed: `--conceptual 85` meaning 85% would silently
    // become a contribution of 1.0 and the mastery score would stop being
    // traceable to its inputs.
    await runInTempVault({ 'one.md': note('One Topic') }, async (vaultPath) => {
      const before = fs.readFileSync(path.join(vaultPath, 'one.md'), 'utf8');

      const outOfRange = await captureOutput(() => assessCommand('One Topic', { conceptual: '85' }));
      assert.match(outOfRange, /expects a number between 0 and 1 \(received 85\)/);
      assert.strictEqual(process.exitCode, 2);

      const negative = await captureOutput(() => assessCommand('One Topic', { debug: '-0.2' }));
      assert.match(negative, /expects a number between 0 and 1/);
      assert.strictEqual(process.exitCode, 2);

      const notANumber = await captureOutput(() => assessCommand('One Topic', { practical: 'high' }));
      assert.match(notANumber, /expects a number between 0 and 1 \(received "high"\)/);
      assert.strictEqual(process.exitCode, 2);

      assert.strictEqual(fs.readFileSync(path.join(vaultPath, 'one.md'), 'utf8'), before);
    });
  });

  test('naming no pillar is a usage error, not a timestamp-only write', async () => {
    await runInTempVault({ 'one.md': note('One Topic') }, async (vaultPath) => {
      const before = fs.readFileSync(path.join(vaultPath, 'one.md'), 'utf8');
      const output = await captureOutput(() => assessCommand('One Topic', {}));
      assert.match(output, /at least one pillar score/);
      assert.strictEqual(process.exitCode, 2);
      assert.strictEqual(fs.readFileSync(path.join(vaultPath, 'one.md'), 'utf8'), before);
    });
  });

  test('an unknown or ambiguous topic exits 2 and writes nothing', async () => {
    await runInTempVault(
      {
        'alpha.md': note('Alpha Topic'),
        'alphabeta.md': note('Alphabeta Topic'),
      },
      async (vaultPath) => {
        const missing = await captureOutput(() => assessCommand('No Such Topic', { debug: '0.5' }));
        assert.match(missing, /No topic found matching "No Such Topic"/);
        assert.strictEqual(process.exitCode, 2);

        const ambiguous = await captureOutput(() => assessCommand('Alpha', { debug: '0.5' }));
        assert.match(ambiguous, /Multiple topics match "Alpha"/);
        assert.strictEqual(process.exitCode, 2);

        for (const file of ['alpha.md', 'alphabeta.md']) {
          assert.strictEqual(readFrontmatter(vaultPath, file).topic_mastery, 0, `${file} untouched`);
        }
      }
    );
  });
});
