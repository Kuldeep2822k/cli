import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { nextCommand } from '../src/cli/next';
import { planCommand } from '../src/cli/plan';
import { progressCommand } from '../src/cli/progress';
import { dashboardCommand } from '../src/cli/dashboard';
import { validateCommand } from '../src/cli/validate';
import { sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';

describe('CLI Machine-Readable --json Output (Invariant #45)', () => {
  let tmpDir: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let loggedOutputs: string[] = [];
  let loggedErrors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-json-test-'));
    tmpConfigDir = path.join(tmpDir, '.config');
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tmpConfigDir;

    saveConfig({ vaultPath: tmpDir });
    loggedOutputs = [];
    loggedErrors = [];
    console.log = (...args: unknown[]) => {
      loggedOutputs.push(args.map(a => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(a => String(a)).join(' '));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
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

  function getLastParsedJsonError(): any {
    const raw = loggedErrors[loggedErrors.length - 1];
    assert.ok(raw, 'Expected at least one console.error output');
    return JSON.parse(raw);
  }

  describe('Configuration & Setup Error Output in JSON mode', () => {
    test('validate --json emits structured JSON error when vault not configured', async () => {
      saveConfig({ vaultPath: undefined });
      await validateCommand({ json: true });
      const err = getLastParsedJsonError();
      assert.ok(err.error.includes('Vault path not configured'));
      assert.strictEqual(process.exitCode, 2);
    });

    test('next --json emits structured JSON error when vault path not found', async () => {
      saveConfig({ vaultPath: path.join(tmpDir, 'does-not-exist') });
      await nextCommand({ json: true });
      const err = getLastParsedJsonError();
      assert.ok(err.error.includes('Vault path not found'));
      assert.strictEqual(process.exitCode, 2);
    });
  });

  describe('Empty Vault Output', () => {
    test('next --json on empty vault produces consistent single next structure', async () => {
      await nextCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 0);
      assert.strictEqual(data.due_count, 0);
      assert.strictEqual(data.next, null);
    });

    test('next --all --json on empty vault produces due_topics array structure', async () => {
      await nextCommand({ all: true, json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 0);
      assert.deepStrictEqual(data.due_topics, []);
      assert.strictEqual(data.next, null);
    });

    test('plan --json on empty vault produces valid JSON structure', async () => {
      await planCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 0);
      assert.deepStrictEqual(data.reviews_due, []);
      assert.deepStrictEqual(data.ready_to_learn, []);
      assert.strictEqual(data.counts.due, 0);
    });

    test('progress --json on empty vault produces valid JSON structure', async () => {
      await progressCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 0);
      assert.strictEqual(data.mastered, 0);
      assert.strictEqual(data.avg_mastery, 0);
      assert.strictEqual(data.by_difficulty.beginner.total, 0);
    });

    test('dashboard --json on empty vault produces valid JSON structure', async () => {
      await dashboardCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 0);
      assert.strictEqual(data.mastered, 0);
      assert.strictEqual(data.reviews_due, 0);
      assert.strictEqual(data.next_review, null);
    });

    test('validate --json on empty vault reports valid', async () => {
      await validateCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.valid, true);
      assert.strictEqual(data.topic_count, 0);
      assert.strictEqual(data.error_count, 0);
      assert.deepStrictEqual(data.errors, []);
    });

    test('session list --json on empty vault reports 0 sessions and drafts', async () => {
      await sessionCommand('list', { json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_confirmed, 0);
      assert.strictEqual(data.total_drafts, 0);
      assert.deepStrictEqual(data.confirmed, []);
      assert.deepStrictEqual(data.drafts, []);
    });
  });

  describe('Populated Vault Output', () => {
    beforeEach(() => {
      // Create topic 1 (due, beginner, mastery 0.8)
      fs.writeFileSync(
        path.join(tmpDir, 'topic-1.md'),
        `---
palee_schema: 1
palee_id: T-topic-1
title: Introduction to Rust
difficulty: beginner
topic_mastery: 0.8
repetition: 3
lapses: 0
due_at: 2020-01-01T00:00:00.000Z
depends_on: []
---
# Intro
`,
        'utf8'
      );

      // Create topic 2 (not due, advanced, mastery 0.2)
      fs.writeFileSync(
        path.join(tmpDir, 'topic-2.md'),
        `---
palee_schema: 1
palee_id: T-topic-2
title: Advanced Rust Lifetimes
difficulty: 5
topic_mastery: 0.2
repetition: 1
lapses: 1
due_at: 2099-01-01T00:00:00.000Z
depends_on:
  - T-topic-1
---
# Lifetimes
`,
        'utf8'
      );
    });

    test('next --json outputs single next due topic', async () => {
      await nextCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.due_count, 1);
      assert.ok(data.next);
      assert.strictEqual(data.next.id, 'T-topic-1');
      assert.strictEqual(data.next.mastery, 0.8);
    });

    test('next --all --json outputs all due topics array', async () => {
      await nextCommand({ all: true, json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.due_topics.length, 1);
      assert.strictEqual(data.due_topics[0].id, 'T-topic-1');
      assert.strictEqual(data.next.id, 'T-topic-1');
    });

    test('plan --json outputs due and ready-to-learn plan with counts', async () => {
      await planCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.counts.due, 1);
      assert.strictEqual(data.counts.mastered, 1);
      assert.strictEqual(data.reviews_due.length, 1);
      assert.strictEqual(data.reviews_due[0].id, 'T-topic-1');
      assert.strictEqual(data.reviews_due[0].difficulty, 'beginner');
      assert.strictEqual(data.ready_to_learn.length, 1);
      assert.strictEqual(data.ready_to_learn[0].id, 'T-topic-2');
      assert.strictEqual(data.ready_to_learn[0].difficulty, 'advanced');
    });

    test('progress --json outputs aggregate progress statistics', async () => {
      await progressCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.mastered, 1);
      assert.strictEqual(data.learning, 1);
      assert.strictEqual(data.new, 0);
      assert.strictEqual(data.by_difficulty.beginner.total, 1);
      assert.strictEqual(data.by_difficulty.advanced.total, 1);
      assert.strictEqual(data.total_reviews, 4);
      assert.strictEqual(data.total_lapses, 1);
    });

    test('progress --topic <id> --json outputs single topic stats', async () => {
      await progressCommand({ topic: 'T-topic-1', json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.id, 'T-topic-1');
      assert.strictEqual(data.title, 'Introduction to Rust');
      assert.strictEqual(data.mastery, 0.8);
      assert.strictEqual(data.difficulty, 'beginner');
      assert.strictEqual(data.repetition, 3);
    });

    test('progress --topic <missing> --json outputs error JSON and sets exitCode 2', async () => {
      await progressCommand({ topic: 'non-existent', json: true });
      const errData = getLastParsedJsonError();
      assert.ok(errData.error.includes('Topic not found'));
      assert.strictEqual(process.exitCode, 2);
    });

    test('dashboard --json outputs complete dashboard metrics and next review', async () => {
      await dashboardCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.mastered, 1);
      assert.strictEqual(data.learning, 1);
      assert.strictEqual(data.reviews_due, 1);
      assert.strictEqual(data.by_difficulty.beginner.mastered, 1);
      assert.strictEqual(data.next_review.id, 'T-topic-1');
    });

    test('validate --json on valid vault returns valid=true', async () => {
      await validateCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.valid, true);
      assert.strictEqual(data.topic_count, 2);
      assert.strictEqual(data.error_count, 0);
    });

    test('validate --json on invalid vault returns errors and sets exitCode 3', async () => {
      // Create missing dependency topic
      fs.writeFileSync(
        path.join(tmpDir, 'broken-topic.md'),
        `---
palee_schema: 1
palee_id: T-broken
title: Broken Topic
depends_on:
  - T-does-not-exist
---
# Broken
`,
        'utf8'
      );

      await validateCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.valid, false);
      assert.strictEqual(data.error_count, 1);
      assert.strictEqual(data.errors[0].type, 'missing_dependency');
      assert.strictEqual(process.exitCode, 3);
    });

    test('session list --json outputs confirmed sessions and active drafts', async () => {
      const sessDir = path.join(tmpDir, '.palee', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'S-20260814T120000.md'), '# Session 1');
      fs.writeFileSync(path.join(sessDir, 'DRAFT-S-20260814T120500.md'), '# Draft 1');

      await sessionCommand('list', { json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_confirmed, 1);
      assert.strictEqual(data.total_drafts, 1);
      assert.strictEqual(data.confirmed[0], 'S-20260814T120000.md');
      assert.strictEqual(data.drafts[0], 'DRAFT-S-20260814T120500.md');
    });
  });
});
