/**
 * validate --fix: safe repairs dispatch off the rules' own `fixable`
 * metadata (#323).
 *
 * Contracts under test:
 * - A rule declaring `fixable: 'safe'` has its finding repaired by `--fix`
 *   (previously the engine hard-coded the one `'manual'` rule it knew about
 *   and never read the field, so every `'safe'` declaration was decorative).
 * - `.palee/index.md` and `.palee/hot.md` are rebuilt through the storage
 *   layer's own `rebuildHotAndIndex` entry point, so the rebuild carries that
 *   path's lock + OCC fingerprint discipline instead of a second writer.
 * - Drifted `topic_mastery` is recomputed from the note's own pillars through
 *   the engine's single mastery writer, never copied from the finding.
 * - A repair that cannot be applied safely is reported through
 *   `repair_conflicts`, never silently skipped.
 * - Rules whose metadata does not admit a repair are left alone.
 * - Repair counts never leak into `valid`/`error_count` or the exit-code
 *   policy (errors gate; warnings gate only under `--strict`).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateCommand } from '../src/cli/validate';
import { VALIDATION_RULES } from '../src/validation';
import type { ValidationIssue, ValidationRule } from '../src/validation/types';
import { Lock, parseFrontmatter } from '../src/storage';

/** Expected mastery for the drift fixture: round((0.8+0.7+0.9+2*0.85)/5, 4). */
const PILLAR_EXPECTED = 0.82;

/**
 * Isolated temp vault + PALEE config (mirrors cli-validate-fix-sm2.test.ts).
 * `isTTY` forces the human/JSON output mode deterministically, because
 * `isJsonOutput()` also auto-switches on a non-TTY stdout.
 */
async function runInTempVault(
  fn: (vaultPath: string) => Promise<void>,
  options: { isTTY?: boolean } = {}
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-fix323-'));
  const vaultPath = path.join(tempDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ vaultPath }, null, 2));

  const origConfigDir = process.env.PALEE_CONFIG_DIR;
  const origIsTTY = process.stdout.isTTY;
  const origExitCode = process.exitCode;
  process.env.PALEE_CONFIG_DIR = tempDir;
  process.stdout.isTTY = options.isTTY ?? true;
  process.exitCode = 0;
  try {
    await fn(vaultPath);
  } finally {
    process.stdout.isTTY = origIsTTY;
    process.exitCode = origExitCode;
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Runs an action capturing console.log/console.error into strings. */
async function captureOutput(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const origLog = console.log;
  const origError = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => { out += `${args.join(' ')}\n`; };
  console.error = (...args: unknown[]) => { err += `${args.join(' ')}\n`; };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out, err };
}

/** Writes a schema-v1 topic note with the given extra frontmatter keys. */
function writeTopic(
  vaultPath: string,
  filename: string,
  extra: Record<string, unknown> = {}
): string {
  const frontmatter: Record<string, unknown> = {
    palee_schema: 1,
    title: `Topic ${filename}`,
    difficulty: 'beginner',
    depends_on: [],
    ...extra,
  };
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : JSON.stringify(v)}`)
    .join('\n');
  const filePath = path.join(vaultPath, filename);
  fs.writeFileSync(filePath, `---\n${yaml}\n---\nBody text\n`);
  return filePath;
}

/** Writes a confirmed session note under `.palee/sessions/`. */
function writeSession(
  vaultPath: string,
  sessionId: string,
  topicId: string,
  startedAt: string
): string {
  const paleeDir = path.join(vaultPath, '.palee');
  fs.mkdirSync(path.join(paleeDir, 'sessions'), { recursive: true });
  // `.palee` metadata files quote all strings (agent.md on-disk formats).
  const yaml = [
    'palee_schema: 1',
    `session_id: "${sessionId}"`,
    `topic_id: "${topicId}"`,
    `started_at: "${startedAt}"`,
    `ended_at: "${startedAt}"`,
    'status: "completed"',
  ].join('\n');
  const filePath = path.join(paleeDir, 'sessions', `${sessionId}.md`);
  fs.writeFileSync(filePath, `---\n${yaml}\n---\n# Session: ${sessionId}\n\nWorking through the material.\n`);
  return filePath;
}

