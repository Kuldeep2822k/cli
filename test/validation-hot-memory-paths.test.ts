/**
 * Hot-memory, safe-vault-paths, and diagnostic-value tests (#43, #45, #166)
 *
 * Contracts under test:
 * - valid-hot-memory (#43): hot.md is a rebuildable derived view —
 *   findings are warnings that never gate; identity (memory_id),
 *   word cap (MAX_HOT_WORDS via countWords, frontmatter excluded),
 *   and session/topic references (skipped on readIncomplete).
 * - safe-vault-paths (#45): every managed path must resolve inside
 *   the vault — traversal (`../`), absolute, and Windows-drive
 *   escapes are errors; backslash separators normalize first;
 *   normal in-vault paths pass.
 * - diagnostic-value (#166): non-finite frontmatter values render
 *   their explicit spelling (NaN/Infinity) in messages and
 *   details.actual instead of JSON.stringify's `null`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validHotMemoryRule } from '../src/validation/rules/valid-hot-memory';
import { safeVaultPathsRule } from '../src/validation/rules/safe-vault-paths';
import { displayValue } from '../src/validation/rules/diagnostic-value';
import type { ValidationContext } from '../src/validation/types';
import type { LoadedTopic } from '../src/storage/loader';
import type { LoadedSession } from '../src/storage/sessions';
import type { ScannedNote } from '../src/types';

/** Canonical hot-memory frontmatter builder. */
function hotFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    palee_schema: 1,
    memory_id: 'H-active',
    last_session: 'S-1',
    active_topic: 'T-topic',
    started_at: '2026-09-12T10:00:00.000Z',
    updated_at: '2026-09-12',
    ...overrides,
  };
}

/** Hot-memory read builder — `ok` state with a small body by default. */
function makeHot(overrides: Record<string, unknown> = {}, body = 'Studied the topic.') {
  return {
    state: 'ok' as const,
    frontmatter: hotFrontmatter(overrides) as never,
    body,
  };
}

/** Minimal topic builder. */
function makeTopic(overrides: Partial<LoadedTopic> = {}): LoadedTopic {
  return {
    palee_id: 'T-topic',
    id: 'T-topic',
    title: 'Topic',
    path: 'topic.md',
    filePath: '/vault/topic.md',
    content: '---\n---\n',
    frontmatter: {},
    difficulty: 'beginner',
    depends_on: [],
    topic_mastery: 0,
    status: 'not_started',
    ...overrides,
  };
}

/** Minimal session builder. */
function makeSession(overrides: Partial<LoadedSession> = {}): LoadedSession {
  return {
    sessionId: 'S-1',
    isDraft: false,
    path: '.palee/sessions/S-1.md',
    filePath: '/vault/.palee/sessions/S-1.md',
    frontmatter: {},
    ...overrides,
  };
}

/** Minimal scanned-note builder. */
function makeNote(overrides: Partial<ScannedNote> = {}): ScannedNote {
  return {
    absolutePath: '/vault/note.md',
    relativePath: 'note.md',
    frontmatter: {},
    ...overrides,
  };
}

/** Context builder with a healthy hot memory by default. */
function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    vaultPath: '/vault',
    files: [],
    topics: [],
    notes: [],
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: makeHot(),
    memoryReadErrors: [],
    readIncomplete: false,
    ...overrides,
  };
}

