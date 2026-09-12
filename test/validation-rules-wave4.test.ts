/**
 * Wave 4 validation rule tests (#28, #29, #31)
 *
 * Contracts under test:
 * - valid-palee-schema (#28): managed notes must declare `palee_schema: 1`;
 *   missing/unversioned managed data, non-numeric, and future versions are
 *   errors; non-managed notes are never reported.
 * - valid-topic-id-format (#29): topic IDs must match the centralized slug
 *   policy (T- prefix + kebab/numeric segments); invalid IDs error without
 *   mutating anything.
 * - valid-topic-status (#31): status must be one of the four lifecycle
 *   values; pseudo-statuses like `completed`/`done` are errors; missing
 *   status is tolerated as the adopt default (not_started), matching the
 *   loader's normalization contract.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validPaleeSchemaRule } from '../src/validation/rules/valid-palee-schema';
import { validTopicIdFormatRule } from '../src/validation/rules/valid-topic-id-format';
import { validTopicStatusRule } from '../src/validation/rules/valid-topic-status';
import type { ValidationContext } from '../src/validation/types';
import type { LoadedTopic } from '../src/storage/loader';
import type { ScannedNote } from '../src/types';

/** Minimal valid topic builder. */
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

/** Minimal scanned-note builder. */
function makeNote(overrides: Partial<ScannedNote> = {}): ScannedNote {
  return {
    absolutePath: '/vault/note.md',
    relativePath: 'note.md',
    frontmatter: {},
    ...overrides,
  };
}

/** Context builder. */
function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    vaultPath: '/vault',
    files: [],
    topics: [],
    notes: [],
    readIncomplete: false,
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: { state: 'missing', frontmatter: null, body: '' },
    ...overrides,
  };
}

describe('valid-palee-schema rule (#28)', () => {
  test('palee_schema: 1 passes', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_schema: 1, palee_id: 'T-a' } })],
      topics: [makeTopic({ palee_id: 'T-a' })],
    });

    assert.deepStrictEqual(validPaleeSchemaRule.run(context), []);
  });

  test('schema 999 (future version) is an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'future.md', frontmatter: { palee_schema: 999, palee_id: 'T-a' } })],
    });

    const issues = validPaleeSchemaRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-palee-schema');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].file, 'future.md');
    assert.strictEqual(issues[0].field, 'palee_schema');
    assert.strictEqual(issues[0].details?.actual, 999);
  });

  test('string schema "1" is an error (type, not just value)', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'stringy.md', frontmatter: { palee_schema: '1', palee_id: 'T-a' } })],
    });

    const issues = validPaleeSchemaRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.actual, '1');
  });

  test('missing schema on a managed topic note is an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'bare-topic.md', frontmatter: { palee_id: 'T-a', title: 'A' } })],
      topics: [makeTopic({ palee_id: 'T-a' })],
    });

    const issues = validPaleeSchemaRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.actual, null);
    assert.match(issues[0].message, /missing/i);
  });

  test('missing schema on an unrelated non-managed note is not reported', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'journal.md', frontmatter: { tags: ['personal'] } })],
    });

    assert.deepStrictEqual(validPaleeSchemaRule.run(context), []);
  });

  test('numeric palee_id still counts as managed (key presence, not type)', () => {
    // `palee_id: 123` is malformed identity data, not a non-PALEE note: the
    // MANAGED_KEY being present at all marks the note as PALEE-managed, so a
    // missing/invalid schema must error rather than silently passing.
    const context = makeContext({
      notes: [makeNote({ relativePath: 'numid.md', frontmatter: { palee_id: 123 } })],
    });

    const issues = validPaleeSchemaRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-palee-schema');
    assert.strictEqual(issues[0].file, 'numid.md');
    assert.match(issues[0].message, /missing palee_schema/i);
  });

  test('null palee_id still counts as managed (key presence, not type)', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'nullid.md', frontmatter: { palee_id: null } })],
    });

    const issues = validPaleeSchemaRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].file, 'nullid.md');
  });

  test('array session_id still counts as managed', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'sess.md', frontmatter: { session_id: ['S-1'] } })],
    });

    const issues = validPaleeSchemaRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].file, 'sess.md');
  });

  test('rule metadata: error severity, manual fixability', () => {
    assert.strictEqual(validPaleeSchemaRule.id, 'valid-palee-schema');
    assert.strictEqual(validPaleeSchemaRule.severity, 'error');
    assert.strictEqual(validPaleeSchemaRule.fixable, 'manual');
  });
});

