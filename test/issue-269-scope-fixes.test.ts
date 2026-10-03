/**
 * Scoped regression tests for the six owned fixes (#269 subset).
 *
 * Each group pins one defect so a revert fails loudly:
 * migrate conflict/deleted/unresolved accounting, unknown
 * `depends_on_source` validation, advisory-aware quarantine,
 * plan de-duplication and reconciling counts, adopt malformed-YAML
 * integrity exit, and the wikilink read guard.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validDependencyListRule } from '../src/validation/rules/valid-dependency-list';
import {
  quarantineCyclicTopics,
  getReadyTopics,
} from '../src/engine/dependency';
import type { TopicNode } from '../src/types';
import type { ValidationContext } from '../src/validation/types';
import type { LoadedTopic } from '../src/storage/loader';
import type { ScannedNote } from '../src/types';

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

function makeContext(topics: LoadedTopic[]): ValidationContext {
  return {
    vaultPath: '/vault',
    files: [],
    topics,
    notes: [] as ScannedNote[],
    memoryReadErrors: [],
    readIncomplete: false,
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: { state: 'missing', frontmatter: null, body: '' },
  };
}

function withVault(
  files: Record<string, string>,
  fn: (vault: string, dir: string) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-scope-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(vault, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ vaultPath: vault }));
  const prevDir = process.env.PALEE_CONFIG_DIR;
  const prevExit = process.exitCode;
  process.env.PALEE_CONFIG_DIR = dir;
  const run = (async () => {
    await fn(fs.realpathSync(vault), dir);
  })();
  return run.finally(() => {
    if (prevDir !== undefined) process.env.PALEE_CONFIG_DIR = prevDir;
    else delete process.env.PALEE_CONFIG_DIR;
    process.exitCode = prevExit;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function silence(): () => string {
  const chunks: string[] = [];
  const out = console.log;
  const err = console.error;
  console.log = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  return () => {
    console.log = out;
    console.error = err;
    return chunks.join('\n');
  };
}

function storedNote(id: string, title: string, deps: string[], source: string): string {
  return [
    '---',
    `palee_id: ${id}`,
    'palee_schema: 1',
    `title: ${title}`,
    'difficulty: beginner',
    `depends_on: [${deps.join(', ')}]`,
    `depends_on_source: ${source}`,
    'topic_mastery: 0',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

describe('migrate relabel accounting', () => {
  test('an OCC conflict counts as skipped, not a silent success', async () => {
    const { default: migrateCommand } = await import('../src/cli/migrate');
    await withVault(
      {
        'm/02-a.md': storedNote('T-a', 'First', [], 'numbered'),
        'm/02-b.md': storedNote('T-b', 'Second', ['T-a'], 'numbered'),
      },
      async (vault) => {
        const notePath = path.join(vault, 'm', '02-b.md');
        const originalRename = fs.renameSync;
        try {
          (fs as unknown as { renameSync: unknown }).renameSync = ((from: string, to: string) => {
            if (to === notePath) {
              const err = new Error('OCC conflict: mocked collision') as NodeJS.ErrnoException;
              err.code = 'ECONFLICT';
              throw err;
            }
            return (originalRename as typeof fs.renameSync)(from, to);
          }) as typeof fs.renameSync;
          const restore = silence();
          await migrateCommand({ relabelTies: true });
          const output = restore();
          assert.strictEqual(process.exitCode, 4);
          assert.match(output, /skipped/i);
        } finally {
          (fs as unknown as { renameSync: unknown }).renameSync = originalRename;
          process.exitCode = 0;
        }
      }
    );
  });

  test('a note deleted mid-pass is skipped with a re-run, never a write error', async () => {
    const { default: migrateCommand } = await import('../src/cli/migrate');
    await withVault(
      {
        'm/02-a.md': storedNote('T-a', 'First', [], 'numbered'),
        'm/02-b.md': storedNote('T-b', 'Second', ['T-a'], 'numbered'),
      },
      async (vault) => {
        const notePath = path.join(vault, 'm', '02-b.md');
        const originalRead = fs.readFileSync;
        let reads = 0;
        try {
          (fs as unknown as { readFileSync: unknown }).readFileSync = ((target: unknown, opts: unknown) => {
            const out = Reflect.apply(originalRead, fs, [target as never, opts as never]) as string | Buffer;
            if (target === notePath && typeof out === 'string') {
              reads += 1;
              if (reads === 2) {
                const err = new Error("ENOENT: no such file or directory, open '02-b.md'") as NodeJS.ErrnoException;
                err.code = 'ENOENT';
                throw err;
              }
            }
            return out;
          }) as typeof fs.readFileSync;
          const restore = silence();
          await migrateCommand({ relabelTies: true });
          const output = restore();
          assert.ok(reads >= 2, 'the write loop must re-read the note');
          assert.strictEqual(process.exitCode, 4);
          assert.match(output, /Skipped/);
          assert.doesNotMatch(output, /write error/);
        } finally {
          (fs as unknown as { readFileSync: unknown }).readFileSync = originalRead;
          process.exitCode = 0;
        }
      }
    );
  });
});

describe('unknown depends_on_source labels', () => {
  test('typos, empty strings and lists are errors so validate fails closed', () => {
    const bad = ['toc-typo', 'weird', '', 'TOC-ish'];
    for (const label of bad) {
      const topic = makeTopic({
        palee_id: 'T-bad',
        id: 'T-bad',
        path: 'bad.md',
        frontmatter: { depends_on: ['T-a'], depends_on_source: label },
      });
      const issues = validDependencyListRule.run(makeContext([topic]));
      const flagged = issues.filter((i) => i.field === 'depends_on_source');
      assert.strictEqual(flagged.length, 1, `label ${JSON.stringify(label)} must be flagged`);
      assert.strictEqual(flagged[0].severity, 'error');
    }
    const listTopic = makeTopic({
      palee_id: 'T-list',
      id: 'T-list',
      path: 'list.md',
      frontmatter: { depends_on: ['T-a'], depends_on_source: ['toc'] },
    });
    const listIssues = validDependencyListRule.run(makeContext([listTopic]));
    assert.ok(listIssues.some((i) => i.field === 'depends_on_source' && i.severity === 'error'));
  });

  test('known labels and absent labels pass', () => {
    for (const label of ['numbered', 'toc', 'declared', 'tie', ' TOC ', 'Tie']) {
      const topic = makeTopic({
        palee_id: 'T-ok',
        id: 'T-ok',
        path: 'ok.md',
        frontmatter: { depends_on: ['T-a'], depends_on_source: label },
      });
      const issues = validDependencyListRule.run(makeContext([topic]));
      assert.deepStrictEqual(
        issues.filter((i) => i.field === 'depends_on_source'),
        [],
        `label ${JSON.stringify(label)} must pass`
      );
    }
    const missing = makeTopic({ frontmatter: { depends_on: ['T-a'] } });
    assert.deepStrictEqual(
      validDependencyListRule.run(makeContext([missing])).filter((i) => i.field === 'depends_on_source'),
      []
    );
  });
});

describe('quarantine respects advisory edges', () => {
  test('a ring of pure toc edges stays usable', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], depends_on_source: 'toc', topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], depends_on_source: 'toc', topic_mastery: 0 }],
    ]);
    const { acyclic, cycles } = quarantineCyclicTopics(topics);
    assert.strictEqual(cycles.length, 0);
    assert.strictEqual(acyclic.size, 2);
    assert.deepStrictEqual(
      getReadyTopics(acyclic).map((t) => t.palee_id).sort(),
      ['T-a', 'T-b']
    );
  });

  test('a pure gating ring still quarantines', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-free', { palee_id: 'T-free', depends_on: [], topic_mastery: 0 }],
    ]);
    const { acyclic, cycles } = quarantineCyclicTopics(topics);
    assert.strictEqual(cycles.length, 1);
    assert.ok(!acyclic.has('T-a') && !acyclic.has('T-b'));
    assert.ok(acyclic.has('T-free'));
  });

  test('a dependent reached only through an advisory edge is not blocked', () => {
    const topics = new Map<string, TopicNode>([
      ['T-a', { palee_id: 'T-a', depends_on: ['T-b'], topic_mastery: 0 }],
      ['T-b', { palee_id: 'T-b', depends_on: ['T-a'], topic_mastery: 0 }],
      ['T-advisory', { palee_id: 'T-advisory', depends_on: ['T-a'], depends_on_source: 'toc', topic_mastery: 0 }],
    ]);
    const { acyclic } = quarantineCyclicTopics(topics);
    assert.ok(acyclic.has('T-advisory'));
  });
});

describe('plan lists and counts', () => {
  test('a blocked note never appears under Reviews Due', async () => {
    const { default: planCommand } = await import('../src/cli/plan');
    await withVault(
      {
        'gatekeeper.md': storedNote('T-gatekeeper', 'Gatekeeper', [], 'numbered').replace(
          'depends_on: []',
          'depends_on: []'
        ),
        'gated.md': storedNote('T-gated', 'Gated', ['T-gatekeeper'], 'numbered'),
      },
      async () => {
        const restore = silence();
        await planCommand({ json: true });
        const output = restore();
        const data = JSON.parse(output.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
          reviews_due: { id: string }[];
          blocked: { id: string }[];
          counts: { due: number; blocked: number; mastered: number; learning: number; new: number; total_topics?: number };
          total_topics: number;
        };
        const dueIds = data.reviews_due.map((t) => t.id);
        const blockedIds = data.blocked.map((b) => b.id);
        assert.ok(blockedIds.includes('T-gated'));
        assert.ok(!dueIds.includes('T-gated'), 'blocked notes live under Blocked only');
        assert.strictEqual(data.counts.due, data.reviews_due.length);
        assert.strictEqual(data.counts.mastered + data.counts.learning + data.counts.new, data.total_topics);
      }
    );
  });
});

describe('adopt malformed frontmatter', () => {
  test('names the note and exits 3 with nothing written', async () => {
    const { default: adoptCommand } = await import('../src/cli/adopt');
    await withVault(
      {
        'good.md': '# Good\n',
        'broken.md': '---\nkey: [unclosed\n---\n# Broken\n',
      },
      async (vault) => {
        const restore = silence();
        await adoptCommand(undefined, { all: true, yes: true });
        const output = restore();
        assert.strictEqual(process.exitCode, 3);
        assert.match(output, /broken\.md/);
        assert.ok(!fs.readFileSync(path.join(vault, 'good.md'), 'utf8').includes('palee_id'));
      }
    );
  });
});

describe('wikilink unreadable note', () => {
  test('an EACCES read becomes a friendly named error', async () => {
    const { resolveWikilinkRoadmap } = await import('../src/storage/wikilink');
    const { parseWikilink } = await import('../src/engine/auto-chain');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-269-wiki-'));
    try {
      fs.writeFileSync(path.join(dir, 'note.md'), '# Note\n');
      const parsed = parseWikilink('[[note]]');
      assert.ok(parsed);
      const original = fs.readFileSync;
      try {
        (fs as unknown as { readFileSync: unknown }).readFileSync = (( ) => {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }) as typeof fs.readFileSync;
        assert.throws(
          () => resolveWikilinkRoadmap(dir, [{ track: '', links: [parsed!] }]),
          (err: unknown) => {
            const msg = (err as Error).message;
            assert.match(msg, /Could not read note\.md/);
            assert.doesNotMatch(msg, /at Object|at fs/);
            return true;
          }
        );
      } finally {
        (fs as unknown as { readFileSync: unknown }).readFileSync = original;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