/** Writes `.palee/index.md` verbatim (caller supplies the stale/corrupt bytes). */
function writeIndex(vaultPath: string, content: string): string {
  const paleeDir = path.join(vaultPath, '.palee');
  fs.mkdirSync(paleeDir, { recursive: true });
  const filePath = path.join(paleeDir, 'index.md');
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Writes `.palee/hot.md` from a frontmatter map plus a body. */
function writeHot(
  vaultPath: string,
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const paleeDir = path.join(vaultPath, '.palee');
  fs.mkdirSync(paleeDir, { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join('\n');
  const filePath = path.join(paleeDir, 'hot.md');
  fs.writeFileSync(filePath, `---\n${yaml}\n---\n${body}`);
  return filePath;
}

/** Reads parsed frontmatter from a vault-relative path. */
function readFrontmatter(vaultPath: string, relPath: string): Record<string, unknown> {
  const content = fs.readFileSync(path.join(vaultPath, relPath), 'utf8');
  return parseFrontmatter(content).frontmatter || {};
}

/** Reads a vault-relative file, or null when it does not exist. */
function readIfPresent(vaultPath: string, relPath: string): string | null {
  const abs = path.join(vaultPath, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

/** Parses the single-line JSON payload of a `--json` run. */
function parseReport(out: string): Record<string, unknown> {
  const line = out.split('\n').find((l) => l.includes('"valid"'));
  assert.ok(line, `expected a JSON output line in: ${out}`);
  return JSON.parse(line) as Record<string, unknown>;
}

/** The `repairs[]` array from a JSON report. */
function repairsOf(report: Record<string, unknown>): Record<string, unknown>[] {
  return report.repairs as Record<string, unknown>[];
}

/** The `repair_conflicts[]` array from a JSON report. */
function conflictsOf(report: Record<string, unknown>): string[] {
  return report.repair_conflicts as string[];
}

/** A well-formed index body listing the given session refs. */
function indexWithRefs(refs: string[]): string {
  const lines = refs.map((r) => `- [[${r}]] - Topic: T-alpha (2026-08-30)`).join('\n');
  return [
    '---',
    'palee_schema: 1',
    'type: "session_index"',
    'updated_at: "2026-08-30"',
    '---',
    '# PALEE Session Index',
    '',
    `Total Sessions: ${refs.length}`,
    '',
    lines,
    '',
  ].join('\n');
}

describe('#323 validate --fix: derived views (valid-session-index / valid-hot-memory)', () => {
  test('a stale session index is rebuilt and validation goes clean', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      writeIndex(vaultPath, indexWithRefs(['S-20260830T100000-aaaa1111', 'S-ghost']));

      const before = await captureOutput(() => validateCommand({ json: true }));
      const beforeReport = parseReport(before.out);
      assert.strictEqual(beforeReport.valid, true, 'derived-view findings are warnings, never errors');
      assert.strictEqual(beforeReport.warning_count, 1, `expected one stale-index warning: ${before.out}`);

      const fixed = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(fixed.out, /Repaired derived view \.palee\/index\.md/, fixed.out);
      assert.strictEqual(process.exitCode, 0, `expected exit 0, got ${process.exitCode}: ${fixed.out}`);

      const index = readIfPresent(vaultPath, '.palee/index.md') ?? '';
      assert.doesNotMatch(index, /S-ghost/, 'phantom ref must be gone');
      assert.match(index, /\[\[S-20260830T100000-aaaa1111\]\]/, 'canonical session must be re-listed');

      const after = await captureOutput(() => validateCommand({ json: true }));
      assert.strictEqual(parseReport(after.out).warning_count, 0, after.out);
    });
  });

  test('an index with corrupt frontmatter is rebuilt into a parseable projection', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      writeIndex(vaultPath, '---\npalee_schema: 1\ntype: [unclosed\n---\n# PALEE Session Index\n');

      await captureOutput(() => validateCommand({ fix: true }));

      const fm = readFrontmatter(vaultPath, '.palee/index.md');
      assert.strictEqual(fm.palee_schema, 1);
      assert.strictEqual(fm.type, 'session_index');

      const after = await captureOutput(() => validateCommand({ json: true }));
      const report = parseReport(after.out);
      assert.strictEqual(report.warning_count, 0, after.out);
      assert.strictEqual(report.valid, true);
    });
  });

  test('drifted hot memory is rebuilt: identity and references restored from canonical sessions', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      // Hand-edited hot memory: foreign identity + a `last_session` that does
      // not exist + an `active_topic` that does not exist.
      writeHot(vaultPath, {
        palee_schema: 1,
        memory_id: 'H-something-else',
        last_session: 'S-does-not-exist',
        active_topic: 'T-vanished',
        started_at: null,
        updated_at: '2026-08-30',
      }, 'Drifted summary.\n');

      const before = await captureOutput(() => validateCommand({ json: true }));
      assert.ok(
        ((before.out.match(/"rule_id":"valid-hot-memory"/g) ?? []).length) >= 2,
        `expected at least two hot-memory warnings: ${before.out}`
      );

      const fixed = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(fixed.out, /Repaired derived view \.palee\/hot\.md/, fixed.out);

      const fm = readFrontmatter(vaultPath, '.palee/hot.md');
      assert.strictEqual(fm.memory_id, 'H-active');
      assert.strictEqual(fm.last_session, 'S-20260830T100000-aaaa1111');
      assert.strictEqual(fm.active_topic, 'T-alpha');

      const after = await captureOutput(() => validateCommand({ json: true }));
      assert.strictEqual(parseReport(after.out).warning_count, 0, after.out);
    });
  });

  test('a rebuild conflict is reported through repair_conflicts and leaves the derived view stale', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      writeIndex(vaultPath, indexWithRefs(['S-ghost']));
      const staleIndex = readIfPresent(vaultPath, '.palee/index.md');

      // A live lock on hot.md — the first write `rebuildHotAndIndex` performs —
      // makes the rebuild refuse, exactly as it would for a concurrent writer.
      const lock = new Lock(vaultPath, path.join(vaultPath, '.palee', 'hot.md'));
      await lock.acquire();
      try {
        const fixed = await captureOutput(() => validateCommand({ fix: true, json: true }));
        const report = parseReport(fixed.out);
        assert.deepStrictEqual(repairsOf(report), [], 'a refused rebuild repairs nothing');
        assert.strictEqual(conflictsOf(report).length, 1, `expected one conflict: ${fixed.out}`);
        assert.match(conflictsOf(report)[0], /\.palee\/hot\.md/, conflictsOf(report)[0]);

        assert.strictEqual(readIfPresent(vaultPath, '.palee/index.md'), staleIndex);

        const after = await captureOutput(() => validateCommand({ json: true }));
        assert.strictEqual(parseReport(after.out).warning_count, 1, after.out);
      } finally {
        lock.release();
      }
    });
  });

  test('an incomplete snapshot refuses the rebuild instead of baking a read failure into derived state', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      writeIndex(vaultPath, indexWithRefs(['S-ghost']));
      const staleIndex = readIfPresent(vaultPath, '.palee/index.md');
      // A session note that cannot be read (a directory wearing a note's
      // name): the collector flags the snapshot incomplete.
      fs.mkdirSync(path.join(vaultPath, '.palee', 'sessions', 'S-20260901T100000-bbbb2222.md'));

      const fixed = await captureOutput(() => validateCommand({ fix: true, json: true }));
      const report = parseReport(fixed.out);
      assert.deepStrictEqual(repairsOf(report), [], 'no rebuild may run on a provisional snapshot');
      assert.strictEqual(conflictsOf(report).length, 1, `expected a refusal: ${fixed.out}`);
      assert.match(conflictsOf(report)[0], /snapshot is incomplete/, conflictsOf(report)[0]);
      assert.strictEqual(readIfPresent(vaultPath, '.palee/index.md'), staleIndex);
    });
  });

  test('a clean vault with --fix writes no derived views at all', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });

      const { out } = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(out, /Nothing to repair/, out);
      assert.strictEqual(process.exitCode, 0);
      assert.strictEqual(fs.existsSync(path.join(vaultPath, '.palee', 'hot.md')), false);
      assert.strictEqual(fs.existsSync(path.join(vaultPath, '.palee', 'index.md')), false);
    });
  });
});

