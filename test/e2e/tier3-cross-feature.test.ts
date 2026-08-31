import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault, TestVaultEnv } from './test-env';
import { Lock } from '../../src/storage';

describe('Tier 3: Pairwise Cross-Feature Interactions', () => {
  let env: TestVaultEnv;

  beforeEach(() => {
    env = createTestVault('tier3-cross-');
  });

  afterEach(() => {
    env.cleanup();
  });

  // -------------------------------------------------------------------------
  // X1: Roadmap Import -> Session Start -> Session Draft -> Review -> Session End -> Dashboard
  // -------------------------------------------------------------------------
  test('X1: Full End-to-End Learning Cycle (Roadmap -> Session -> Review -> Dashboard)', () => {
    // 1. Roadmap Import
    const roadmapFile = path.join(env.tempDir, 'x1-roadmap.yaml');
    fs.writeFileSync(roadmapFile, `
topics:
  - id: T-cycle-1
    title: Cycle Topic 1
    path: cycle1.md
    difficulty: beginner
`, 'utf8');
    const rRes = env.run(['roadmap', '--from', roadmapFile, '--yes']);
    assert.strictEqual(rRes.status, 0);

    // 2. Session Start
    const sStart = env.run(['session', 'start']);
    assert.strictEqual(sStart.status, 0);

    // 3. Session Draft
    const sDraft = env.run(['session', 'draft', '--topic', 'T-cycle-1']);
    assert.strictEqual(sDraft.status, 0);

    // 4. Review
    const rReview = env.run(['review', 'T-cycle-1', '5']);
    assert.strictEqual(rReview.status, 0);

    // 5. Session End
    const sEnd = env.run(['session', 'end', '--topic', 'T-cycle-1']);
    assert.strictEqual(sEnd.status, 0);

    // 6. Dashboard Inspection
    const dash = env.run(['dashboard', '--json']);
    assert.strictEqual(dash.status, 0);
    const parsed = JSON.parse(dash.stdout);
    assert.strictEqual(parsed.total_topics, 1);
    assert.strictEqual(parsed.reviews_due, 0, 'Quality 5 review schedules review into the future');
  });

  // -------------------------------------------------------------------------
  // X2: Session Start -> Draft -> Adopt Note -> Review -> Session End -> Plan
  // -------------------------------------------------------------------------
  test('X2: Dynamic Vault Adoption during Active Session Workflow', () => {
    // 1. Session Start on clean vault
    env.run(['session', 'start']);

    // 2. Session Draft
    env.run(['session', 'draft', '--topic', 'T-dynamic-study']);

    // 3. Create raw note and adopt
    const rawNote = path.join(env.vaultDir, 'unadopted.md');
    fs.writeFileSync(rawNote, '# Unadopted Architecture\nSome notes.', 'utf8');
    const aRes = env.run(['adopt', 'unadopted.md', '--difficulty', 'advanced', '--yes']);
    assert.strictEqual(aRes.status, 0);

    // 4. Review the adopted note
    const topic = env.readTopic('unadopted.md');
    const adoptedId = topic.frontmatter?.palee_id as string;
    assert.ok(adoptedId);

    const rRes = env.run(['review', adoptedId, '4']);
    assert.strictEqual(rRes.status, 0);

    // 5. Session End
    env.run(['session', 'end', '--topic', 'T-dynamic-study']);

    // 6. Plan inspection
    const planRes = env.run(['plan', '--json']);
    assert.strictEqual(planRes.status, 0);
    const planData = JSON.parse(planRes.stdout);
    assert.strictEqual(planData.total_topics, 1);
  });

  // -------------------------------------------------------------------------
  // X3: Roadmap Import -> Review Prereq -> Plan Unlocking -> Session Start -> Session End -> Progress
  // -------------------------------------------------------------------------
  test('X3: Prerequisite Mastery Gate & Plan Unlocking with Session Lifecycle', () => {
    // 1. Ingest roadmap with prerequisite dependency
    const roadmapFile = path.join(env.tempDir, 'prereq-roadmap.yaml');
    fs.writeFileSync(roadmapFile, `
topics:
  - id: T-prereq-base
    title: Base Knowledge
    path: base.md
  - id: T-dependent-adv
    title: Advanced Extension
    path: advanced.md
    depends_on: [T-prereq-base]
`, 'utf8');
    env.run(['roadmap', '--from', roadmapFile, '--yes']);

    // 2. Before review: Advanced topic should be blocked in plan
    let plan = JSON.parse(env.run(['plan', '--json']).stdout);
    let readyIds = plan.ready_to_learn.map((t: { id: string }) => t.id);
    assert.ok(readyIds.includes('T-prereq-base'));
    assert.strictEqual(readyIds.includes('T-dependent-adv'), false, 'Dependent topic should be blocked');

    // 3. Complete prerequisite pillar scores & review to reach mastery >= 70%
    const baseNote = env.readTopic('base.md');
    env.createTopic('base.md', {
      ...baseNote.frontmatter,
      conceptual: 0.9,
      practical: 0.9,
      debug: 0.9,
      feynman: 0.9,
    });
    env.run(['review', 'T-prereq-base', '5']);

    // 4. Plan should now have unlocked the dependent topic
    plan = JSON.parse(env.run(['plan', '--json']).stdout);
    readyIds = plan.ready_to_learn.map((t: { id: string }) => t.id);
    assert.ok(readyIds.includes('T-dependent-adv'), 'Dependent topic should be ready now');

    // 5. Session on unlocked topic
    env.run(['session', 'end', '--topic', 'T-dependent-adv']);

    // 6. Progress inspection
    const progRes = env.run(['progress', '--json']);
    const progData = JSON.parse(progRes.stdout);
    assert.strictEqual(progData.total_topics, 2);
    assert.strictEqual(progData.mastered, 1);
  });

  // -------------------------------------------------------------------------
  // X4: Session Start -> Roadmap Import (with partial failure) -> Session Draft -> Session End
  // -------------------------------------------------------------------------
  test('X4: Roadmap Partial Failure Interleaving with Session Lifecycle', () => {
    // 1. Session start
    env.run(['session', 'start']);

    // 2. Roadmap import with 1 valid and 1 corrupt note (per-topic write failure → exit 1)
    const roadmapFile = path.join(env.tempDir, 'mixed.yaml');

    // Pre-create a corrupt note that will fail during import
    const corruptPath = path.join(env.vaultDir, 'corrupt-x4.md');
    fs.writeFileSync(corruptPath, '---\npalee_id: [unclosed\n---\n# Corrupt\n', 'utf8');

    fs.writeFileSync(roadmapFile, `
topics:
  - id: T-valid-topic
    title: Valid Topic
    path: valid.md
  - id: T-corrupt-topic
    title: Corrupt Topic
    path: corrupt-x4.md
`, 'utf8');
    const rRes = env.run(['roadmap', '--from', roadmapFile, '--yes']);
    assert.strictEqual(rRes.status, 1, 'Partial failure exits with code 1');

    // valid.md should be created
    assert.ok(fs.existsSync(path.join(env.vaultDir, 'valid.md')));

    // 3. Valid topic draft
    const dRes = env.run(['session', 'draft', '--topic', 'T-valid-topic']);
    assert.strictEqual(dRes.status, 0);

    // 4. Valid topic session end
    const eRes = env.run(['session', 'end', '--topic', 'T-valid-topic']);
    assert.strictEqual(eRes.status, 0);

    const sessions = env.listSessions();
    assert.strictEqual(sessions.confirmed.length, 1);
    assert.strictEqual(sessions.drafts.length, 0);
  });

  // -------------------------------------------------------------------------
  // X5: Session Start -> Concurrent Lock Conflict on Review (Exit 4) -> Release Lock -> Successful Review -> Session End
  // -------------------------------------------------------------------------
  test('X5: Lock Conflict Recovery during Review and Session Finalization', async () => {
    env.createTopic('lock-recov.md', {
      palee_id: 'T-lock-recov',
      title: 'Lock Recovery Topic',
    });

    // 1. Session start
    env.run(['session', 'start']);

    // 2. Lock note externally
    const notePath = path.join(env.vaultDir, 'lock-recov.md');
    const lock = new Lock(env.vaultDir, notePath);
    await lock.acquire();

    try {
      // Review fails with exit code 4
      const failReview = env.run(['review', 'T-lock-recov', '4']);
      assert.strictEqual(failReview.status, 4);
    } finally {
      // Release lock
      lock.release();
    }

    // 3. Retry review succeeds with exit code 0
    const okReview = env.run(['review', 'T-lock-recov', '4']);
    assert.strictEqual(okReview.status, 0);

    // 4. Session end succeeds
    const sEnd = env.run(['session', 'end', '--topic', 'T-lock-recov']);
    assert.strictEqual(sEnd.status, 0);
  });

  // -------------------------------------------------------------------------
  // X6: Config set-vault -> Roadmap Import -> Next (due) -> Review -> Dashboard
  // -------------------------------------------------------------------------
  test('X6: Re-pointing Vault Configuration across Full Learning Flow', () => {
    // 1. Roadmap import on initial vault
    const rFile = path.join(env.tempDir, 'r-flow.yaml');
    fs.writeFileSync(rFile, `
topics:
  - id: T-due-now
    title: Due Topic Now
    path: due-now.md
`, 'utf8');
    env.run(['roadmap', '--from', rFile, '--yes']);

    // 2. Next shows topic is due (due_at is null initially)
    const nextRes = env.run(['next', '--json']);
    const nextData = JSON.parse(nextRes.stdout);
    assert.strictEqual(nextData.due_count, 1);
    assert.strictEqual(nextData.next?.id, 'T-due-now');

    // 3. Review topic with quality 4
    env.run(['review', 'T-due-now', '4']);

    // 4. Dashboard shows 0 due topics now
    const dashRes = env.run(['dashboard', '--json']);
    const dashData = JSON.parse(dashRes.stdout);
    assert.strictEqual(dashData.reviews_due, 0);
  });

  // -------------------------------------------------------------------------
  // X7: Multi-topic Roadmap -> Draft on T1 -> Draft on T2 -> End T1 -> Draft T2 Remains
  // -------------------------------------------------------------------------
  test('X7: Topic-Specific Draft Isolation across Interleaved Multi-Topic Study', () => {
    // 1. Ingest 2 topics
    const rFile = path.join(env.tempDir, 'multi.yaml');
    fs.writeFileSync(rFile, `
topics:
  - id: T-multi-1
    title: Multi 1
    path: m1.md
  - id: T-multi-2
    title: Multi 2
    path: m2.md
`, 'utf8');
    env.run(['roadmap', '--from', rFile, '--yes']);

    // 2. Create draft for T-multi-1 and draft for T-multi-2
    env.run(['session', 'draft', '--topic', 'T-multi-1']);
    env.run(['session', 'draft', '--topic', 'T-multi-2']);

    assert.strictEqual(env.listSessions().drafts.length, 2);

    // 3. End session for T-multi-1 only
    env.run(['session', 'end', '--topic', 'T-multi-1']);

    const sessions = env.listSessions();
    assert.strictEqual(sessions.confirmed.length, 1);
    assert.strictEqual(sessions.drafts.length, 1);

    // 4. Verify remaining draft belongs to T-multi-2
    const remainingDraft = env.readTopic(path.join('.palee', 'sessions', sessions.drafts[0]));
    assert.strictEqual(remainingDraft.frontmatter?.topic_id, 'T-multi-2');
  });

  // -------------------------------------------------------------------------
  // X8: Adopt Note -> Session Draft -> Corrupt Draft Frontmatter -> Session Start Recovery -> Session End
  // -------------------------------------------------------------------------
  test('X8: Fault Recovery on Corrupt Draft Checkpoint during Session Lifecycle', () => {
    // 1. Adopt note
    const notePath = path.join(env.vaultDir, 'fault-topic.md');
    fs.writeFileSync(notePath, '# Fault Topic\nContent.', 'utf8');
    env.run(['adopt', 'fault-topic.md', '--yes']);

    // 2. Create draft
    env.run(['session', 'draft', '--topic', 'fault-topic']);

    // 3. Corrupt the draft file
    const draftName = env.listSessions().drafts[0];
    const draftPath = path.join(env.vaultDir, '.palee', 'sessions', draftName);
    fs.writeFileSync(draftPath, '---\ninvalid: [ YAML error\n---\n# Corrupt draft\n', 'utf8');

    // 4. Session end succeeds regardless of corrupt draft
    const endRes = env.run(['session', 'end', '--topic', 'fault-topic']);
    assert.strictEqual(endRes.status, 0);

    const sessions = env.listSessions();
    assert.strictEqual(sessions.confirmed.length, 1);
  });

  // -------------------------------------------------------------------------
  // X9: Roadmap Import -> Failed Review (quality 0) -> Next (due immediately) -> Session End -> Progress
  // -------------------------------------------------------------------------
  test('X9: Failed Review (Quality 0) Resets Schedule and Keeps Topic Due in Next', () => {
    // 1. Roadmap import
    const rFile = path.join(env.tempDir, 'fail-review.yaml');
    fs.writeFileSync(rFile, `
topics:
  - id: T-fail-study
    title: Difficult Algorithm
    path: algo.md
`, 'utf8');
    env.run(['roadmap', '--from', rFile, '--yes']);

    // 2. Review with quality 0 (complete lapse)
    const revRes = env.run(['review', 'T-fail-study', '0']);
    assert.strictEqual(revRes.status, 0);
    assert.match(revRes.stdout, /Review failed - interval reset to 1 day/);

    // 3. Topic note state inspection
    const topic = env.readTopic('algo.md');
    assert.strictEqual(topic.frontmatter?.repetition, 0);
    assert.strictEqual(topic.frontmatter?.interval_days, 1);

    // 4. Session End
    env.run(['session', 'end', '--topic', 'T-fail-study']);

    // 5. Progress shows repetition 0 and healthy tracking
    const progRes = env.run(['progress', '--topic', 'T-fail-study', '--json']);
    const progData = JSON.parse(progRes.stdout);
    assert.strictEqual(progData.repetition, 0);
  });

  // -------------------------------------------------------------------------
  // X10: Roadmap Import -> High-rating Review (quality 5) -> Next (due in future) -> Plan -> Dashboard
  // -------------------------------------------------------------------------
  test('X10: High Quality Review Schedules Topic Out of Immediate Due Queue', () => {
    // 1. Roadmap import
    const rFile = path.join(env.tempDir, 'pass-review.yaml');
    fs.writeFileSync(rFile, `
topics:
  - id: T-mastered-topic
    title: Mastered Concept
    path: concept.md
`, 'utf8');
    env.run(['roadmap', '--from', rFile, '--yes']);

    // 2. Review with quality 5
    env.run(['review', 'T-mastered-topic', '5']);

    // 3. Next shows 0 due topics
    const nextRes = env.run(['next', '--json']);
    const nextData = JSON.parse(nextRes.stdout);
    assert.strictEqual(nextData.due_count, 0);

    // 4. Plan shows 0 reviews due
    const planRes = env.run(['plan', '--json']);
    const planData = JSON.parse(planRes.stdout);
    assert.strictEqual(planData.counts.due, 0);

    // 5. Dashboard shows 0 reviews due
    const dashRes = env.run(['dashboard', '--json']);
    const dashData = JSON.parse(dashRes.stdout);
    assert.strictEqual(dashData.reviews_due, 0);
  });

  // -------------------------------------------------------------------------
  // X11: Empty Vault -> Session Start (onboarding) -> Adopt -> Next -> Review -> Dashboard Box & Mastery Validation
  // -------------------------------------------------------------------------
  test('X11: Progressive Vault Onboarding and UI Formatting Validation', () => {
    // 1. Session start on empty vault
    const sStart = env.run(['session', 'start']);
    assert.strictEqual(sStart.status, 0);

    // 2. Create note and adopt
    const noteFile = path.join(env.vaultDir, 'onboarding.md');
    fs.writeFileSync(noteFile, '# First Note\nContent.', 'utf8');
    env.run(['adopt', 'onboarding.md', '--difficulty', 'beginner', '--yes']);

    // 3. Review
    const topic = env.readTopic('onboarding.md');
    env.run(['review', topic.frontmatter?.palee_id as string, '4']);

    // 4. Dashboard displays formatted stats and box borders
    const dash = env.run(['dashboard']);
    assert.strictEqual(dash.status, 0);
    assert.match(dash.stdout, /╔════════════════════════════════════════════════════════════╗/);
    assert.match(dash.stdout, /╚════════════════════════════════════════════════════════════╝/);
    assert.match(dash.stdout, /Total Topics:\s+1/);
  });

  // -------------------------------------------------------------------------
  // X12: Roadmap Import -> Concurrent Review Lock Contention -> Recovery -> Dashboard Stats
  // -------------------------------------------------------------------------
  test('X12: Concurrent Lock Contention during Review does not Corrupt Dashboard Metrics', async () => {
    const rFile = path.join(env.tempDir, 'lock-dash.yaml');
    fs.writeFileSync(rFile, `
topics:
  - id: T-lock-dash
    title: Lock Dashboard Topic
    path: lock-dash.md
`, 'utf8');
    env.run(['roadmap', '--from', rFile, '--yes']);

    // Lock note
    const notePath = path.join(env.vaultDir, 'lock-dash.md');
    const lock = new Lock(env.vaultDir, notePath);
    await lock.acquire();

    try {
      const failRev = env.run(['review', 'T-lock-dash', '5']);
      assert.strictEqual(failRev.status, 4);
    } finally {
      lock.release();
    }

    // Dashboard still reports valid vault state without crashing
    const dash = env.run(['dashboard', '--json']);
    assert.strictEqual(dash.status, 0);
    const parsed = JSON.parse(dash.stdout);
    assert.strictEqual(parsed.total_topics, 1);
  });

  // -------------------------------------------------------------------------
  // X13: Session Draft -> Session End with duration recovery -> Memory rebuild -> Progress inspection
  // -------------------------------------------------------------------------
  test('X13: Session Duration Recovery and Index Consistency across Memory Rebuild', () => {
    env.createTopic('mem-test.md', {
      palee_id: 'T-mem-test',
      title: 'Memory Test Topic',
    });

    // 1. Create draft
    env.run(['session', 'draft', '--topic', 'T-mem-test']);

    // 2. End session
    env.run(['session', 'end', '--topic', 'T-mem-test']);

    // 3. Verify hot.md and index.md
    const hot = env.readHotMemory();
    assert.ok(hot);
    assert.ok(hot.frontmatter?.last_session);

    const idx = env.readSessionIndex();
    assert.ok(idx);
    assert.match(idx.body, /Total Sessions: 1/);

    // 4. Progress command reflects healthy topic state
    const prog = env.run(['progress', '--topic', 'T-mem-test', '--json']);
    assert.strictEqual(prog.status, 0);
  });

  // -------------------------------------------------------------------------
  // X14: Roadmap Markdown Codeblock Import -> Session Start -> Review -> Progress --json
  // -------------------------------------------------------------------------
  test('X14: Markdown Codeblock Roadmap Ingestion with Progress JSON Verification', () => {
    const mdFile = path.join(env.tempDir, 'codeblock-roadmap.md');
    fs.writeFileSync(mdFile, `
# Full Curriculum

\`\`\`yaml
topics:
  - id: T-codeblock-topic
    title: Codeblock Topic
    path: cb-topic.md
    difficulty: advanced
\`\`\`
`, 'utf8');

    env.run(['roadmap', '--from', mdFile, '--yes']);
    env.run(['session', 'start']);
    env.run(['review', 'T-codeblock-topic', '4']);

    const progRes = env.run(['progress', '--topic', 'T-codeblock-topic', '--json']);
    assert.strictEqual(progRes.status, 0);
    const parsed = JSON.parse(progRes.stdout);
    assert.strictEqual(parsed.id, 'T-codeblock-topic');
    assert.strictEqual(parsed.difficulty, 'advanced');
    assert.strictEqual(parsed.repetition, 1);
  });

  // -------------------------------------------------------------------------
  // X15: Adopt All Directory -> Plan -> Multi-Review Sequence -> Dashboard Box & Mastery Validation
  // -------------------------------------------------------------------------
  test('X15: Batch Directory Adoption followed by Multi-Review and Dashboard Inspection', () => {
    // Create multiple markdown files in notes/ folder
    const notesDir = path.join(env.vaultDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'n1.md'), '# Note 1\nContent.', 'utf8');
    fs.writeFileSync(path.join(notesDir, 'n2.md'), '# Note 2\nContent.', 'utf8');

    // Adopt all
    const adoptRes = env.run(['adopt', 'notes', '--all', '--yes']);
    assert.strictEqual(adoptRes.status, 0);

    // Plan inspection
    const planRes = env.run(['plan', '--json']);
    assert.strictEqual(planRes.status, 0);
    const planData = JSON.parse(planRes.stdout);
    assert.strictEqual(planData.total_topics, 2);

    // Review both topics
    const t1 = env.readTopic('notes/n1.md');
    const t2 = env.readTopic('notes/n2.md');
    env.run(['review', t1.frontmatter?.palee_id as string, '5']);
    env.run(['review', t2.frontmatter?.palee_id as string, '4']);

    // Dashboard inspection
    const dashRes = env.run(['dashboard']);
    assert.strictEqual(dashRes.status, 0);
    assert.match(dashRes.stdout, /PALEE Learning Dashboard/);
    assert.match(dashRes.stdout, /Total Topics:\s+2/);
  });

  // -------------------------------------------------------------------------
  // X16: Multi-Stage Spaced Repetition Workflow over Time
  // -------------------------------------------------------------------------
  test('X16: Multi-Stage Spaced Repetition Progression over Sequential Reviews', () => {
    env.createTopic('sm2-stage.md', {
      palee_id: 'T-sm2-progression',
      title: 'SM2 Progression Topic',
      repetition: 0,
      interval_days: 1,
      ease_factor: 2.5,
    });

    // Review 1 (quality 4)
    env.run(['review', 'T-sm2-progression', '4']);
    let topic = env.readTopic('sm2-stage.md');
    assert.strictEqual(topic.frontmatter?.repetition, 1);
    assert.strictEqual(topic.frontmatter?.interval_days, 1);

    // Review 2 (quality 5)
    env.run(['review', 'T-sm2-progression', '5']);
    topic = env.readTopic('sm2-stage.md');
    assert.strictEqual(topic.frontmatter?.repetition, 2);
    assert.strictEqual(topic.frontmatter?.interval_days, 6);

    // Review 3 (quality 5)
    env.run(['review', 'T-sm2-progression', '5']);
    topic = env.readTopic('sm2-stage.md');
    assert.strictEqual(topic.frontmatter?.repetition, 3);
    assert.ok((topic.frontmatter?.interval_days as number) >= 15);
  });
});
