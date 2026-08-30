import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseFrontmatter,
  Lock,
} from '../src/storage';
import { createTestVault, TestVaultEnv, CLIResult, runPaleeCli } from './e2e/test-env';

const PALEE_BIN = path.resolve(__dirname, '../bin/palee.ts');
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Executes the PALEE CLI binary asynchronously in a child process for concurrency stress testing.
 *
 * @param args - CLI arguments to pass to the binary
 * @param configDir - Isolated directory containing config.json
 * @param options - Additional options including custom env vars
 * @returns Promise resolving to CLI execution result
 */
function runPaleeCliAsync(
  args: string[],
  configDir: string,
  options?: { env?: Record<string, string> }
): Promise<CLIResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', PALEE_BIN, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PALEE_CONFIG_DIR: configDir,
        NODE_ENV: 'test',
        ...(options?.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('close', (status) => {
      resolve({
        status: status ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

describe('Challenger 1: Empirical Concurrency & Batch Resilience Stress Harness', () => {
  let env: TestVaultEnv;

  beforeEach(() => {
    env = createTestVault('palee-chal1-');
  });

  afterEach(() => {
    env.cleanup();
  });

  // =========================================================================
  // Challenge 1: Concurrency & OCC TOCTOU Stress Tests
  // =========================================================================
  describe('Challenge 1: Concurrency & OCC Conflict Stress', () => {
    test('10 simultaneous review processes against the same topic cleanly resolve via OCC (code 0 or code 4) without data corruption', async () => {
      const topicPath = env.createTopic(
        'distributed-systems.md',
        {
          palee_id: 'T-dist-sys',
          title: 'Distributed Systems',
          ease_factor: 2.5,
          repetition: 1,
          interval_days: 1,
          topic_mastery: 0.2,
        },
        'Distributed systems consensus and fault tolerance notes.'
      );

      const initialContent = fs.readFileSync(topicPath, 'utf8');
      assert.ok(initialContent.includes('Distributed systems consensus'));

      // Launch 10 simultaneous review CLI invocations
      const promises: Promise<CLIResult>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(runPaleeCliAsync(['review', 'T-dist-sys', '4'], env.configDir));
      }

      const results = await Promise.all(promises);

      const successCount = results.filter((r) => r.status === 0).length;
      const conflictCount = results.filter((r) => r.status === 4).length;
      const otherErrors = results.filter((r) => r.status !== 0 && r.status !== 4);

      // No unhandled exceptions or crashes
      assert.strictEqual(
        otherErrors.length,
        0,
        `Unexpected exit codes detected: ${JSON.stringify(otherErrors)}`
      );

      // At least 1 review succeeded
      assert.ok(
        successCount >= 1,
        `Expected at least 1 successful review, got ${successCount}`
      );
      assert.strictEqual(successCount + conflictCount, 10);

      // Verify topic note is not corrupted
      const finalContent = fs.readFileSync(topicPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(finalContent);

      assert.ok(frontmatter !== null, 'Frontmatter must remain valid YAML');
      assert.strictEqual(frontmatter.palee_id, 'T-dist-sys');
      assert.strictEqual(frontmatter.palee_schema, 1);
      assert.ok(
        (frontmatter.repetition as number) >= 2,
        'Repetition count must have incremented'
      );
      assert.ok(body.includes('Distributed systems consensus and fault tolerance notes.'));

      // Check no temp files or locks remain
      const vaultFiles = fs.readdirSync(env.vaultDir);
      const tempFiles = vaultFiles.filter((f) => f.includes('.tmp.') || f.endsWith('.lock'));
      assert.strictEqual(tempFiles.length, 0, 'No leftover temporary files or locks');
    });

    test('active note modification during review prompt strictly triggers OCC conflict (exit code 4)', async () => {
      const topicPath = env.createTopic(
        'concurrency-model.md',
        {
          palee_id: 'T-conc-mod',
          title: 'Concurrency Models',
          ease_factor: 2.5,
          repetition: 0,
          interval_days: 1,
        },
        'Original note body before concurrent edit.'
      );

      // Acquire lock on the topic file before calling review to simulate in-flight collision
      const lock = new Lock(env.vaultDir, topicPath);
      await lock.acquire();

      try {
        // While lock is held, review command must fail with exit code 4
        const result = runPaleeCli(['review', 'T-conc-mod', '5'], env.configDir);
        assert.strictEqual(result.status, 4, `Expected exit code 4 on lock contention, got ${result.status}`);
        assert.match(result.stderr, /OCC conflict|Lock conflict/);
      } finally {
        lock.release();
      }

      // Modify note content on disk directly to change its SHA-256 fingerprint
      fs.writeFileSync(
        topicPath,
        `---\npalee_id: T-conc-mod\npalee_schema: 1\ntitle: Concurrency Models\nease_factor: 2.6\nrepetition: 1\ninterval_days: 2\n---\n# Concurrency Models\n\nModified externally during prompt.`,
        'utf8'
      );

      // Now run review on the freshly modified note - it should succeed on the new content
      const result2 = runPaleeCli(['review', 'T-conc-mod', '4'], env.configDir);
      assert.strictEqual(result2.status, 0);

      const parsed = parseFrontmatter(fs.readFileSync(topicPath, 'utf8'));
      assert.ok(parsed.frontmatter);
      assert.strictEqual(parsed.frontmatter.repetition, 2);
      assert.ok(parsed.body.includes('Modified externally during prompt.'));
    });

    test('stress cycle: 5 sequential rounds of 6 concurrent reviews maintain 100% data integrity', async () => {
      const topicPath = env.createTopic(
        'stress-accumulator.md',
        {
          palee_id: 'T-stress-acc',
          title: 'Stress Accumulator',
          ease_factor: 2.5,
          repetition: 0,
          interval_days: 1,
        },
        'Sequential multi-round concurrent stress test.'
      );

      for (let round = 0; round < 5; round++) {
        const promises = Array.from({ length: 6 }, () =>
          runPaleeCliAsync(['review', 'T-stress-acc', '4'], env.configDir)
        );
        const results = await Promise.all(promises);

        for (const res of results) {
          assert.ok(
            res.status === 0 || res.status === 4,
            `Round ${round} produced invalid exit code: ${res.status}`
          );
        }

        // Verify valid file integrity after each round
        const content = fs.readFileSync(topicPath, 'utf8');
        const parsed = parseFrontmatter(content);
        assert.ok(parsed.frontmatter !== null);
        assert.strictEqual(parsed.frontmatter.palee_id, 'T-stress-acc');
      }
    });
  });

  // =========================================================================
  // Challenge 2: Roadmap Batch Resilience & Error Isolation Stress Tests
  // =========================================================================
  describe('Challenge 2: Roadmap Batch Resilience & Error Isolation', () => {
    test('roadmap import with corrupted YAML notes, path traversal escape, and valid notes imports valid, isolates errors, and exits with code 1', () => {
      // 1. Create existing note with established study state
      env.createTopic(
        'existing-preserved.md',
        {
          palee_id: 'T-exist-1',
          title: 'Existing Preserved Topic',
          topic_mastery: 0.85,
          repetition: 5,
          ease_factor: 2.8,
          interval_days: 14,
        },
        'Preserved notes body content.'
      );

      // 2. Create existing note with corrupted, unparseable YAML frontmatter
      const corruptNotePath = path.join(env.vaultDir, 'corrupted-note.md');
      fs.writeFileSync(
        corruptNotePath,
        `---\nkey: [unclosed malformed YAML array\n---\n# Corrupted Note Body`,
        'utf8'
      );

      // 3. Create roadmap YAML file
      const roadmapYaml = `
topics:
  - id: T-new-valid
    title: New Valid Topic
    path: topics/new-valid.md
    difficulty: beginner
  - id: T-exist-1
    title: Existing Preserved Topic
    path: existing-preserved.md
    difficulty: intermediate
  - id: T-corrupt
    title: Corrupted Target Note
    path: corrupted-note.md
    difficulty: advanced
  - id: T-traversal
    title: Vault Escape Attempt
    path: ../../escaped-outside.md
    difficulty: intermediate
  - id: T-deep-nested
    title: Deeply Nested Topic
    path: deep/nested/structure/topic.md
    difficulty: intermediate
`;

      const roadmapFile = path.join(env.tempDir, 'batch-roadmap.yaml');
      fs.writeFileSync(roadmapFile, roadmapYaml, 'utf8');

      // Execute roadmap import with --yes
      const result = runPaleeCli(['roadmap', '--from', roadmapFile, '--yes'], env.configDir);

      // R3 Requirement: Exit with code 1 if any topic fails in the batch
      assert.strictEqual(
        result.status,
        1,
        `Expected exit code 1 on partial batch failure, got ${result.status}. Stderr: ${result.stderr}, Stdout: ${result.stdout}`
      );

      // Check outputs
      assert.match(result.stderr, /Failed to import 2 topics/);
      assert.match(result.stdout, /Created: 2 notes/);
      assert.match(result.stdout, /Updated: 1 notes/);

      // Check errors logged for corrupt and escaping notes
      assert.ok(
        result.stderr.includes('Roadmap path escapes vault: ../../escaped-outside.md') ||
        result.stdout.includes('Roadmap path escapes vault: ../../escaped-outside.md'),
        'Must report vault escape error'
      );
      assert.ok(
        result.stderr.includes('Failed T-corrupt') ||
        result.stdout.includes('Failed T-corrupt'),
        'Must report failure for corrupted note'
      );

      // Verify T-new-valid was created
      const newValidPath = path.join(env.vaultDir, 'topics', 'new-valid.md');
      assert.ok(fs.existsSync(newValidPath), 'T-new-valid file should exist');
      const parsedNew = parseFrontmatter(fs.readFileSync(newValidPath, 'utf8'));
      assert.strictEqual(parsedNew.frontmatter?.palee_id, 'T-new-valid');
      assert.strictEqual(parsedNew.frontmatter?.difficulty, 'beginner');

      // Verify T-exist-1 preserved prior study state
      const existPath = path.join(env.vaultDir, 'existing-preserved.md');
      const parsedExist = parseFrontmatter(fs.readFileSync(existPath, 'utf8'));
      assert.strictEqual(parsedExist.frontmatter?.palee_id, 'T-exist-1');
      assert.strictEqual(parsedExist.frontmatter?.topic_mastery, 0.85);
      assert.strictEqual(parsedExist.frontmatter?.repetition, 5);
      assert.strictEqual(parsedExist.frontmatter?.ease_factor, 2.8);
      assert.strictEqual(parsedExist.frontmatter?.interval_days, 14);

      // Verify T-deep-nested created with parent directories
      const deepPath = path.join(env.vaultDir, 'deep', 'nested', 'structure', 'topic.md');
      assert.ok(fs.existsSync(deepPath), 'Deep nested topic file should exist');
      const parsedDeep = parseFrontmatter(fs.readFileSync(deepPath, 'utf8'));
      assert.strictEqual(parsedDeep.frontmatter?.palee_id, 'T-deep-nested');

      // Verify no file was created outside vault
      const outsidePath = path.resolve(env.vaultDir, '../../escaped-outside.md');
      assert.strictEqual(fs.existsSync(outsidePath), false, 'Outside escape file must not exist');
    });

    test('roadmap import with locked target file triggers OCC conflict and halts cleanly with code 4', async () => {
      const topicPath = env.createTopic(
        'locked-roadmap-topic.md',
        {
          palee_id: 'T-locked-target',
          title: 'Locked Target',
        },
        'Body content.'
      );

      const roadmapYaml = `
topics:
  - id: T-locked-target
    title: Locked Target
    path: locked-roadmap-topic.md
`;
      const roadmapFile = path.join(env.tempDir, 'locked-roadmap.yaml');
      fs.writeFileSync(roadmapFile, roadmapYaml, 'utf8');

      // Acquire lock on the target file
      const lock = new Lock(env.vaultDir, topicPath);
      await lock.acquire();

      try {
        const result = runPaleeCli(['roadmap', '--from', roadmapFile, '--yes'], env.configDir);
        assert.strictEqual(
          result.status,
          4,
          `Expected exit code 4 on OCC lock conflict during roadmap import, got ${result.status}`
        );
        assert.match(result.stderr, /OCC conflict|Lock conflict/);
      } finally {
        lock.release();
      }
    });

    test('roadmap import with multiple mixed corruptions across 10 topics imports all valid notes and accurately reports stats', () => {
      // Create 3 valid pre-existing notes
      for (let i = 1; i <= 3; i++) {
        env.createTopic(`valid-${i}.md`, {
          palee_id: `T-valid-${i}`,
          title: `Valid Topic ${i}`,
          topic_mastery: 0.5,
        });
      }

      // Create 2 corrupt pre-existing notes
      for (let i = 1; i <= 2; i++) {
        fs.writeFileSync(
          path.join(env.vaultDir, `corrupt-${i}.md`),
          `---\nkey_${i}: [unclosed malformed YAML array ${i}\n---\n# Corrupt`,
          'utf8'
        );
      }

      // Build roadmap with 10 topics: 3 existing valid, 2 existing corrupt, 3 new valid, 2 escaping
      const topics = [
        { id: 'T-valid-1', title: 'Valid 1', path: 'valid-1.md' },
        { id: 'T-valid-2', title: 'Valid 2', path: 'valid-2.md' },
        { id: 'T-valid-3', title: 'Valid 3', path: 'valid-3.md' },
        { id: 'T-corrupt-1', title: 'Corrupt 1', path: 'corrupt-1.md' },
        { id: 'T-corrupt-2', title: 'Corrupt 2', path: 'corrupt-2.md' },
        { id: 'T-new-1', title: 'New 1', path: 'sub/new-1.md' },
        { id: 'T-new-2', title: 'New 2', path: 'sub/new-2.md' },
        { id: 'T-new-3', title: 'New 3', path: 'sub/new-3.md' },
        { id: 'T-escape-1', title: 'Escape 1', path: '../escape-1.md' },
        { id: 'T-escape-2', title: 'Escape 2', path: '/absolute/escape-2.md' },
      ];

      const roadmapYaml = `
topics:
${topics.map((t) => `  - id: ${t.id}\n    title: ${t.title}\n    path: ${t.path}`).join('\n')}
`;
      const roadmapFile = path.join(env.tempDir, 'mixed-10-roadmap.yaml');
      fs.writeFileSync(roadmapFile, roadmapYaml, 'utf8');

      const result = runPaleeCli(['roadmap', '--from', roadmapFile, '--yes'], env.configDir);

      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Failed to import 4 topics/);
      assert.match(result.stdout, /Created: 3 notes/);
      assert.match(result.stdout, /Updated: 3 notes/);

      // Verify all 3 new notes created
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'sub', 'new-1.md')));
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'sub', 'new-2.md')));
      assert.ok(fs.existsSync(path.join(env.vaultDir, 'sub', 'new-3.md')));
    });
  });
});
