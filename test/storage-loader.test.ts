import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeDependencies } from '../src/storage/dependencies';
import {
  loadTopics,
  getTopicCache,
  getNonTopicCache,
  MAX_NON_TOPIC_CACHE_ENTRIES,
} from '../src/storage/loader';
import { FileCache } from '../src/storage/cache';
import { MAX_NOTE_SOURCE_BYTES } from '../src/storage/source-cap';
import type { LoadedTopic } from '../src/storage/loader';
import type { TopicNode } from '../src/types';

/**
 * Counts `fs.readFileSync` calls for the listed paths while `body` runs.
 *
 * @remarks
 * The loader reaches the filesystem through the shared `fs` module object, so
 * replacing the method for the duration of the callback observes its IO without
 * changing it, and the `finally` restore keeps a failing assertion from leaking
 * the patch. This is what makes a caching fix directly measurable: a repeated
 * load that serves a verdict from a cached entry performs no read at all, while
 * an uncached verdict costs exactly one read per pass.
 *
 * @param targets - Absolute paths whose reads are counted
 * @param body - Code under observation
 * @returns The callback result plus per-path read counts
 */
function countReads<T>(targets: string[], body: () => T): { result: T; reads: Map<string, number> } {
  const original = fs.readFileSync;
  const callOriginal = original as unknown as (...args: unknown[]) => unknown;
  const holder = fs as unknown as { readFileSync: typeof fs.readFileSync };
  const reads = new Map<string, number>(targets.map((t) => [t, 0]));
  holder.readFileSync = ((...args: unknown[]): unknown => {
    const key = args[0];
    if (typeof key === 'string' && reads.has(key)) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
    }
    return callOriginal.apply(fs, args);
  }) as typeof fs.readFileSync;
  try {
    return { result: body(), reads };
  } finally {
    holder.readFileSync = original;
  }
}

/**
 * Pins each file's `mtime` a fixed interval in the past at a millisecond value
 * that is not a whole second.
 *
 * @remarks
 * Outside the unsettled horizon, and off the whole-second fallback (#367), a
 * validated cache hit is served from `stat` alone. Without this the readers
 * re-read a just-written file by design, so a read count would measure the
 * horizon rather than the cache.
 *
 * @param files - Absolute paths to settle
 */