describe('valid-hot-memory rule (#43)', () => {
  test('valid hot memory passes', () => {
    const context = makeContext({
      sessions: [makeSession()],
      topics: [makeTopic()],
    });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('missing hot memory never reports (fresh vault)', () => {
    const context = makeContext({ hotMemory: { state: 'missing', frontmatter: null, body: '' } });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('corrupt / no-frontmatter states never report (rebuild, do not diagnose)', () => {
    const corrupt = makeContext({
      hotMemory: { state: 'corrupt', frontmatter: null, body: '' },
    });
    assert.deepStrictEqual(validHotMemoryRule.run(corrupt), []);
    const bare = makeContext({
      hotMemory: { state: 'no-frontmatter', frontmatter: null, body: 'text' },
    });
    assert.deepStrictEqual(validHotMemoryRule.run(bare), []);
  });

  test('schema-invalid hot memory reports one warning and stops', () => {
    const context = makeContext({
      hotMemory: {
        state: 'schema-invalid',
        frontmatter: hotFrontmatter({ palee_schema: 2 }) as never,
        body: 'x',
      },
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].field, 'palee_schema');
    assert.match(issues[0].message, /unsupported palee_schema/);
  });

  test('missing or foreign memory_id reports a warning', () => {
    const context = makeContext({
      sessions: [makeSession()], // S-1 exists
      topics: [makeTopic()], // T-topic exists — references resolve
      hotMemory: makeHot({ memory_id: 'H-something-else' }),
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'memory_id');
    assert.strictEqual(issues[0].details?.expected, 'H-active');
  });

  test('non-finite memory_id renders its spelling, not null (CodeRabbit)', () => {
    // YAML .nan/.inf reach hot.md frontmatter as NaN/Infinity; the
    // identity finding must name the value in both message and
    // details.actual — JSON.stringify alone would render null.
    const context = makeContext({
      sessions: [makeSession()],
      topics: [makeTopic()],
      hotMemory: makeHot({ memory_id: NaN }),
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'memory_id');
    assert.match(issues[0].message, /got "NaN"/);
    assert.strictEqual(issues[0].details?.actual, 'NaN');
  });

  test('unknown last_session reference reports a warning', () => {
    const context = makeContext({
      sessions: [], // S-1 does not exist
      topics: [makeTopic()],
      hotMemory: makeHot({ last_session: 'S-gone' }),
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'last_session');
    assert.strictEqual(issues[0].details?.missingSession, 'S-gone');
  });

  test('unknown active_topic reference reports a warning', () => {
    const context = makeContext({
      sessions: [makeSession()],
      topics: [], // T-topic does not exist
      hotMemory: makeHot({ active_topic: 'T-ghost' }),
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'active_topic');
    assert.strictEqual(issues[0].details?.missingTopic, 'T-ghost');
  });

  test('null last_session and active_topic are the legal idle state', () => {
    const context = makeContext({
      hotMemory: makeHot({ last_session: null, active_topic: null }),
    });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('body over the 250-word cap reports a warning with the count', () => {
    const words = Array.from({ length: 251 }, (_, i) => `word${i}`).join(' ');
    const context = makeContext({
      sessions: [makeSession()],
      topics: [makeTopic()],
      hotMemory: makeHot({}, words),
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'body');
    assert.strictEqual(issues[0].details?.wordCount, 251);
    assert.strictEqual(issues[0].details?.maxWords, 250);
  });

  test('body at exactly 250 words passes (the writer truncates to the cap)', () => {
    const words = Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ');
    const context = makeContext({
      sessions: [makeSession()],
      topics: [makeTopic()],
      hotMemory: makeHot({}, words),
    });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('reference findings are skipped on a readIncomplete snapshot', () => {
    // The referenced session/topic may be exactly the note that failed
    // to read — a reference warning would be speculation. The identity
    // and word-cap checks are local to the file and still run.
    const context = makeContext({
      sessions: [],
      topics: [],
      hotMemory: makeHot({}, 'ok body'),
      readIncomplete: true,
    });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('non-string last_session and active_topic shapes are skipped (not this rule\'s finding)', () => {
    // Non-string references are schema-shape defects, not resolvable
    // references — this rule only judges string references.
    const context = makeContext({
      hotMemory: makeHot({ last_session: 42, active_topic: true }),
    });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('padded active_topic resolves like the consumer (trim before matching)', () => {
    // resolveActiveTopic trims before use; a padded " T-topic " is the
    // same reference to the consumer and must not warn here either.
    const context = makeContext({
      sessions: [makeSession()],
      topics: [makeTopic()], // T-topic exists
      hotMemory: makeHot({ active_topic: ' T-topic ' }),
    });
    assert.deepStrictEqual(validHotMemoryRule.run(context), []);
  });

  test('case-insensitive (none) active_topic is the idle state, never a warning', () => {
    // The consumer treats any casing of "(none)" as no active topic
    // (resolveActiveTopic); the rule must not report it as a reference.
    for (const idle of ['(none)', '(None)', '(NONE)']) {
      const context = makeContext({
        sessions: [makeSession()],
        topics: [], // no topics exist
        hotMemory: makeHot({ active_topic: idle }),
      });
      assert.deepStrictEqual(
        validHotMemoryRule.run(context),
        [],
        `active_topic ${idle} is the idle state and must never warn`
      );
    }
  });

  test('padded last_session still reports (the consumer does not trim it)', () => {
    // session.ts reads last_session without trimming — a padded
    // reference is genuinely broken for the consumer too.
    const context = makeContext({
      sessions: [makeSession()], // S-1 exists unpadded
      topics: [makeTopic()], // T-topic resolves (active_topic default)
      hotMemory: makeHot({ last_session: ' S-1 ' }),
    });
    const issues = validHotMemoryRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].field, 'last_session');
  });

  test('rule metadata: id, warning severity, safe fixability (rebuildable)', () => {
    assert.strictEqual(validHotMemoryRule.id, 'valid-hot-memory');
    assert.strictEqual(validHotMemoryRule.severity, 'warning');
    assert.strictEqual(validHotMemoryRule.fixable, 'safe');
  });
});

describe('safe-vault-paths rule (#45)', () => {
  test('normal in-vault paths pass', () => {
    const context = makeContext({
      topics: [makeTopic({ path: 'notes/deep/nested.md' })],
      notes: [makeNote({ relativePath: 'a.md' })],
      sessions: [makeSession()],
    });
    assert.deepStrictEqual(safeVaultPathsRule.run(context), []);
  });

  test('parent-directory escape (../outside.md) reports an error', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-esc', path: '../outside.md' })],
    });
    const issues = safeVaultPathsRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'safe-vault-paths');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-esc');
    assert.strictEqual(issues[0].details?.path, '../outside.md');
  });

  test('absolute path outside the vault reports an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'C:/Windows/system32/evil.md' })],
    });
    const issues = safeVaultPathsRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].message, /escapes the vault boundary/);
  });

  test('Windows backslash paths normalize before validation', () => {
    // A backslash traversal must be caught after POSIX normalization.
    const context = makeContext({
      notes: [makeNote({ relativePath: '..\\outside.md' })],
    });
    const issues = safeVaultPathsRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.path, '..\\outside.md');
  });

  test('backslash-escaped in-vault path passes after normalization', () => {
    const context = makeContext({
      topics: [makeTopic({ path: 'notes\\deep\\nested.md' })],
    });
    assert.deepStrictEqual(safeVaultPathsRule.run(context), []);
  });

  test('traversal deeper in the path (a/../../escape.md) reports an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'a/../../escape.md' })],
    });
    const issues = safeVaultPathsRule.run(context);
    assert.strictEqual(issues.length, 1);
  });

  test('the vault root itself is inside (empty relative path)', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: '' })],
    });
    assert.deepStrictEqual(safeVaultPathsRule.run(context), []);
  });

  test('session path escape reports an error with the session id', () => {
    const context = makeContext({
      sessions: [makeSession({ sessionId: 'S-esc', path: '../sessions-outside/S-esc.md' })],
    });
    const issues = safeVaultPathsRule.run(context);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].sessionId, 'S-esc');
  });

  test('findings sort by file path', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: '../z.md' }),
        makeNote({ relativePath: '../a.md' }),
      ],
    });
    const issues = safeVaultPathsRule.run(context);
    assert.deepStrictEqual(issues.map((i) => i.file), ['../a.md', '../z.md']);
  });

  test('rule metadata: id, error severity, manual fixability', () => {
    assert.strictEqual(safeVaultPathsRule.id, 'safe-vault-paths');
    assert.strictEqual(safeVaultPathsRule.severity, 'error');
    assert.strictEqual(safeVaultPathsRule.fixable, 'manual');
  });
});

