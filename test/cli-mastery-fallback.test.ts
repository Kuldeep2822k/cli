import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewCommand } from '../src/cli/review';
import adoptCommand from '../src/cli/adopt';
import { parseFrontmatter } from '../src/storage';

/**
 * Creates an isolated temp vault plus a PALEE config pointing at it.
 * Sets `PALEE_CONFIG_DIR` (the env var `loadConfig()` honors) so the
 * command handlers under test resolve the vault without touching the
 * developer's real configuration.
 */
async function runInTempVault(fn: (vaultPath: string) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-mastery-'));
  const vaultPath = path.join(tempDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ vaultPath }, null, 2));

  const origConfigDir = process.env.PALEE_CONFIG_DIR;
  process.env.PALEE_CONFIG_DIR = tempDir;
  try {
    await fn(vaultPath);
  } finally {
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Writes a Markdown note with the given frontmatter. `includeId` controls
 * whether a `palee_id` is present: `loadTopics()` (used by `review`) only
 * surfaces notes carrying one, while `adopt` skips notes that already have
 * one — so adoption tests must pass notes without it.
 */
function createNote(
  vaultPath: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  includeId = true
): string {
  const fm = includeId ? { palee_id: `T-${filename.replace(/\.md$/, '')}`, ...frontmatter } : frontmatter;
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const filePath = path.join(vaultPath, filename);
  fs.writeFileSync(filePath, `---\n${yaml}\n---\nBody text\n`);
  return filePath;
}

/**
 * Reads a note from the vault and returns its parsed frontmatter dictionary.
 *
 * @param vaultPath - Absolute path to the temp vault root
 * @param filename - Note filename relative to the vault root
 * @returns The parsed frontmatter object, or an empty object if absent
 */
function readFrontmatter(vaultPath: string, filename: string): Record<string, unknown> {
  const content = fs.readFileSync(path.join(vaultPath, filename), 'utf8');
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter || {};
}

const PILLARS = { conceptual: 0.8, practical: 0.6, debug: 0.4, feynman: 0.9 } as const;

describe('CLI mastery fallback characterization', () => {
  describe('review (pillars-first)', () => {
    test('no pillars, no existing mastery -> 0', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic' });
        await reviewCommand('Test Topic', '5');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.topic_mastery, 0);
      });
    });

    test('pillars only -> computed from formula', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', ...PILLARS });
        await reviewCommand('Test Topic', '5');
        const fm = readFrontmatter(vaultPath, 'note.md');
        // (0.8 + 0.6 + 0.4 + 2*0.9) / 5 = 0.72
        assert.strictEqual(fm.topic_mastery, 0.72);
      });
    });

    test('existing mastery only, no pillars -> existing kept', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', topic_mastery: 0.85 });
        await reviewCommand('Test Topic', '5');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.topic_mastery, 0.85);
      });
    });

    test('both pillars and existing -> pillars win (recompute)', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', ...PILLARS, topic_mastery: 0.85 });
        await reviewCommand('Test Topic', '5');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.topic_mastery, 0.72);
      });
    });
  });

  describe('adopt single-file (existing-first)', () => {
    test('no pillars, no existing mastery -> 0', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic' }, false);
        await adoptCommand('note.md');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0);
      });
    });

    test('pillars only -> computed from formula', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', ...PILLARS }, false);
        await adoptCommand('note.md');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0.72);
      });
    });

    test('existing mastery only, no pillars -> existing kept', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', topic_mastery: 0.85 }, false);
        await adoptCommand('note.md');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0.85);
      });
    });

    test('both pillars and existing -> existing wins', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', ...PILLARS, topic_mastery: 0.85 }, false);
        await adoptCommand('note.md');
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0.85);
      });
    });
  });

  describe('adopt batch (existing-first)', () => {
    test('no pillars, no existing mastery -> 0', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic' }, false);
        await adoptCommand(vaultPath, { yes: true });
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0);
      });
    });

    test('pillars only -> computed from formula', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', ...PILLARS }, false);
        await adoptCommand(vaultPath, { yes: true });
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0.72);
      });
    });

    test('existing mastery only, no pillars -> existing kept', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', topic_mastery: 0.85 }, false);
        await adoptCommand(vaultPath, { yes: true });
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0.85);
      });
    });

    test('both pillars and existing -> existing wins', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', { title: 'Test Topic', ...PILLARS, topic_mastery: 0.85 }, false);
        await adoptCommand(vaultPath, { yes: true });
        const fm = readFrontmatter(vaultPath, 'note.md');
        assert.strictEqual(fm.palee_schema, 1, 'adoption should have run');
        assert.strictEqual(fm.topic_mastery, 0.85);
      });
    });
  });

  describe('review SM-2 state coercion', () => {
    test('explicit repetition: 0 is preserved as a real value, not defaulted', async () => {
      await runInTempVault(async (vaultPath) => {
        // Valid SM-2 state: repetition 0 is legitimate (never reviewed before).
        createNote(vaultPath, 'note.md', {
          title: 'Test Topic',
          repetition: 0,
          interval_days: 1,
          ease_factor: 2.5,
        });
        await reviewCommand('Test Topic', '5');
        const fm = readFrontmatter(vaultPath, 'note.md');
        // Successful review: repetition 0 -> 1. If the falsy-zero bug were
        // still present, the loader would coerce 0 to the same default and
        // the review would still pass, so this pins the non-regression.
        assert.strictEqual(fm.repetition, 1);
      });
    });

    test('invalid SM-2 values fail the review with exit code 5 and leave the note unchanged', async () => {
      await runInTempVault(async (vaultPath) => {
        createNote(vaultPath, 'note.md', {
          title: 'Test Topic',
          ease_factor: 0, // below the 1.3 minimum -> processReview throws
          interval_days: 0,
        });

        const origExitCode = process.exitCode;
        const origError = console.error;
        let logged = '';
        console.error = (msg: string) => { logged += `${msg}\n`; };
        try {
          process.exitCode = 0;
          await reviewCommand('Test Topic', '5');
          assert.strictEqual(process.exitCode, 5, `expected exit 5, logged: ${logged}`);
          assert.match(logged, /ease_factor/i);
          const fm = readFrontmatter(vaultPath, 'note.md');
          // The atomic write must not have happened: the malformed state is untouched.
          assert.strictEqual(fm.ease_factor, 0);
          assert.strictEqual(fm.interval_days, 0);
        } finally {
          console.error = origError;
          process.exitCode = origExitCode;
        }
      });
    });
  });
});