describe('valid-topic-id-format rule (#29)', () => {
  test('T-git-rebase passes', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_id: 'T-git-rebase' } })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('generated-style ID T-20260830T120000-a1b2c3d4 passes (legacy adopt format)', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_id: 'T-20260830T120000-a1b2c3d4' } })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('numeric palee_id is an error (raw frontmatter, no loader coercion)', () => {
    // The loader drops non-string palee_id notes from context.topics, so the
    // rule must see them via context.notes — the acceptance criterion
    // "missing or non-string IDs fail for topic notes" (#29).
    const context = makeContext({
      notes: [makeNote({ relativePath: 'num.md', frontmatter: { palee_id: 123 } })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-id-format');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].file, 'num.md');
    assert.strictEqual(issues[0].field, 'palee_id');
    assert.strictEqual(issues[0].details?.actual, 123);
  });

  test('absent palee_id on a schema-marked topic note is an error (CodeRabbit #159)', () => {
    // #29 acceptance criteria: "missing or non-string IDs fail for topic
    // notes." The old gate skipped notes without the palee_id KEY, so a
    // topic note whose ID was entirely absent passed validation — the
    // exact malformed record the rule exists to catch. Eligibility must
    // come from managed markers (palee_schema here), never from the
    // validated key itself.
    const context = makeContext({
      notes: [makeNote({ relativePath: 'absent.md', frontmatter: { palee_schema: 1, title: 'No ID' } })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-id-format');
    assert.strictEqual(issues[0].file, 'absent.md');
    assert.strictEqual(issues[0].field, 'palee_id');
    assert.strictEqual(issues[0].details?.actual, undefined);
    assert.strictEqual(issues[0].topicId, undefined, 'no topicId to attach when the key is absent');
  });

  test('schema-marked session note without palee_id stays out of scope', () => {
    // Session notes carry palee_schema too, so the schema marker alone
    // cannot mean "topic note" — the session_id key must keep them
    // excluded from the topic ID policy.
    const context = makeContext({
      notes: [makeNote({ relativePath: 'session.md', frontmatter: { palee_schema: 1, session_id: 'S-1' } })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('session index note (type: session_index) stays out of scope', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'index.md', frontmatter: { type: 'session_index', palee_schema: 1 } })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('null palee_id (YAML empty value) is an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'null.md', frontmatter: { palee_id: null } })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.actual, null);
  });

  test('blank palee_id is an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'blank.md', frontmatter: { palee_id: '   ' } })],
    });

    assert.strictEqual(validTopicIdFormatRule.run(context).length, 1);
  });

  test('snake_case ID git_rebase is an error', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'old.md', frontmatter: { palee_id: 'git_rebase' } })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'git_rebase');
    assert.strictEqual(issues[0].field, 'palee_id');
    assert.ok(issues[0].details?.expected);
  });

  test('empty-slug ID T- is an error', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_id: 'T-' } })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-');
  });

  test('uppercase in slug is an error (policy: lowercase kebab)', () => {
    const context = makeContext({
      notes: [makeNote({ frontmatter: { palee_id: 'T-Git-Rebase' } })],
    });

    assert.strictEqual(validTopicIdFormatRule.run(context).length, 1);
  });

  test('non-topic notes are skipped (session note carries session_id, not palee_id)', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'session.md', frontmatter: { session_id: 'S-1', palee_schema: 1 } })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('notes with parse errors are skipped (parse-frontmatter owns them)', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'broken.md', frontmatter: null, parseError: 'bad yaml' })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('issues are deterministic: sorted by file path', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 'c-valid.md', frontmatter: { palee_id: 'T-valid-slug' } }),
        makeNote({ relativePath: 'z-bad.md', frontmatter: { palee_id: 'bad-two' } }),
        makeNote({ relativePath: 'a-bad.md', frontmatter: { palee_id: 'bad-one' } }),
      ],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.deepStrictEqual(issues.map((i) => i.file), ['a-bad.md', 'z-bad.md']);
  });

  test('rule metadata: error severity, not fixable (no ID mutation)', () => {
    assert.strictEqual(validTopicIdFormatRule.id, 'valid-topic-id-format');
    assert.strictEqual(validTopicIdFormatRule.severity, 'error');
    assert.strictEqual(validTopicIdFormatRule.fixable, false);
  });
});