function settleOutsideHorizon(files: string[]): void {
  const pinned = Math.floor((Date.now() - 10000) / 1000) * 1000 + 250;
  for (const filePath of files) {
    fs.utimesSync(filePath, new Date(pinned), new Date(pinned));
  }
  // Fail with the real cause if the filesystem rounds `mtime` to whole seconds:
  // there the #367 fingerprint fallback re-reads on every hit and a read count
  // would no longer be a cache measurement.
  if (files.length > 0) {
    assert.notStrictEqual(
      fs.statSync(files[0]).mtimeMs % 1000,
      0,
      'the temp filesystem must record sub-second mtimes for this measurement'
    );
  }
}

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
  override get(filePath: string): LoadedTopic | null {
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
  override set(filePath: string, data: LoadedTopic, fingerprint?: string): void {
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

  test('loadTopics coerces a quoted numeric last_quality and nulls a genuinely invalid one (Issue #375)', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'quoted-quality.md'),
      `---
palee_schema: 1
palee_id: T-quoted-quality
title: Quoted Quality Topic
last_quality: "4"
---
# Quoted Quality
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpVault, 'invalid-quality.md'),
      `---
palee_schema: 1
palee_id: T-invalid-quality
title: Invalid Quality Topic
last_quality: "not-a-number"
---
# Invalid Quality
`,
      'utf8'
    );

    const byId = new Map(loadTopics(tmpVault).map((t) => [t.palee_id, t]));

    // Quoted numeric string is coerced the same way sibling SM-2 integer fields are
    assert.strictEqual(byId.get('T-quoted-quality')!.last_quality, 4);
    // A genuinely non-numeric value still falls back to null (no SM-2 history yet)
    assert.strictEqual(byId.get('T-invalid-quality')!.last_quality, null);
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

  test('loadTopics carries depends_on_source so the toc tier can be recognized as advisory', () => {
    const write = (name: string, label: string): void => {
      fs.writeFileSync(
        path.join(tmpVault, name),
        `---
palee_schema: 1
palee_id: T-${name}
title: Labeled Topic
depends_on:
  - T-prereq
depends_on_source: ${label}
---
# Labeled
`,
        'utf8'
      );
    };
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.mkdirSync(tmpVault, { recursive: true });

    write('toc.md', 'toc');
    write('numbered.md', 'numbered');
    write('declared.md', 'declared');
    write('tie.md', 'tie');
    write('junk.md', '"toc-ish"');
    write('missing.md', 'null');

    const byName = new Map(loadTopics(tmpVault).map((t) => [t.palee_id, t]));
    assert.strictEqual(byName.get('T-toc.md')!.depends_on_source, 'toc');
    assert.strictEqual(byName.get('T-numbered.md')!.depends_on_source, 'numbered');
    assert.strictEqual(byName.get('T-declared.md')!.depends_on_source, 'declared');
    assert.strictEqual(byName.get('T-tie.md')!.depends_on_source, 'tie');
    assert.strictEqual(byName.get('T-junk.md')!.depends_on_source, undefined, 'an unknown label must not be trusted');
    assert.strictEqual(byName.get('T-missing.md')!.depends_on_source, undefined);
  });

  test('a mistyped label keeps the note gating, because an unknown source is not advisory', () => {
    // Fail-closed direction: the whole point of the label is that it relaxes a
    // gate. A typo (`ToC`, `toc ` aside from the accepted spellings) must fall
    // back to the pre-existing behaviour rather than silently unlocking.
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.mkdirSync(tmpVault, { recursive: true });
    fs.writeFileSync(
      path.join(tmpVault, 'typo.md'),
      `---
palee_schema: 1
palee_id: T-typo
title: Typo
depends_on:
  - T-prereq
depends_on_source: adds_on_source
topic_mastery: 0
---
# Typo
`,
      'utf8'
    );
    const [topic] = loadTopics(tmpVault);
    const { areDependenciesSatisfied } = require('../src/engine/dependency');
    const prereq = { palee_id: 'T-prereq', depends_on: [], topic_mastery: 0 };
    const graph = new Map<string, TopicNode>([
      [topic.palee_id, topic],
      [prereq.palee_id, prereq],
    ]);
    assert.strictEqual(
      areDependenciesSatisfied(topic, graph),
      false,
      'an unrecognized label must not demote a real prerequisite to advisory'
    );
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
    // A non-topic file is consulted in the injected cache (the loader cannot
    // know before parsing) but its verdict is NOT stored there: non-topic
    // markers live in their own bounded cache so they can never evict a real
    // topic past the topic cache cap (#331). Re-pinned from the two-file form
    // that preceded #331, where get() and set() counts were trivially equal.
    const plain = path.join(tmpVault, 'ordinary-note.md');
    fs.writeFileSync(plain, '# Just a note\n\nNo frontmatter anywhere.\n', 'utf8');
    const injected = new TrackingCache();

    const topics = loadTopics(tmpVault, { cache: injected });

    assert.strictEqual(topics.length, 2);
    assert.ok(injected.getCalls.includes(f1) && injected.getCalls.includes(f2));
    assert.ok(injected.setCalls.includes(f1) && injected.setCalls.includes(f2));
    // get() precedes set() for each file: misses then writes
    assert.strictEqual(injected.getCalls.length, 3);
    assert.strictEqual(injected.setCalls.length, 2);
    assert.ok(!injected.setCalls.includes(plain), 'a non-topic verdict stays out of the topic cache');
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

describe('a note whose extension is not lowercase', () => {
  let vault: string;

  /**
   * Creates a vault holding `Setup.MD`, adopted and titled by nothing but its
   * filename.
   */
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-case-'));
    fs.writeFileSync(
      path.join(vault, 'Setup.MD'),
      '---\npalee_id: T-setup-1\npalee_schema: 1\ndepends_on: []\n---\n# Setup\n'
    );
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  // `walkVault` matched the extension case-sensitively, so this note was in no
  // scan at all while `[[setup]]` still resolved it as a link target — and the
  // loader's title fallback stripped `.md` case-sensitively too, so a note that
  // did arrive came back titled "Setup.MD".
  test('is loaded, and titled from its name without the extension', () => {
    const topics = loadTopics(vault);
    assert.strictEqual(topics.length, 1, 'the walker and the loader fold the same way');
    assert.strictEqual(topics[0].palee_id, 'T-setup-1');
    assert.strictEqual(topics[0].title, 'Setup');
  });
});

// Issue #331: `cache.set` used to run only for files that yielded a `palee_id`,
// so every non-topic file fell through `continue` with no negative entry and a
// long-lived process re-read and re-parsed the whole vault on each load — scan
// cost tracked total vault size instead of topic count.
describe('loadTopics negative caching of non-topic notes (Issue #331)', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-negative-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  /**
   * Writes an ordinary vault note: a real note, no `palee_id` anywhere.
   *
   * @param name - File name inside the temp vault
   * @param content - Note text (default: a note with a non-PALEE frontmatter block)
   * @returns Absolute path of the written note
   */
  function writePlainNote(name: string, content = '---\ntags: [reading]\ntitle: Book notes\n---\n# Book\n'): string {
    const filePath = path.join(tmpVault, name);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  /**
   * Writes a minimal PALEE topic note.
   *
   * @param id - palee_id to embed
   * @returns Absolute path of the written note
   */
  function writeTopic(id: string): string {
    const filePath = path.join(tmpVault, `topic-${id}.md`);
    fs.writeFileSync(filePath, `---\npalee_id: ${id}\ntitle: ${id}\n---\n\n# ${id}\n`, 'utf8');
    return filePath;
  }

  test('a repeated load does not re-read a non-topic file', () => {
    const topic = writeTopic('T-331-topic');
    const withFrontmatter = writePlainNote('book-notes.md');
    const withoutFrontmatter = writePlainNote('journal.md', '# Journal\n\nProse, no fences.\n');
    settleOutsideHorizon([topic, withFrontmatter, withoutFrontmatter]);

    const injected = new TrackingCache();
    const first = countReads([topic, withFrontmatter, withoutFrontmatter], () =>
      loadTopics(tmpVault, { cache: injected })
    );
    assert.strictEqual(first.result.length, 1);
    assert.strictEqual(first.reads.get(topic), 1, 'the topic is read once to be parsed');
    assert.strictEqual(first.reads.get(withFrontmatter), 1, 'the verdict needs the bytes once');
    assert.strictEqual(first.reads.get(withoutFrontmatter), 1);

    const second = countReads([topic, withFrontmatter, withoutFrontmatter], () =>
      loadTopics(tmpVault, { cache: injected })
    );
    assert.strictEqual(second.result.length, 1, 'the negative verdict is not mistaken for a topic');
    assert.strictEqual(second.result[0], first.result[0], 'topics keep their cached identity');
    assert.strictEqual(second.reads.get(topic), 0);
    // The fix: a known non-topic note costs a `stat`, not a read plus a YAML parse.
    assert.strictEqual(second.reads.get(withFrontmatter), 0, 'the marker serves the verdict');
    assert.strictEqual(second.reads.get(withoutFrontmatter), 0);
  });

  test('a marker is held by the negative cache and never by the topic cache', () => {
    const topic = writeTopic('T-331-split');
    const plain = writePlainNote('plain.md');
    const injected = new TrackingCache();

    loadTopics(tmpVault, { cache: injected });

    assert.deepStrictEqual(injected.setCalls, [topic], 'only the topic enters the topic cache');
    const markers = getNonTopicCache();
    assert.deepStrictEqual(markers.get(plain), { palee_non_topic: true });
    assert.strictEqual(markers.get(topic), null, 'a real topic is never negatively cached');
  });

  test('an edited non-topic file that gains a palee_id is loaded on the next pass', () => {
    const promoted = writePlainNote('promoted.md');
    const injected = new TrackingCache();

    assert.strictEqual(loadTopics(tmpVault, { cache: injected }).length, 0);
    assert.deepStrictEqual(getNonTopicCache().get(promoted), { palee_non_topic: true });

    fs.writeFileSync(promoted, '---\npalee_id: T-promoted\n---\n# Now a topic\n', 'utf8');

    const after = loadTopics(tmpVault, { cache: injected });
    assert.strictEqual(after.length, 1, 'the stale marker cannot hide a promoted note');
    assert.strictEqual(after[0].palee_id, 'T-promoted');
    assert.strictEqual(getNonTopicCache().get(promoted), null, 'the invalidated marker is evicted');
  });

  test('a marker is fingerprint-validated, not trusted from the path alone', () => {
    // Same byte length, different bytes: `mtime` and `size` both still match
    // what the entry recorded, so only the re-hashed fingerprint can catch it.
    // The file stays inside the unsettled horizon, which is what forces the
    // re-hash on read.
    const original = '---\ntags: [aaaa]\n---\n# A\n';
    const edited = '---\ntags: [bbbb]\n---\n# A\n';
    assert.strictEqual(
      Buffer.byteLength(edited),
      Buffer.byteLength(original),
      'the rewrite is same-size, so a size-only check would pass it'
    );
    const swapped = writePlainNote('swap.md', original);
    loadTopics(tmpVault, { cache: new TrackingCache() });
    assert.deepStrictEqual(getNonTopicCache().get(swapped), { palee_non_topic: true });

    fs.writeFileSync(swapped, edited, 'utf8');
    assert.strictEqual(fs.statSync(swapped).size, Buffer.byteLength(original));
    assert.strictEqual(
      getNonTopicCache().get(swapped),
      null,
      'the changed fingerprint must invalidate the marker'
    );
  });

  test('a negatively cached file that disappears is retried rather than trusted', () => {
    const gone = writePlainNote('gone.md');
    loadTopics(tmpVault, { cache: new TrackingCache() });
    assert.deepStrictEqual(getNonTopicCache().get(gone), { palee_non_topic: true });
    fs.unlinkSync(gone);

    const topics = loadTopics(tmpVault, { files: [gone], cache: new TrackingCache() });

    assert.strictEqual(topics.length, 0);
    assert.strictEqual(
      getNonTopicCache().get(gone),
      null,
      'a marker for a file that no longer stats is dropped, never carried forward'
    );
  });

  test('snapshot-injected bytes never populate the negative cache', () => {
    // Same rule the topic cache already enforces: injected content is snapshot
    // truth, not on-disk truth, and a marker written from it would hide the
    // file's real verdict from every later load.
    const note = writeTopic('T-331-disk');
    const snapshot = new Map<string, string>([[note, '# Only a snapshot\n']]);

    const injected = countReads([note], () => loadTopics(tmpVault, { contents: snapshot }));
    assert.strictEqual(injected.result.length, 0, 'the snapshot bytes are not a topic');
    assert.strictEqual(injected.reads.get(note), 0, 'injected bytes are used verbatim');
    assert.strictEqual(getNonTopicCache().get(note), null, 'no marker survived the snapshot load');

    const after = loadTopics(tmpVault, { cache: new TrackingCache() });
    assert.strictEqual(after.length, 1, 'the disk verdict is still read fresh');
    assert.strictEqual(after[0].palee_id, 'T-331-disk');
  });

  test('the negative cache cap is a bounded positive constant', () => {
    assert.ok(
      Number.isInteger(MAX_NON_TOPIC_CACHE_ENTRIES) && MAX_NON_TOPIC_CACHE_ENTRIES > 0,
      'markers are bounded on their own cap, so they cannot evict topics'
    );
  });
});