describe('#323 validate --fix: topic mastery is recomputed through the engine', () => {
  test('drifted topic_mastery is reset to the pillar-derived formula value', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', {
        palee_id: 'T-alpha',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: null,
        topic_mastery: 0.1,
      });

      const before = await captureOutput(() => validateCommand({ json: true }));
      assert.strictEqual(parseReport(before.out).warning_count, 1, before.out);

      const fixed = await captureOutput(() => validateCommand({ fix: true }));
      assert.match(
        fixed.out,
        new RegExp(`Repaired T-alpha: topic_mastery 0\\.1 -> ${PILLAR_EXPECTED}`),
        fixed.out
      );
      assert.strictEqual(process.exitCode, 0);

      assert.strictEqual(readFrontmatter(vaultPath, 'alpha.md').topic_mastery, PILLAR_EXPECTED);

      const after = await captureOutput(() => validateCommand({ json: true }));
      assert.strictEqual(parseReport(after.out).warning_count, 0, after.out);
    });
  });

  test('a malformed mastery value is replaced by the recomputed number, and other fields survive', async () => {
    await runInTempVault(async (vaultPath) => {
      const filePath = writeTopic(vaultPath, 'alpha.md', {
        palee_id: 'T-alpha',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: null,
        topic_mastery: 'excellent',
        status: 'active',
      });
      const bodyBefore = readIfPresent(vaultPath, 'alpha.md');

      const report = parseReport((await captureOutput(() => validateCommand({ fix: true, json: true }))).out);
      assert.deepStrictEqual(repairsOf(report), [
        {
          topic_id: 'T-alpha',
          file: 'alpha.md',
          field: 'topic_mastery',
          from: 'excellent',
          to: PILLAR_EXPECTED,
        },
      ], JSON.stringify(report.repairs));
      assert.deepStrictEqual(conflictsOf(report), []);

      const fm = readFrontmatter(vaultPath, 'alpha.md');
      assert.strictEqual(fm.topic_mastery, PILLAR_EXPECTED);
      assert.strictEqual(fm.status, 'active', 'unrelated frontmatter must survive');
      assert.strictEqual(fm.conceptual, 0.8);
      // CST-preserving write: the body is untouched byte-for-byte.
      assert.ok((bodyBefore ?? '').endsWith('Body text\n'));
      assert.match(readIfPresent(vaultPath, 'alpha.md') ?? '', /Body text\n$/);
      assert.ok(fs.readFileSync(filePath, 'utf8').includes('---\n'));
    });
  });

  test('a concurrent write to the drifted note is reported as a conflict and the note stays untouched', async () => {
    await runInTempVault(async (vaultPath) => {
      const filePath = writeTopic(vaultPath, 'alpha.md', {
        palee_id: 'T-alpha',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: null,
        topic_mastery: 0.1,
      });
      const before = fs.readFileSync(filePath, 'utf8');

      const lock = new Lock(vaultPath, filePath);
      await lock.acquire();
      try {
        const report = parseReport(
          (await captureOutput(() => validateCommand({ fix: true, json: true }))).out
        );
        assert.deepStrictEqual(repairsOf(report), [], 'a conflicting note must not be reported as repaired');
        assert.strictEqual(conflictsOf(report).length, 1, JSON.stringify(report.repair_conflicts));
        assert.match(conflictsOf(report)[0], /alpha\.md/, conflictsOf(report)[0]);
        assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before, 'conflicted note must stay byte-identical');

        const after = parseReport((await captureOutput(() => validateCommand({ json: true }))).out);
        assert.strictEqual(after.warning_count, 1, 'the unresolved finding is still reported');
      } finally {
        lock.release();
      }
    });
  });
});

