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

  test('rule metadata: error severity, manual fixability', () => {
    assert.strictEqual(validPaleeSchemaRule.id, 'valid-palee-schema');
    assert.strictEqual(validPaleeSchemaRule.severity, 'error');
    assert.strictEqual(validPaleeSchemaRule.fixable, 'manual');
  });
});

describe('valid-topic-id-format rule (#29)', () => {
  test('T-git-rebase passes', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-git-rebase', id: 'T-git-rebase' })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('generated-style ID T-20260830T120000-a1b2c3d4 passes', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-20260830T120000-a1b2c3d4', id: 'T-20260830T120000-a1b2c3d4' })],
    });

    assert.deepStrictEqual(validTopicIdFormatRule.run(context), []);
  });

  test('snake_case ID git_rebase is an error', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'git_rebase', id: 'git_rebase', path: 'old.md' })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-id-format');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'git_rebase');
    assert.strictEqual(issues[0].field, 'palee_id');
    assert.ok(issues[0].details?.expected);
  });

  test('empty-slug ID T- is an error', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-', id: 'T-' })],
    });

    const issues = validTopicIdFormatRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].topicId, 'T-');
  });

  test('uppercase in slug is an error (policy: lowercase kebab)', () => {
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-Git-Rebase', id: 'T-Git-Rebase' })],
    });

    assert.strictEqual(validTopicIdFormatRule.run(context).length, 1);
  });

  test('issues are deterministic: sorted by topic ID', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-valid-slug', id: 'T-valid-slug' }),
        makeTopic({ palee_id: 'bad-two', id: 'bad-two' }),
        makeTopic({ palee_id: 'bad-one', id: 'bad-one' }),
      ],
    });

    const issues = validTopicIdFormatRule.run(context);

    // Only the two invalid IDs report, in code-unit order.
    assert.deepStrictEqual(
      issues.map((i) => i.topicId),
      ['bad-one', 'bad-two']
    );
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

  test('rule metadata: error severity, manual fixability', () => {
    assert.strictEqual(validTopicStatusRule.id, 'valid-topic-status');
    assert.strictEqual(validTopicStatusRule.severity, 'error');
    assert.strictEqual(validTopicStatusRule.fixable, 'manual');
  });
});
