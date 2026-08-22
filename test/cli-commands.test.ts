import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';

describe('CLI Commands', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-cli-test-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir);
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[]): { status: number | null, stdout: string, stderr: string } {
    try {
      const stdout = execSync(`npx tsx bin/palee.ts ${args.join(' ')}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
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
    // 1. Create a roadmap yaml
    const roadmapYaml = path.join(tempDir, 'roadmap.yaml');
    fs.writeFileSync(roadmapYaml, `
topics:
  - id: R-1
    title: First
    path: first.md
  - id: R-2
    title: Traversal
    path: ../escaped.md
`);

    // 2. Mock user input for prompt (Y)
    let result;
    try {
      const stdout = execSync(`npx tsx bin/palee.ts roadmap --from "${roadmapYaml}" --yes`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      result = { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      result = { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }

    // Since R-2 escapes the vault, the command should fail but still process R-1
    assert.strictEqual(result.status, 1, `Command should exit with 1 due to failures.\nStdout: ${result.stdout}\nStderr: ${result.stderr}`);
    assert.match(result.stderr, /Roadmap path escapes vault/);
    assert.match(result.stderr, /Failed to import 1 topics/);

    // R-1 should exist
    const firstPath = path.join(vaultDir, 'first.md');
    assert.ok(fs.existsSync(firstPath));

    // 3. Modify R-1 state manually to simulate a review
    let content = fs.readFileSync(firstPath, 'utf8');
    let parsed = parseFrontmatter(content);
    parsed.frontmatter!.topic_mastery = 0.8;
    parsed.frontmatter!.repetition = 5;
    
    // rewrite
    const { updateFrontmatter } = require('../src/storage/frontmatter');
    fs.writeFileSync(firstPath, updateFrontmatter(content, parsed.frontmatter));

    // 4. Run roadmap import again, but with a valid roadmap
    fs.writeFileSync(roadmapYaml, `
topics:
  - id: R-1
    title: First Modified
    path: first.md
`);
    
    try {
      execSync(`npx tsx bin/palee.ts roadmap --from "${roadmapYaml}" --yes`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        stdio: 'pipe',
      });
    } catch (e) {}

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
      const isDepReadyBefore = (parsedBefore.ready_topics || []).some(
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
      const isDepReadyAfter = (parsedAfter.ready_topics || []).some(
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

    for (const cmd of ['dashboard', 'plan', 'progress', 'next']) {
      const result = runCLI([cmd]);
      assert.strictEqual(result.status, 2, `${cmd} should exit with code 2 on missing vault`);
      assert.match(result.stderr, /Vault path not found/);
    }

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
});

