import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  writeSessionNote,
  updateHotMemory,
  regenerateIndex,
  writeDraftCheckpoint,
  recoverDraft,
  walkVault,
  ensureVaultDirectory,
  parseFrontmatter,
  Lock,
} from '../src/storage';
import { createTestVault, TestVaultEnv, runPaleeCli } from './e2e/test-env';

describe('Empirical Challenger 1: Deep Verification & Stress Test Suite', () => {
  let env: TestVaultEnv;

  beforeEach(() => {
    env = createTestVault('chal1-deep-');
  });

  afterEach(() => {
    env.cleanup();
  });

  // =========================================================================
  // Challenge Area 1: Concurrency Stress & OCC Contention on Hot Memory & Locks
  // =========================================================================
  describe('Area 1: Concurrency Stress & OCC Contention', () => {
    test('concurrent multi-worker updates to hot memory enforce OCC without corruption or lost updates', async () => {
      // 1. Initialize hot memory
      await updateHotMemory(env.vaultDir, 'S-init', 'T-init', 'Initial summary text', '2026-08-30T10:00:00.000Z');
      const hotPath = path.join(env.vaultDir, '.palee', 'hot.md');
      assert.ok(fs.existsSync(hotPath));

      // 2. Perform 15 concurrent updateHotMemory operations simulating parallel workers
      const updateWorkers = Array.from({ length: 15 }, (_, i) => {
        return (async () => {
          try {
            await updateHotMemory(
              env.vaultDir,
              `S-worker-${i}`,
              `T-worker-${i}`,
              `Summary from worker ${i} notes.`,
              '2026-08-30T12:00:00.000Z'
            );
            return { worker: i, success: true };
          } catch (err: any) {
            return { worker: i, success: false, error: err.message, isConflict: err.code === 'ECONFLICT' || err.message?.includes('conflict') };
          }
        })();
      });

      const results = await Promise.all(updateWorkers);
      const successful = results.filter((r) => r.success);
      const conflicts = results.filter((r) => !r.success);

      // At least 1 update succeeds
      assert.ok(successful.length >= 1, `Expected at least 1 successful hot update, got ${successful.length}`);

      // Any failed update MUST be due to OCC conflict, never unhandled error
      for (const c of conflicts) {
        assert.ok(c.isConflict, `Failed worker error must be OCC conflict: ${c.error}`);
      }

      // Hot memory file must remain valid markdown with intact frontmatter
      const content = fs.readFileSync(hotPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      assert.ok(frontmatter !== null, 'Frontmatter must remain valid');
      assert.strictEqual(frontmatter.memory_id, 'H-active');
      assert.strictEqual(frontmatter.palee_schema, 1);
      assert.ok(body.length > 0);

      // The persisted state must match exactly one worker that reported success
      const winners = successful.map((r) => `S-worker-${r.worker}`);
      assert.ok(
        winners.includes(frontmatter.last_session as string),
        `Persisted last_session (${frontmatter.last_session}) must match one of the successful workers (${winners.join(', ')})`
      );
    });

    test('high-contention lock acquisition properly blocks and releases without stale lock leakage', async () => {
      const targetFile = path.join(env.vaultDir, 'contested-target.md');
      fs.writeFileSync(targetFile, '# Target\n', 'utf8');

      const lock = new Lock(env.vaultDir, targetFile);
      await lock.acquire();

      // Second lock acquisition on the same file MUST fail with ECONFLICT
      const lock2 = new Lock(env.vaultDir, targetFile);
      let secondLockFailed = false;
      try {
        await lock2.acquire();
      } catch (err: any) {
        secondLockFailed = true;
        assert.strictEqual(err.code, 'ECONFLICT');
      }
      assert.strictEqual(secondLockFailed, true, 'Second lock acquisition must throw ECONFLICT');

      // Release first lock
      lock.release();

      // Now second lock can acquire successfully
      await lock2.acquire();
      lock2.release();
    });
  });

  // =========================================================================
  // Challenge Area 2: Non-ENOENT Pre-Read Error Handling in memory.ts
  // =========================================================================
  describe('Area 2: Non-ENOENT Error Handling in memory.ts', () => {
    test('writeSessionNote rethrows non-ENOENT errors (e.g. EACCES / EBUSY) and does NOT set expectedFingerprint = null', async () => {
      const targetPath = path.join(env.vaultDir, '.palee', 'sessions', 'S-test-eacces.md');
      const originalReadFileSync = fs.readFileSync;
      const originalExistsSync = fs.existsSync;

      try {
        // Simulate EACCES error during readFileSync on session note
        (fs as any).existsSync = (filePath: string) => {
          if (filePath === targetPath) return true;
          return originalExistsSync(filePath);
        };

        (fs as any).readFileSync = (filePath: string, options: any) => {
          if (filePath === targetPath) {
            const err = new Error('Permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return originalReadFileSync(filePath, options);
        };

        let threwEACCES = false;
        try {
          await writeSessionNote(
            env.vaultDir,
            {
              session_id: 'S-test-eacces',
              topic_id: 'T-test',
              started_at: '2026-08-30T10:00:00Z',
              ended_at: '2026-08-30T10:30:00Z',
              duration_minutes: 30,
            },
            'Session notes body'
          );
        } catch (err: any) {
          threwEACCES = true;
          assert.strictEqual(err.code, 'EACCES', `Expected rethrown EACCES, got: ${err.code || err.message}`);
        }

        assert.strictEqual(threwEACCES, true, 'writeSessionNote must rethrow non-ENOENT EACCES error');
      } finally {
        (fs as any).readFileSync = originalReadFileSync;
        (fs as any).existsSync = originalExistsSync;
      }
    });

    test('updateHotMemory rethrows EBUSY / EPERM and does NOT bypass OCC', async () => {
      const targetPath = path.join(env.vaultDir, '.palee', 'hot.md');
      const originalReadFileSync = fs.readFileSync;
      const originalExistsSync = fs.existsSync;

      try {
        (fs as any).existsSync = (filePath: string) => {
          if (filePath === targetPath) return true;
          return originalExistsSync(filePath);
        };

        (fs as any).readFileSync = (filePath: string, options: any) => {
          if (filePath === targetPath) {
            const err = new Error('Resource busy or locked') as NodeJS.ErrnoException;
            err.code = 'EBUSY';
            throw err;
          }
          return originalReadFileSync(filePath, options);
        };

        let threwEBUSY = false;
        try {
          await updateHotMemory(env.vaultDir, 'S-1', 'T-1', 'Notes body');
        } catch (err: any) {
          threwEBUSY = true;
          assert.strictEqual(err.code, 'EBUSY');
        }
        assert.strictEqual(threwEBUSY, true, 'updateHotMemory must rethrow EBUSY error');
      } finally {
        (fs as any).readFileSync = originalReadFileSync;
        (fs as any).existsSync = originalExistsSync;
      }
    });

    test('regenerateIndex rethrows EPERM and does NOT downgrade expectedFingerprint', async () => {
      const targetPath = path.join(env.vaultDir, '.palee', 'index.md');
      const originalReadFileSync = fs.readFileSync;
      const originalExistsSync = fs.existsSync;

      try {
        (fs as any).existsSync = (filePath: string) => {
          if (filePath === targetPath) return true;
          return originalExistsSync(filePath);
        };

        (fs as any).readFileSync = (filePath: string, options: any) => {
          if (filePath === targetPath) {
            const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
            err.code = 'EPERM';
            throw err;
          }
          return originalReadFileSync(filePath, options);
        };

        let threwEPERM = false;
        try {
          await regenerateIndex(env.vaultDir);
        } catch (err: any) {
          threwEPERM = true;
          assert.strictEqual(err.code, 'EPERM');
        }
        assert.strictEqual(threwEPERM, true, 'regenerateIndex must rethrow EPERM error');
      } finally {
        (fs as any).readFileSync = originalReadFileSync;
        (fs as any).existsSync = originalExistsSync;
      }
    });

    test('writeDraftCheckpoint rethrows EACCES without bypassing OCC', async () => {
      const targetPath = path.join(env.vaultDir, '.palee', 'sessions', 'DRAFT-S-err.md');
      const originalReadFileSync = fs.readFileSync;
      const originalExistsSync = fs.existsSync;

      try {
        (fs as any).existsSync = (filePath: string) => {
          if (filePath === targetPath) return true;
          return originalExistsSync(filePath);
        };

        (fs as any).readFileSync = (filePath: string, options: any) => {
          if (filePath === targetPath) {
            const err = new Error('Permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return originalReadFileSync(filePath, options);
        };

        let threwEACCES = false;
        try {
          await writeDraftCheckpoint(env.vaultDir, 'DRAFT-S-err', { topic_id: 'T-1', started_at: '2026-08-30T10:00:00Z' }, 'Draft notes');
        } catch (err: any) {
          threwEACCES = true;
          assert.strictEqual(err.code, 'EACCES');
        }
        assert.strictEqual(threwEACCES, true, 'writeDraftCheckpoint must rethrow EACCES error');
      } finally {
        (fs as any).readFileSync = originalReadFileSync;
        (fs as any).existsSync = originalExistsSync;
      }
    });
  });

  // =========================================================================
  // Challenge Area 3: Cross-Midnight & Timestamp Recency Invariants
  // =========================================================================
  describe('Area 3: Elapsed Session Duration & Timestamp Recency Invariants', () => {
    test('session end on draft checkpoint accurately preserves 45-minute elapsed duration and satisfies started_at <= ended_at', () => {
      // 1. Create a draft note started 45 minutes ago
      const now = new Date();
      const fortyFiveMinsAgo = new Date(now.getTime() - 45 * 60 * 1000);
      const startedAtIso = fortyFiveMinsAgo.toISOString();

      const draftPath = path.join(env.vaultDir, '.palee', 'sessions', 'DRAFT-S-midnight.md');
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(
        draftPath,
        `---\npalee_schema: 1\nsession_id: DRAFT-S-midnight\ntopic_id: T-midnight\nstarted_at: '${startedAtIso}'\nended_at: null\nstatus: draft\n---\n# Draft\n\nCross midnight draft notes.`,
        'utf8'
      );

      // 2. End session on topic T-midnight
      const result = runPaleeCli(['session', 'end', '--topic', 'T-midnight'], env.configDir);
      assert.strictEqual(result.status, 0, `CLI failed with: ${result.stderr}`);

      // 3. Find created session note
      const sessionsDir = path.join(env.vaultDir, '.palee', 'sessions');
      const sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.startsWith('S-') && !f.startsWith('DRAFT-'));
      assert.strictEqual(sessionFiles.length, 1);

      const sessionContent = fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), 'utf8');
      const { frontmatter } = parseFrontmatter(sessionContent);
      assert.ok(frontmatter);

      const sessionStarted = new Date(frontmatter.started_at as string).getTime();
      const sessionEnded = new Date(frontmatter.ended_at as string).getTime();

      // Invariant checks
      assert.ok(sessionStarted <= sessionEnded, `Invariant violated: started_at (${sessionStarted}) > ended_at (${sessionEnded})`);
      assert.strictEqual(frontmatter.started_at, startedAtIso);
      const durationMin = Number(frontmatter.duration_minutes);
      assert.ok(
        durationMin >= 44 && durationMin <= 46,
        `Expected duration around 45 min, got ${durationMin}`
      );
      assert.ok(!Number.isNaN(durationMin));
    });

    test('draft checkpoint with future timestamp is strictly rejected/clamped so started_at <= ended_at', async () => {
      // Create draft with future timestamp (+30 minutes in future)
      const futureTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const draftPath = path.join(env.vaultDir, '.palee', 'sessions', 'DRAFT-S-future.md');
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(
        draftPath,
        `---\npalee_schema: 1\nsession_id: DRAFT-S-future\ntopic_id: T-future\nstarted_at: '${futureTime}'\nended_at: null\nstatus: draft\n---\n# Future Draft\n\nFuture notes.`,
        'utf8'
      );

      // Recover draft via save
      await recoverDraft(env.vaultDir, draftPath, 'save');

      const sessionsDir = path.join(env.vaultDir, '.palee', 'sessions');
      const sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.startsWith('S-') && !f.startsWith('DRAFT-'));
      assert.strictEqual(sessionFiles.length, 1);

      const sessionContent = fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), 'utf8');
      const { frontmatter } = parseFrontmatter(sessionContent);
      assert.ok(frontmatter);

      const sessionStarted = new Date(frontmatter.started_at as string).getTime();
      const sessionEnded = new Date(frontmatter.ended_at as string).getTime();

      // Invariant: started_at MUST NOT be in future, must be <= ended_at
      assert.ok(sessionStarted <= sessionEnded, `Future start leaked: started_at (${sessionStarted}) > ended_at (${sessionEnded})`);
      assert.strictEqual(frontmatter.duration_minutes, 0);
    });

    test('draft checkpoint older than 24 hours accurately preserves multi-day duration without discarding study time', async () => {
      // Create draft with timestamp 30 hours ago
      const staleTime = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      const draftPath = path.join(env.vaultDir, '.palee', 'sessions', 'DRAFT-S-stale.md');
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(
        draftPath,
        `---\npalee_schema: 1\nsession_id: DRAFT-S-stale\ntopic_id: T-stale\nstarted_at: '${staleTime}'\nended_at: null\nstatus: draft\n---\n# Stale Draft\n\nStale notes.`,
        'utf8'
      );

      // Recover draft via save
      await recoverDraft(env.vaultDir, draftPath, 'save');

      const sessionsDir = path.join(env.vaultDir, '.palee', 'sessions');
      const sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.startsWith('S-') && !f.startsWith('DRAFT-'));
      assert.strictEqual(sessionFiles.length, 1);

      const sessionContent = fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), 'utf8');
      const { frontmatter } = parseFrontmatter(sessionContent);
      assert.ok(frontmatter);

      const sessionStarted = new Date(frontmatter.started_at as string).getTime();
      const sessionEnded = new Date(frontmatter.ended_at as string).getTime();

      assert.ok(sessionStarted <= sessionEnded);
      const durationMin = Number(frontmatter.duration_minutes);
      assert.ok(durationMin >= 1790 && durationMin <= 1810, `Expected ~1800 min, got ${durationMin}`);
    });
  });

  // =========================================================================
  // Challenge Area 4: Vault Boundary Edge Cases & ..custom Paths
  // =========================================================================
  describe('Area 4: Vault Boundary Edge Cases', () => {
    test('ensureVaultDirectory accepts legitimate ..custom directory names within the vault', () => {
      // 1. Single level ..custom directory
      const dir1 = ensureVaultDirectory(env.vaultDir, '..custom/notes.md');
      assert.ok(fs.existsSync(dir1));
      assert.ok(dir1.includes('..custom'));

      // 2. Nested directory containing ..custom component
      const dir2 = ensureVaultDirectory(env.vaultDir, 'subfolder/..custom-nested/topic.md');
      assert.ok(fs.existsSync(dir2));
      assert.ok(dir2.includes('..custom-nested'));

      // 3. Verify walkVault handles the directory structure without error
      const files = walkVault(env.vaultDir);
      assert.ok(Array.isArray(files));
    });

    test('ensureVaultDirectory strictly rejects all path traversal escapes', () => {
      // 1. Parent directory escape
      assert.throws(() => {
        ensureVaultDirectory(env.vaultDir, '../escaped.md');
      }, /escaped|escapes vault/i);

      // 2. Deep relative escape
      assert.throws(() => {
        ensureVaultDirectory(env.vaultDir, 'nested/../../escaped.md');
      }, /escaped|escapes vault/i);

      // 3. Absolute path outside vault
      const outsideDir = path.resolve(env.vaultDir, '..', 'completely-outside');
      assert.throws(() => {
        ensureVaultDirectory(env.vaultDir, path.join(outsideDir, 'note.md'));
      }, /escaped|escapes vault/i);
    });

    test('roadmap import with ..custom path creates note successfully, while ../escape fails', () => {
      const roadmapYaml = `
topics:
  - id: T-custom-dir
    title: Custom Dir Topic
    path: ..custom/valid-note.md
  - id: T-escape-dir
    title: Escape Dir Topic
    path: ../escape.md
`;
      const roadmapFile = path.join(env.tempDir, 'boundary-roadmap.yaml');
      fs.writeFileSync(roadmapFile, roadmapYaml, 'utf8');

      const result = runPaleeCli(['roadmap', '--from', roadmapFile, '--yes'], env.configDir);
      assert.strictEqual(result.status, 1, `Expected partial failure exit code 1, got ${result.status}`);

      // Verify ..custom file was created
      const customPath = path.join(env.vaultDir, '..custom', 'valid-note.md');
      assert.ok(fs.existsSync(customPath), '..custom/valid-note.md should exist');

      // Verify escape file was NOT created
      const escapePath = path.resolve(env.vaultDir, '../escape.md');
      assert.strictEqual(fs.existsSync(escapePath), false, '../escape.md must not exist');
    });
  });
});
