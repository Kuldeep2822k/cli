import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { nextCommand } from '../src/cli/next';
import { planCommand } from '../src/cli/plan';
import { dashboardCommand } from '../src/cli/dashboard';
import { saveConfig } from '../src/cli/config';

/**
 * #305 / #306 / #307 — one prerequisite gate across `next`, `plan` and `dashboard`.
 *
 * `plan` computed the readiness gate (`areDependenciesSatisfied`, threshold
 * `MASTERY_THRESHOLD`) while `next` ignored it, so the two commands gave a
 * learner opposite answers about the same note — both at exit 0. That
 * contradicts the gating semantics of INV-24 (a blocked dependency blocks) and
 * INV-47 (a gating edge keeps a dependent off the ready list until its
 * predecessor is mastered): README states "Never study topics before
 * prerequisites", and `next` is the command a learner obeys.
 *
 * `plan` also listed the same note under both "Reviews Due" and "Blocked by
 * prerequisites" (#306), double-counting it, and `dashboard` reported
 * `next_review: null` in the same breath as `Run "palee next" to start
 * reviewing` (#307 residue).
 */
describe('prerequisite gating is consistent across next/plan/dashboard (#305, #306, #307)', () => {
  let tmpDir: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let loggedOutputs: string[] = [];
  const originalLog = console.log;
  const originalIsTTY = process.stdout.isTTY;

  function asTTY() {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  }

  function restoreTTY() {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-gate-'));
    tmpConfigDir = path.join(tmpDir, '.config');
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tmpConfigDir;
    saveConfig({ vaultPath: tmpDir });
    loggedOutputs = [];
    console.log = (...args: unknown[]) => {
      loggedOutputs.push(args.map((a) => String(a)).join(' '));
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    process.exitCode = 0;
    restoreTTY();
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function lastJson(): any {
    const raw = loggedOutputs[loggedOutputs.length - 1];
    assert.ok(raw, 'expected at least one console.log output');
    return JSON.parse(raw);
  }

  function allOutput(): string {
    return loggedOutputs.join('\n');
  }

  function writeNote(name: string, frontmatter: string, body = `# ${name}`) {
    fs.writeFileSync(path.join(tmpDir, name), `---\npalee_schema: 1\n${frontmatter}---\n${body}\n`, 'utf8');
  }

  /**
   * The issue's own fixture: one edge, both notes unassessed (mastery 0.0000),
   * nothing scheduled yet, so both are actionable by due status alone.
   */
  function seedBlockedChildVault() {
    writeNote(
      'one.md',
      `palee_id: T-aa
title: BlockedChild
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-bb
`
    );
    writeNote(
      'two.md',
      `palee_id: T-bb
title: RootPrereq
difficulty: beginner
topic_mastery: 0
depends_on: []
`
    );
  }

  // ─── #305: `next` must not hand the learner a gated topic ───────────────────

  describe('next gates on prerequisites (#305)', () => {
    beforeEach(seedBlockedChildVault);

    test('next recommends the unblocked topic instead of the blocked one', async () => {
      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      const text = allOutput();
      assert.match(text, /Next topic due for review:/, 'a ready topic exists, so the normal header must print');
      assert.ok(text.includes('RootPrereq'), 'next must name the topic with no prerequisites');
      const named = text.split('Next topic due for review:')[1] ?? '';
      assert.ok(
        !/\bID:\s*T-aa\b/.test(named),
        'next must not recommend T-aa, which plan reports as blocked behind T-bb'
      );
      assert.strictEqual(process.exitCode, 0);
    });

    test('next --json excludes the blocked topic from due_count and names it in `blocked`', async () => {
      await nextCommand({ json: true });
      const data = lastJson();
      assert.strictEqual(data.next.id, 'T-bb', 'the recommendation must be the unblocked topic');
      assert.strictEqual(data.due_count, 1, 'only the unblocked topic may count as due');
      assert.strictEqual(data.total_topics, 2);
      assert.strictEqual(data.status, 'ready', 'next --json must carry the gating state as a field');
      assert.deepStrictEqual(data.blocked.map((b: any) => b.id), ['T-aa']);
      assert.match(
        data.blocked[0].waiting_on[0],
        /RootPrereq \(T-bb\) at mastery 0\.0000, needs 0\.70/,
        'the blocked entry must name the prerequisite with its mastery against the threshold'
      );
    });

    test('next --all --json keeps the never-reviewed-first ordering inside the ready set', async () => {
      writeNote(
        'three.md',
        `palee_id: T-old
title: OldReview
difficulty: beginner
topic_mastery: 0.4
due_at: 2020-01-01
depends_on: []
`
      );
      await nextCommand({ all: true, json: true });
      const data = lastJson();
      assert.deepStrictEqual(
        data.due_topics.map((t: any) => t.id),
        ['T-bb', 'T-old'],
        'never-reviewed topics still sort ahead of elapsed reviews once the gate is applied'
      );
      assert.deepStrictEqual(data.blocked.map((b: any) => b.id), ['T-aa']);
      assert.strictEqual(data.next.id, 'T-bb');
    });

    test('next warns in human mode when a due topic was gated away', async () => {
      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      assert.match(
        allOutput(),
        /⚠ 1 due topic is waiting on a prerequisite/,
        'a learner who knows about T-aa must be told why it is not the recommendation'
      );
    });

    test('next --json and next --all --json expose the same gating keys', async () => {
      await nextCommand({ json: true });
      const single = Object.keys(lastJson()).sort();
      await nextCommand({ all: true, json: true });
      const all = Object.keys(lastJson()).sort();
      for (const key of ['status', 'blocked', 'total_topics', 'next']) {
        assert.ok(single.includes(key), `next --json must expose "${key}"`);
        assert.ok(all.includes(key), `next --all --json must expose "${key}"`);
      }
    });
  });

  // ─── #305: nothing ready — say so, and name the blocker ─────────────────────

  describe('next when gating leaves nothing actionable (#305)', () => {
    beforeEach(() => {
      // The only due note is gated; its prerequisite is scheduled far in the
      // future, so it is not actionable either.
      writeNote(
        'one.md',
        `palee_id: T-aa
title: BlockedChild
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-bb
`
      );
      writeNote(
        'two.md',
        `palee_id: T-bb
title: RootPrereq
difficulty: beginner
topic_mastery: 0
due_at: 2099-01-01
depends_on: []
`
      );
    });

    test('human output states that nothing is ready and names the blocking prerequisite', async () => {
      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      const text = allOutput();
      assert.match(
        text,
        /Nothing to review — every due topic is blocked by prerequisites:/,
        'next must say the queue is empty because of gating, not pretend nothing is due'
      );
      assert.doesNotMatch(text, /Next topic due for review:/, 'no topic may be recommended');
      assert.doesNotMatch(
        text,
        /No topics due for review\./,
        'the "nothing scheduled" message would be a lie — T-aa is due, it is just gated'
      );
      assert.ok(
        text.includes('waiting on RootPrereq (T-bb) at mastery 0.0000, needs 0.70'),
        'the message must name the prerequisite, its mastery and the threshold'
      );
      assert.strictEqual(process.exitCode, 0, 'a gated vault is a recoverable read state, not an error');
    });

    test('--json reports status "blocked" with next null and the blocker details', async () => {
      await nextCommand({ json: true });
      const data = lastJson();
      assert.strictEqual(data.status, 'blocked');
      assert.strictEqual(data.next, null);
      assert.strictEqual(data.due_count, 0);
      assert.strictEqual(data.total_topics, 2);
      assert.deepStrictEqual(data.blocked.map((b: any) => b.id), ['T-aa']);
      assert.match(data.blocked[0].waiting_on[0], /RootPrereq \(T-bb\) at mastery 0\.0000, needs 0\.70/);
      assert.strictEqual(process.exitCode, 0);
    });

    test('an unscheduled vault still reports the plain "no topics due" state', async () => {
      writeNote(
        'future.md',
        `palee_id: T-later
title: FutureOnly
difficulty: beginner
topic_mastery: 0.2
due_at: 2099-01-01
depends_on: []
`
      );
      fs.unlinkSync(path.join(tmpDir, 'one.md'));
      await nextCommand({ json: true });
      const data = lastJson();
      assert.strictEqual(data.status, 'nothing_due');
      assert.deepStrictEqual(data.blocked, []);
      assert.strictEqual(data.next, null);

      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      assert.match(allOutput(), /No topics due for review\./);
    });

    test('a dangling prerequisite is reported as missing, not as mastery 0 (INV-24)', async () => {
      fs.unlinkSync(path.join(tmpDir, 'two.md'));
      await nextCommand({ json: true });
      const data = lastJson();
      assert.strictEqual(data.status, 'blocked');
      assert.match(data.blocked[0].waiting_on[0], /T-bb is not in the vault \(run palee validate\)/);
    });

    test('a long gated queue is truncated with a count, like plan truncates its blocked list', async () => {
      for (const id of ['T-c', 'T-d', 'T-e', 'T-f', 'T-g']) {
        writeNote(
          `${id}.md`,
          `palee_id: ${id}
title: Child ${id}
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-bb
`
        );
      }
      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      const text = allOutput();
      assert.match(text, /Nothing to review — every due topic is blocked by prerequisites:/);
      const bulletLines = text.split('\n').filter((line) => line.trimStart().startsWith('• '));
      assert.strictEqual(
        bulletLines.length,
        5,
        'the gated queue prints at most five blockers, matching plan\'s blocked section'
      );
      assert.match(text, /\.\.\. and 1 more/);
    });

    test('the trailing warning agrees on the withheld count in both singular and plural', async () => {
      // Make the prerequisite itself actionable so the queue is not empty, which
      // is the branch that appends the warning instead of the blocked report.
      fs.writeFileSync(path.join(tmpDir, 'two.md'), `---
palee_schema: 1
palee_id: T-bb
title: RootPrereq
difficulty: beginner
topic_mastery: 0
depends_on: []
---
# RootPrereq
`, 'utf8');
      writeNote(
        'child-c.md',
        `palee_id: T-c
title: ChildC
difficulty: beginner
topic_mastery: 0
depends_on:
  - T-bb
`
      );
      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      assert.match(allOutput(), /⚠ 2 due topics are waiting on prerequisites — see: palee plan/);

      fs.unlinkSync(path.join(tmpDir, 'child-c.md'));
      loggedOutputs = [];
      asTTY();
      try {
        await nextCommand({});
      } finally {
        restoreTTY();
      }
      assert.match(allOutput(), /⚠ 1 due topic is waiting on a prerequisite — see: palee plan/);
    });
  });

  // ─── the gate is about study order, not about re-reviewing what is learned ──

  describe('next only gates unmastered topics', () => {
    test('a mastered, due topic with an unmastered prerequisite is still recommended', async () => {
      // Reviewing an already-mastered note breaks no prerequisite ordering, and
      // `plan` deliberately keeps such a note out of the blocked list — the two
      // commands must agree.
      writeNote(
        'done.md',
        `palee_id: T-done
title: MasteredButDue
difficulty: beginner
topic_mastery: 0.9
due_at: 2020-01-01
depends_on:
  - T-weak
`
      );
      writeNote(
        'weak.md',
        `palee_id: T-weak
title: WeakPrereq
difficulty: beginner
topic_mastery: 0.1
due_at: 2099-01-01
depends_on: []
`
      );
      await nextCommand({ json: true });
      const data = lastJson();
      assert.strictEqual(data.next.id, 'T-done', 'an already-mastered review is never prerequisite-blocked');
      assert.deepStrictEqual(data.blocked, []);

      await planCommand({ json: true });
      const plan = lastJson();
      assert.deepStrictEqual(
        plan.reviews_due.map((t: any) => t.id),
        ['T-done'],
        'plan must keep the same note in Reviews Due'
      );
      assert.deepStrictEqual(plan.blocked, []);
    });
  });

  // ─── #306: plan must not list one note twice ────────────────────────────────

  describe('plan lists a blocked note once (#306)', () => {
    beforeEach(seedBlockedChildVault);

    test('--json puts the gated note only in `blocked` and stops double-counting it', async () => {
      await planCommand({ json: true });
      const data = lastJson();
      assert.deepStrictEqual(
        data.reviews_due.map((t: any) => t.id),
        ['T-bb'],
        'Reviews Due must contain only topics that are actually reviewable'
      );
      assert.deepStrictEqual(data.blocked.map((b: any) => b.id), ['T-aa']);
      assert.strictEqual(data.counts.due, 1, 'counts.due must not include a blocked topic');
      assert.strictEqual(data.counts.blocked, 1);
      assert.strictEqual(data.counts.due, data.reviews_due.length);
      const dueIds = new Set(data.reviews_due.map((t: any) => t.id));
      for (const b of data.blocked) {
        assert.ok(!dueIds.has(b.id), `topic ${b.id} must not appear in both reviews_due and blocked`);
      }
    });

    test('human output prints "Reviews Due: 1" and names the blocked note exactly once', async () => {
      asTTY();
      try {
        await planCommand({});
      } finally {
        restoreTTY();
      }
      const text = allOutput();
      assert.match(text, /Reviews Due: 1\n/);
      assert.match(text, /Blocked by prerequisites: 1/);
      const occurrences = text.split('BlockedChild').length - 1;
      assert.strictEqual(occurrences, 1, 'one note must be reported in exactly one section');
      assert.match(text, /• RootPrereq \(T-bb\) - Due: Never reviewed/);
      assert.doesNotMatch(text, /• BlockedChild \(T-aa\) - Due:/);
    });

    test('next and plan agree on the reviewable set', async () => {
      await planCommand({ json: true });
      const plan = lastJson();
      await nextCommand({ all: true, json: true });
      const next = lastJson();
      assert.deepStrictEqual(
        plan.reviews_due.map((t: any) => t.id).sort(),
        next.due_topics.map((t: any) => t.id).sort(),
        'the two read models must expose the same actionable set (#305 class of bug)'
      );
      assert.deepStrictEqual(
        plan.reviews_due.map((t: any) => t.id),
        ['T-bb'],
        'and that shared set must be the reviewable one, not the gated note plus it'
      );
    });
  });

  // ─── #307 residue: dashboard pointed at a command it claimed had nothing ────

  describe('dashboard next_review draws from the gated actionable set (#307)', () => {
    beforeEach(seedBlockedChildVault);

    test('--json names the same topic next names, while the backlog metric stays 0', async () => {
      await dashboardCommand({ json: true });
      const dash = lastJson();
      await nextCommand({ json: true });
      const next = lastJson();
      assert.ok(dash.next_review, 'freshly adopted vault must not report next_review: null');
      assert.strictEqual(dash.next_review.id, next.next.id);
      assert.strictEqual(dash.next_review.id, 'T-bb', 'a gated topic must not become the next review');
      assert.strictEqual(
        dash.reviews_due,
        0,
        'the deliberate review-backlog metric counts elapsed scheduled reviews only'
      );
      assert.strictEqual(process.exitCode, 0);
    });

    test('human output prints a Next Review section next to its own "run palee next" prompt', async () => {
      asTTY();
      try {
        await dashboardCommand({});
      } finally {
        restoreTTY();
      }
      const text = allOutput();
      assert.match(text, /Next Review:/);
      assert.match(text, /RootPrereq \(T-bb\)/);
      assert.match(text, /Run "palee next" to start reviewing/);
      assert.doesNotMatch(text, /BlockedChild/, 'the gated note must not be presented as the next review');
    });

    test('next_review keeps the never-reviewed-first order `next` uses, and the backlog still counts elapsed reviews', async () => {
      writeNote(
        'old.md',
        `palee_id: T-old
title: OldReview
difficulty: beginner
topic_mastery: 0.4
due_at: 2020-01-01
depends_on: []
`
      );
      await dashboardCommand({ json: true });
      const dash = lastJson();
      await nextCommand({ json: true });
      const next = lastJson();
      assert.strictEqual(dash.reviews_due, 1, 'the backlog metric still counts the elapsed review');
      assert.strictEqual(dash.next_review.id, next.next.id, 'dashboard must name the review `next` names');
      assert.strictEqual(dash.next_review.id, 'T-bb', 'never-reviewed topics lead, exactly as in `next`');
      assert.strictEqual(dash.next_review.due_at, null);
    });

    test('among elapsed reviews only, the oldest still leads', async () => {
      fs.unlinkSync(path.join(tmpDir, 'one.md'));
      fs.unlinkSync(path.join(tmpDir, 'two.md'));
      writeNote(
        'a.md',
        `palee_id: T-a
title: NewerReview
difficulty: beginner
topic_mastery: 0.4
due_at: 2020-01-01
depends_on: []
`
      );
      writeNote(
        'b.md',
        `palee_id: T-b
title: OldestReview
difficulty: beginner
topic_mastery: 0.4
due_at: 2015-06-01
depends_on: []
`
      );
      await dashboardCommand({ json: true });
      const dash = lastJson();
      assert.strictEqual(dash.reviews_due, 2);
      assert.strictEqual(dash.next_review.id, 'T-b', 'the oldest scheduled review still wins the slot');
    });
  });
});
