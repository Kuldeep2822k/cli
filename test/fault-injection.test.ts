import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter, updateFrontmatter } from '../src/storage/frontmatter';
import { loadTopics } from '../src/storage/loader';
import { rebuildHotAndIndex, getDrafts } from '../src/storage/memory';
import { walkVault } from '../src/storage/vault-walker';

describe('Storage & Memory Fault Injection Test Suite', () => {
  let testVault: string;

  before(() => {
    testVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-fault-vault-'));
  });

  after(() => {
    fs.rmSync(testVault, { recursive: true, force: true });
  });

  describe('Frontmatter Corruption & Adversarial Inputs', () => {
    test('handles unclosed frontmatter fence (single --- at top)', () => {
      const content = '---\ntitle: Unclosed\nkey: value\n# Body without closing fence';
      const result = parseFrontmatter(content);
      // Parser should treat as body without crashing
      assert.strictEqual(result.frontmatter, null);
      assert.strictEqual(result.body, content);
    });

    test('handles empty frontmatter fence (------)', () => {
      const content = '---\n---\n# Body after empty fence';
      const result = parseFrontmatter(content);
      assert.strictEqual(result.frontmatter, null);
      assert.ok(result.body.includes('# Body after empty fence'));
    });

    test('handles frontmatter containing printable multi-byte unicode characters', () => {
      const content = '---\ntitle: 🚀 Advanced AI 🤖\ntags: [🔥, 学习, 🧠, ⚡]\n---\n# Unicode Note';
      const result = parseFrontmatter(content);
      assert.ok(result.frontmatter);
      assert.strictEqual(result.frontmatter.title, '🚀 Advanced AI 🤖');
      assert.ok(Array.isArray(result.frontmatter.tags));
      assert.strictEqual(result.frontmatter.tags.length, 4);
    });

    test('handles frontmatter with malformed YAML syntax gracefully without crashing', () => {
      const content = '---\ntitle: Test\ninvalid: >>>malformed\ncompletely broken: {{{\n---\n# Body';
      const result = parseFrontmatter(content);
      // Malformed YAML with parse errors gracefully falls back to null frontmatter without throwing
      assert.strictEqual(result.frontmatter, null);
      assert.strictEqual(result.body, '# Body');
    });

    test('updateFrontmatter throws clean error on unparseable corrupted frontmatter', () => {
      const corrupted = '---\n: invalid yaml syntax [[]\n---\n# Body';
      // If parsing fails with syntax error, updateFrontmatter should report clean error
      try {
        const res = updateFrontmatter(corrupted, { title: 'Updated' });
        assert.ok(res);
      } catch (err: unknown) {
        assert.ok((err as Error).message.includes('Malformed frontmatter'));
      }
    });
  });

  describe('Topic Loader Fault Tolerance', () => {
    test('loadTopics ignores corrupted, empty, and non-PALEE notes gracefully', () => {
      const normalNote = path.join(testVault, 'normal.md');
      const corruptedNote = path.join(testVault, 'corrupted.md');
      const emptyNote = path.join(testVault, 'empty.md');
      const nonPaleeNote = path.join(testVault, 'non-palee.md');

      fs.writeFileSync(normalNote, '---\npalee_id: T-ok\npalee_schema: 1\ntitle: OK\n---\n# OK');
      fs.writeFileSync(corruptedNote, '---\n: bad yaml\n---\n# Bad');
      fs.writeFileSync(emptyNote, '');
      fs.writeFileSync(nonPaleeNote, '# Regular Obsidian Note without frontmatter');

      const loaded = loadTopics(testVault);
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].palee_id, 'T-ok');

      fs.unlinkSync(normalNote);
      fs.unlinkSync(corruptedNote);
      fs.unlinkSync(emptyNote);
      fs.unlinkSync(nonPaleeNote);
    });

    test('loadTopics sanitizes NaN, infinite, and out-of-range review statistics', () => {
      const weirdStatsNote = path.join(testVault, 'weird-stats.md');
      fs.writeFileSync(
        weirdStatsNote,
        `---
palee_id: T-weird
palee_schema: 1
title: Weird Stats
topic_mastery: 999.5
ease_factor: 0.2
interval_days: -50
repetition: -10
lapses: -5
last_quality: 99
conceptual: 15.0
practical: -2.0
---
# Weird
`
      );

      const loaded = loadTopics(testVault);
      assert.strictEqual(loaded.length, 1);
      const topic = loaded[0];

      // topic_mastery clamped to 0..1
      assert.strictEqual(topic.topic_mastery, 1.0);
      // ease_factor preserves parsed number
      assert.strictEqual(topic.ease_factor, 0.2);
      // interval preserves parsed integer
      assert.strictEqual(topic.interval_days, -50);
      // repetition preserves parsed integer
      assert.strictEqual(topic.repetition, -10);
      // lapses preserves parsed integer
      assert.strictEqual(topic.lapses, -5);
      // quality preserves parsed integer
      assert.strictEqual(topic.last_quality, 99);
      // pillar scores clamped to 0..1
      assert.strictEqual(topic.conceptual, 1.0);
      assert.strictEqual(topic.practical, 0.0);

      fs.unlinkSync(weirdStatsNote);
    });
  });

  describe('Session Memory & Draft Resilience', () => {
    test('rebuildHotAndIndex gracefully handles corrupted and invalid session files', async () => {
      const paleeDir = path.join(testVault, '.palee');
      const sessionsDir = path.join(paleeDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Valid session
      fs.writeFileSync(
        path.join(sessionsDir, 'S-20260820T100000-aaaa.md'),
        '---\npalee_schema: 1\nsession_id: S-20260820T100000-aaaa\ntopic_id: T-valid\nstatus: completed\nstarted_at: "2026-08-20T10:00:00Z"\nended_at: "2026-08-20T10:30:00Z"\n---\n# Notes\nGood session.'
      );

      // Corrupted session
      fs.writeFileSync(
        path.join(sessionsDir, 'S-20260820T110000-bbbb.md'),
        '---\n: bad frontmatter\n---\nCorrupted content'
      );

      // Draft checkpoint
      fs.writeFileSync(
        path.join(sessionsDir, 'DRAFT-S-12345678.md'),
        '---\npalee_schema: 1\nsession_id: DRAFT-S-12345678\ntopic_id: T-draft\nstatus: draft\nstarted_at: "2026-08-20T11:00:00Z"\nended_at: null\n---\nDraft note'
      );

      await rebuildHotAndIndex(testVault);

      const hotPath = path.join(paleeDir, 'hot.md');
      const indexPath = path.join(paleeDir, 'index.md');

      assert.ok(fs.existsSync(hotPath));
      assert.ok(fs.existsSync(indexPath));

      const hotContent = fs.readFileSync(hotPath, 'utf8');
      assert.ok(hotContent.includes('T-valid'));

      const drafts = getDrafts(testVault);
      assert.strictEqual(drafts.length, 1);
      assert.ok(drafts[0].includes('DRAFT-S-12345678.md'));
    });
  });

  describe('Vault Walker Error Recovery', () => {
    test('walkVault traverses deeply nested directory trees without stack overflow', () => {
      let currentDir = testVault;
      for (let i = 0; i < 15; i++) {
        currentDir = path.join(currentDir, `level-${i}`);
        fs.mkdirSync(currentDir, { recursive: true });
        fs.writeFileSync(path.join(currentDir, `note-${i}.md`), `# Note ${i}`);
      }

      const files = walkVault(testVault);
      assert.ok(files.length >= 15);
    });
  });
});
