/**
 * Validation rules tests (#25, #26, #30)
 *
 * Contracts under test:
 * - `parse-frontmatter` reports one warning per malformed note with the
 *   parser message, ordered by file path (#26).
 * - `no-duplicate-topic-id` reports one error per duplicate ID with every
 *   file in the group, deterministic by topic ID (#30).
 * - `no-missing-dependency` and `no-dependency-cycle` port the engine's
 *   graph checks as rules without changing findings.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseFrontmatterRule } from '../src/validation/rules/parse-frontmatter';
import { noDuplicateTopicIdRule } from '../src/validation/rules/no-duplicate-topic-id';
import { noMissingDependencyRule } from '../src/validation/rules/no-missing-dependency';
import { noDependencyCycleRule } from '../src/validation/rules/no-dependency-cycle';
import type { ValidationContext } from '../src/validation/types';
import type { LoadedTopic } from '../src/storage/loader';
import type { ScannedNote } from '../src/types';

/** Minimal valid topic builder for hand-built contexts. */
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

/** Minimal scanned-note builder for hand-built contexts. */
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
    ...overrides,
  };
}

describe('parse-frontmatter rule (#26)', () => {
  test('reports one warning per malformed note with parser message', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 'a-broken.md', frontmatter: null, parseError: 'bad yaml' }),
        makeNote({ relativePath: 'b-good.md' }),
      ],
    });

    const issues = parseFrontmatterRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'parse-frontmatter');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].file, 'a-broken.md');
    assert.strictEqual(issues[0].details?.parserMessage, 'bad yaml');
  });

  test('orders warnings by file path deterministically', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 'z-broken.md', frontmatter: null, parseError: 'z' }),
        makeNote({ relativePath: 'a-broken.md', frontmatter: null, parseError: 'a' }),
      ],
    });

    const issues = parseFrontmatterRule.run(context);

    assert.deepStrictEqual(
      issues.map((i) => i.file),
      ['a-broken.md', 'z-broken.md']
    );
  });

  test('clean vault yields no issues', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'plain.md', frontmatter: null })],
    });

    assert.deepStrictEqual(parseFrontmatterRule.run(context), []);
  });

  test('rule metadata: id, warning severity, manual fixability', () => {
    assert.strictEqual(parseFrontmatterRule.id, 'parse-frontmatter');
    assert.strictEqual(parseFrontmatterRule.severity, 'warning');
    assert.strictEqual(parseFrontmatterRule.fixable, 'manual');
  });
});

describe('no-duplicate-topic-id rule (#30)', () => {
  test('duplicate across two files reports one issue with both files', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-dup', id: 'T-dup', path: 'one.md' }),
        makeTopic({ palee_id: 'T-dup', id: 'T-dup', path: 'two.md' }),
      ],
    });

    const issues = noDuplicateTopicIdRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'no-duplicate-topic-id');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-dup');
    assert.deepStrictEqual(issues[0].details?.files, ['one.md', 'two.md']);
  });

  test('duplicate across three files reports all files in one issue', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-dup', id: 'T-dup', path: 'one.md' }),
        makeTopic({ palee_id: 'T-dup', id: 'T-dup', path: 'three.md' }),
        makeTopic({ palee_id: 'T-dup', id: 'T-dup', path: 'two.md' }),
      ],
    });

    const issues = noDuplicateTopicIdRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0].details?.files, ['one.md', 'three.md', 'two.md']);
  });

  test('two different duplicate IDs report two issues sorted by topic ID', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-z', id: 'T-z', path: 'z1.md' }),
        makeTopic({ palee_id: 'T-z', id: 'T-z', path: 'z2.md' }),
        makeTopic({ palee_id: 'T-a', id: 'T-a', path: 'a1.md' }),
        makeTopic({ palee_id: 'T-a', id: 'T-a', path: 'a2.md' }),
      ],
    });

    const issues = noDuplicateTopicIdRule.run(context);

    assert.deepStrictEqual(
      issues.map((i) => i.topicId),
      ['T-a', 'T-z']
    );
  });

  test('unique IDs pass', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-one', id: 'T-one' }),
        makeTopic({ palee_id: 'T-two', id: 'T-two' }),
      ],
    });

    assert.deepStrictEqual(noDuplicateTopicIdRule.run(context), []);
  });

  test('rule metadata: error severity, not fixable', () => {
    assert.strictEqual(noDuplicateTopicIdRule.id, 'no-duplicate-topic-id');
    assert.strictEqual(noDuplicateTopicIdRule.severity, 'error');
    assert.strictEqual(noDuplicateTopicIdRule.fixable, false);
  });
});

