import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadTopics } from '../src/storage/loader';

describe('Storage Topic Loader', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('loadTopics returns empty array when no PALEE topics exist', () => {
    fs.writeFileSync(path.join(tmpVault, 'regular.md'), '# Regular note without palee_id', 'utf8');
    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 0);
  });

  test('loadTopics parses frontmatter, normalizes fields, and builds LoadedTopic objects', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic1.md'),
      `---
palee_schema: 1
palee_id: T-topic-1
title: Introduction to TypeScript
difficulty: beginner
depends_on: []
topic_mastery: 0.8
conceptual: 0.8
practical: 0.8
debug: 0.8
feynman: 0.8
ease_factor: 2.6
interval_days: 6
repetition: 2
lapses: 0
last_quality: 4
last_reviewed_at: 2026-08-15
due_at: 2026-08-21
---
# TypeScript Intro
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(tmpVault, 'topic2.md'),
      `---
palee_schema: 1
palee_id: T-topic-2
difficulty: advanced
dependencies:
  - T-topic-1
topic_mastery: 0.2
status: learning
---
# Advanced Generics
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 2);

    const t1 = topics.find((t) => t.palee_id === 'T-topic-1');
    assert.ok(t1);
    assert.strictEqual(t1.title, 'Introduction to TypeScript');
    assert.strictEqual(t1.difficulty, 'beginner');
    assert.strictEqual(t1.topic_mastery, 0.8);
    assert.strictEqual(t1.ease_factor, 2.6);
    assert.strictEqual(t1.repetition, 2);
    assert.strictEqual(t1.last_quality, 4);
    assert.strictEqual(t1.due_at, '2026-08-21');
    assert.deepStrictEqual(t1.depends_on, []);

    const t2 = topics.find((t) => t.palee_id === 'T-topic-2');
    assert.ok(t2);
    assert.strictEqual(t2.title, 'topic2'); // Filename fallback when frontmatter title omitted
    assert.strictEqual(t2.difficulty, 'advanced');
    assert.strictEqual(t2.status, 'learning');
    assert.deepStrictEqual(t2.depends_on, ['T-topic-1']); // Normalized from dependencies alias
  });
});
