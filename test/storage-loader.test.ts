import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeDependencies } from '../src/storage/dependencies';
import { loadTopics, getTopicCache } from '../src/storage/loader';
import { FileCache } from '../src/storage/cache';
import type { LoadedTopic } from '../src/storage/loader';

/**
 * FileCache subclass that records get()/set() calls without altering behavior.
 * Used to prove loadTopics({ cache }) actually reads and populates the
 * injected cache rather than silently falling back to the shared instance.
 */
class TrackingCache extends FileCache<LoadedTopic> {
  getCalls: string[] = [];
  setCalls: string[] = [];

  /**
   * Records the read attempt and delegates to the parent cache.
   *
   * @param filePath - Absolute path to cached file
   * @returns Cached topic if still valid, or null on miss/invalidation
   */
  get(filePath: string): LoadedTopic | null {
    this.getCalls.push(filePath);
    return super.get(filePath);
  }

  /**
   * Records the write attempt and delegates to the parent cache.
   *
   * @param filePath - Absolute path to cached file
   * @param data - Parsed topic payload to store
   * @param fingerprint - Content SHA-256 hash of the file
   */
  set(filePath: string, data: LoadedTopic, fingerprint?: string): void {
    this.setCalls.push(filePath);
    super.set(filePath, data, fingerprint);
  }
}

describe('Storage Topic Loader', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('loadTopics returns empty array when no PALEE topics exist', () => {
    fs.writeFileSync(path.join(tmpVault, 'regular.md'), '# Regular note without palee_id', 'utf8');
    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 0);
  });

  test('loadTopics parses frontmatter, normalizes fields, and builds LoadedTopic objects', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic1.md'),
      `---
palee_schema: 1
palee_id: T-topic-1
title: Introduction to TypeScript
difficulty: beginner
depends_on: []
topic_mastery: 0.8
conceptual: 0.8
practical: 0.8
debug: 0.8
feynman: 0.8
ease_factor: 2.6
interval_days: 6
repetition: 2
lapses: 0
last_quality: 4
last_reviewed_at: 2026-08-15
due_at: 2026-08-21
---
# TypeScript Intro
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(tmpVault, 'topic2.md'),
      `---
palee_schema: 1
palee_id: T-topic-2
difficulty: advanced
dependencies:
  - T-topic-1
topic_mastery: 0.2
status: learning
---
# Advanced Generics
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 2);

    const t1 = topics.find((t) => t.palee_id === 'T-topic-1');
    assert.ok(t1);
    assert.strictEqual(t1.title, 'Introduction to TypeScript');
    assert.strictEqual(t1.difficulty, 'beginner');
    assert.strictEqual(t1.topic_mastery, 0.8);
    assert.strictEqual(t1.ease_factor, 2.6);
    assert.strictEqual(t1.repetition, 2);
    assert.strictEqual(t1.last_quality, 4);
    assert.strictEqual(t1.due_at, '2026-08-21');
    assert.deepStrictEqual(t1.depends_on, []);

    const t2 = topics.find((t) => t.palee_id === 'T-topic-2');
    assert.ok(t2);
    assert.strictEqual(t2.title, 'topic2'); // Filename fallback when frontmatter title omitted
    assert.strictEqual(t2.difficulty, 'advanced');
    assert.strictEqual(t2.status, 'learning');
    assert.deepStrictEqual(t2.depends_on, ['T-topic-1']); // Normalized from dependencies alias
  });

  test('loadTopics parses string scores and clamps out-of-range values', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic-scores.md'),
      `---
palee_schema: 1
palee_id: T-topic-scores
title: String Scores Topic
difficulty: 2
depends_on: []
topic_mastery: "1.5"
conceptual: "0.85"
practical: -0.2
debug: "invalid"
feynman: 0.999999
---
# Scores
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 1);
    const t = topics[0];
    assert.strictEqual(t.topic_mastery, 1.0); // Clamped from 1.5
    assert.strictEqual(t.conceptual, 0.85); // Parsed from "0.85"
    assert.strictEqual(t.practical, 0.0); // Clamped from -0.2
    assert.strictEqual(t.debug, 0.0); // Fallback from "invalid"
    assert.strictEqual(t.feynman, 1.0); // Rounded from 0.999999
    assert.strictEqual(t.difficulty, 'intermediate'); // Coerced from numeric 2
  });

  test('loadTopics falls back to canonical defaults when review counters are NaN or non-finite', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic-nan.md'),
      `---
palee_schema: 1
palee_id: T-topic-nan
title: NaN Counters Topic
repetition: .nan
lapses: .nan
ease_factor: .nan
interval_days: .nan
last_quality: .nan
---
# NaN Topic
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 1);
    const t = topics[0];
    assert.strictEqual(t.repetition, 0);
    assert.strictEqual(t.lapses, 0);
    assert.strictEqual(t.ease_factor, 2.5);
    assert.strictEqual(t.interval_days, 1);
    assert.strictEqual(t.last_quality, null);
  });

  test('loadTopics accepts pre-scanned files array to avoid redundant directory walks', () => {
    const file1 = path.join(tmpVault, 'prescan1.md');
    fs.writeFileSync(
      file1,
      `---
palee_schema: 1
palee_id: T-prescan-1
title: Prescan 1
---
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault, [file1]);
    assert.strictEqual(topics.length, 1);
    assert.strictEqual(topics[0].palee_id, 'T-prescan-1');
  });

  test('loadTopics unions and dedupes depends_on and dependencies when both keys are present (Issue #126)', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'dual-deps.md'),
      `---
palee_schema: 1
palee_id: T-dual-deps
title: Dual Dependencies Topic
depends_on:
  - T-dep-1
  - T-dep-2
dependencies:
  - T-dep-2
  - T-dep-3
---
# Dual Deps Topic
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 1);
    const t = topics[0];
    assert.deepStrictEqual(t.depends_on, ['T-dep-1', 'T-dep-2', 'T-dep-3']);
  });

  test('loadTopics supports comma-separated string dependencies and unions aliases', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'comma-deps.md'),
      `---
palee_schema: 1
palee_id: T-comma-deps
title: Comma Dependencies Topic
depends_on: "T-dep-a, T-dep-b"
dependencies: "T-dep-b, T-dep-c"
---
# Comma Deps Topic
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 1);
    const t = topics[0];
    assert.deepStrictEqual(t.depends_on, ['T-dep-a', 'T-dep-b', 'T-dep-c']);
  });

  test('loadTopics drops null/empty list entries from YAML without coercing to "null"', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'null-entry.md'),
      `---
