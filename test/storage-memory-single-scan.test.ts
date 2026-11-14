import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildHotAndIndex } from '../src/storage/memory';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * `hot.md` and `index.md` are two views of one rebuild pass, but each walked
 * `S-*.md` on its own: stat, read and YAML-parse every session twice per
 * rebuild (#565 P2-09). Sessions grow without bound, so every `session end`,
 * draft save/discard and `validate --fix` paid O(2N).
 *
 * The rebuild now scans once and hands the same rows to the index writer. This
 * test counts the filesystem calls a real rebuild makes, so returning to two
 * scans doubles the directory listing and every per-session read.
 */
describe('rebuildHotAndIndex scans the sessions directory once (#565 P2-09)', () => {
  let vault: string;
  let sessionsDir: string;

  const SESSION_FILES = ['S-old.md', 'S-new.md', 'S-unsupported.md'];

  /** Writes a canonical session note; `schema` 2 is the unsupported variant. */
  function writeSession(
    fileName: string,
    sessionId: string,
    topicId: string,
    startedAt: string,
    body: string,
    schema = 1
  ): void {
    fs.writeFileSync(
      path.join(sessionsDir, fileName),
      `---
palee_schema: ${schema}
session_id: ${sessionId}
topic_id: ${topicId}
started_at: ${startedAt}
ended_at: ${startedAt}
status: completed
---
${body}
`,
      'utf8'
    );
  }

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-one-scan-'));
    sessionsDir = path.join(vault, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeSession('S-old.md', 'S-old', 'T-old', '2026-01-02T03:04:05.000Z', 'Older session body.');
    writeSession('S-new.md', 'S-new', 'T-new', '2026-02-03T04:05:06.000Z', 'Newest session body.');
    writeSession('S-unsupported.md', 'S-unsupported', 'T-bad', '2026-03-04T05:06:07.000Z', 'Unsupported schema body.', 2);
  });

  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('one directory listing and one read per session file, with both views intact', async () => {
    const originalReaddir = fs.readdirSync;
    const originalReadFile = fs.readFileSync;
    let sessionDirListings = 0;
    const readsPerFile = new Map<string, number>();

    try {
      Object.defineProperty(fs, 'readdirSync', {
        configurable: true,
        writable: true,
        value: (target: fs.PathLike, options?: unknown): unknown => {
          if (String(target) === sessionsDir) sessionDirListings++;
          return (originalReaddir as unknown as (t: fs.PathLike, o?: unknown) => unknown)(target, options);
        },
      });
      Object.defineProperty(fs, 'readFileSync', {
        configurable: true,
        writable: true,
        value: (target: fs.PathLike, options?: unknown): unknown => {
          const file = String(target);
          if (path.dirname(file) === sessionsDir) {
            readsPerFile.set(file, (readsPerFile.get(file) ?? 0) + 1);
          }
          return (originalReadFile as unknown as (t: fs.PathLike, o?: unknown) => unknown)(target, options);
        },
      });

      await rebuildHotAndIndex(vault);
    } finally {
      Object.defineProperty(fs, 'readdirSync', { configurable: true, writable: true, value: originalReaddir });
      Object.defineProperty(fs, 'readFileSync', { configurable: true, writable: true, value: originalReadFile });
    }

    assert.strictEqual(sessionDirListings, 1, 'the rebuild must list the sessions directory once');
    for (const file of SESSION_FILES) {
      assert.strictEqual(
        readsPerFile.get(path.join(sessionsDir, file)),
        1,
        `${file} must be read exactly once per rebuild`
      );
    }

    // Parity: the single snapshot still produces both files as before.
    const index = fs.readFileSync(path.join(vault, '.palee', 'index.md'), 'utf8');
    assert.match(index, /Total Sessions: 2/, index);
    assert.match(index, /Skipped \(unreadable or unsupported schema\): 1/, index);
    assert.match(index, /- \[\[S-new\]\] - Topic: T-new/);
    assert.match(index, /- \[\[S-old\]\] - Topic: T-old/);
    assert.ok(index.indexOf('[[S-new]]') < index.indexOf('[[S-old]]'), 'the index is newest first');

    const hot = parseFrontmatter(fs.readFileSync(path.join(vault, '.palee', 'hot.md'), 'utf8')).frontmatter;
    assert.strictEqual(hot?.last_session, 'S-new', 'hot.md must still point at the newest confirmed session');
  });
});
