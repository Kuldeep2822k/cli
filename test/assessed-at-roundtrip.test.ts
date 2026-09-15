/**
 * assessed_at epoch round-trip (issue #171 finding 4)
 *
 * @remarks
 * adopt/loader persist `assessed_at` via String(frontmatter.assessed_at),
 * which stringifies epoch-ms numbers into plain digits. The
 * isValidAssessedAt rule accepts number epoch-ms but rejects
 * stringified-digit epoch values — a contract break where adopt/loader
 * produce data their own validator rejects.
 *
 * Fix: preserve the native frontmatter type (number stays number,
 * string stays string) at both write (adopt.ts) and load (loader.ts)
 * boundaries, instead of coercing everything through String().
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter, updateFrontmatter } from '../src/storage/frontmatter';
import { loadTopics } from '../src/storage/loader';
import { isValidAssessedAt } from '../src/validation/rules/assessed-at';

describe('assessed_at epoch round-trip (#171 finding 4)', () => {
  const epochMs = 1771075200000;

  it('rule accepts raw epoch-ms number and rejects stringified digits', () => {
    // The asymmetry that makes this a bug: the rule handles both forms,
    // but String()-ifying a number turns a valid epoch into an invalid
    // stringified-digit value that the rule rejects.
    assert.strictEqual(isValidAssessedAt(epochMs), true);
    assert.strictEqual(isValidAssessedAt(String(epochMs)), false);
  });

  it('loader preserves numeric assessed_at from raw frontmatter', () => {
    // Write a note with numeric assessed_at, load it, verify the type
    // is preserved (not stringified) and passes the rule.
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-epoch-'));
    try {
      const content = `---\npalee_schema: 1\npalee_id: T-epoch\ntitle: Epoch Topic\ndifficulty: beginner\ndepends_on: []\nassessed_at: ${epochMs}\n---\n# Epoch Topic\n`;
      const filePath = path.join(vaultDir, 'epoch.md');
      fs.writeFileSync(filePath, content, 'utf8');

      const topics = loadTopics(vaultDir);
      const topic = topics.find(t => t.palee_id === 'T-epoch');
      assert.ok(topic, 'topic should load');
      assert.strictEqual(typeof topic.assessed_at, 'number', 'assessed_at must stay a number, not be stringified');
      assert.strictEqual(topic.assessed_at, epochMs);
      assert.strictEqual(isValidAssessedAt(topic.assessed_at), true);
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('updateFrontmatter preserves numeric assessed_at in written YAML', () => {
    // The write boundary (adopt.ts calls updateFrontmatter with paleeData):
    // a numeric assessed_at must serialize as a YAML number, not a
    // quoted stringified-digit, so re-parsing yields a number the rule accepts.
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-write-'));
    try {
      const filePath = path.join(vaultDir, 'topic.md');
      const original = `---\nassessed_at: ${epochMs}\n---\n# Topic\n`;
      fs.writeFileSync(filePath, original, 'utf8');

      const { frontmatter } = parseFrontmatter(original);
      assert.ok(frontmatter);

      // Mimic what adopt.ts does: pass frontmatter.assessed_at through.
      const paleeData: Record<string, unknown> = {
        palee_id: 'T-write',
        palee_schema: 1,
        title: 'Written Topic',
        difficulty: 'beginner',
        depends_on: [],
        assessed_at: frontmatter.assessed_at ?? null,
      };
      const written = updateFrontmatter(original, paleeData);

      // Re-parse the written file — assessed_at must be a number, not a string.
      const reparsed = parseFrontmatter(written);
      assert.ok(reparsed.frontmatter);
      assert.strictEqual(typeof reparsed.frontmatter.assessed_at, 'number',
        'written assessed_at must be a YAML number, not stringified');
      assert.strictEqual(reparsed.frontmatter.assessed_at, epochMs);
      assert.strictEqual(isValidAssessedAt(reparsed.frontmatter.assessed_at), true,
        're-parsed assessed_at must pass the rule');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