palee_schema: 1
palee_id: T-null-entry
title: Null Entry Topic
depends_on:
  -
  - T-valid-dep
dependencies:
  -
---
# Null Entry Topic
`,
      'utf8'
    );

    const topics = loadTopics(tmpVault);
    assert.strictEqual(topics.length, 1);
    const t = topics[0];
    assert.deepStrictEqual(t.depends_on, ['T-valid-dep']);
  });
});

describe('normalizeDependencies (Issue #126)', () => {
  const testCases: Array<{
    name: string;
    dependsOn: unknown;
    dependencies: unknown;
    expected: string[];
  }> = [
    {
      name: 'unions arrays in canonical-first order',
      dependsOn: ['T-1', 'T-2'],
      dependencies: ['T-2', 'T-3'],
      expected: ['T-1', 'T-2', 'T-3'],
    },
    {
      name: 'supports comma-separated and array values',
      dependsOn: 'T-1, T-2',
      dependencies: ['T-2', 'T-3'],
      expected: ['T-1', 'T-2', 'T-3'],
    },
    {
      name: 'preserves wikilinks',
      dependsOn: ['[[T-math]]'],
      dependencies: '[[T-math]], [[T-geometry]]',
      expected: ['[[T-math]]', '[[T-geometry]]'],
    },
    {
      name: 'trims whitespace and drops empty values',
      dependsOn: ['  T-1  ', ' ', null],
      dependencies: ' , T-2, ',
      expected: ['T-1', 'T-2'],
    },
    {
      name: 'ignores unsupported values',
      dependsOn: { invalid: true },
      dependencies: 42,
      expected: [],
    },
  ];

  for (const { name, dependsOn, dependencies, expected } of testCases) {
    test(name, () => {
      assert.deepStrictEqual(normalizeDependencies(dependsOn, dependencies), expected);
    });
  }
});

describe('loadTopics cache injection (Issue #129)', () => {
  let tmpVault: string;

  beforeEach(() => {
    // Canonicalize the temp path the way walkVault does (realpathSync):
    // on macOS os.tmpdir() is /var/..., a symlink to /private/var/...,
    // so walked file paths never string-match the raw mkdtemp result.
    tmpVault = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-cache-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  /**
   * Writes a minimal PALEE topic note into the temp vault.
   *
   * @param id - palee_id to embed in the note frontmatter
   * @param status - Learning status value for the note (default: learning)
   * @returns Absolute path of the written note
   */
  function writeTopicNote(id: string, status = 'learning'): string {
    const filePath = path.join(tmpVault, `topic-${id}.md`);
    fs.writeFileSync(
      filePath,
      `---\npalee_id: ${id}\ntitle: Topic ${id}\nstatus: ${status}\ndepends_on: []\n---\n\n# Topic ${id}\n`,
      'utf8'
    );
    return filePath;
  }

  test('first load with { cache } invokes the injected cache get() and set() per valid topic', () => {
    const f1 = writeTopicNote('T-inj-1');
    const f2 = writeTopicNote('T-inj-2');
    const injected = new TrackingCache();

    const topics = loadTopics(tmpVault, { cache: injected });

    assert.strictEqual(topics.length, 2);
    assert.ok(injected.getCalls.includes(f1) && injected.getCalls.includes(f2));
    assert.ok(injected.setCalls.includes(f1) && injected.setCalls.includes(f2));
    // get() precedes set() for each file: misses then writes
    assert.strictEqual(injected.getCalls.length, 2);
    assert.strictEqual(injected.setCalls.length, 2);
  });

  test('second unchanged load returns identical cached objects; get() grows, set() does not', () => {
    const f1 = writeTopicNote('T-inj-stable');
    const injected = new TrackingCache();

    const first = loadTopics(tmpVault, { cache: injected });
    const getsAfterFirst = injected.getCalls.length;
    const setsAfterFirst = injected.setCalls.length;
    assert.strictEqual(setsAfterFirst, 1);

    const second = loadTopics(tmpVault, { cache: injected });

    assert.strictEqual(second.length, 1);
    // Object identity preserved from the injected cache
    assert.strictEqual(second[0], first[0]);
    assert.strictEqual(second[0].palee_id, 'T-inj-stable');
    // Cache consulted again (get) but never rewritten (no new set)
    assert.strictEqual(injected.getCalls.length, getsAfterFirst + 1);
    assert.strictEqual(injected.setCalls.length, setsAfterFirst);
    assert.ok(injected.getCalls.includes(f1));
  });

  test('mutating a note invalidates the injected cache and returns updated content', () => {
    writeTopicNote('T-inj-mut', 'learning');
    const injected = new TrackingCache();

    const before = loadTopics(tmpVault, { cache: injected });
    assert.strictEqual(before[0].status, 'learning');
    const setsAfterFirst = injected.setCalls.length;

    // Rewrite the note with different content (and settle mtime granularity)
    const filePath = path.join(tmpVault, 'topic-T-inj-mut.md');
    const newMtime = new Date(Date.now() + 1500);
    fs.writeFileSync(
      filePath,
      '---\npalee_id: T-inj-mut\ntitle: Topic T-inj-mut\nstatus: mastered\ndepends_on: []\n---\n\n# Updated\n',
      'utf8'
    );
    fs.utimesSync(filePath, newMtime, newMtime);

    const after = loadTopics(tmpVault, { cache: injected });

    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].status, 'mastered');
    // Invalidation forced a fresh set() with the updated topic
    assert.ok(injected.setCalls.length > setsAfterFirst);
  });

  test('a fresh injected cache starts empty and keeps counters independent of the shared cache', () => {
    writeTopicNote('T-inj-fresh');
    const sharedBefore = getTopicCache();
    // Warm the shared cache via the default form
    loadTopics(tmpVault);

    const injected = new TrackingCache();
    assert.strictEqual(injected.getCalls.length, 0);
    assert.strictEqual(injected.setCalls.length, 0);

    const viaInjected = loadTopics(tmpVault, { cache: injected });

    assert.strictEqual(viaInjected.length, 1);
    assert.strictEqual(viaInjected[0].palee_id, 'T-inj-fresh');
    // The injected cache populated itself even though the shared cache was already warm
    assert.strictEqual(injected.setCalls.length, 1);
    // And the shared cache is untouched by the injected run
    assert.notStrictEqual(sharedBefore, injected);
  });

  test('legacy files-array form still works and uses the shared cache', () => {
    const f1 = writeTopicNote('T-inj-legacy');
    const topics = loadTopics(tmpVault, [f1]);
    assert.strictEqual(topics.length, 1);
    assert.strictEqual(topics[0].palee_id, 'T-inj-legacy');
  });

  test('default no-arg form still resolves via getTopicCache()', () => {
    writeTopicNote('T-inj-default');
    const shared = getTopicCache();
    shared.clear();

    const topics = loadTopics(tmpVault);

    assert.strictEqual(topics.length, 1);
    assert.strictEqual(topics[0].palee_id, 'T-inj-default');
    // Prove the shared cache served this load: a second call returns
    // the same object identity as what the shared cache holds.
    const again = loadTopics(tmpVault);
    assert.strictEqual(again[0], topics[0]);
  });

  test('runtime null second argument keeps the legacy vault-walk fallback (JS callers)', () => {
    // `loadTopics(v, null)` predated the options overload via `files ?? walkVault`;
    // it must keep walking the vault rather than dereferencing null.files.
    writeTopicNote('T-inj-null');
    const topics = loadTopics(tmpVault, null as unknown as string[]);
    assert.strictEqual(topics.length, 1);
    assert.strictEqual(topics[0].palee_id, 'T-inj-null');
  });
});


