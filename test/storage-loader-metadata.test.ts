import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { loadTopics, loadTopicMetadata } from '../src/storage/loader';
import type { LoadedTopic } from '../src/storage/loader';
import { MAX_NOTE_SOURCE_BYTES } from '../src/storage/source-cap';

/**
 * The full `loadTopics` pipeline a metadata load must match, minus the body.
 *
 * @remarks
 * `content` is the one field {@link loadTopicMetadata} deliberately omits
 * (P3-06); every other field must be indistinguishable between the two paths.
 * `Partial` rather than `Omit` so the `delete` below type-checks.
 */
type FullTopicWithoutContent = Partial<LoadedTopic>;

/**
 * Observes `fs.readFileSync`, `fs.readSync` and `crypto.createHash` while
 * `body` runs, without changing their behavior for other callers.
 *
 * @remarks
 * The loader reaches the filesystem through the shared `fs` module object and
 * hashing through `frontmatter.ts`'s `crypto` import, so replacing those
 * methods for the duration of the callback observes the IO of one load. For
 * every probed path `readFileSync` **throws** — a metadata-only load must
 * never perform a full-body read, so a revert to `readFileSync` cannot pass
 * silently: the loader's graceful-skip turns it into a missing topic, which
 * the `topics.length` assertions reject.
 *
 * @param probedPaths - Absolute paths a full-body read is forbidden on
 * @param body - Code under observation
 * @returns The callback result plus the recorded IO counters
 */
function probeIo<T>(probedPaths: string[], body: () => T): {
  result: T;
  readFileSyncCalls: Map<string, number>;
  readSyncBytes: number;
  hashes: number;
} {
  const probed = new Set(probedPaths);
  const readFileSyncCalls = new Map<string, number>(probedPaths.map((p) => [p, 0]));
  let readSyncBytes = 0;
  let hashes = 0;

  const fsHolder = fs as unknown as Record<string, unknown>;
  const originalReadFileSync = fs.readFileSync;
  const originalReadSync = fs.readSync;
  const originalCreateHash = crypto.createHash;

  fsHolder.readFileSync = ((filePath: unknown, ...rest: unknown[]): unknown => {
    if (typeof filePath === 'string' && probed.has(filePath)) {
      readFileSyncCalls.set(filePath, (readFileSyncCalls.get(filePath) ?? 0) + 1);
      throw new Error(`full-body readFileSync attempted on ${filePath}`);
    }
    return (originalReadFileSync as unknown as (...args: unknown[]) => unknown).apply(fs, [filePath, ...rest]);
  }) as typeof fs.readFileSync;

  fsHolder.readSync = ((...args: unknown[]): number => {
    const bytes = (originalReadSync as unknown as (...args: unknown[]) => number).apply(fs, args);
    readSyncBytes += bytes;
    return bytes;
  }) as typeof fs.readSync;

  (crypto as unknown as Record<string, unknown>).createHash = ((...args: unknown[]): unknown => {
    hashes += 1;
    return (originalCreateHash as unknown as (...args: unknown[]) => unknown).apply(crypto, args);
  }) as typeof crypto.createHash;

  try {
    return { result: body(), readFileSyncCalls, readSyncBytes, hashes };
  } finally {
    fsHolder.readFileSync = originalReadFileSync;
    fsHolder.readSync = originalReadSync;
    (crypto as unknown as Record<string, unknown>).createHash = originalCreateHash;
  }
}

/**
 * Pins each file's `mtime` a fixed interval in the past at a millisecond value
 * that is not a whole second.
 *
 * @remarks
 * Mirrors the helper in `storage-loader.test.ts`: outside the unsettled
 * horizon and off the whole-second fallback (#367), a `FileCache.get` hit is
 * served from `stat` alone. The cache-isolation test below depends on that —
 * a metadata load that poisoned the shared topic cache would be served
 * verbatim on the next full load only when validation reads nothing.
 *
 * @param files - Absolute paths to settle
 */
function settleOutsideHorizon(files: string[]): void {
  const pinned = Math.floor((Date.now() - 10000) / 1000) * 1000 + 250;
  for (const filePath of files) {
    fs.utimesSync(filePath, new Date(pinned), new Date(pinned));
  }
  const [firstFile] = files;
  if (firstFile !== undefined) {
    assert.notStrictEqual(
      fs.statSync(firstFile).mtimeMs % 1000,
      0,
      'the temp filesystem must record sub-second mtimes for this measurement'
    );
  }
}

