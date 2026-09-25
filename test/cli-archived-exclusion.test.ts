import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { planCommand } from '../src/cli/plan';
import { dashboardCommand } from '../src/cli/dashboard';
import { progressCommand } from '../src/cli/progress';
import { getReadyTopics } from '../src/engine/dependency';
import { saveConfig } from '../src/cli/config';

/**
 * BUG-002 — archived topics must not leak into `plan`/`dashboard`.
 *
 * `progress` already excludes `status: archived` from its derived stats
 * (src/cli/progress.ts); plan and dashboard did not, so the same vault produced
 * contradictory numbers across commands.
 */
describe('BUG-002 archived topics excluded from plan/dashboard', () => {
  let tmpDir: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let loggedOutputs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-bug002-'));
    tmpConfigDir = path.join(tmpDir, '.config');
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tmpConfigDir;
    saveConfig({ vaultPath: tmpDir });

    loggedOutputs = [];
    console.log = (...args: unknown[]) => {
      loggedOutputs.push(args.map(a => String(a)).join(' '));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function getLastParsedJson(): any {
    const raw = loggedOutputs[loggedOutputs.length - 1];
    assert.ok(raw, 'Expected at least one console.log output');
    return JSON.parse(raw);
  }

  // Text (human) output requires a TTY: under `node --test` stdout is piped, so
  // isJsonOutput() would auto-switch to JSON (src/cli/onboarding.ts:28).
  const originalIsTTY = process.stdout.isTTY;

  function asTTY() {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  }

  function restoreTTY() {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }

  function seedVault() {
    fs.writeFileSync(
      path.join(tmpDir, 'topic-1.md'),
      `---
palee_schema: 1
palee_id: T-topic-1
title: Introduction to Rust
difficulty: beginner
status: learning
topic_mastery: 0.8
repetition: 3
lapses: 0
due_at: 2020-01-01
depends_on: []
---
# Intro
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'topic-2.md'),
      `---
palee_schema: 1
palee_id: T-topic-2
title: Advanced Rust Lifetimes
difficulty: advanced
status: learning
topic_mastery: 0.2
repetition: 1
lapses: 1
due_at: 2099-01-01
depends_on:
  - T-topic-1
---
# Lifetimes
`,
      'utf8'
    );
    // Archived, unmastered, long-overdue, no prerequisites: without a status
    // filter it is counted as "new", "ready to learn" and "due for review".
    fs.writeFileSync(
      path.join(tmpDir, 'archived.md'),
      `---
palee_schema: 1
palee_id: T-archived
title: Archived Topic
difficulty: intermediate
status: archived
topic_mastery: 0
repetition: 0
lapses: 0
due_at: 2020-01-01
depends_on: []
---
# Archived Topic
`,
      'utf8'
    );
  }

  describe('engine readiness', () => {
    test('getReadyTopics skips archived topics', () => {
      const topics = new Map<string, any>([
        ['T-open', { palee_id: 'T-open', topic_mastery: 0, depends_on: [], status: 'not_started' }],
        ['T-archived', { palee_id: 'T-archived', topic_mastery: 0, depends_on: [], status: 'archived' }],
      ]);
      const ready = getReadyTopics(topics);
      assert.deepStrictEqual(ready.map(t => t.palee_id), ['T-open']);
    });
  });

  describe('plan --json', () => {
    beforeEach(seedVault);

    test('excludes archived from ready_to_learn and counts', async () => {
      await planCommand({ json: true });
      const data = getLastParsedJson();
      // T-topic-2 (mastery 0.2, prereq T-topic-1 mastered) is the only genuine
      // ready candidate; the archived topic must never appear.
      assert.deepStrictEqual(data.ready_to_learn.map((t: any) => t.id), ['T-topic-2'], 'archived topic must not be reported as ready to learn');
      assert.strictEqual(data.counts.ready, 1);
      assert.strictEqual(data.counts.new, 0, 'archived topic must not be counted as new');
      assert.strictEqual(data.counts.due, 1, 'archived topic must not be counted as due');
      assert.deepStrictEqual(data.reviews_due.map((t: any) => t.id), ['T-topic-1']);
      assert.strictEqual(data.counts.mastered, 1);
      assert.strictEqual(data.counts.learning, 1);
    });

    test('reports active and archived split consistent with progress', async () => {
      await planCommand({ json: true });
      const plan = getLastParsedJson();
      await progressCommand({ json: true });
      const progress = getLastParsedJson();
      assert.strictEqual(plan.total_topics, 3);
      assert.strictEqual(plan.active_topic_count, progress.active_topic_count);
      assert.strictEqual(plan.archived_topic_count, progress.archived_topic_count);
      assert.strictEqual(plan.active_topic_count, 2);
      assert.strictEqual(plan.archived_topic_count, 1);
    });

    test('text output omits archived topics from lists and totals', async () => {
      asTTY();
      try {
        await planCommand({});
        const text = loggedOutputs.join('\n');
        assert.match(text, /Ready to Learn: 1/);
        assert.match(text, /Reviews Due: 1/);
        assert.doesNotMatch(text, /Archived Topic/, 'archived topic must not be listed in the plan');
        assert.match(text, /Total Topics: 2 \(1 archived\)/);
        assert.match(text, /New: 0/);
      } finally {
        restoreTTY();
      }
    });
  });

  describe('dashboard --json', () => {
    beforeEach(seedVault);

    test('excludes archived from derived stats and next review', async () => {
      await dashboardCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 3);
      assert.strictEqual(data.active_topic_count, 2);
      assert.strictEqual(data.archived_topic_count, 1);
      assert.strictEqual(data.new, 0, 'archived topic must not be counted as new');
      assert.strictEqual(data.mastered, 1);
      assert.strictEqual(data.learning, 1);
      assert.strictEqual(data.reviews_due, 1);
      assert.strictEqual(data.by_difficulty.intermediate.total, 0, 'archived topic must not inflate difficulty buckets');
      assert.strictEqual(data.next_review.id, 'T-topic-1');
      // Percentages are relative to the active population.
      assert.strictEqual(data.mastered_pct, 50);
    });

    test('text output does not count archived in New line', async () => {
      asTTY();
      try {
        await dashboardCommand({});
        const text = loggedOutputs.join('\n');
        assert.match(text, /^New:\s+0\s/m);
        assert.doesNotMatch(text, /Archived Topic/);
        assert.match(text, /Total Topics:\s+2 \(1 archived\)/);
      } finally {
        restoreTTY();
      }
    });

    test('archived-only vault still reports zeroed active stats', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'extra-archived.md'),
        `---
palee_schema: 1
palee_id: T-archived-2
title: Another Archived
difficulty: beginner
status: archived
topic_mastery: 0
depends_on: []
---
# Another Archived
`,
        'utf8'
      );
      // Remove the active topics so only archived notes remain.
      fs.unlinkSync(path.join(tmpDir, 'topic-1.md'));
      fs.unlinkSync(path.join(tmpDir, 'topic-2.md'));

      await dashboardCommand({ json: true });
      const data = getLastParsedJson();
      // Two archived notes remain on disk; nothing is active.
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.active_topic_count, 0);
      assert.strictEqual(data.archived_topic_count, 2);
      assert.strictEqual(data.mastered_pct, 0);
      assert.strictEqual(data.learning_pct, 0);
      assert.strictEqual(data.new_pct, 0);
      assert.strictEqual(data.next_review, null);
    });
  });
});
