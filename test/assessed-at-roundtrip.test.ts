/**
 * assessed_at epoch round-trip (issue #171 finding 4 / #179)
 *
 * @remarks
 * adopt/loader persisted `assessed_at` via `String(frontmatter.assessed_at)`,
 * which stringified epoch-ms numbers into plain digit strings the validator
 * rejects. Issue #179 requires normalization to ISO 8601.
 *
 * Fix: `normalizeAssessedAt` converts finite numeric epoch-ms values to
 * `new Date(value).toISOString()` at both write (adopt.ts) and load
 * (loader.ts) boundaries.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter, updateFrontmatter } from '../src/storage/frontmatter';
import { loadTopics } from '../src/storage/loader';
import { isValidAssessedAt } from '../src/validation/rules/assessed-at';
import { normalizeAssessedAt } from '../src/types';

describe('assessed_at epoch round-trip (#171 finding 4 / #179)', () => {
  const epochMs = 1771075200000;
  const expectedIso = new Date(epochMs).toISOString();

  it('normalizes epoch-ms to ISO 8601 and rule accepts the result', () => {
    // The old bug stringified the number — isValidAssessedAt rejects
    // '1771075200000' as a non-date string — but the normalized ISO
    // output passes.
    assert.strictEqual(isValidAssessedAt(String(epochMs)), false);
    assert.strictEqual(isValidAssessedAt(normalizeAssessedAt(epochMs)), true);
  });

  it('rejects out-of-range finite numbers as null but keeps fractional epochs', () => {
    // 8640000000000001 exceeds the valid Date range — new Date(raw) produces
    // an invalid time value (NaN), so normalizeAssessedAt returns null.
    const outOfRange = 8640000000000001;
    assert.strictEqual(normalizeAssessedAt(outOfRange), null,
      'out-of-range finite number must normalize to null, not throw');

    assert.strictEqual(normalizeAssessedAt(Infinity), null);
    assert.strictEqual(normalizeAssessedAt(NaN), null);

    // Fractional epoch is clipped to ms precision by Date but is still valid —
    // it must be preserved as its millisecond ISO string, not nulled.
    const fractional = epochMs + 0.75;
    const clippedIso = new Date(epochMs).toISOString();
    assert.strictEqual(normalizeAssessedAt(fractional), clippedIso,
      'fractional epoch must be clipped to ms and converted, not nulled');
  });

  it('loader normalizes numeric assessed_at to ISO string', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-epoch-'));
    try {
      const content = `---\npalee_schema: 1\npalee_id: T-epoch\ntitle: Epoch Topic\ndifficulty: beginner\ndepends_on: []\nassessed_at: ${epochMs}\n---\n# Epoch Topic\n`;
      const filePath = path.join(vaultDir, 'epoch.md');
      fs.writeFileSync(filePath, content, 'utf8');

      const topics = loadTopics(vaultDir);
      const topic = topics.find((t) => t.palee_id === 'T-epoch');
      assert.ok(topic, 'topic should load');
      assert.strictEqual(topic.assessed_at, expectedIso,
        'numeric epoch must be normalized to ISO 8601 string');
      assert.strictEqual(typeof topic.assessed_at, 'string', 'assessed_at must be a string');
      assert.strictEqual(isValidAssessedAt(topic.assessed_at), true);
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('updateFrontmatter preserves ISO string through the write boundary', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-write-'));
    try {
      const filePath = path.join(vaultDir, 'topic.md');
      const original = `---\nassessed_at: ${epochMs}\n---\n# Topic\n`;
      fs.writeFileSync(filePath, original, 'utf8');

      const { frontmatter } = parseFrontmatter(original);
      assert.ok(frontmatter);

      // Mimic what adopt.ts does: normalize via normalizeAssessedAt.
      const paleeData: Record<string, unknown> = {
        palee_id: 'T-write',
        palee_schema: 1,
        title: 'Written Topic',
        difficulty: 'beginner',
        depends_on: [],
        assessed_at: normalizeAssessedAt(frontmatter.assessed_at),
      };
      const written = updateFrontmatter(original, paleeData);

      // Re-parse the written file — assessed_at must be an ISO string.
      const reparsed = parseFrontmatter(written);
      assert.ok(reparsed.frontmatter);
      assert.strictEqual(reparsed.frontmatter.assessed_at, expectedIso,
        'written assessed_at must be the normalized ISO string');
      assert.strictEqual(isValidAssessedAt(reparsed.frontmatter.assessed_at), true,
        're-parsed assessed_at must pass the rule');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
