import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault, TestVaultEnv } from './test-env';
import { Lock } from '../../src/storage';

describe('Tier 4: Real-World Application Workload Scenarios', () => {
  let env: TestVaultEnv;

  beforeEach(() => {
    env = createTestVault('tier4-scenario-');
  });

  afterEach(() => {
    env.cleanup();
  });

  // =========================================================================
  // Scenario 1: Full Student Daily Routine
  // =========================================================================
  test('Scenario 1: Full Student Daily Routine (Roadmap Ingestion -> Morning Plan -> Study Session -> Draft Checkpoints -> Session End -> Spaced Repetition -> Night Dashboard)', () => {
    // Phase A: Morning Curriculum Ingestion
    const curriculumFile = path.join(env.tempDir, 'curriculum.yaml');
    fs.writeFileSync(curriculumFile, `
topics:
  - id: T-ds-foundations
    title: Data Structures Foundations
    path: ds/foundations.md
    difficulty: beginner
  - id: T-algo-graphs
    title: Graph Algorithms
    path: algo/graphs.md
    difficulty: intermediate
    depends_on: [T-ds-foundations]
  - id: T-adv-dp
    title: Dynamic Programming
    path: algo/dp.md
    difficulty: advanced
    depends_on: [T-algo-graphs]
`, 'utf8');

    const importRes = env.run(['roadmap', '--from', curriculumFile, '--yes']);
    assert.strictEqual(importRes.status, 0);

    // Phase B: Morning Plan Inspection (only T-ds-foundations is ready initially)
    const morningPlan = env.run(['plan', '--json']);
    assert.strictEqual(morningPlan.status, 0);
    const planData = JSON.parse(morningPlan.stdout);
    assert.strictEqual(planData.total_topics, 3);
    const readyIds = planData.ready_to_learn.map((t: { id: string }) => t.id);
    assert.ok(readyIds.includes('T-ds-foundations'));
    assert.strictEqual(readyIds.includes('T-algo-graphs'), false, 'Graphs should be locked');
    assert.strictEqual(readyIds.includes('T-adv-dp'), false, 'DP should be locked');

    // Phase C: Active Study Session Start & Intermediate Checkpoint
    const sStart = env.run(['session', 'start']);
    assert.strictEqual(sStart.status, 0);

    const sDraft = env.run(['session', 'draft', '--topic', 'T-ds-foundations']);
    assert.strictEqual(sDraft.status, 0);
    assert.strictEqual(env.listSessions().drafts.length, 1);

    // Phase D: Session Finalization (Duration Recorded, Draft Cleared)
    const sEnd = env.run(['session', 'end', '--topic', 'T-ds-foundations']);
    assert.strictEqual(sEnd.status, 0);
    assert.strictEqual(env.listSessions().drafts.length, 0);
    assert.strictEqual(env.listSessions().confirmed.length, 1);

    // Phase E: Spaced Repetition Review with 4-Pillar Mastery
    env.updateTopic('ds/foundations.md', {
      conceptual: 0.95,
      practical: 0.90,
      debug: 0.85,
      feynman: 0.90,
    });
    const reviewRes = env.run(['review', 'T-ds-foundations', '5']);
    assert.strictEqual(reviewRes.status, 0);

    // Phase F: Verify Dependency Unlocked in Plan
    const planRes = env.run(['plan', '--json']);
    assert.strictEqual(planRes.status, 0, `plan failed: ${planRes.stderr}`);
    const afternoonPlan = JSON.parse(planRes.stdout);
    const newReadyIds = afternoonPlan.ready_to_learn.map((t: { id: string }) => t.id);
    assert.ok(newReadyIds.includes('T-algo-graphs'), 'Graph algorithms should now be unlocked');

    // Phase G: Nightly Dashboard & Progress Audit
    const dashRes = env.run(['dashboard']);
    assert.strictEqual(dashRes.status, 0);
    assert.match(dashRes.stdout, /╔════════════════════════════════════════════════════════════╗/);
    assert.match(dashRes.stdout, /Total Topics:\s+3/);
    assert.match(dashRes.stdout, /Mastered \(≥70%\):\s+1 \(33\.3%\)/);

    const progRes = env.run(['progress', '--topic', 'T-ds-foundations']);
    assert.strictEqual(progRes.status, 0);
    assert.match(progRes.stdout, /Mastery:\s+90\.0%/);
  });

  // =========================================================================
  // Scenario 2: Multi-Topic Concurrent Study Session with Interleaved Drafts
  // =========================================================================
  test('Scenario 2: Multi-Topic Concurrent Study Session with Interleaved Drafts and Draft Recovery', () => {
    // 1. Setup 3 study topics
    env.createTopic('rust/types.md', { palee_id: 'T-rust-types', title: 'Rust Types' });
    env.createTopic('rust/borrowing.md', { palee_id: 'T-rust-borrowing', title: 'Rust Borrowing' });
    env.createTopic('rust/async.md', { palee_id: 'T-rust-async', title: 'Rust Async' });

    // 2. Interleaved study drafts across all 3 topics
    env.run(['session', 'draft', '--topic', 'T-rust-types']);
    env.run(['session', 'draft', '--topic', 'T-rust-borrowing']);
    env.run(['session', 'draft', '--topic', 'T-rust-async']);

    let sessions = env.listSessions();
    assert.strictEqual(sessions.drafts.length, 3);
    assert.strictEqual(sessions.confirmed.length, 0);

    // 3. Finalize session for T-rust-types
    env.run(['session', 'end', '--topic', 'T-rust-types']);

    sessions = env.listSessions();
    assert.strictEqual(sessions.confirmed.length, 1);
    assert.strictEqual(sessions.drafts.length, 2, '2 drafts should remain');

    // 4. Finalize session for T-rust-borrowing and T-rust-async
    env.run(['session', 'end', '--topic', 'T-rust-borrowing']);
    env.run(['session', 'end', '--topic', 'T-rust-async']);

    sessions = env.listSessions();
    assert.strictEqual(sessions.confirmed.length, 3);
    assert.strictEqual(sessions.drafts.length, 0);

    // 5. Index catalogs all 3 sessions in order
    const idx = env.readSessionIndex();
    assert.ok(idx);
    assert.match(idx.body, /Total Sessions: 3/);
    assert.match(idx.body, /T-rust-types/);
    assert.match(idx.body, /T-rust-borrowing/);
    assert.match(idx.body, /T-rust-async/);
  });

  // =========================================================================
  // Scenario 3: Concurrent Multi-Process Vault Sync during Review & Roadmap Import
  // =========================================================================
  test('Scenario 3: Concurrent Multi-Process Vault Sync & Conflict Handling (OCC Lock Contention & Safe Recovery)', async () => {
    // 1. Initialize vault with review topic
    env.createTopic('concurrency/thread.md', {
      palee_id: 'T-thread-sync',
      title: 'Thread Synchronization',
    });

    const topicPath = path.join(env.vaultDir, 'concurrency', 'thread.md');

    // 2. External sync tool / background process locks the file
    const lock = new Lock(env.vaultDir, topicPath);
    await lock.acquire();

    try {
      // 3. Attempt review while file is locked -> OCC conflict exit code 4
      const reviewConflict = env.run(['review', 'T-thread-sync', '4']);
      assert.strictEqual(reviewConflict.status, 4);
      assert.match(reviewConflict.stderr, /conflict|lock/i);

      // 4. Attempt roadmap import on locked target -> OCC conflict exit code 4
      const roadmapFile = path.join(env.tempDir, 'conflict-rm.yaml');
      fs.writeFileSync(roadmapFile, `
topics:
  - id: T-thread-sync
    title: Thread Synchronization Updated
    path: concurrency/thread.md
`, 'utf8');

      const rmConflict = env.run(['roadmap', '--from', roadmapFile, '--yes']);
      assert.strictEqual(rmConflict.status, 4);
    } finally {
      // 5. External process finishes sync and releases lock
      lock.release();
    }

    // 6. Retry review -> succeeds cleanly
    const reviewSuccess = env.run(['review', 'T-thread-sync', '4']);
    assert.strictEqual(reviewSuccess.status, 0);
    assert.match(reviewSuccess.stdout, /Review recorded/);

    // 7. Verify vault health via dashboard
    const dashRes = env.run(['dashboard', '--json']);
    assert.strictEqual(dashRes.status, 0);
    const dashData = JSON.parse(dashRes.stdout);
    assert.strictEqual(dashData.total_topics, 1);
  });

  // =========================================================================
  // Scenario 4: Batch Roadmap Ingestion on Mixed Vault
  // =========================================================================
  test('Scenario 4: Batch Roadmap Ingestion on Mixed Vault (Existing Notes, Preserved Progress, Traversal Escapes)', () => {
    // 1. Create existing note with established study progress
    env.createTopic('existing-studied.md', {
      palee_id: 'T-studied',
      title: 'Studied Note',
      topic_mastery: 0.88,
      repetition: 6,
      ease_factor: 2.7,
    });

    // 2. Create existing unmanaged markdown note
    fs.writeFileSync(path.join(env.vaultDir, 'unmanaged.md'), '# Unmanaged Note\nRandom thoughts.', 'utf8');

    // 3. Ingest mixed roadmap
    const mixedRoadmap = path.join(env.tempDir, 'mixed-vault-roadmap.yaml');
    fs.writeFileSync(mixedRoadmap, `
topics:
  - id: T-studied
    title: Studied Note Revised
    path: existing-studied.md
  - id: T-brand-new
    title: Brand New Topic
    path: sub/brand-new.md
  - id: T-escape-hack
    title: Malicious Traversal
    path: ../outside-vault.md
`, 'utf8');

    const importRes = env.run(['roadmap', '--from', mixedRoadmap, '--yes']);
    // Path escape is caught at validation time → exit code 3, entire import is blocked
    assert.strictEqual(importRes.status, 3);
    assert.match(importRes.stderr, /escapes vault boundary/);

    // 4. Verify existing studied note was NOT modified (import was blocked at validation)
    const studiedNote = env.readTopic('existing-studied.md');
    assert.strictEqual(studiedNote.frontmatter?.title, 'Studied Note');
    assert.strictEqual(studiedNote.frontmatter?.topic_mastery, 0.88);
    assert.strictEqual(studiedNote.frontmatter?.repetition, 6);
    assert.strictEqual(studiedNote.frontmatter?.ease_factor, 2.7);

    // 5. Verify new valid note was NOT created (import was blocked)
    assert.strictEqual(fs.existsSync(path.join(env.vaultDir, 'sub', 'brand-new.md')), false);

    // 6. Verify outside-vault.md was NOT created outside vault
    assert.strictEqual(fs.existsSync(path.join(env.tempDir, 'outside-vault.md')), false);
  });

  // =========================================================================
  // Scenario 5: Complete Dashboard & Progress Inspection with Mastery & Border Validation
  // =========================================================================
  test('Scenario 5: Complete Curriculum Lifecycle with Strict Mastery Formatting (XX.X%) and 62-Character Box Validation', () => {
    // 1. Ingest multi-difficulty curriculum
    const curriculum = path.join(env.tempDir, 'full-curriculum.yaml');
    fs.writeFileSync(curriculum, `
topics:
  - id: T-beg-1
    title: Beginner Topic 1
    path: beg1.md
    difficulty: beginner
  - id: T-int-1
    title: Intermediate Topic 1
    path: int1.md
    difficulty: intermediate
  - id: T-adv-1
    title: Advanced Topic 1
    path: adv1.md
    difficulty: advanced
`, 'utf8');
    env.run(['roadmap', '--from', curriculum, '--yes']);

    // 2. Perform assessments and reviews across the 3 topics:
    // Beginner topic: Mastered (85%)
    env.updateTopic('beg1.md', {
      conceptual: 0.85,
      practical: 0.85,
      debug: 0.85,
      feynman: 0.85,
    });
    env.run(['review', 'T-beg-1', '5']);

    // Intermediate topic: Learning (40%)
    env.updateTopic('int1.md', {
      conceptual: 0.40,
      practical: 0.40,
      debug: 0.40,
      feynman: 0.40,
    });
    env.run(['review', 'T-int-1', '3']);

    // Advanced topic: New (0%) - not yet reviewed

    // 3. Inspect individual topic progress
    const pBeg = env.run(['progress', '--topic', 'T-beg-1']);
    assert.strictEqual(pBeg.status, 0);
    assert.match(pBeg.stdout, /Mastery:\s+85\.0%/);

    const pInt = env.run(['progress', '--topic', 'T-int-1']);
    assert.strictEqual(pInt.status, 0);
    assert.match(pInt.stdout, /Mastery:\s+40\.0%/);

    // 4. Inspect global progress summary
    const pGlobal = env.run(['progress']);
    assert.strictEqual(pGlobal.status, 0);
    assert.match(pGlobal.stdout, /Mastered \(≥70%\):\s+1 \(33\.3%\)/);
    assert.match(pGlobal.stdout, /Learning:\s+1 \(33\.3%\)/);
    assert.match(pGlobal.stdout, /New:\s+1 \(33\.3%\)/);

    // 5. Inspect dashboard text output layout
    const dash = env.run(['dashboard']);
    assert.strictEqual(dash.status, 0);
    const lines = dash.stdout.split('\n');

    const topBorder = lines.find(l => l.includes('╔════'));
    const bottomBorder = lines.find(l => l.includes('╚════'));
    const titleLine = lines.find(l => l.includes('PALEE Learning Dashboard'));

    assert.ok(topBorder);
    assert.ok(bottomBorder);
    assert.ok(titleLine);

    assert.strictEqual(topBorder.trim().length, 62, 'Top border must be 62 chars');
    assert.strictEqual(bottomBorder.trim().length, 62, 'Bottom border must be 62 chars');
    assert.strictEqual(titleLine.trim().length, 62, 'Title row must fit border (62 chars)');

    // 6. JSON output parity
    const dashRes = env.run(['dashboard', '--json']);
    assert.strictEqual(dashRes.status, 0, `dashboard --json failed: ${dashRes.stderr}`);
    const dashData = JSON.parse(dashRes.stdout);
    assert.strictEqual(dashData.total_topics, 3);
    assert.strictEqual(dashData.mastered, 1);
    assert.strictEqual(dashData.learning, 1);
    assert.strictEqual(dashData.new, 1);
    assert.strictEqual(dashData.mastered_pct, 33.3);
    assert.strictEqual(dashData.learning_pct, 33.3);
    assert.strictEqual(dashData.new_pct, 33.3);
  });
});
