import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';
import { parseFrontmatter } from '../src/storage';

/**
 * Characterization tests for hot.md read behavior across session flows,
 * pinned ahead of the #130 read-accessor extraction. Each describe block
 * asserts the *current* policy of exactly one flow; do not normalize their
 * differing age/skew rules (draft: 24h/no-future; end: no age limit +
 * 60s future skew; start: rebuild on corrupt/schema-invalid only).
 */
describe('Session hot.md read characterization', () => {
  let tempDir: string;
  let vaultDir: string;
  let prevConfigDir: string | undefined;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-hot-char-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;
    saveConfig({ vaultPath: vaultDir });
  });

  after(() => {
    process.exitCode = 0;
    if (prevConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.exitCode = undefined;
    const paleeDir = path.join(vaultDir, '.palee');
    if (fs.existsSync(paleeDir)) {
      fs.rmSync(paleeDir, { recursive: true, force: true });
    }
    fs.mkdirSync(paleeDir, { recursive: true });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  /** Writes hot.md with the given frontmatter lines (schema included unless caller omits). */
  function writeHot(frontmatterLines: string[], body = '# Working Memory\n'): string {
    const hotPath = path.join(vaultDir, '.palee', 'hot.md');
    const fm = frontmatterLines.length > 0
      ? `---\n${frontmatterLines.join('\n')}\n---\n`
      : '';
    fs.writeFileSync(hotPath, `${fm}${body}`, 'utf8');
    return hotPath;
  }

  /** Reads the started_at written into the newest draft checkpoint. */
  function readDraftStart(): string | undefined {
    const draftsDir = path.join(vaultDir, '.palee', 'sessions');
    const drafts = fs.readdirSync(draftsDir).filter(f => f.startsWith('DRAFT-S-'));
    if (drafts.length === 0) return undefined;
    const { frontmatter } = parseFrontmatter(
      fs.readFileSync(path.join(draftsDir, drafts[0]), 'utf8')
    );
    return frontmatter?.started_at as string | undefined;
  }

  // ── Topic resolution: swallows every read/parse problem ──────────────

  describe('topic resolution', () => {
    test('reads active_topic from valid hot.md', async () => {
      writeHot(['palee_schema: 1', 'active_topic: T-res-resolve']);
      await sessionCommand('draft');
      // Success leaves process.exitCode unset (undefined)
      assert.notStrictEqual(process.exitCode, 2);
      const inherited = readDraftStart();
      assert.ok(inherited, 'draft checkpoint must exist for resolved topic');
    });
  });

  // ── Start: rebuilds corrupt/schema-invalid; tolerates no-frontmatter ──

  describe('start policy', () => {
    test('rebuilds hot.md when frontmatter has no palee_schema', async () => {
      writeHot(['memory_id: H-active', 'active_topic: T-schemaless']);
      await sessionCommand('start');
      const hotPath = path.join(vaultDir, '.palee', 'hot.md');
      const { frontmatter } = parseFrontmatter(fs.readFileSync(hotPath, 'utf8'));
      assert.ok(frontmatter?.palee_schema, 'hot.md must be rebuilt with schema');
    });

    test('rebuilds hot.md when palee_schema is an unsupported version', async () => {
      // Strict contract (ADR-0007): only palee_schema: 1 is supported. A version-2
      // hot.md previously classified as ok (truthiness) and skipped the rebuild.
      writeHot(['palee_schema: 2', 'active_topic: T-v2']);
      await sessionCommand('start');
      const hotPath = path.join(vaultDir, '.palee', 'hot.md');
      const { frontmatter } = parseFrontmatter(fs.readFileSync(hotPath, 'utf8'));
      assert.strictEqual(frontmatter?.palee_schema, 1, 'hot.md must be rebuilt at schema 1');
    });

    test('rebuilds hot.md when frontmatter is malformed YAML', async () => {
      const hotPath = path.join(vaultDir, '.palee', 'hot.md');
      fs.writeFileSync(hotPath, '---\nbroken: [ { invalid yaml\n---\n# Corrupt\n', 'utf8');
      await sessionCommand('start');
      const { frontmatter } = parseFrontmatter(fs.readFileSync(hotPath, 'utf8'));
      assert.ok(frontmatter?.palee_schema, 'hot.md must be rebuilt after malformed YAML');
    });

    test('tolerates hot.md with no frontmatter without rebuilding', async () => {
      // No frontmatter fences: parseFrontmatter returns frontmatter null WITHOUT error.
      // start's rebuild condition is state corrupt/schema-invalid — no-frontmatter
      // takes the tolerant no-rebuild path, per the #130 behavior matrix.
      const hotPath = path.join(vaultDir, '.palee', 'hot.md');
      fs.writeFileSync(hotPath, 'plain body without frontmatter\n', 'utf8');
      const before = fs.readFileSync(hotPath, 'utf8');
      await sessionCommand('start');
      const after = fs.readFileSync(hotPath, 'utf8');
      assert.strictEqual(after, before, 'no-frontmatter hot.md must NOT be rebuilt by start');
    });

    test('empty-fence frontmatter (--- \\n ---) does not trigger corrupt rebuild', async () => {
      // ---\n--- empty fence: parseFrontmatter returns frontmatter null WITHOUT error.
      // start's rebuild condition is state corrupt/schema-invalid — no-frontmatter
      // takes the tolerant no-rebuild path (prints with (none) fields).
      const hotPath = path.join(vaultDir, '.palee', 'hot.md');
      fs.writeFileSync(hotPath, '---\n---\nempty fence body\n', 'utf8');
      await sessionCommand('start');
      assert.notStrictEqual(process.exitCode, 5, 'start must not crash on empty fence');
      // hot.md is not reset+rebuilt in this path; body content is preserved as-is in output path
    });
  });

  // ── Draft: same-topic, ≤24h old, not future ─────────────────────────

  describe('draft inheritance policy', () => {
    test('inherits started_at when same topic and within 24h', async () => {
      const past = new Date(Date.now() - 3600000).toISOString(); // 1h ago
      writeHot([
        'palee_schema: 1',
        'active_topic: T-draft-24h',
        `started_at: "${past}"`,
      ]);
      await sessionCommand('draft', { topic: 'T-draft-24h' });
      assert.strictEqual(readDraftStart(), past, 'draft must inherit same-topic started_at within 24h');
    });

    test('rejects started_at older than 24h (falls back to now)', async () => {
      const stale = new Date(Date.now() - 25 * 3600000).toISOString(); // 25h ago
      writeHot([
        'palee_schema: 1',
        'active_topic: T-draft-stale',
        `started_at: "${stale}"`,
      ]);
      await sessionCommand('draft', { topic: 'T-draft-stale' });
      const inherited = readDraftStart();
      assert.ok(inherited);
      assert.notStrictEqual(inherited, stale, 'draft must not inherit >24h timestamp');
      assert.ok(Math.abs(new Date(inherited!).getTime() - Date.now()) < 120000, 'fallback must be ~now');
    });

    test('rejects future started_at beyond 60s (falls back to now)', async () => {
      const future = new Date(Date.now() + 600000).toISOString(); // 10min future
      writeHot([
        'palee_schema: 1',
        'active_topic: T-draft-future',
        `started_at: "${future}"`,
      ]);
      await sessionCommand('draft', { topic: 'T-draft-future' });
      const inherited = readDraftStart();
      assert.ok(inherited);
      assert.ok(new Date(inherited!).getTime() <= Date.now() + 5000, 'fallback must not be future');
    });

    test('ignores started_at when active topic differs', async () => {
      const past = new Date(Date.now() - 3600000).toISOString();
      writeHot([
        'palee_schema: 1',
        'active_topic: T-other-topic',
        `started_at: "${past}"`,
      ]);
      await sessionCommand('draft', { topic: 'T-draft-mismatch' });
      const inherited = readDraftStart();
      assert.ok(inherited);
      assert.notStrictEqual(inherited, past, 'must not inherit cross-topic timestamp');
    });

    test('ignores non-string or invalid started_at', async () => {
      writeHot([
        'palee_schema: 1',
        'active_topic: T-draft-bad-date',
        'started_at: not-a-date',
      ]);
      await sessionCommand('draft', { topic: 'T-draft-bad-date' });
      const inherited = readDraftStart();
      assert.ok(inherited);
      assert.ok(!Number.isNaN(new Date(inherited!).getTime()), 'fallback must be valid timestamp');
    });
  });

  // ── End: Tier-2 hot.md recovery — no age limit, 60s future skew ──────

  describe('end policy (tier 2)', () => {
    test('recovers same-topic started_at older than 24h (no age limit)', async () => {
      const old = new Date(Date.now() - 48 * 3600000).toISOString(); // 48h ago
      writeHot([
        'palee_schema: 1',
        'active_topic: T-end-48h',
        `started_at: "${old}"`,
      ]);
      await sessionCommand('end', { topic: 'T-end-48h' });
      const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
      const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1);
      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(sessionsDir, confirmed[0]), 'utf8')
      );
      assert.strictEqual(frontmatter?.started_at, old, 'end must recover any-age same-topic started_at');
      assert.strictEqual(frontmatter?.duration_minutes, 2880, '48h in minutes');
    });

    test('clamps same-topic started_at within 60s future skew', async () => {
      const skew = new Date(Date.now() + 30000).toISOString(); // 30s future
      writeHot([
        'palee_schema: 1',
        'active_topic: T-end-skew',
        `started_at: "${skew}"`,
      ]);
      await sessionCommand('end', { topic: 'T-end-skew' });
      const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
      const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1);
      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(sessionsDir, confirmed[0]), 'utf8')
      );
      assert.ok(frontmatter?.started_at);
      assert.ok(
        new Date(frontmatter!.started_at as string).getTime() <= Date.now() + 1000,
        'skewed future start must be clamped to <= now'
      );
    });

    test('rejects same-topic started_at beyond 60s future (tier 3 fallback)', async () => {
      const future = new Date(Date.now() + 600000).toISOString(); // 10min future
      writeHot([
        'palee_schema: 1',
        'active_topic: T-end-future',
        `started_at: "${future}"`,
      ]);
      await sessionCommand('end', { topic: 'T-end-future' });
      const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
      const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1);
      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(sessionsDir, confirmed[0]), 'utf8')
      );
      assert.ok(frontmatter?.started_at);
      assert.ok(
        Math.abs(new Date(frontmatter!.started_at as string).getTime() - Date.now()) < 120000,
        'beyond-skew future must fall back to current instant'
      );
    });

    test('ignores hot.md started_at when active topic differs (tier 3 fallback)', async () => {
      const past = new Date(Date.now() - 3600000).toISOString();
      writeHot([
        'palee_schema: 1',
        'active_topic: T-someone-else',
        `started_at: "${past}"`,
      ]);
      await sessionCommand('end', { topic: 'T-end-mismatch' });
      const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
      const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1);
      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(sessionsDir, confirmed[0]), 'utf8')
      );
      assert.notStrictEqual(frontmatter?.started_at, past, 'must not recover cross-topic timestamp');
    });

    test('recovers from malformed hot.md without throwing (swallow → tier 3)', async () => {
      const hotPath = path.join(vaultDir, '.palee', 'hot.md');
      fs.writeFileSync(hotPath, '---\nbroken: [ { invalid yaml\n---\n# Corrupt\n', 'utf8');
      await sessionCommand('end', { topic: 'T-end-corrupt' });
      const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
      const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1, 'end must complete via tier 3 fallback despite corrupt hot.md');
    });
  });

  // ── Wrong-typed frontmatter values ──────────────────────────────────

  describe('wrong-typed fields', () => {
    test('topic resolution ignores non-string active_topic', async () => {
      writeHot(['palee_schema: 1', 'active_topic: 42']);
      // draft without explicit topic → resolution from hot.md must yield null → exitCode 2
      await sessionCommand('draft');
      assert.strictEqual(process.exitCode, 2);
    });

    test('end ignores non-string started_at (tier 3 fallback)', async () => {
      writeHot(['palee_schema: 1', 'active_topic: T-end-num', 'started_at: 12345']);
      await sessionCommand('end', { topic: 'T-end-num' });
      const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
      const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1);
    });
  });

  // ── Non-ENOENT read failures: propagation is caller-specific ────────

  describe('non-ENOENT read failures (EACCES)', () => {
    /**
     * Patches fs.readFileSync to throw EACCES for hot.md only; restores in finally.
     * Returns a spy the caller invokes after the command to restore early if needed.
     */
    function patchHotReadFailure(): () => void {
      const origReadFileSync = fs.readFileSync;
      (fs as any).readFileSync = (p: any, ...rest: any[]) => {
        if (typeof p === 'string' && p.includes('hot.md')) {
          const e = new Error(`EACCES: permission denied, open '${p}'`) as NodeJS.ErrnoException;
          e.code = 'EACCES';
          throw e;
        }
        return origReadFileSync(p, ...rest);
      };
      return () => { (fs as any).readFileSync = origReadFileSync; };
    }

    test('topic resolution swallows EACCES and reports no active topic', async () => {
      writeHot(['palee_schema: 1', 'active_topic: T-locked']);
      const restore = patchHotReadFailure();
      try {
        await sessionCommand('draft'); // no explicit topic → resolution must read hot.md
        assert.strictEqual(process.exitCode, 2, 'swallowed read failure → no topic → usage error');
      } finally {
        restore();
      }
    });

    test('draft swallows EACCES and falls back to now', async () => {
      writeHot(['palee_schema: 1', 'active_topic: T-draft-eacces', `started_at: "${new Date(Date.now() - 3600000).toISOString()}"`]);
      const restore = patchHotReadFailure();
      try {
        await sessionCommand('draft', { topic: 'T-draft-eacces' }); // explicit topic skips resolution read
        assert.notStrictEqual(process.exitCode, 2, 'draft must survive hot.md read failure');
        const inherited = readDraftStart();
        assert.ok(inherited);
        assert.ok(Math.abs(new Date(inherited!).getTime() - Date.now()) < 120000, 'fallback must be ~now');
      } finally {
        restore();
      }
    });

    test('end swallows EACCES in tier 2 (tier 3 fallback) but rebuild propagates to exit 5', async () => {
      writeHot(['palee_schema: 1', 'active_topic: T-end-eacces', `started_at: "${new Date(Date.now() - 3600000).toISOString()}"`]);
      const restore = patchHotReadFailure();
      try {
        await sessionCommand('end', { topic: 'T-end-eacces' }); // explicit topic skips resolution read
        // Tier-2 read swallowed → session note still written with ~now started_at
        const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
        const confirmed = fs.readdirSync(sessionsDir).filter(f => f.startsWith('S-'));
        assert.strictEqual(confirmed.length, 1, 'session note must be written despite hot.md read failure');
        const { frontmatter } = parseFrontmatter(
          fs.readFileSync(path.join(sessionsDir, confirmed[0]), 'utf8')
        );
        assert.ok(
          Math.abs(new Date(frontmatter!.started_at as string).getTime() - Date.now()) < 120000,
          'tier 3 fallback must be ~now'
        );
        // The post-write rebuild reads hot.md for its OCC fingerprint and propagates EACCES
        assert.strictEqual(process.exitCode, 5, 'rebuild failure must propagate to command catch');
      } finally {
        restore();
      }
    });

    test('start propagates EACCES to the command catch (exit 5)', async () => {
      writeHot(['palee_schema: 1', 'active_topic: T-start-eacces']);
      const restore = patchHotReadFailure();
      const origError = console.error;
      let logged = '';
      console.error = (msg?: unknown) => { logged += String(msg ?? ''); };
      try {
        await sessionCommand('start');
        assert.strictEqual(process.exitCode, 5, 'initial hot.md read failure must reach command catch');
        assert.match(logged, /EACCES|permission denied/);
      } finally {
        restore();
        console.error = origError;
      }
    });
  });
});
