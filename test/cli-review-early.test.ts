import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * Regression coverage for #301 (reviews accepted before `due_at` silently
 * compound the interval) and the CLI-level half of #300 (a review must not
 * mint pillar scores on a note the learner never assessed).
 */
describe('CLI review early-warning and pillar-absence behaviour', () => {
  let tempDir: string;
  let vaultDir: string;
  let origConfigDir: string | undefined;

  before(() => {
    origConfigDir = process.env.PALEE_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-review-early-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir);
    process.env.PALEE_CONFIG_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }, null, 2),
      'utf8'
    );
  });

  after(() => {
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[]): { status: number | null, stdout: string, stderr: string } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  /**
   * Writes a flat-frontmatter topic note (the on-disk shape) carrying the SM-2
   * defaults and the requested `due_at`, and none of the four pillar keys —
   * i.e. a note that has never been assessed.
   */
  function writeTopicNote(fileName: string, paleeId: string, dueAt: string): string {
    const notePath = path.join(vaultDir, fileName);
    fs.writeFileSync(
      notePath,
      `---
palee_id: ${paleeId}
palee_schema: 1
title: Early Warning Topic ${paleeId}
difficulty: intermediate
depends_on: []
topic_mastery: 0
ease_factor: 2.5
interval_days: 1
repetition: 0
lapses: 0
last_quality: ${dueAt === 'null' ? 'null' : '4'}
last_reviewed_at: ${dueAt === 'null' ? 'null' : '2026-01-01'}
due_at: ${dueAt}
---
# Body
`,
      'utf8'
    );
    return notePath;
  }

  test('#301 a review before the stored due date is still recorded, exits 0, and warns naming the due date', () => {
    const notePath = writeTopicNote('early-warn.md', 'T-early-warn', '2099-01-15');

    const result = runCLI(['review', 'T-early-warn', '5']);
    assert.strictEqual(result.status, 0, `early review must still record and exit 0. stderr: ${result.stderr}`);
    assert.match(result.stdout, /✓ Review recorded/);
    assert.match(result.stdout, /⚠ Reviewed early/);
    assert.match(result.stdout, /2099-01-15/, 'warning must name the date the note was actually due');

    const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
    assert.strictEqual(parsed.frontmatter!.repetition, 1, 'the SM-2 state must still advance');
    assert.strictEqual(parsed.frontmatter!.last_quality, 5);
    assert.ok(parsed.frontmatter!.due_at, 'a new due date must still be stamped');
  });

  test('#301 --force suppresses the early-review warning but still records the review', () => {
    const notePath = writeTopicNote('early-force.md', 'T-early-force', '2099-01-15');

    const result = runCLI(['review', 'T-early-force', '5', '--force']);
    assert.strictEqual(result.status, 0, `--force must exit 0, not error. stderr: ${result.stderr}`);
    assert.match(result.stdout, /✓ Review recorded/);
    assert.ok(!result.stdout.includes('Reviewed early'), '--force must not print the early-review warning');

    const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
    assert.strictEqual(parsed.frontmatter!.repetition, 1, 'the review is still recorded under --force');
  });

  test('#301 a never-reviewed note with due_at null is not early and prints no warning', () => {
    const notePath = writeTopicNote('due-null.md', 'T-due-null', 'null');

    const result = runCLI(['review', 'T-due-null', '5']);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(!result.stdout.includes('Reviewed early'), 'due_at null means no schedule to be early against');

    const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
    assert.strictEqual(parsed.frontmatter!.repetition, 1);
  });

  test('#301 a review on the due date itself is not early', () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    writeTopicNote('due-today.md', 'T-due-today', todayStr);

    const result = runCLI(['review', 'T-due-today', '5']);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(!result.stdout.includes('Reviewed early'), 'a due-today review is exactly on schedule');
  });

  test('#300 review on a never-assessed note writes no pillar keys', () => {
    const notePath = writeTopicNote('no-pillars.md', 'T-no-pillars', 'null');

    const before = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
    assert.strictEqual(before.frontmatter!.conceptual, undefined, 'fixture must carry no pillars');

    const result = runCLI(['review', 'T-no-pillars', '4']);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
    for (const pillar of ['conceptual', 'practical', 'debug', 'feynman'] as const) {
      assert.strictEqual(parsed.frontmatter![pillar], undefined, `review must not mint ${pillar}: 0`);
    }
    assert.ok(parsed.frontmatter!.due_at, 'the SM-2 fields themselves are still written');
  });
});
