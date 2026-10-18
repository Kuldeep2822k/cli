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
import configCommand, { saveConfig, loadConfig } from '../src/cli/config';

describe('CLI Machine-Readable --json Output (Invariant INV-30)', () => {
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
      saveConfig({});
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
      assert.deepStrictEqual(data.quarantined_cycles, [], 'empty vault must report the quarantine fields too (#79 schema consistency)');
      assert.strictEqual(data.counts.due, 0);
      assert.strictEqual(data.counts.quarantined, 0);
    });

    test('plan --json reports the same keys for an empty vault as for a populated one', async () => {
      // The empty-vault response is a separate literal from the populated one,
      // and `blocked` / `counts.blocked` were added to only the latter — so a
      // client that reads the documented shape gets `undefined` exactly when the
      // vault is empty. Comparing the two key sets makes any future one-sided
      // addition fail here rather than in a consumer.
      await planCommand({ json: true });
      const empty = getLastParsedJson();

      fs.writeFileSync(
        path.join(tmpDir, 'one.md'),
        `---
palee_schema: 1
palee_id: T-shape-one
title: Shape One
difficulty: beginner
topic_mastery: 0
depends_on: []
---
# Shape One
`,
        'utf8'
      );
      await planCommand({ json: true });
      const populated = getLastParsedJson();

      assert.deepStrictEqual(
        Object.keys(empty).sort(),
        Object.keys(populated).sort(),
        'top-level keys must not diverge between the two response branches'
      );
      assert.deepStrictEqual(
        Object.keys(empty.counts).sort(),
        Object.keys(populated.counts).sort(),
        'counts keys must not diverge between the two response branches'
      );
      assert.deepStrictEqual(empty.blocked, []);
      assert.strictEqual(empty.counts.blocked, 0);
    });

    test('progress --json on empty vault produces valid JSON structure', async () => {
      await progressCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 0);
      assert.strictEqual(data.active_topic_count, 0);
      assert.strictEqual(data.archived_topic_count, 0);
      assert.strictEqual(data.global_mastery, null);
      assert.strictEqual(data.mastery_status, 'no_data');
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
due_at: 2020-01-01
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
due_at: 2099-01-01
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
      assert.strictEqual(data.active_topic_count, 2);
      assert.strictEqual(data.global_mastery, 0.5); // (0.8 + 0.2) / 2 = 0.5
      assert.strictEqual(data.mastery_status, 'learning');
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

    test('progress --json excludes archived topics from global_mastery and active_topic_count', async () => {
      const archivedPath = path.join(tmpDir, 'archived.md');
      fs.writeFileSync(
        archivedPath,
        `---
palee_id: T-archived
palee_schema: 1
title: Archived Topic
status: archived
topic_mastery: 0.0
difficulty: intermediate
depends_on: []
---
# Archived Topic
`,
        'utf8'
      );

      await progressCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 3);
      assert.strictEqual(data.active_topic_count, 2);
      assert.strictEqual(data.archived_topic_count, 1);
      assert.strictEqual(data.global_mastery, 0.5); // Still (0.8 + 0.2) / 2 = 0.5, unaffected by archived 0.0

      fs.unlinkSync(archivedPath);
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
      // Missing dependency is a warning since the #34 severity policy —
      // a duplicate ID is the pinned error fixture.
      fs.writeFileSync(
        path.join(tmpDir, 'dup-a.md'),
        `---
palee_schema: 1
palee_id: T-dup
title: Dup A
depends_on: []
---
# Dup A
`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'dup-b.md'),
        `---
palee_schema: 1
palee_id: T-dup
title: Dup B
depends_on: []
---
# Dup B
`,
        'utf8'
      );

      await validateCommand({ json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.valid, false);
      assert.strictEqual(data.error_count, 1);
      assert.strictEqual(data.errors[0].type, 'duplicate_id');
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

  describe('Cyclic Component Quarantine in Plan Output (#79)', () => {
    test('plan --json quarantines cyclic topics from ready list while acyclic topics keep working', async () => {
      // NOTE: runs against the Populated Vault beforeEach fixture (topic-1, topic-2 — acyclic).
      // Cyclic pair: T-cycle-a ↔ T-cycle-b
      fs.writeFileSync(
        path.join(tmpDir, 'cycle-a.md'),
        `---
palee_schema: 1
palee_id: T-cycle-a
title: Cycle A
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-cycle-b
---
# Cycle A
`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'cycle-b.md'),
        `---
palee_schema: 1
palee_id: T-cycle-b
title: Cycle B
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-cycle-a
---
# Cycle B
`,
        'utf8'
      );
      // Independent acyclic topic, unmastered and dependency-free → ready
      fs.writeFileSync(
        path.join(tmpDir, 'free.md'),
        `---
palee_schema: 1
palee_id: T-free
title: Free Standing Topic
difficulty: intermediate
topic_mastery: 0
depends_on: []
---
# Free
`,
        'utf8'
      );

      await planCommand({ json: true });
      const data = getLastParsedJson();

      // Acyclic component keeps working: T-free is in the ready list
      const readyIds = data.ready_to_learn.map((t: { id: string }) => t.id);
      assert.ok(readyIds.includes('T-free'), 'acyclic topic must remain ready to learn');
      assert.ok(!readyIds.includes('T-cycle-a'), 'cyclic topic must be quarantined from ready list');
      assert.ok(!readyIds.includes('T-cycle-b'), 'cyclic topic must be quarantined from ready list');

      // Cycle is reported with its exact canonicalized path
      assert.strictEqual(data.quarantined_cycles.length, 1);
      assert.deepStrictEqual(data.quarantined_cycles[0], ['T-cycle-a', 'T-cycle-b', 'T-cycle-a']);
      assert.strictEqual(data.counts.quarantined, 2);

      // Spec: plan continues on valid acyclic components — no error exit
      assert.strictEqual(process.exitCode, 0);
    });

    test('plan --json on acyclic vault reports empty quarantine (#79)', async () => {
      // Fresh vault with a single acyclic topic (independent of the cycle files
      // written by the sibling test — tmpDir is per-test via beforeEach).
      fs.writeFileSync(
        path.join(tmpDir, 'solo.md'),
        `---
palee_schema: 1
palee_id: T-solo
title: Solo Topic
difficulty: intermediate
topic_mastery: 0
depends_on: []
---
# Solo
`,
        'utf8'
      );

      await planCommand({ json: true });
      const data = getLastParsedJson();
      assert.deepStrictEqual(data.quarantined_cycles, []);
      assert.strictEqual(data.counts.quarantined, 0);
    });

    test('plan human mode prints the quarantine section with canonical paths (#79)', async () => {
      // The human-mode branch (Section 0) had no test: the cycle scenario only
      // invoked planCommand({ json: true }), so regressions in the human
      // cycle paths or the exclusion note would still pass the suite
      // (Copilot review). Vault: cyclic pair + an independent ready topic.
      fs.writeFileSync(
        path.join(tmpDir, 'cycle-a.md'),
        `---
palee_schema: 1
palee_id: T-cycle-a
title: Cycle A
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-cycle-b
---
# Cycle A
`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'cycle-b.md'),
        `---
palee_schema: 1
palee_id: T-cycle-b
title: Cycle B
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-cycle-a
---
# Cycle B
`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'free.md'),
        `---
palee_schema: 1
palee_id: T-free
title: Free Standing Topic
difficulty: intermediate
topic_mastery: 0
depends_on: []
---
# Free
`,
        'utf8'
      );

      await planCommand({});
      const humanOutput = loggedOutputs.join('\n');

      // Section 0: heading counts one cycle, not truncated.
      assert.ok(humanOutput.includes('Quarantined Cycles: 1'), 'human heading must report the cycle count');
      assert.ok(!humanOutput.includes('truncated'), 'single cycle must not claim truncation');
      // Exact canonicalized path in the quarantine warning line.
      assert.ok(
        humanOutput.includes('T-cycle-a → T-cycle-b → T-cycle-a'),
        'human output must print the canonicalized cycle path'
      );
      // Exclusion note present.
      assert.ok(
        humanOutput.includes('excluded from Ready to Learn'),
        'human output must carry the exclusion note'
      );
      // Ready-to-Learn section (heading `Ready to Learn: N`) keeps the
      // acyclic topic and drops the pair. The colon anchors on the section
      // heading, not the exclusion note above, which also says the phrase.
      const [readySection = ''] = (humanOutput.split('Ready to Learn: ')[1] ?? '').split('Progress Summary');
      assert.ok(readySection.includes('T-free'), 'ready list must keep the independent topic');
      assert.ok(!readySection.includes('T-cycle-a'), 'ready list must exclude the cyclic pair');
      assert.strictEqual(process.exitCode, 0, 'plan continues on valid acyclic components');
    });

    test('plan names what blocks a topic, distinguishing an unmet prereq from a dead one', async () => {
      // A topic with unmet prerequisites is simply absent from Ready to Learn,
      // which reads the same as "nothing to study"; a prerequisite id that no
      // longer resolves never becomes satisfiable at all, and `validate` only
      // warns. Both must be reported, and the dead one must say so.
      fs.writeFileSync(
        path.join(tmpDir, 'gated-behind-live.md'),
        `---
palee_schema: 1
palee_id: T-gated-live
title: Gated Behind Live
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-gatekeeper
---
# Gated
`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'gated-behind-dead.md'),
        `---
palee_schema: 1
palee_id: T-gated-dead
title: Gated Behind Dead
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-never-existed
---
# Gated Dead
`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'gatekeeper.md'),
        `---
palee_schema: 1
palee_id: T-gatekeeper
title: Gatekeeper
difficulty: beginner
topic_mastery: 0
depends_on: []
---
# Gatekeeper
`,
        'utf8'
      );

      await planCommand({});
      const human = loggedOutputs.join('\n');
      const [section = ''] = (human.split('Blocked by prerequisites: ')[1] ?? '').split('Progress Summary');

      assert.ok(section.includes('T-gated-live'), 'a topic behind an unmet prereq must be named');
      assert.ok(section.includes('needs 0.70'), 'the report must state the threshold it is waiting on');
      assert.ok(section.includes('T-gatekeeper'), 'the blocking prerequisite must be named');
      assert.ok(section.includes('T-gated-dead'), 'a topic behind a dead prereq must be named');
      assert.ok(
        section.includes('T-never-existed is not in the vault'),
        'an unresolvable prerequisite must be called out as missing, not as unmastered'
      );
      assert.ok(section.includes('palee validate'), 'the dead-prereq line must point at the fix');

      loggedOutputs.length = 0;
      await planCommand({ json: true });
      const data = getLastParsedJson();
      // The whole list, not a search for one entry: finding `T-gated-dead` passes
      // whether or not `T-gated-live` was reported, and whether or not the
      // available gatekeeper was wrongly included.
      const blocked = (data.blocked as { id: string; waiting_on: string[] }[])
        .map((b) => [b.id, b.waiting_on.join(' | ')] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));
      assert.deepStrictEqual(blocked, [
        ['T-gated-dead', 'T-never-existed is not in the vault (run palee validate)'],
        ['T-gated-live', 'Gatekeeper (T-gatekeeper) at mastery 0.0000, needs 0.70'],
      ]);
      assert.strictEqual(data.counts.blocked, 2, 'counts must agree with the list length');
      assert.deepStrictEqual(
        (data.ready_to_learn as { id: string }[]).map((t) => t.id),
        ['T-gatekeeper'],
        'the available prerequisite is ready, not blocked'
      );
    });
  });

  describe('Non-TTY (Piped/Redirected) Output Selection (#357)', () => {
    let prevPaleeJson: string | undefined;

    beforeEach(() => {
      // Piping/redirecting must NOT switch to JSON on its own anymore: JSON
      // requires the explicit --json flag or PALEE_JSON.
      prevPaleeJson = process.env.PALEE_JSON;
      delete process.env.PALEE_JSON;

      // Create a topic in tmpDir
      fs.writeFileSync(
        path.join(tmpDir, 'topic-tty.md'),
        `---
palee_schema: 1
palee_id: T-topic-tty
title: TTY Test Topic
difficulty: beginner
topic_mastery: 0.5
repetition: 1
lapses: 0
due_at: 2020-01-01
depends_on: []
---
# TTY
`,
        'utf8'
      );
    });

    afterEach(() => {
      if (prevPaleeJson !== undefined) {
        process.env.PALEE_JSON = prevPaleeJson;
      } else {
        delete process.env.PALEE_JSON;
      }
    });

    function allOutput(): string {
      const raw = loggedOutputs.join('\n');
      assert.ok(raw.trim(), 'Expected console.log output');
      return raw;
    }

    /** Human-readable reports are multi-line prose/tables, never a JSON document. */
    function assertHumanReadable(raw: string): void {
      assert.throws(
        () => JSON.parse(raw),
        'piped output without --json must stay human-readable, not JSON'
      );
    }

    test('next on non-TTY without --json keeps the human-readable report', async () => {
      await nextCommand({});
      const raw = allOutput();
      assertHumanReadable(raw);
      assert.match(raw, /Next topic due for review:/);
    });

    test('plan on non-TTY without --json keeps the human-readable report', async () => {
      await planCommand({});
      assertHumanReadable(allOutput());
    });

    test('progress on non-TTY without --json keeps the human-readable report', async () => {
      await progressCommand({});
      assertHumanReadable(allOutput());
    });

    test('dashboard on non-TTY without --json keeps the human-readable report', async () => {
      await dashboardCommand({});
      assertHumanReadable(allOutput());
    });

    test('validate on non-TTY without --json keeps the human-readable report', async () => {
      await validateCommand({});
      assertHumanReadable(allOutput());
    });

    test('session list on non-TTY without --json keeps the human-readable report', async () => {
      await sessionCommand('list', {});
      assertHumanReadable(allOutput());
    });

    test('PALEE_JSON=1 restores JSON output without --json flag', async () => {
      process.env.PALEE_JSON = '1';
      await nextCommand({});
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 1);
      assert.strictEqual(data.due_count, 1);
      assert.strictEqual(data.next.id, 'T-topic-tty');
    });

    test('PALEE_JSON=1 selects JSON for every remaining reading command', async () => {
      // The next/plan cases above cover two of the six; pin the other four so
      // env-var selection is not silently command-specific (#357). A parsed
      // object is truthy whatever it holds, so each case names a field: a
      // command that emitted unrelated JSON, or an empty document, fails here.
      process.env.PALEE_JSON = '1';
      await progressCommand({});
      assert.strictEqual(
        getLastParsedJson().total_topics,
        1,
        'progress emits its own JSON under PALEE_JSON'
      );
      await dashboardCommand({});
      assert.strictEqual(
        getLastParsedJson().total_topics,
        1,
        'dashboard emits its own JSON under PALEE_JSON'
      );
      await validateCommand({});
      assert.strictEqual(
        getLastParsedJson().topic_count,
        1,
        'validate emits its own JSON under PALEE_JSON'
      );
      await sessionCommand('list', {});
      const sessions = getLastParsedJson();
      assert.strictEqual(
        sessions.total_confirmed,
        0,
        'session list emits its own JSON under PALEE_JSON'
      );
      assert.ok(Array.isArray(sessions.drafts), 'the session document carries its draft list');
    });

    test('PALEE_JSON=true (case-insensitive) restores JSON output without --json flag', async () => {
      process.env.PALEE_JSON = 'TRUE';
      await planCommand({});
      const data = getLastParsedJson();
      assert.strictEqual(data.total_topics, 1);
      assert.strictEqual(data.counts.due, 1);
    });

    test("PALEE_JSON='false' keeps the human-readable report (only '1'/'true' opt in)", async () => {
      process.env.PALEE_JSON = 'false';
      await nextCommand({});
      const raw = allOutput();
      assertHumanReadable(raw);
      assert.match(raw, /Next topic due for review:/);
    });

    test("PALEE_JSON='0' keeps the human-readable report (only '1'/'true' opt in)", async () => {
      process.env.PALEE_JSON = '0';
      await planCommand({});
      assertHumanReadable(allOutput());
    });
  });

  describe('Every JSON Arm Answers JSON (#45 residual gaps)', () => {
    let prevPaleeJson: string | undefined;

    beforeEach(() => {
      prevPaleeJson = process.env.PALEE_JSON;
      delete process.env.PALEE_JSON;
      fs.writeFileSync(
        path.join(tmpDir, 'topic-json.md'),
        `---
palee_schema: 1
palee_id: T-topic-json
title: JSON Fixture Topic
difficulty: beginner
topic_mastery: 0.6
repetition: 2
lapses: 0
due_at: 2020-01-01
depends_on: []
---
# JSON Fixture
`,
        'utf8'
      );
    });

    afterEach(() => {
      if (prevPaleeJson !== undefined) {
        process.env.PALEE_JSON = prevPaleeJson;
      } else {
        delete process.env.PALEE_JSON;
      }
    });

    /** Nothing on stdout may be prose once JSON is selected — not a banner, not a notice. */
    function assertStdoutIsDocumentsOnly(): void {
      for (const line of loggedOutputs) {
        assert.ok(
          !/^Building working memory|^=== PALEE Session|^Working Memory|^✓ |^ {2}Path:/u.test(line),
          `stdout carries a prose line under JSON mode: ${line.slice(0, 50)}`
        );
        JSON.parse(line);
      }
    }

    test('config set-vault answers one document and the write really lands', async () => {
      await configCommand('set-vault', tmpDir, { json: true });
      assert.strictEqual(process.exitCode, 0);
      assert.strictEqual(loggedOutputs.length, 1, 'exactly one document on stdout');
      const data = getLastParsedJson();
      assert.strictEqual(data.status, 'set');
      assert.strictEqual(data.vault_path, path.resolve(tmpDir));
      assert.strictEqual(loadConfig().vaultPath, path.resolve(tmpDir), 'the document agrees with the disk');
    });

    test('config set-provider, set-model and unset-api-key each answer one document', async () => {
      await configCommand('set-provider', 'ollama', { json: true });
      assert.strictEqual(getLastParsedJson().ai_provider, 'ollama');
      await configCommand('set-model', 'llama3', { json: true });
      assert.strictEqual(getLastParsedJson().model, 'llama3');
      await configCommand('unset-api-key', undefined, { json: true });
      const data = getLastParsedJson();
      assert.strictEqual(data.status, 'absent', 'nothing was stored, so the removal is reported as absent');
      assert.strictEqual(data.api_key_set, false);
      assertStdoutIsDocumentsOnly();
    });

    test('the human arm of a config write still prints its original sentence', async () => {
      await configCommand('set-model', 'llama3', {});
      assert.deepStrictEqual(loggedOutputs, ['Model set to: llama3']);
    });

    test('a refused config action answers {error, valid_actions} on stderr only', async () => {
      await configCommand('bogus', undefined, { json: true });
      assert.strictEqual(process.exitCode, 2);
      assert.strictEqual(loggedOutputs.length, 0, 'a refusal never writes a document to stdout');
      const data = getLastParsedJsonError();
      assert.match(data.error, /unknown action 'bogus'/u);
      assert.ok(data.valid_actions.includes('set-api-key'), 'the guidance line becomes a field');
    });

    test('set-api-key given a literal is refused as one object and never echoes the key', async () => {
      await configCommand('set-api-key', 'sk-must-not-appear', { json: true });
      assert.strictEqual(process.exitCode, 2);
      const data = getLastParsedJsonError();
      assert.strictEqual(Object.keys(data).join(','), 'error,remedy', 'the two-line refusal travels as one object');
      const spoken = loggedErrors.join('\n') + loggedOutputs.join('\n');
      assert.ok(!spoken.includes('sk-must-not-appear'), 'a credential must never reach output');
      assert.strictEqual(loadConfig().apiKey, undefined, 'and nothing was stored');
    });

    test('session start answers one document and suppresses the rebuild notice', async () => {
      await sessionCommand('start', { topic: 'T-topic-json', json: true });
      assert.strictEqual(process.exitCode, 0);
      assert.strictEqual(loggedOutputs.length, 1, 'the hot.md rebuild notice has no place on stdout');
      const data = getLastParsedJson();
      assert.strictEqual(data.status, 'started');
      assert.strictEqual(data.active_topic, 'T-topic-json');
      assert.strictEqual(typeof data.working_memory, 'string');
      assert.deepStrictEqual(data.warnings, []);
      assert.strictEqual(data.vault_path, path.resolve(tmpDir), 'the write names its vault as fields');
    });

    test('a second start reports the already-active heads-up inside the document', async () => {
      await sessionCommand('start', { topic: 'T-topic-json', json: true });
      loggedOutputs = [];
      loggedErrors = [];
      await sessionCommand('start', { json: true });
      assert.strictEqual(process.exitCode, 0, 'the heads-up does not change the exit code');
      assert.strictEqual(loggedOutputs.length, 1);
      const data = getLastParsedJson();
      assert.strictEqual(data.warnings.length, 1, 'the warning travels as a field, not a stderr line');
      assert.match(data.warnings[0], /already active for T-topic-json/u);
    });

    test('session draft and end report consumed drafts inside the document, not as lines', async () => {
      await sessionCommand('start', { topic: 'T-topic-json', json: true });
      await sessionCommand('draft', { json: true });
      const draft = getLastParsedJson();
      assert.strictEqual(draft.status, 'drafted');
      assert.strictEqual(draft.topic_id, 'T-topic-json');
      assert.match(draft.draft_id, /^DRAFT-S-/u);

      loggedOutputs = [];
      await sessionCommand('end', { json: true });
      assert.strictEqual(process.exitCode, 0);
      assert.strictEqual(loggedOutputs.length, 1, 'each consumed draft is a field, never a preceding line');
      const end = getLastParsedJson();
      assert.strictEqual(end.status, 'recorded');
      assert.deepStrictEqual(end.consumed_drafts, [path.basename(draft.draft_path)]);
      assert.strictEqual(end.draft_cleanup_failures, 0);
      assert.strictEqual(end.topic_id, 'T-topic-json');
      assert.strictEqual(typeof end.duration_minutes, 'number');
      assertStdoutIsDocumentsOnly();
    });

    test('an unknown session action answers {error, valid_actions}', async () => {
      await sessionCommand('bogus', { json: true });
      assert.strictEqual(process.exitCode, 2);
      assert.strictEqual(loggedOutputs.length, 0);
      const data = getLastParsedJsonError();
      assert.match(data.error, /Unknown session action: 'bogus'/u);
      assert.deepStrictEqual(data.valid_actions, ['start', 'end', 'draft', 'list']);
    });

    test('PALEE_JSON=1 selects the same documents as the flag', async () => {
      process.env.PALEE_JSON = '1';
      await configCommand('set-model', 'gpt-4', {});
      assert.strictEqual(getLastParsedJson().status, 'set');
      loggedOutputs = [];
      await sessionCommand('start', { topic: 'T-topic-json' });
      assert.strictEqual(loggedOutputs.length, 1);
      assert.strictEqual(getLastParsedJson().status, 'started');
    });
  });
});
