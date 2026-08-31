import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseFrontmatter, computeFingerprint } from '../src/storage/frontmatter';
import { Lock } from '../src/storage/lock';
import { atomicWrite, isConflictError } from '../src/storage/atomic-write';
import { reviewCommand } from '../src/cli/review';

describe('CLI Commands', () => {
  let tempDir: string;
  let vaultDir: string;
  let origConfigDir: string | undefined;

  before(() => {
    origConfigDir = process.env.PALEE_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-cli-test-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir);
    process.env.PALEE_CONFIG_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }, null, 2),
      'utf8'
    );
  });

  after(() => {
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[]): { status: number | null, stdout: string, stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../bin/palee.ts'), ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  test('config set-vault points to directory', () => {
    const result = runCLI(['config', 'set-vault', vaultDir]);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Vault path set to/);
  });

  test('config set-vault rejects file', () => {
    const file = path.join(tempDir, 'file.txt');
    fs.writeFileSync(file, 'hello');
    const result = runCLI(['config', 'set-vault', file]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /vault path is not a directory/);
  });

  test('adopt command sets up topic', () => {
    const notePath = path.join(vaultDir, 'note.md');
    fs.writeFileSync(notePath, '# Test Note\n');
    
    const result = runCLI(['adopt', 'note.md', '--difficulty', 'advanced']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Adopted as topic/);

    const content = fs.readFileSync(notePath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(frontmatter.difficulty, 'advanced');
    assert.strictEqual(frontmatter.topic_mastery, 0);
  });

  test('adopt command rejects path escaping vault', () => {
    const outsideFile = path.join(tempDir, 'outside.md');
    fs.writeFileSync(outsideFile, '# Outside');
    const result = runCLI(['adopt', '../outside.md']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /escapes vault/);
  });

  test('roadmap command preserves existing state and prevents path traversal', () => {
    // 1. Create a roadmap yaml with R-1 only, import it successfully first
    const roadmapYaml = path.join(tempDir, 'roadmap.yaml');
    fs.writeFileSync(roadmapYaml, `
topics:
  - id: R-1
    title: First
    path: first.md
`);

    const importResult = runCLI(['roadmap', '--from', roadmapYaml, '--yes']);
    assert.strictEqual(importResult.status, 0, `Initial import should succeed. Stderr: ${importResult.stderr}`);

    // R-1 should exist
    const firstPath = path.join(vaultDir, 'first.md');
    assert.ok(fs.existsSync(firstPath));

    // 2. Verify path traversal is blocked at validation (exit 3), import does NOT proceed
    const traversalYaml = path.join(tempDir, 'traversal-roadmap.yaml');
    fs.writeFileSync(traversalYaml, `
topics:
  - id: R-1
    title: First
    path: first.md
  - id: R-2
    title: Traversal
    path: ../escaped.md
`);

    const traversalResult = runCLI(['roadmap', '--from', traversalYaml, '--yes']);
    // Path escape is caught at validation → exit code 3, entire import blocked
    assert.strictEqual(traversalResult.status, 3, `Path traversal must fail at validation (exit 3). Got: ${traversalResult.status}`);
    assert.match(traversalResult.stderr, /escapes vault/);

    // 3. Modify R-1 state manually to simulate a review
    let content = fs.readFileSync(firstPath, 'utf8');
    let parsed = parseFrontmatter(content);
    parsed.frontmatter!.topic_mastery = 0.8;
    parsed.frontmatter!.repetition = 5;

    // rewrite
    const { updateFrontmatter } = require('../src/storage/frontmatter');
    fs.writeFileSync(firstPath, updateFrontmatter(content, parsed.frontmatter));

    // 4. Run roadmap import again with a valid roadmap to verify state preservation
    fs.writeFileSync(roadmapYaml, `
topics:
  - id: R-1
    title: First Modified
    path: first.md
`);

    runCLI(['roadmap', '--from', roadmapYaml, '--yes']);

    // Check state preservation
    content = fs.readFileSync(firstPath, 'utf8');
    parsed = parseFrontmatter(content);
    assert.strictEqual(parsed.frontmatter!.title, 'First Modified'); // Should be updated
    assert.strictEqual(parsed.frontmatter!.topic_mastery, 0.8); // Should be preserved
    assert.strictEqual(parsed.frontmatter!.repetition, 5); // Should be preserved
  });

  test('roadmap command imports from Markdown files with frontmatter and code blocks', () => {
    const mdVault = path.join(tempDir, 'md-roadmap-vault');
    fs.mkdirSync(mdVault, { recursive: true });
    runCLI(['config', 'set-vault', mdVault]);

    try {
      // 1. Test frontmatter roadmap in Markdown
      const mdFrontmatterRoadmap = path.join(tempDir, 'roadmap-frontmatter.md');
      fs.writeFileSync(mdFrontmatterRoadmap, `---
title: Fullstack Path
topics:
  - id: R-md-1
    title: TypeScript Advanced
    path: ts-advanced.md
    difficulty: advanced
---

# Fullstack Roadmap
Detailed notes here...
`);

      const result1 = runCLI(['roadmap', '--from', mdFrontmatterRoadmap, '--yes']);
      assert.strictEqual(result1.status, 0, `Command failed: ${result1.stderr}`);
      assert.match(result1.stdout, /Roadmap imported successfully/);

      const tsNotePath = path.join(mdVault, 'ts-advanced.md');
      assert.ok(fs.existsSync(tsNotePath));
      const tsParsed = parseFrontmatter(fs.readFileSync(tsNotePath, 'utf8'));
      assert.strictEqual(tsParsed.frontmatter!.palee_id, 'R-md-1');
      assert.strictEqual(tsParsed.frontmatter!.difficulty, 'advanced');

      // 2. Test embedded YAML codeblock roadmap in Markdown
      const mdCodeBlockRoadmap = path.join(tempDir, 'roadmap-codeblock.md');
      fs.writeFileSync(mdCodeBlockRoadmap, `# Cloud Architecture

\`\`\`yaml
topics:
  - id: R-md-2
    title: Serverless Microservices
    path: cloud/serverless.md
    difficulty: intermediate
    depends_on: [R-md-1]
\`\`\`
`);

      const result2 = runCLI(['roadmap', '--from', mdCodeBlockRoadmap, '--yes']);
      assert.strictEqual(result2.status, 0, `Command failed: ${result2.stderr}`);
      assert.match(result2.stdout, /Roadmap imported successfully/);

      const cloudNotePath = path.join(mdVault, 'cloud', 'serverless.md');
      assert.ok(fs.existsSync(cloudNotePath));
      const cloudParsed = parseFrontmatter(fs.readFileSync(cloudNotePath, 'utf8'));
      assert.strictEqual(cloudParsed.frontmatter!.palee_id, 'R-md-2');
      assert.deepStrictEqual(cloudParsed.frontmatter!.depends_on, ['R-md-1']);
    } finally {
      // Restore vaultDir
      runCLI(['config', 'set-vault', vaultDir]);
    }
  });

  test('roadmap command batch imports valid topics and logs error when encountering corrupted note', () => {
    const corruptVault = path.join(tempDir, 'corrupt-note-vault');
    fs.mkdirSync(corruptVault, { recursive: true });
    runCLI(['config', 'set-vault', corruptVault]);

    try {
      // Create a corrupted note on disk with invalid YAML frontmatter
      const corruptNotePath = path.join(corruptVault, 'corrupted.md');
      fs.writeFileSync(corruptNotePath, '---\npalee_id: [unclosed\n---\n# Corrupted\n', 'utf8');

      const batchRoadmap = path.join(tempDir, 'corrupt-note-roadmap.yaml');
      fs.writeFileSync(batchRoadmap, `topics:
  - id: R-valid-1
    title: First Valid Note
    path: valid1.md
    difficulty: beginner
  - id: R-corrupted
    title: Corrupted Note Topic
    path: corrupted.md
  - id: R-valid-2
    title: Second Valid Note
    path: valid2.md
    difficulty: intermediate
`);

      const result = runCLI(['roadmap', '--from', batchRoadmap, '--yes']);
      assert.strictEqual(result.status, 1, `Expected exit code 1 on partial failure, got ${result.status}. Stderr: ${result.stderr}`);
      assert.match(result.stderr, /Failed R-corrupted \(corrupted\.md\)/);
      assert.match(result.stderr, /Malformed frontmatter/);
      assert.match(result.stderr, /Failed to import 1 topics/);

      // Verify valid topics were created
      assert.ok(fs.existsSync(path.join(corruptVault, 'valid1.md')), 'valid1.md should be created');
      assert.ok(fs.existsSync(path.join(corruptVault, 'valid2.md')), 'valid2.md should be created');
    } finally {
      runCLI(['config', 'set-vault', vaultDir]);
    }
  });

  test('review command updates SM2 fields but preserves mastery', () => {
    // Review R-1
    const result = runCLI(['review', 'R-1', '4']);
    assert.strictEqual(result.status, 0, `Command should exit with 0. Stderr: ${result.stderr}`);

    const firstPath = path.join(vaultDir, 'first.md');
    const content = fs.readFileSync(firstPath, 'utf8');
    const parsed = parseFrontmatter(content);

    assert.ok(parsed.frontmatter!.last_reviewed_at);
    assert.ok(parsed.frontmatter!.due_at);
    // The due_at should be a date-only string YYYY-MM-DD
    assert.match(parsed.frontmatter!.due_at as string, /^\d{4}-\d{2}-\d{2}$/);
    
    // Mastery fields should NOT be overwritten by review
    assert.strictEqual(parsed.frontmatter!.conceptual, 0); // Unchanged from init
    assert.strictEqual(parsed.frontmatter!.practical, 0);
    assert.strictEqual(parsed.frontmatter!.debug, 0);
    assert.strictEqual(parsed.frontmatter!.feynman, 0);
    assert.strictEqual(parsed.frontmatter!.topic_mastery, 0.8); // We set this to 0.8 in the roadmap test manually
  });

  test('review command recomputes topic_mastery when assessment pillars are present', () => {
    const pillarNotePath = path.join(vaultDir, 'pillar-topic.md');
    try {
      fs.writeFileSync(
        pillarNotePath,
        `---
palee_id: T-pillar-review
palee_schema: 1
title: Pillar Review Topic
difficulty: intermediate
depends_on: []
conceptual: 0.8
practical: 0.8
debug: 0.8
feynman: 0.8
topic_mastery: 0.0
---
# Pillar Review Topic
Content.
`,
        'utf8'
      );

      const result = runCLI(['review', 'T-pillar-review', '5']);
      assert.strictEqual(result.status, 0, `Command should exit with 0. Stderr: ${result.stderr}`);

      const content = fs.readFileSync(pillarNotePath, 'utf8');
      const parsed = parseFrontmatter(content);

      assert.strictEqual(parsed.frontmatter!.conceptual, 0.8);
      assert.strictEqual(parsed.frontmatter!.practical, 0.8);
      assert.strictEqual(parsed.frontmatter!.debug, 0.8);
      assert.strictEqual(parsed.frontmatter!.feynman, 0.8);
      assert.strictEqual(parsed.frontmatter!.topic_mastery, 0.8);
      assert.strictEqual(parsed.frontmatter!.last_quality, 5);
    } finally {
      if (fs.existsSync(pillarNotePath)) {
        fs.unlinkSync(pillarNotePath);
      }
    }
  });

  test('review command recomputing mastery unlocks dependent topics in plan', () => {
    const prereqPath = path.join(vaultDir, 'prereq-topic.md');
    const depPath = path.join(vaultDir, 'dep-topic.md');
    try {
      fs.writeFileSync(
        prereqPath,
        `---
palee_id: T-prereq-gate
palee_schema: 1
title: Prerequisite Gate Topic
difficulty: intermediate
depends_on: []
conceptual: 0.9
practical: 0.9
debug: 0.9
feynman: 0.9
topic_mastery: 0.0
---
# Prerequisite
`,
        'utf8'
      );

      fs.writeFileSync(
        depPath,
        `---
palee_id: T-dependent-gate
palee_schema: 1
title: Dependent Gate Topic
difficulty: advanced
depends_on:
  - T-prereq-gate
topic_mastery: 0.0
---
# Dependent
`,
        'utf8'
      );

      // Before review, T-dependent-gate should not be ready
      const planBefore = runCLI(['plan', '--json']);
      assert.strictEqual(planBefore.status, 0);
      const parsedBefore = JSON.parse(planBefore.stdout);
      const isDepReadyBefore = (parsedBefore.ready_to_learn || []).some(
        (t: { id: string }) => t.id === 'T-dependent-gate'
      );
      assert.strictEqual(isDepReadyBefore, false, 'Dependent topic should not be ready before prerequisite is reviewed');

      // Review prerequisite topic with quality 5
      const reviewResult = runCLI(['review', 'T-prereq-gate', '5']);
      assert.strictEqual(reviewResult.status, 0);

      // After review, T-prereq-gate mastery should be >= 0.70 and T-dependent-gate should now be ready
      const planAfter = runCLI(['plan', '--json']);
      assert.strictEqual(planAfter.status, 0);
      const parsedAfter = JSON.parse(planAfter.stdout);
      const isDepReadyAfter = (parsedAfter.ready_to_learn || []).some(
        (t: { id: string }) => t.id === 'T-dependent-gate'
      );
      assert.strictEqual(isDepReadyAfter, true, 'Dependent topic should be unlocked and ready after prerequisite mastery >= 0.70');
    } finally {
      if (fs.existsSync(prereqPath)) fs.unlinkSync(prereqPath);
      if (fs.existsSync(depPath)) fs.unlinkSync(depPath);
    }
  });

  test('progress --topic handles malformed date strings gracefully without throwing', () => {
    const malformedNotePath = path.join(vaultDir, 'malformed-date.md');
    try {
      fs.writeFileSync(
        malformedNotePath,
        `---
palee_id: T-malformed-date
palee_schema: 1
title: Malformed Date Topic
difficulty: beginner
depends_on: []
topic_mastery: 0.5
assessed_at: "garbage-invalid-date"
last_reviewed_at: "not-a-real-date"
---
# Malformed Date Topic
Body content.
`,
        'utf8'
      );

      const result = runCLI(['progress', '--topic', 'T-malformed-date']);
      assert.strictEqual(result.status, 0, `Command should exit with 0. Stderr: ${result.stderr}`);
      assert.match(result.stdout, /Progress for: Malformed Date Topic/);
      assert.match(result.stdout, /Last Assessed: garbage-invalid-date/);
      assert.match(result.stdout, /Last Reviewed: not-a-real-date/);
    } finally {
      if (fs.existsSync(malformedNotePath)) {
        fs.unlinkSync(malformedNotePath);
      }
    }
  });



  test('dashboard command outputs formatted stats without NaN on populated vault', () => {
    const result = runCLI(['dashboard']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /PALEE Learning Dashboard/);
    assert.match(result.stdout, /Total Topics:\s+2/);
    assert.match(result.stdout, /Mastered \(≥70%\):\s+1 \(50\.0%\)/);
    assert.doesNotMatch(result.stdout, /NaN/);

    const lines = result.stdout.split('\n');
    const topBorder = lines.find(l => l.includes('╔════'));
    const bottomBorder = lines.find(l => l.includes('╚════'));
    const titleLine = lines.find(l => l.includes('PALEE Learning Dashboard'));
    const divider = lines.find(l => l.includes('───'));

    assert.ok(topBorder);
    assert.ok(bottomBorder);
    assert.ok(titleLine);
    assert.ok(divider);

    assert.strictEqual(topBorder.trim().length, 62, 'Top border must be 62 chars');
    assert.strictEqual(titleLine.trim().length, 62, 'Title line must be 62 chars');
    assert.strictEqual(bottomBorder.trim().length, 62, 'Bottom border must be 62 chars');
    assert.strictEqual(divider.trim().length, 62, 'Divider line must be 62 chars');
  });

  test('next command outputs mastery in standard XX.X% format for single and all due topics', () => {
    const nextSingle = runCLI(['next']);
    assert.strictEqual(nextSingle.status, 0);
    assert.match(nextSingle.stdout, /Next topic due for review:/);
    assert.match(nextSingle.stdout, /Mastery:\s+\d+\.\d%/);

    const nextAll = runCLI(['next', '--all']);
    assert.strictEqual(nextAll.status, 0);
    assert.match(nextAll.stdout, /topic\(s\) due for review:/);
    assert.match(nextAll.stdout, /Mastery:\s+\d+\.\d%/);
  });

  test('commands display onboarding guidance on empty vault', () => {
    const emptyVault = path.join(tempDir, 'empty-vault');
    fs.mkdirSync(emptyVault, { recursive: true });
    runCLI(['config', 'set-vault', emptyVault]);

    // 1. dashboard
    const dashResult = runCLI(['dashboard']);
    assert.strictEqual(dashResult.status, 0);
    assert.match(dashResult.stdout, /No topics found in vault/);
    assert.match(dashResult.stdout, /palee adopt/);
    assert.match(dashResult.stdout, /palee roadmap --from/);

    // 2. plan
    const planResult = runCLI(['plan']);
    assert.strictEqual(planResult.status, 0);
    assert.match(planResult.stdout, /No topics found in vault/);
    assert.match(planResult.stdout, /palee adopt/);

    // 3. progress
    const progResult = runCLI(['progress']);
    assert.strictEqual(progResult.status, 0);
    assert.match(progResult.stdout, /No topics found in vault/);
    assert.match(progResult.stdout, /palee adopt/);

    // 4. next
    const nextResult = runCLI(['next']);
    assert.strictEqual(nextResult.status, 0);
    assert.match(nextResult.stdout, /No topics found in vault/);
    assert.match(nextResult.stdout, /palee adopt/);

    // Restore vaultDir
    runCLI(['config', 'set-vault', vaultDir]);
  });

  test('commands exit with code 2 on non-existent vault path', () => {
    const missingVault = path.join(tempDir, 'missing-vault');
    fs.mkdirSync(missingVault, { recursive: true });
    runCLI(['config', 'set-vault', missingVault]);
    fs.rmSync(missingVault, { recursive: true, force: true });

    for (const cmd of ['dashboard', 'plan', 'progress', 'next', 'migrate']) {
      const result = runCLI([cmd]);
      assert.strictEqual(result.status, 2, `${cmd} should exit with code 2 on missing vault`);
      assert.match(result.stderr, /Vault path not found/);
    }

    const adoptResult = runCLI(['adopt', 'dummy.md', '--yes']);
    assert.strictEqual(adoptResult.status, 2, 'adopt should exit with code 2 on missing vault');
    assert.match(adoptResult.stderr, /Vault path not found/);

    const reviewResult = runCLI(['review', 'T-1', '5']);
    assert.strictEqual(reviewResult.status, 2, 'review should exit with code 2 on missing vault');
    assert.match(reviewResult.stderr, /Vault path not found/);

    const sampleRoadmap = path.join(tempDir, 'sample-roadmap.yaml');
    fs.writeFileSync(sampleRoadmap, 'topics:\n  - id: T-1\n    title: T1\n    path: t1.md\n');
    const roadmapResult = runCLI(['roadmap', '--from', sampleRoadmap, '--yes']);
    assert.strictEqual(roadmapResult.status, 2, 'roadmap should exit with code 2 on missing vault');
    assert.match(roadmapResult.stderr, /Vault path not found/);

    // Restore vaultDir
    runCLI(['config', 'set-vault', vaultDir]);
  });

  test('session end requires topic when hot.md has no active topic', () => {
    // Ensure clean vault without hot.md active_topic
    const sessionTestVault = path.join(tempDir, 'session-vault');
    fs.mkdirSync(sessionTestVault, { recursive: true });
    runCLI(['config', 'set-vault', sessionTestVault]);

    const result = runCLI(['session', 'end']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /Topic required/);

    // Assert that no phantom T-general file was created
    const sessionsDir = path.join(sessionTestVault, '.palee', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir);
      assert.strictEqual(files.filter(f => f.includes('T-general')).length, 0);
    }

    // Restore vaultDir
    runCLI(['config', 'set-vault', vaultDir]);
  });

  test('session end records session when explicit topic is provided', () => {
    const sessionTestVault = path.join(tempDir, 'session-vault-explicit');
    fs.mkdirSync(sessionTestVault, { recursive: true });
    runCLI(['config', 'set-vault', sessionTestVault]);

    const result = runCLI(['session', 'end', '--topic', 'T-docker-basics']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Session recorded/);

    // Verify session note exists and has T-docker-basics topic_id
    const sessionsDir = path.join(sessionTestVault, '.palee', 'sessions');
    const files = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-') && f.endsWith('.md'));
    assert.strictEqual(files.length, 1);

    const sessionContent = fs.readFileSync(path.join(sessionsDir, files[0]), 'utf8');
    const { frontmatter } = parseFrontmatter(sessionContent);
    assert.strictEqual(frontmatter?.topic_id, 'T-docker-basics');

    // Restore vaultDir
    runCLI(['config', 'set-vault', vaultDir]);
  });

  test('review command exits with code 4 on concurrent lock conflict', async () => {
    const lockNotePath = path.join(vaultDir, 'lock-conflict-review.md');
    try {
      fs.writeFileSync(
        lockNotePath,
        `---
palee_id: T-lock-review
palee_schema: 1
title: Lock Conflict Review
difficulty: beginner
depends_on: []
topic_mastery: 0.5
---
# Lock Conflict Review
`,
        'utf8'
      );

      const lock = new Lock(vaultDir, lockNotePath);
      await lock.acquire();

      try {
        const result = runCLI(['review', 'T-lock-review', '4']);
        assert.strictEqual(result.status, 4, `Expected exit code 4 on lock conflict, got ${result.status}. Stderr: ${result.stderr}`);
        assert.match(result.stderr, /Lock conflict|conflict/i);
      } finally {
        lock.release();
      }
    } finally {
      if (fs.existsSync(lockNotePath)) {
        fs.unlinkSync(lockNotePath);
      }
    }
  });

  test('adopt command exits with code 4 on concurrent lock conflict', async () => {
    const lockAdoptPath = path.join(vaultDir, 'lock-conflict-adopt.md');
    try {
      fs.writeFileSync(
        lockAdoptPath,
        `# Unadopted Note
This note is undergoing concurrent modification.
`,
        'utf8'
      );

      const lock = new Lock(vaultDir, lockAdoptPath);
      await lock.acquire();

      try {
        const result = runCLI(['adopt', lockAdoptPath, '--yes']);
        assert.strictEqual(result.status, 4, `Expected exit code 4 on lock conflict, got ${result.status}. Stderr: ${result.stderr}`);
        assert.match(result.stderr, /Lock conflict|conflict/i);
      } finally {
        lock.release();
      }
    } finally {
      if (fs.existsSync(lockAdoptPath)) {
        fs.unlinkSync(lockAdoptPath);
      }
    }
  });

  test('roadmap command exits with code 4 on concurrent lock conflict', async () => {
    const roadmapFile = path.join(tempDir, 'conflict-roadmap.yaml');
    const targetNote = path.join(vaultDir, 'roadmap-conflict-target.md');
    try {
      fs.writeFileSync(
        roadmapFile,
        `topics:
  - id: T-roadmap-lock
    title: Roadmap Lock Test
    path: roadmap-conflict-target.md
    difficulty: beginner
`,
        'utf8'
      );

      const lock = new Lock(vaultDir, targetNote);
      await lock.acquire();

      try {
        const result = runCLI(['roadmap', '--from', roadmapFile, '--yes']);
        assert.strictEqual(result.status, 4, `Expected exit code 4 on roadmap lock conflict, got ${result.status}. Stderr: ${result.stderr}`);
        assert.match(result.stderr, /Lock conflict|conflict/i);
      } finally {
        lock.release();
      }
    } finally {
      if (fs.existsSync(roadmapFile)) fs.unlinkSync(roadmapFile);
      if (fs.existsSync(targetNote)) fs.unlinkSync(targetNote);
    }
  });

  test('atomicWrite OCC conflict produces ECONFLICT error recognized by isConflictError', async () => {
    const occNote = path.join(vaultDir, 'occ-conflict.md');
    try {
      const initial = '# Initial Content\n';
      fs.writeFileSync(occNote, initial, 'utf8');
      const fp = computeFingerprint(initial);

      // Concurrent external write modifies the note
      fs.writeFileSync(occNote, '# External modification\n', 'utf8');

      try {
        await atomicWrite(vaultDir, occNote, '# Overwrite attempt\n', fp);
        assert.fail('Expected atomicWrite to throw on OCC conflict');
      } catch (e: unknown) {
        assert.strictEqual(isConflictError(e), true);
        const err = e as { code?: string; message?: string };
        assert.strictEqual(err.code, 'ECONFLICT');
        assert.match(err.message || '', /OCC conflict/);
      }
    } finally {
      if (fs.existsSync(occNote)) fs.unlinkSync(occNote);
    }
  });

  test('review command exits with code 4 when topic note is modified concurrently between discovery and write submission (TOCTOU)', async () => {
    const toctouPath = path.join(vaultDir, 'toctou-review-conflict.md');
    try {
      fs.writeFileSync(
        toctouPath,
        `---
palee_id: T-toctou-review
palee_schema: 1
title: TOCTOU Review Conflict
difficulty: intermediate
topic_mastery: 0.5
ease_factor: 2.5
interval_days: 1
repetition: 0
lapses: 0
---
# TOCTOU Review Conflict
Initial content.
`,
        'utf8'
      );

      const originalExitCode = process.exitCode;
      const originalError = console.error;
      let loggedError = '';
      console.error = (msg: string) => { loggedError += msg; };

      // Spy on fs.readFileSync to return modified content on the second read (fresh read in reviewCommand)
      const origReadFileSync = fs.readFileSync;
      let readCount = 0;
      (fs as any).readFileSync = (p: any, options: any) => {
        const content = origReadFileSync(p, options);
        if (typeof p === 'string' && p.includes('toctou-review-conflict.md')) {
          readCount++;
          if (readCount > 1) {
            // Simulate external process modifying the note concurrently
            return String(content).replace('Initial content.', 'Concurrently modified by external editor.');
          }
        }
        return content;
      };

      try {
        await reviewCommand('T-toctou-review', '5');
        assert.strictEqual(process.exitCode, 4, 'Expected process.exitCode = 4 on OCC TOCTOU conflict');
        assert.match(loggedError, /OCC conflict/i);
      } finally {
        fs.readFileSync = origReadFileSync;
        console.error = originalError;
        process.exitCode = originalExitCode;
      }
    } finally {
      if (fs.existsSync(toctouPath)) {
        fs.unlinkSync(toctouPath);
      }
    }
  });

  test('review command exits with code 4 when topic note is deleted concurrently before write', async () => {
    const deletedTopicPath = path.join(vaultDir, 'deleted-review-topic.md');
    try {
      fs.writeFileSync(
        deletedTopicPath,
        `---
palee_id: T-deleted-review
palee_schema: 1
title: Deleted Review Topic
difficulty: intermediate
topic_mastery: 0.5
ease_factor: 2.5
interval_days: 1
repetition: 0
lapses: 0
---
# Deleted Review Topic
Content.
`,
        'utf8'
      );

      const originalExitCode = process.exitCode;
      const originalError = console.error;
      let loggedError = '';
      console.error = (msg: string) => { loggedError += msg; };

      const origExistsSync = fs.existsSync;
      let checkCount = 0;
      (fs as any).existsSync = (p: any) => {
        if (typeof p === 'string' && p.includes('deleted-review-topic.md')) {
          checkCount++;
          if (checkCount > 1) {
            // Simulate file deletion right after initial discovery
            return false;
          }
        }
        return origExistsSync(p);
      };

      try {
        await reviewCommand('T-deleted-review', '5');
        assert.strictEqual(process.exitCode, 4, 'Expected process.exitCode = 4 when topic note does not exist at pre-write');
        assert.match(loggedError, /OCC conflict/i);
      } finally {
        fs.existsSync = origExistsSync;
        console.error = originalError;
        process.exitCode = originalExitCode;
      }
    } finally {
      if (fs.existsSync(deletedTopicPath)) {
        fs.unlinkSync(deletedTopicPath);
      }
    }
  });
});