describe('valid-topic-status rule (#31)', () => {
  test('all four allowed statuses pass', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-1', status: 'not_started' }),
        makeTopic({ palee_id: 'T-2', status: 'learning' }),
        makeTopic({ palee_id: 'T-3', status: 'paused' }),
        makeTopic({ palee_id: 'T-4', status: 'archived' }),
      ],
    });

    assert.deepStrictEqual(validTopicStatusRule.run(context), []);
  });

  test('completed is an error (mastery is derived, never a stored status)', () => {
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-done',
        status: 'completed' as unknown as 'not_started',
        frontmatter: { status: 'completed' },
      })],
    });

    const issues = validTopicStatusRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-status');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-done');
    assert.strictEqual(issues[0].field, 'status');
    assert.deepStrictEqual(issues[0].details?.allowed, ['not_started', 'learning', 'paused', 'archived']);
  });

  test('done is an error', () => {
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-x',
        status: 'done' as unknown as 'not_started',
        frontmatter: { status: 'done' },
      })],
    });

    assert.strictEqual(validTopicStatusRule.run(context).length, 1);
  });

  test('numeric status is an error', () => {
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-x',
        status: 1 as unknown as 'not_started',
        frontmatter: { status: 1 },
      })],
    });

    const issues = validTopicStatusRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].details?.actual, 1);
  });

  test('missing status is tolerated as not_started (loader default policy)', () => {
    // Loader normalizes missing status to not_started; validation runs on
    // the normalized view, so the rule must not double-report it.
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-fresh', status: 'not_started' })],
    });

    assert.deepStrictEqual(validTopicStatusRule.run(context), []);
  });

  test('raw frontmatter with no status key is tolerated (managed default)', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-fresh', frontmatter: {} })],
    });

    assert.deepStrictEqual(validTopicStatusRule.run(context), []);
  });

  test('null status is an error (present-but-empty is not the missing-key default)', () => {
    // YAML `status:` (empty value) deserializes to explicit null. Unlike a
    // missing key — the adopt default case — an explicit null is a stored
    // defect: no PALEE writer emits it, and the null-vs-0 invariant says
    // branch on null explicitly, never coerce it away.
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-null',
        status: 'not_started',
        frontmatter: { status: null },
      })],
    });

    const issues = validTopicStatusRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-status');
    assert.strictEqual(issues[0].topicId, 'T-null');
    assert.strictEqual(issues[0].details?.actual, null);
  });

  test('array status fails even when its coerced form is an allowed word', () => {
    // String(['learning']) === 'learning' — a naive String(raw) allowlist
    // lookup passes this. The raw on-disk value is a list, and #31 says
    // non-string status values fail.
    const context = makeContext({
      topics: [makeTopic({
        palee_id: 'T-arr',
        status: 'not_started',
        frontmatter: { status: ['learning'] },
      })],
    });

    const issues = validTopicStatusRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0].details?.actual, ['learning']);
  });

  test('rule metadata: error severity, manual fixability', () => {
    assert.strictEqual(validTopicStatusRule.id, 'valid-topic-status');
    assert.strictEqual(validTopicStatusRule.severity, 'error');
    assert.strictEqual(validTopicStatusRule.fixable, 'manual');
  });
});