describe('#323 validate --fix: dispatch is authorized by rule metadata', () => {
  test('a rule declared fixable false is never repaired', async () => {
    await runInTempVault(async (vaultPath) => {
      // `no-duplicate-topic-id` declares fixable: false.
      writeTopic(vaultPath, 'a.md', { palee_id: 'T-dup', topic_mastery: 0 });
      writeTopic(vaultPath, 'b.md', { palee_id: 'T-dup', topic_mastery: 0 });

      const report = parseReport(
        (await captureOutput(() => validateCommand({ fix: true, json: true }))).out
      );
      assert.deepStrictEqual(repairsOf(report), [], 'metadata forbids repairing this finding');
      assert.strictEqual(report.error_count, 1, JSON.stringify(report.errors));
      assert.strictEqual(report.valid, false);
      assert.strictEqual(process.exitCode, 3);
    });
  });

  test('a declared-safe rule with no implemented repair is surfaced, not silently skipped', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      const phantom: ValidationRule = {
        id: 'phantom-safe-rule',
        description: 'Test double: declares a safe repair the engine does not implement',
        severity: 'warning',
        fixable: 'safe',
        run(): ValidationIssue[] {
          return [
            {
              ruleId: 'phantom-safe-rule',
              severity: 'warning',
              message: 'Phantom finding that declares itself safely fixable',
            },
          ];
        },
      };
      // The catalog is the single source of truth the CLI dispatches over.
      VALIDATION_RULES.push(phantom);
      try {
        const report = parseReport(
          (await captureOutput(() => validateCommand({ fix: true, json: true }))).out
        );
        assert.deepStrictEqual(repairsOf(report), []);
        assert.strictEqual(conflictsOf(report).length, 1, JSON.stringify(report.repair_conflicts));
        assert.match(conflictsOf(report)[0], /phantom-safe-rule/, conflictsOf(report)[0]);
        assert.match(conflictsOf(report)[0], /no repair is implemented/, conflictsOf(report)[0]);
        assert.strictEqual(report.valid, true, 'a reported refusal never becomes an error');
        assert.strictEqual(process.exitCode, 0);

        const human = await captureOutput(() => validateCommand({ fix: true }));
        assert.match(human.err, /Skipped repair.*phantom-safe-rule/, human.err);
      } finally {
        VALIDATION_RULES.pop();
      }
    });
  });

  test('the SM-2 review-field repair still runs for its explicitly listed manual rule', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'zero.md', {
        palee_id: 'T-zero',
        ease_factor: 1.0,
        interval_days: 0,
        repetition: 0,
        lapses: 0,
        last_quality: null,
        due_at: '2026-09-25',
      });

      const report = parseReport(
        (await captureOutput(() => validateCommand({ fix: true, json: true }))).out
      );
      assert.deepStrictEqual(repairsOf(report), [
        { topic_id: 'T-zero', file: 'zero.md', field: 'ease_factor', from: 1, to: 2.5 },
        { topic_id: 'T-zero', file: 'zero.md', field: 'interval_days', from: 0, to: 1 },
      ], JSON.stringify(report.repairs));
      assert.strictEqual(report.valid, true);
      assert.strictEqual(process.exitCode, 0);
    });
  });

  test('repair passes are independent: a conflicted mastery note still lets the review-field reset run', async () => {
    await runInTempVault(async (vaultPath) => {
      const masteryNote = writeTopic(vaultPath, 'alpha.md', {
        palee_id: 'T-alpha',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: null,
        topic_mastery: 0.1,
      });
      writeTopic(vaultPath, 'zero.md', {
        palee_id: 'T-zero',
        ease_factor: 1.0,
        interval_days: 0,
      });

      const lock = new Lock(vaultPath, masteryNote);
      await lock.acquire();
      try {
        const report = parseReport(
          (await captureOutput(() => validateCommand({ fix: true, json: true }))).out
        );
        const fields = repairsOf(report).map((r) => `${r.topic_id}:${r.field}`);
        assert.deepStrictEqual(fields, ['T-zero:ease_factor', 'T-zero:interval_days'], JSON.stringify(fields));
        assert.strictEqual(conflictsOf(report).length, 1, JSON.stringify(report.repair_conflicts));
      } finally {
        lock.release();
      }
      assert.strictEqual(readFrontmatter(vaultPath, 'zero.md').ease_factor, 2.5);
      assert.strictEqual(readFrontmatter(vaultPath, 'alpha.md').topic_mastery, 0.1);
    });
  });
});