describe('diagnostic-value helper (#166)', () => {
  test('non-finite numbers render their explicit spelling', () => {
    assert.strictEqual(displayValue(NaN), 'NaN');
    assert.strictEqual(displayValue(Infinity), 'Infinity');
    assert.strictEqual(displayValue(-Infinity), '-Infinity');
  });

  test('finite values pass through unchanged', () => {
    assert.strictEqual(displayValue(42), 42);
    assert.strictEqual(displayValue(0.5), 0.5);
    assert.strictEqual(displayValue('text'), 'text');
    assert.strictEqual(displayValue(null), null);
    assert.strictEqual(displayValue(undefined), undefined);
    assert.deepStrictEqual(displayValue([1, 2]), [1, 2]);
  });

  test('JSON.stringify of the rendered value keeps the NaN distinction', () => {
    // The bug: JSON.stringify(NaN) === 'null'. Via displayValue the
    // message and details.actual both carry "NaN" as a string.
    assert.strictEqual(JSON.stringify(NaN), 'null');
    assert.strictEqual(JSON.stringify(displayValue(NaN)), '"NaN"');
    assert.strictEqual(JSON.stringify(displayValue(Infinity)), '"Infinity"');
  });

  test('downstream rules render non-finite values explicitly (integration)', async () => {
    // A non-finite assessed_at must NOT read "got null" — the same
    // vault shape the #166 report reproduced.
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-nan',
        path: 'nan.md',
        frontmatter: { palee_id: 'T-nan', assessed_at: NaN },
      })],
      hotMemory: { state: 'missing', frontmatter: null, body: '' },
    });
    // valid-assessment-fields reads raw frontmatter; we only need its
    // rendering, imported lazily to keep this suite focused.
    const { validAssessmentFieldsRule } = await import('../src/validation/rules/valid-assessment-fields');
    const issues = validAssessmentFieldsRule.run(context);
    assert.ok(issues.length >= 1, 'NaN assessed_at must produce a finding');
    assert.match(issues[0].message, /got "NaN"/);
    assert.strictEqual(issues[0].details?.actual, 'NaN');
  });

  test('score findings keep the non-finite distinction in details.actual (Greptile)', async () => {
    // The score branch must render NaN in BOTH the message and the
    // machine-readable details.actual — a JSON consumer reading only
    // details.actual must not see null (Greptile P2).
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-nan',
        path: 'nan.md',
        frontmatter: { palee_id: 'T-nan', conceptual: NaN, practical: Infinity },
      })],
      hotMemory: { state: 'missing', frontmatter: null, body: '' },
    });
    const { validAssessmentFieldsRule } = await import('../src/validation/rules/valid-assessment-fields');
    const issues = validAssessmentFieldsRule.run(context);
    assert.strictEqual(issues.length, 2);
    const byField = new Map(issues.map((i) => [i.field, i]));
    assert.strictEqual(byField.get('conceptual')?.details?.actual, 'NaN');
    assert.match(byField.get('conceptual')?.message ?? '', /got "NaN"/);
    assert.strictEqual(byField.get('practical')?.details?.actual, 'Infinity');
    // JSON round-trip keeps the distinction (the original bug: null).
    const serialized = JSON.parse(JSON.stringify(issues.map((i) => i.details?.actual)));
    assert.deepStrictEqual(serialized, ['NaN', 'Infinity']);
  });
});