describe('no-missing-dependency rule (ported from engine)', () => {
  test('existing dependency passes', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-a', id: 'T-a' }),
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-a'] }),
      ],
    });

    assert.deepStrictEqual(noMissingDependencyRule.run(context), []);
  });

  test('missing dependency reports issue with source topic and missing ID', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-broken', id: 'T-broken', depends_on: ['T-does-not-exist'] }),
      ],
    });

    const issues = noMissingDependencyRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'no-missing-dependency');
    assert.strictEqual(issues[0].severity, 'error');
    assert.strictEqual(issues[0].topicId, 'T-broken');
    assert.strictEqual(issues[0].details?.missing, 'T-does-not-exist');
    assert.match(issues[0].message, /T-broken/);
    assert.match(issues[0].message, /T-does-not-exist/);
  });

  test('multiple missing deps report in deterministic order', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-x'] }),
        makeTopic({ palee_id: 'T-a', id: 'T-a', depends_on: ['T-z', 'T-y'] }),
      ],
    });

    const issues = noMissingDependencyRule.run(context);

    assert.deepStrictEqual(
      issues.map((i) => `${i.topicId}:${i.details?.missing}`),
      ['T-a:T-y', 'T-a:T-z', 'T-b:T-x']
    );
  });
});

describe('no-dependency-cycle rule (ported from engine)', () => {
  test('two-node cycle reports the exact path', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-a', id: 'T-a', depends_on: ['T-b'] }),
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-a'] }),
      ],
    });

    const issues = noDependencyCycleRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'no-dependency-cycle');
    assert.strictEqual(issues[0].severity, 'error');
    assert.ok(Array.isArray(issues[0].details?.path));
    const path = issues[0].details?.path as string[];
    assert.strictEqual(path[0], path[path.length - 1]);
    assert.ok(path.includes('T-a'));
    assert.ok(path.includes('T-b'));
  });

  test('three-node cycle reports the exact path', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-a', id: 'T-a', depends_on: ['T-c'] }),
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-a'] }),
        makeTopic({ palee_id: 'T-c', id: 'T-c', depends_on: ['T-b'] }),
      ],
    });

    const issues = noDependencyCycleRule.run(context);

    assert.strictEqual(issues.length, 1);
    const path = issues[0].details?.path as string[];
    assert.strictEqual(path.length, 4);
    assert.strictEqual(path[0], 'T-a');
    assert.strictEqual(path[path.length - 1], 'T-a');
  });

  test('acyclic chain passes', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-a', id: 'T-a' }),
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-a'] }),
        makeTopic({ palee_id: 'T-c', id: 'T-c', depends_on: ['T-b'] }),
      ],
    });

    assert.deepStrictEqual(noDependencyCycleRule.run(context), []);
  });

  test('duplicate IDs do not corrupt cycle detection (first occurrence wins)', () => {
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-a', id: 'T-a', path: 'a1.md', depends_on: ['T-b'] }),
        makeTopic({ palee_id: 'T-a', id: 'T-a', path: 'a2.md', depends_on: [] }),
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-a'] }),
      ],
    });

    const issues = noDependencyCycleRule.run(context);

    assert.strictEqual(issues.length, 1);
    const path = issues[0].details?.path as string[];
    assert.ok(path.includes('T-a'));
    assert.ok(path.includes('T-b'));
  });
});