describe('Storage Loader metadata-only path (P3-06)', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-loader-meta-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /** Writes one topic note whose body is large enough that a full read cannot hide inside a probe window. */
  function writeBigTopicNote(): { notePath: string; bodyBytes: number } {
    const frontmatter =
      '---\n' +
      'palee_schema: 1\n' +
      'palee_id: T-meta\n' +
      'title: Metadata Only\n' +
      'difficulty: beginner\n' +
      'topic_mastery: 0.5\n' +
      'depends_on: []\n' +
      '---\n';
    const body = `# Metadata Only\n${'x'.repeat(200 * 1024)}\n`;
    const notePath = path.join(tmpVault, 'big.md');
    fs.writeFileSync(notePath, frontmatter + body, 'utf8');
    return { notePath, bodyBytes: Buffer.byteLength(body, 'utf8') };
  }

  test('metadata load reads no note body and hashes nothing', () => {
    const { notePath, bodyBytes } = writeBigTopicNote();

    const { result: topics, readFileSyncCalls, readSyncBytes, hashes } = probeIo([notePath], () =>
      loadTopicMetadata(tmpVault)
    );

    // The note itself was parsed — not skipped for an unrelated reason.
    assert.strictEqual(topics.length, 1);
    const topic = topics[0];
    assert.ok(topic, 'the single topic note must load');
    assert.strictEqual(topic.palee_id, 'T-meta');
    assert.strictEqual(topic.title, 'Metadata Only');
    assert.strictEqual(topic.topic_mastery, 0.5);
    assert.strictEqual(topic.difficulty, 'beginner');
    assert.strictEqual(topic.status, 'not_started');
    assert.strictEqual(topic.filePath, notePath);

    // The deciding predicate (P3-06): no full-body readFileSync at all, and
    // the windowed reads stopped at the frontmatter instead of the body.
    assert.strictEqual(
      readFileSyncCalls.get(notePath),
      0,
      'a metadata-only load must never call fs.readFileSync on a note'
    );
    assert.ok(readSyncBytes > 0, 'the frontmatter head must actually be read');
    assert.ok(
      readSyncBytes < bodyBytes,
      `metadata read ${readSyncBytes} bytes; must stay under the ${bodyBytes}-byte body`
    );
    assert.strictEqual(hashes, 0, 'a metadata-only load must not hash any content');
  });

  test('a note over the read cap is declined stat-first and never opened', () => {
    const notePath = path.join(tmpVault, 'oversized.md');
    fs.writeFileSync(
      notePath,
      '---\npalee_id: T-big\n---\n' + 'a'.repeat(MAX_NOTE_SOURCE_BYTES + 1024),
      'utf8'
    );

    const { result: topics, readFileSyncCalls, readSyncBytes, hashes } = probeIo([notePath], () =>
      loadTopicMetadata(tmpVault)
    );

    // Same documented decline as the full load (ADR-0018): the note vanishes
    // from the graph silently, and the decline costs no IO at all.
    assert.strictEqual(topics.length, 0);
    assert.strictEqual(readFileSyncCalls.get(notePath), 0, 'the cap must decline before any read');
    assert.strictEqual(readSyncBytes, 0, 'the cap must decline stat-first: the file is never opened');
    assert.strictEqual(hashes, 0);
  });

  test('metadata matches the full load field-for-field, minus content', () => {
    const richBody =
      '# Rich\n\n---\nsecond fence in the body: trap\n---\n\nThe body is never parsed.\n';
    const richNote = path.join(tmpVault, 'rich.md');
    fs.writeFileSync(
      richNote,
      '---\n' +
      'palee_schema: 1\n' +
      'palee_id: T-rich\n' +
      'title: Rich Note\n' +
      'difficulty: advanced\n' +
      'topic_mastery: 0.75\n' +
      'depends_on:\n' +
      '  - T-other\n' +
      'depends_on_source: toc\n' +
      'status: Learning\n' +
      'conceptual: 0.9\n' +
      'practical: 0.8\n' +
      'debug: 0.7\n' +
      'feynman: 0.6\n' +
      'ease_factor: 2.3\n' +
      'interval_days: 6\n' +
      'repetition: 2\n' +
      'lapses: 1\n' +
      'last_quality: "4"\n' +
      'assessed_at: "2026-01-15T10:30:00Z"\n' +
      'last_reviewed_at: "2026-02-01"\n' +
      'due_at: "2026-03-01"\n' +
      'custom_key: hello\n' +
      '---\n' +
      richBody,
      'utf8'
    );
    // Ordinary note: no frontmatter, so not a topic for either path.
    fs.writeFileSync(path.join(tmpVault, 'plain.md'), '# Just a note\n', 'utf8');
    // Malformed frontmatter: YAML error, skipped by both paths.
    fs.writeFileSync(path.join(tmpVault, 'broken.md'), '---\nfrontmatter: [\n---\nbody\n', 'utf8');
    // Opening fence with no closing fence: skipped by both paths.
    fs.writeFileSync(path.join(tmpVault, 'unterminated.md'), '---\npalee_id: T-un\n', 'utf8');
    // CRLF note: the fence shapes must match with carriage returns present.
    fs.writeFileSync(path.join(tmpVault, 'crlf.md'), '---\r\npalee_id: T-crlf\r\ntitle: CRLF Note\r\n---\r\nbody\r\n', 'utf8');
    // BOM note: parseFrontmatter strips the BOM before anchoring its fences.
    fs.writeFileSync(path.join(tmpVault, 'bom.md'), '\uFEFF---\npalee_id: T-bom\ntitle: BOM Note\n---\nbody\n', 'utf8');

    const meta = loadTopicMetadata(tmpVault);
    const full = loadTopics(tmpVault);

    // The decline verdicts agree: exactly the three well-formed topic notes,
    // and neither the ordinary, the malformed, nor the unterminated note.
    assert.strictEqual(meta.length, 3);
    assert.strictEqual(full.length, 3);

    const byId = new Map(meta.map((t) => [t.palee_id, t]));
    const fullById = new Map(full.map((t) => [t.palee_id, t]));
    assert.deepStrictEqual(
      [...byId.keys()].sort(),
      ['T-bom', 'T-crlf', 'T-rich'],
      'T-un has no closing fence, so it is not a topic for either path'
    );

    for (const [id, m] of byId) {
      const f = fullById.get(id);
      assert.ok(f, `full load must also contain ${id}`);
      const fullWithoutContent = { ...f } as FullTopicWithoutContent;
      delete fullWithoutContent.content;
      assert.deepStrictEqual(
        m,
        fullWithoutContent,
        `metadata for ${id} must equal the full load minus content`
      );
      assert.ok(!('content' in m), 'metadata must not carry a content key');
    }

    // Spot-check the normalized fields through the shared builder.
    const rich = byId.get('T-rich');
    assert.ok(rich);
    assert.deepStrictEqual(rich.depends_on, ['T-other']);
    assert.strictEqual(rich.depends_on_source, 'toc');
    assert.strictEqual(rich.status, 'learning');
    assert.strictEqual(rich.last_quality, 4);
    assert.strictEqual(rich.assessed_at, '2026-01-15T10:30:00Z');
    assert.strictEqual(rich.due_at, '2026-03-01');
    assert.strictEqual(rich.frontmatter.custom_key, 'hello');
    const fullRich = fullById.get('T-rich');
    assert.ok(fullRich);
    assert.ok(fullRich.content.endsWith(richBody), 'the full load retains the whole note body');
  });

  test('metadata loads leave the full load\u2019s shared caches untouched', () => {
    const notePath = path.join(tmpVault, 'topic.md');
    const noteContent = '---\npalee_id: T-cache\ntitle: Cached Note\n---\n# Cached body\n';
    fs.writeFileSync(notePath, noteContent, 'utf8');
    settleOutsideHorizon([notePath]);

    // Metadata first: it must not write the shared topic or non-topic caches —
    // a metadata entry (slice fingerprint, no content) or a non-topic marker
    // served from those caches would corrupt or erase the next full load.
    const meta = loadTopicMetadata(tmpVault);
    assert.strictEqual(meta.length, 1);
    assert.ok(meta[0] && !('content' in meta[0]));

    const full = loadTopics(tmpVault);
    assert.strictEqual(full.length, 1, 'a metadata load must not mark the note non-topic');
    assert.strictEqual(full[0]?.content, noteContent, 'a metadata load must not replace the cached full topic');

    // And the reverse order stays metadata-only: the full load's cache entries
    // are not consulted (they hold full-content fingerprints the slice reader
    // would never match) and do not leak a content key back into metadata.
    const metaAgain = loadTopicMetadata(tmpVault);
    assert.strictEqual(metaAgain.length, 1);
    assert.ok(metaAgain[0] && !('content' in metaAgain[0]));
  });
});