describe('#323 validate --fix: payload and exit-code split is unchanged', () => {
  test('--json reports repairs additively while valid stays errors-only', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', {
        palee_id: 'T-alpha',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: null,
        topic_mastery: 0.1,
      });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      writeIndex(vaultPath, indexWithRefs(['S-ghost']));

      const report = parseReport(
        (await captureOutput(() => validateCommand({ json: true, fix: true }))).out
      );
      // Two repairs ran (mastery + rebuild) and cleared two warnings.
      assert.ok(Array.isArray(report.repairs) && repairsOf(report).length >= 3, JSON.stringify(report.repairs));
      assert.strictEqual(report.valid, true, 'repairs never flip valid');
      assert.strictEqual(report.error_count, 0);
      assert.strictEqual(report.warning_count, 0, afterAllWarningsGone(report));
      assert.strictEqual(process.exitCode, 0);
    });
  });

  test('--strict --fix exits 0 once every warning is repaired', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', {
        palee_id: 'T-alpha',
        conceptual: 0.8,
        practical: 0.7,
        debug: 0.9,
        feynman: 0.85,
        assessed_at: null,
        topic_mastery: 0.1,
      });

      const untouched = await captureOutput(() => validateCommand({ strict: true }));
      assert.strictEqual(process.exitCode, 3, untouched.out);

      process.exitCode = 0;
      const fixed = await captureOutput(() => validateCommand({ strict: true, fix: true }));
      assert.strictEqual(process.exitCode, 0, fixed.out);
      assert.match(fixed.out, /validation passed/, fixed.out);
    });
  });

  test('--strict --fix still exits 3 when a warning survives an unfixable snapshot', async () => {
    await runInTempVault(async (vaultPath) => {
      writeTopic(vaultPath, 'alpha.md', { palee_id: 'T-alpha', topic_mastery: 0 });
      writeSession(vaultPath, 'S-20260830T100000-aaaa1111', 'T-alpha', '2026-08-30T10:00:00.000Z');
      writeIndex(vaultPath, indexWithRefs(['S-ghost']));
      fs.mkdirSync(path.join(vaultPath, '.palee', 'sessions', 'S-20260901T100000-bbbb2222.md'));

      await captureOutput(() => validateCommand({ strict: true, fix: true }));
      assert.strictEqual(process.exitCode, 3, 'a refused repair keeps the warning it could not clear');
    });
  });
});

/** Diagnostic text for a warning-count assertion. */
function afterAllWarningsGone(report: Record<string, unknown>): string {
  return `warnings should be gone after the repair pass: ${JSON.stringify(report)}`;
}