// Issue #332: the note readers did unbounded `readFileSync` plus a whole-buffer
// parse, unlike the TOC reader which declines an oversized document stat-first
// (src/storage/toc.ts, issue #263). The ceiling itself is pinned in
// test/storage-source-cap.test.ts.
describe('loadTopics input-size guard (Issue #332)', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-size-'))
    );
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('a document above the cap is skipped without ever being read', () => {
    const topic = path.join(tmpVault, 'topic-ok.md');
    fs.writeFileSync(topic, '---\npalee_id: T-332-ok\n---\n# Ok\n', 'utf8');
    // Past the cap even though its frontmatter opens with a valid `palee_id`:
    // bytes that cannot be loaded cannot be trusted as a topic either.
    const dump = path.join(tmpVault, 'dump.md');
    fs.writeFileSync(
      dump,
      `---\npalee_id: T-332-dump\n---\n${'x'.repeat(MAX_NOTE_SOURCE_BYTES)}`,
      'utf8'
    );

    const paths = [topic, dump];
    const first = countReads(paths, () =>
      loadTopics(tmpVault, { cache: new TrackingCache() })
    );

    assert.strictEqual(first.reads.get(dump), 0, 'the guard stats before reading');
    assert.strictEqual(first.result.length, 1, 'the healthy topic still loads');
    assert.strictEqual(first.result[0].palee_id, 'T-332-ok');
    assert.strictEqual(
      getNonTopicCache().get(dump),
      null,
      'a declined read is not recorded as a verified non-topic note'
    );

    // Shrink it back under the cap and the same path loads — the skip left no
    // cached verdict behind.
    fs.writeFileSync(dump, '---\npalee_id: T-332-shrunk\n---\n# Small now\n', 'utf8');
    const second = countReads(paths, () => loadTopics(tmpVault, { cache: new TrackingCache() }));
    assert.strictEqual(second.reads.get(dump), 1);
    assert.deepStrictEqual(
      second.result.map((t) => t.palee_id).sort(),
      ['T-332-ok', 'T-332-shrunk']
    );
  });

  test('a topic note exactly at the cap still loads', () => {
    const edge = path.join(tmpVault, 'edge-topic.md');
    const frontmatter = '---\npalee_id: T-332-edge\n---\n';
    fs.writeFileSync(
      edge,
      `${frontmatter}${'x'.repeat(MAX_NOTE_SOURCE_BYTES - Buffer.byteLength(frontmatter))}`,
      'utf8'
    );
    assert.strictEqual(fs.statSync(edge).size, MAX_NOTE_SOURCE_BYTES, 'exactly the ceiling');

    const topics = loadTopics(tmpVault, { cache: new TrackingCache() });

    assert.strictEqual(topics.length, 1, 'the ceiling is inclusive');
    assert.strictEqual(topics[0].palee_id, 'T-332-edge');
  });
});



