import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateCommand } from '../src/cli/validate';
import { reviewCommand } from '../src/cli/review';
import { parseFrontmatter } from '../src/storage';

/**
 * Isolated temp vault + PALEE config (mirrors the pattern in
 * cli-mastery-fallback.test.ts). Human-readable output is the default
 * regardless of TTY state: isJsonOutput() only switches to JSON on the
 * explicit --json flag or PALEE_JSON (#357).
 */
async function runInTempVault(
  fn: (vaultPath: string) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-bug003-'));
  const vaultPath = path.join(tempDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ vaultPath }, null, 2));

  const origConfigDir = process.env.PALEE_CONFIG_DIR;
  const origPaleeJson = process.env.PALEE_JSON;
  const origExitCode = process.exitCode;
  process.env.PALEE_CONFIG_DIR = tempDir;
  // Human-output assertions must not depend on the ambient environment:
  // clear PALEE_JSON for the test body, then restore it.
  delete process.env.PALEE_JSON;
  process.exitCode = 0;
  try {
    await fn(vaultPath);
  } finally {
    process.exitCode = origExitCode;
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    if (origPaleeJson !== undefined) {
      process.env.PALEE_JSON = origPaleeJson;
    } else {
      delete process.env.PALEE_JSON;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Writes a fully-formed schema-v1 topic note with the given review state. */
function createTopicNote(
  vaultPath: string,
  filename: string,
  review: Record<string, unknown>
): string {
  const frontmatter = {
    palee_schema: 1,
    title: `Topic ${filename}`,
    difficulty: 'beginner',
    depends_on: [],
    topic_mastery: 0,
    assessed_at: null,
    conceptual: 0,
    practical: 0,
    debug: 0,
    feynman: 0,
    last_quality: null,
    last_reviewed_at: null,
    ...review,
  };
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : JSON.stringify(v)}`)
    .join('\n');
  const filePath = path.join(vaultPath, filename);
  fs.writeFileSync(filePath, `---\n${yaml}\n---\nBody text\n`);
  return filePath;
}

function readFrontmatter(vaultPath: string, filename: string): Record<string, unknown> {
  const content = fs.readFileSync(path.join(vaultPath, filename), 'utf8');
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter || {};
}

/** Runs an action capturing console.log/console.error into strings. */
async function captureOutput(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const origLog = console.log;
  const origError = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => { out += `${args.join(' ')}\n`; };
  console.error = (...args: unknown[]) => { err += `${args.join(' ')}\n`; };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out, err };
}

describe('BUG-003: validate --fix repairs corrupted SM-2 review fields', () => {
  test('happy path: corrupted fields reset to adopt defaults, validate clean, review then succeeds', async () => {
    await runInTempVault(async (vaultPath) => {
      createTopicNote(vaultPath, 'zero.md', {
        palee_id: 'T-zero',
        ease_factor: 1.0,
        interval_days: 0,
        repetition: 0,
        lapses: 0,
        due_at: '2026-09-25',
      });

      const { out } = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(out, /Repaired T-zero: ease_factor 1 -> 2\.5/);
      assert.match(out, /Repaired T-zero: interval_days 0 -> 1/);
      assert.strictEqual(process.exitCode, 0, `expected exit 0, got ${process.exitCode}: ${out}`);

      const fm = readFrontmatter(vaultPath, 'zero.md');
      assert.strictEqual(fm.ease_factor, 2.5);
      assert.strictEqual(fm.interval_days, 1);

      // The repaired topic is now reviewable — the BUG-003 dead end is gone.
      await captureOutput(() => reviewCommand('T-zero', '4'));
      const after = readFrontmatter(vaultPath, 'zero.md');
      assert.strictEqual(after.repetition, 1);
      assert.strictEqual(after.ease_factor, 2.5);
    });
  });

  test('error path: unrepairable findings still reported and gate exit 3; SM-2 corruption is repaired', async () => {
    await runInTempVault(async (vaultPath) => {
      createTopicNote(vaultPath, 'dup-a.md', {
        palee_id: 'T-dup',
        ease_factor: 1.0,
        interval_days: 0,
      });
      createTopicNote(vaultPath, 'dup-b.md', {
        palee_id: 'T-dup',
        ease_factor: 1.2,
        interval_days: 2,
      });

      const { out } = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(out, /duplicate/i);
      assert.match(out, /Repaired T-dup: ease_factor/);
      assert.strictEqual(process.exitCode, 3);

      // Both notes had their SM-2 state repaired despite the remaining error.
      assert.strictEqual(readFrontmatter(vaultPath, 'dup-a.md').ease_factor, 2.5);
      assert.strictEqual(readFrontmatter(vaultPath, 'dup-b.md').ease_factor, 2.5);
      assert.strictEqual(readFrontmatter(vaultPath, 'dup-b.md').interval_days, 2);
    });
  });

  test('edge: clean vault with --fix rewrites nothing and says so', async () => {
    await runInTempVault(async (vaultPath) => {
      const filePath = createTopicNote(vaultPath, 'clean.md', {
        palee_id: 'T-clean',
        ease_factor: 2.5,
        interval_days: 3,
        repetition: 2,
        lapses: 1,
        last_quality: 4,
      });
      const before = fs.readFileSync(filePath);

      const { out } = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(out, /Nothing to repair/);
      assert.strictEqual(process.exitCode, 0);
      assert.deepStrictEqual(fs.readFileSync(filePath), before, 'clean note must stay byte-identical');
    });
  });

  test('edge: only invalid fields are reset; valid siblings are preserved', async () => {
    await runInTempVault(async (vaultPath) => {
      createTopicNote(vaultPath, 'mixed.md', {
        palee_id: 'T-mixed',
        ease_factor: 'high', // wrong type -> reset
        interval_days: 3, // valid -> kept
        repetition: 2.5, // non-integer -> reset
        lapses: 0, // valid -> kept
        last_quality: 9, // out of range -> reset to null
      });

      await captureOutput(() => validateCommand({ fix: true }));
      const fm = readFrontmatter(vaultPath, 'mixed.md');
      assert.strictEqual(fm.ease_factor, 2.5);
      assert.strictEqual(fm.interval_days, 3);
      assert.strictEqual(fm.repetition, 0);
      assert.strictEqual(fm.lapses, 0);
      assert.strictEqual(fm.last_quality, null);
    });
  });

  test('json mode: --fix report carries additive repairs entries', async () => {
    await runInTempVault(async (vaultPath) => {
      createTopicNote(vaultPath, 'zero.md', {
        palee_id: 'T-zero',
        ease_factor: 1.0,
        interval_days: 0,
      });

      const { out } = await captureOutput(() => validateCommand({ json: true, fix: true }));
      const report = JSON.parse(out.trim().split('\n').pop() as string);
      assert.strictEqual(report.valid, true);
      assert.strictEqual(report.error_count, 0);
      assert.deepStrictEqual(report.repairs, [
        { topic_id: 'T-zero', file: 'zero.md', field: 'ease_factor', from: 1, to: 2.5 },
        { topic_id: 'T-zero', file: 'zero.md', field: 'interval_days', from: 0, to: 1 },
      ]);
      assert.deepStrictEqual(report.repair_conflicts, []);
    });
  });

  test('regression pin: review on corrupted state still exits 5, note untouched, and now names the repair command', async () => {
    await runInTempVault(async (vaultPath) => {
      const filePath = createTopicNote(vaultPath, 'zero.md', {
        palee_id: 'T-zero',
        ease_factor: 1.0,
        interval_days: 0,
      });
      const before = fs.readFileSync(filePath);

      const { err } = await captureOutput(() => reviewCommand('T-zero', '4'));
      assert.strictEqual(process.exitCode, 5);
      assert.match(err, /ease_factor/i);
      assert.match(err, /palee validate --fix/);
      assert.deepStrictEqual(fs.readFileSync(filePath), before, 'review must not write the corrupted note');
    });
  });

  test('regression pin (#342): a non-numeric stored interval_days exits 5, prints the repair hint, and leaves the note byte-identical', async () => {
    await runInTempVault(async (vaultPath) => {
      // `repetition: 2` is what makes this the #342 shape rather than a first
      // review: the ladder would multiply `"soon" * 2.5`, get NaN, and write that
      // interval back into the note. A range comparison cannot see the value —
      // `"soon" < 1` is false — which is why the guard is a finiteness check.
      const filePath = createTopicNote(vaultPath, 'soon.md', {
        palee_id: 'T-soon',
        ease_factor: 2.5,
        interval_days: 'soon',
        repetition: 2,
        lapses: 1,
        due_at: '2026-09-25',
      });
      const before = fs.readFileSync(filePath);

      const { out, err } = await captureOutput(() => reviewCommand('T-soon', '4'));
      assert.strictEqual(
        process.exitCode,
        5,
        `expected exit 5, got ${process.exitCode}: ${out}${err}`
      );
      // ADR-0021: the refusal names the field *and* the value it refused, so the
      // learner can find the line to fix.
      assert.match(err, /Invalid interval_days: must be a finite number >= 1, got "soon"/);
      // Exit 5 on its own is a dead end; `src/cli/review.ts` prints this line only
      // when the message carries the `Invalid <field>:` prefix, so a refusal that
      // lost the prefix would leave the learner with no repair path.
      assert.match(
        err,
        /Hint: this note's SM-2 review state is invalid\. Run "palee validate --fix" to repair it\./
      );
      assert.deepStrictEqual(fs.readFileSync(filePath), before, 'review must not write a scheduled NaN into the note');
    });
  });

  test('regression pin (#547): a string stored lapses exits 5, prints the repair hint, and leaves the note byte-identical', async () => {
    await runInTempVault(async (vaultPath) => {
      // `repetition: 5` + quality 2 is a lapse: before #547 the unguarded
      // `lapses += 1` concatenated the string — "2" became "21", then "211",
      // one more digit every review.
      const filePath = createTopicNote(vaultPath, 'lapse.md', {
        palee_id: 'T-lapse',
        ease_factor: 2.5,
        interval_days: 10,
        repetition: 5,
        lapses: '2',
        due_at: '2026-09-25',
      });
      const before = fs.readFileSync(filePath);

      const { out, err } = await captureOutput(() => reviewCommand('T-lapse', '2'));
      assert.strictEqual(
        process.exitCode,
        5,
        `expected exit 5, got ${process.exitCode}: ${out}${err}`
      );
      // ADR-0021: the refusal names the field *and* the value it refused, so the
      // learner can find the line to fix.
      assert.match(err, /Invalid lapses: must be a non-negative integer, got "2"/);
      // Same repair path as the other three SM-2 fields: `validate --fix` resets
      // a non-numeric lapses to 0 (valid-review-fields already listed it).
      assert.match(
        err,
        /Hint: this note's SM-2 review state is invalid\. Run "palee validate --fix" to repair it\./
      );
      assert.deepStrictEqual(fs.readFileSync(filePath), before, 'review must not concatenate into the note');
    });
  });

  test('computed overflow does not suggest validate --fix', async () => {
    await runInTempVault(async (vaultPath) => {
      const filePath = createTopicNote(vaultPath, 'overflow.md', {
        palee_id: 'T-overflow',
        ease_factor: 2.5,
        interval_days: 1e308,
        repetition: 3,
        lapses: 0,
        due_at: '2026-09-25',
      });
      const before = fs.readFileSync(filePath);

      const { err } = await captureOutput(() => reviewCommand('T-overflow', '4'));
      assert.strictEqual(process.exitCode, 5);
      assert.match(err, /Invalid interval_days: computed non-finite value, got Infinity/);
      assert.doesNotMatch(err, /validate --fix/);
      assert.deepStrictEqual(fs.readFileSync(filePath), before, 'review must not write an overflowing interval');
    });
  });
});
