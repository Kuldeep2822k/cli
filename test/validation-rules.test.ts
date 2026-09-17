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
import { parseFrontmatterRule, readFailureRule } from '../src/validation/rules/parse-frontmatter';
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
    memoryReadErrors: [],
    readIncomplete: false,
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: { state: 'missing', frontmatter: null, body: '' },
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

describe('read-failure rule', () => {
  test('reports only unreadable notes in deterministic path order', () => {
    const context = makeContext({
      notes: [
        makeNote({ relativePath: 'z-locked.md', readError: 'EBUSY: file locked' }),
        makeNote({ relativePath: 'a-locked.md', readError: 'EPERM: denied' }),
        makeNote({ relativePath: 'mid-ok.md' }),
      ],
    });

    const issues = readFailureRule.run(context);

    assert.strictEqual(issues.length, 2);
    assert.deepStrictEqual(
      issues.map((i) => i.file),
      ['a-locked.md', 'z-locked.md']
    );
    assert.strictEqual(issues[0].ruleId, 'read-failure');
    assert.strictEqual(issues[0].severity, 'warning');
    assert.match(issues[0].message, /a-locked\.md/);
    assert.match(issues[0].message, /EPERM/);
    assert.strictEqual(issues[0].details?.readError, 'EPERM: denied');
    assert.strictEqual(issues[1].details?.readError, 'EBUSY: file locked');
  });

  test('fully readable vault yields no issues', () => {
    const context = makeContext({
      notes: [makeNote({ relativePath: 'ok.md' })],
    });

    assert.deepStrictEqual(readFailureRule.run(context), []);
  });

  test('rule metadata: warning severity, not fixable', () => {
    assert.strictEqual(readFailureRule.id, 'read-failure');
    assert.strictEqual(readFailureRule.severity, 'warning');
    assert.strictEqual(readFailureRule.fixable, false);
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
    // Vault-scan severity policy (ADR-0008 decision 1 / #34): missing
    // dependencies warn — the engine quarantines the dependent topic
    // instead of failing the scan; roadmap pre-validation keeps its own
    // separate error path.
    assert.strictEqual(issues[0].severity, 'warning');
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

  test('read-incomplete snapshot keeps missing deps reported (never suppressed)', () => {
    // A read failure elsewhere in the vault must not hide a real dangling
    // reference — the finding still reports (warning severity per the #34
    // scan policy), with no speculative incompleteness marker; the
    // read-failure rule reports the transient condition alongside.
    const context = makeContext({
      topics: [makeTopic({ palee_id: 'T-dep', id: 'T-dep', depends_on: ['T-locked'] })],
      readIncomplete: true,
      sessions: [],
      sessionIndex: { state: 'missing', refs: null },
      hotMemory: { state: 'missing', frontmatter: null, body: '' },
    });

    const issues = noMissingDependencyRule.run(context);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].severity, 'warning');
    assert.strictEqual(issues[0].details?.snapshotIncomplete, undefined);
    assert.strictEqual(issues[0].details?.missing, 'T-locked');
  });

  test('rule metadata: id, warning severity per the #34 scan policy, not fixable', () => {
    assert.strictEqual(noMissingDependencyRule.id, 'no-missing-dependency');
    assert.strictEqual(noMissingDependencyRule.severity, 'warning');
    assert.strictEqual(noMissingDependencyRule.fixable, false);
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

  test('two disjoint cycles each report a distinct finding (#171 finding 3)', () => {
    // Two independent cyclic components: T-x <-> T-y  and  T-p <-> T-q.
    // The pre-fix rule used detectCycle (first-only) and reported exactly 1
    // finding; criterion #3 of issue #171 requires every distinct cycle.
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-x', id: 'T-x', depends_on: ['T-y'] }),
        makeTopic({ palee_id: 'T-y', id: 'T-y', depends_on: ['T-x'] }),
        makeTopic({ palee_id: 'T-p', id: 'T-p', depends_on: ['T-q'] }),
        makeTopic({ palee_id: 'T-q', id: 'T-q', depends_on: ['T-p'] }),
      ],
    });

    const issues = noDependencyCycleRule.run(context);

    assert.strictEqual(issues.length, 2, 'each disjoint cycle must produce one finding');
    assert.strictEqual(issues[0].ruleId, 'no-dependency-cycle');
    assert.strictEqual(issues[1].ruleId, 'no-dependency-cycle');
    // detectCycles sorts canonicalized cycle paths lexicographically; assert the
    // exact order rather than sorting, so ordering regressions are caught.
    assert.deepStrictEqual(
      issues.map(i => (i.details?.path as string[]).join(' -> ')),
      ['T-p -> T-q -> T-p', 'T-x -> T-y -> T-x']
    );
    // Each finding is anchored to a node in its own cycle.
    assert.deepStrictEqual(issues.map(i => i.topicId), ['T-p', 'T-x']);
  });

  test('overlapping cycles sharing a node each report a distinct finding', () => {
    // Triangle: T-a -> T-b -> T-c -> T-a  (one cycle, 3 nodes).
    // Plus self-loop: T-a -> T-a  (a second, independent cycle sharing T-a).
    // Both must be reported, not just the first.
    const context = makeContext({
      topics: [
        makeTopic({ palee_id: 'T-a', id: 'T-a', depends_on: ['T-b', 'T-a'] }),
        makeTopic({ palee_id: 'T-b', id: 'T-b', depends_on: ['T-c'] }),
        makeTopic({ palee_id: 'T-c', id: 'T-c', depends_on: ['T-a'] }),
      ],
    });

    const issues = noDependencyCycleRule.run(context);

    // detectCycles returns canonical cycles sorted by path key; the
    // self-loop (T-a -> T-a) sorts before the triangle (T-a -> T-b -> T-c -> T-a).
    assert.strictEqual(issues.length, 2, 'triangle and self-loop must both be reported');
    assert.deepStrictEqual(
      issues.map(i => (i.details?.path as string[]).join(' -> ')),
      ['T-a -> T-a', 'T-a -> T-b -> T-c -> T-a']
    );
    assert.deepStrictEqual(issues.map(i => i.topicId), ['T-a', 'T-a']);
  });

  test('dense graph exceeding 1000 cycles emits truncation finding', () => {
    // K8 complete digraph: every node depends on every other node.
    // Produces exponentially many elementary cycles (>1000), triggering
    // the bounded enumeration's truncation path in the rule itself.
    const topics: LoadedTopic[] = [];
    for (let i = 0; i < 8; i++) {
      const deps = Array.from({ length: 8 }, (_, j) => 'T-' + j).filter((d) => d !== `T-${i}`);
      topics.push(
        makeTopic({
          palee_id: `T-${i}`,
          id: `T-${i}`,
          title: `Node ${i}`,
          path: `n${i}.md`,
          depends_on: deps,
          difficulty: 'intermediate',
        })
      );
    }
    const context = makeContext({ topics });
    const issues = noDependencyCycleRule.run(context);

    // Must have cycle findings AND the truncation finding.
    const truncation = issues.find((i) => i.details?.truncated === true);
    assert.ok(truncation, 'truncated graph must produce a truncation finding');
    assert.strictEqual(
      truncation.message,
      'Dependency cycle enumeration truncated at 1000 cycles — additional cycles may exist'
    );
    assert.strictEqual(truncation.ruleId, 'no-dependency-cycle');
    assert.strictEqual(truncation.severity, 'error');
  });
});
