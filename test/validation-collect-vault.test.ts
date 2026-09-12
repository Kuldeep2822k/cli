/**
 * Validation vault collection tests (#25)
 *
 * Contracts under test:
 * - `collectVault` builds a full `ValidationContext` in one call.
 * - Malformed notes survive collection as parse-error entries — the scan
 *   never aborts (invariant: a bad note is a warning, not a crash).
 * - Valid PALEE topics in the same vault are still collected and checked.
 * - Topic loading honors an injected cache (isolation seam from #129).
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectVault } from '../src/validation/collect-vault';
import { FileCache } from '../src/storage/cache';
import type { LoadedTopic } from '../src/storage/loader';

describe('Validation vault collection', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-collect-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  test('collects topics, files, and per-file note outcomes into one context', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic.md'),
      '---\npalee_schema: 1\npalee_id: T-a\ntitle: A\n---\n# A\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpVault, 'plain.md'), '# Plain\n', 'utf8');

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    assert.strictEqual(context.vaultPath, tmpVault);
    assert.strictEqual(context.files.length, 2);
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.topics[0].palee_id, 'T-a');
    assert.strictEqual(context.notes.length, 2);
  });

  test('malformed note does not abort collection; valid topics still load', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'broken.md'),
      '---\npalee_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpVault, 'good.md'),
      '---\npalee_schema: 1\npalee_id: T-good\ntitle: Good\n---\n# Good\n',
      'utf8'
    );

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    const broken = context.notes.find((n) => n.relativePath === 'broken.md');
    assert.ok(broken, 'malformed note must survive collection');
    assert.ok(broken.parseError);
    assert.strictEqual(broken.frontmatter, null);

    // The valid topic next to it is still fully collected.
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.topics[0].palee_id, 'T-good');
  });

  test('malformed non-PALEE note is retained in notes but yields no topic', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'user-note.md'),
      '---\ntags: [broken\n---\n# Personal note\n',
      'utf8'
    );

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    assert.strictEqual(context.notes.length, 1);
    assert.ok(context.notes[0].parseError);
    assert.strictEqual(context.topics.length, 0);
  });

  test('empty vault collects an empty context without error', () => {
    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    assert.deepStrictEqual(context.files, []);
    assert.deepStrictEqual(context.topics, []);
    assert.deepStrictEqual(context.notes, []);
  });

  test('pre-scanned files are accepted to avoid a duplicate walk', () => {
    const topicPath = path.join(tmpVault, 't.md');
    fs.writeFileSync(
      topicPath,
      '---\npalee_schema: 1\npalee_id: T-t\n---\n# T\n',
      'utf8'
    );

    const context = collectVault(tmpVault, {
      files: [topicPath],
      cache: new FileCache<LoadedTopic>(),
    });

    assert.deepStrictEqual(context.files, [topicPath]);
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.notes.length, 1);
  });

  test('collection is a single-read snapshot: injected bytes match scanned notes', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'topic.md'),
      '---\npalee_schema: 1\npalee_id: T-snap\n---\n# Snap\n',
      'utf8'
    );

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    // Every scanned note's captured content is exactly what the loader saw:
    // same bytes → topics and parse outcomes can never diverge mid-scan.
    const topic = context.topics.find((t) => t.palee_id === 'T-snap');
    assert.ok(topic);
    const note = context.notes.find((n) => n.relativePath === 'topic.md');
    assert.ok(note?.content);
    assert.strictEqual(topic.content, note.content);
    assert.strictEqual(topic.frontmatter.palee_id, 'T-snap');
  });

  test('unreadable files are excluded from topic loading but kept in files', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'good.md'),
      '---\npalee_schema: 1\npalee_id: T-good\n---\n# Good\n',
      'utf8'
    );

    const files = [
      path.join(tmpVault, 'good.md'),
      path.join(tmpVault, 'locked.md'), // does not exist on disk
    ];
    const context = collectVault(tmpVault, {
      files,
      cache: new FileCache<LoadedTopic>(),
    });

    // files[] keeps every scanned path (file_count reports the whole vault)
    assert.strictEqual(context.files.length, 2);
    assert.deepStrictEqual(
      context.notes.map((n) => n.relativePath),
      ['good.md', 'locked.md']
    );
    const locked = context.notes.find((n) => n.relativePath === 'locked.md');
    assert.ok(locked?.readError);
    assert.strictEqual(locked.content, undefined);

    // The read-failure signal propagates and topics exclude the unreadable file
    assert.strictEqual(context.readIncomplete, true);
    assert.strictEqual(context.topics.length, 1);
    assert.strictEqual(context.topics[0].palee_id, 'T-good');
  });

  test('a previously cached topic for a now-unreadable file never resurfaces', () => {
    const cache = new FileCache<LoadedTopic>();

    // First run while the file is readable: the topic lands in the cache.
    fs.writeFileSync(
      path.join(tmpVault, 'topic.md'),
      '---\npalee_schema: 1\npalee_id: T-cached\n---\n# Cached\n',
      'utf8'
    );
    const first = collectVault(tmpVault, { cache });
    assert.strictEqual(first.topics.length, 1);
    assert.strictEqual(first.readIncomplete, false);

    // The file becomes unreadable (deleted mid-scan). The read-failure path
    // must exclude it from loadTopics entirely — a stale cache entry for
    // that path can never be consulted, so no topic from bytes the scanner
    // could not read may appear in the snapshot.
    fs.rmSync(path.join(tmpVault, 'topic.md'));

    const second = collectVault(tmpVault, {
      files: [path.join(tmpVault, 'topic.md')],
      cache,
    });

    assert.strictEqual(second.readIncomplete, true);
    assert.strictEqual(second.topics.length, 0);
    assert.ok(second.notes[0].readError);
  });

  test('a cache that WOULD return the topic never gets asked for read-failure paths', () => {
    // Pins the snapshot-consistency fix directly: FileCache evicts entries
    // on ENOENT itself, so a deleted-file test can pass without the fix.
    // Here the cache is stubbed to hand back the topic no matter what —
    // the only reason it stays out of context.topics is that the collector
    // never passes the read-failure path to loadTopics.
    const lockedPath = path.join(tmpVault, 'locked.md');
    const staleTopic: LoadedTopic = {
      palee_id: 'T-stale',
      id: 'T-stale',
      title: 'Stale',
      path: 'locked.md',
      filePath: lockedPath,
      content: '---\n---\n',
      frontmatter: { palee_id: 'T-stale' },
      difficulty: 'beginner',
      depends_on: [],
      topic_mastery: 0,
      status: 'not_started',
    };
    class SeededCache extends FileCache<LoadedTopic> {
      get(filePath: string): LoadedTopic | null {
        return filePath === lockedPath ? staleTopic : super.get(filePath);
      }
    }

    const context = collectVault(tmpVault, {
      files: [lockedPath], // does not exist on disk: read failure
      cache: new SeededCache(),
    });

    assert.strictEqual(context.readIncomplete, true);
    assert.ok(context.notes[0].readError);
    // The seeded cache would have returned T-stale had the loader been
    // given the path — exclusion happens in the collector, not the cache.
    assert.strictEqual(context.topics.length, 0);
    assert.strictEqual(
      context.topics.some((t) => t.palee_id === 'T-stale'),
      false
    );
  });

  test('memory subsystem is collected in the same snapshot (#41/#42/#44)', () => {
    const sessionsDir = path.join(tmpVault, '.palee', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'S-20260912T100000-abcd.md'),
      '---\npalee_schema: 1\nsession_id: S-20260912T100000-abcd\ntopic_id: T-a\nstarted_at: 2026-09-12T10:00:00.000Z\nended_at: 2026-09-12T10:30:00.000Z\nstatus: completed\n---\n# Session\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionsDir, 'DRAFT-S-1a2b3c4d.md'),
      '---\npalee_schema: 1\nsession_id: DRAFT-S-1a2b3c4d\ntopic_id: T-a\nstarted_at: 2026-09-12T10:00:00.000Z\nended_at: null\nstatus: draft\n---\n# Draft\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionsDir, 'S-bad.md'),
      '---\nsession_id: [unclosed\n---\n# Broken\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpVault, '.palee', 'index.md'),
      '---\npalee_schema: 1\ntype: session_index\n---\n# PALEE Session Index\n\n- [[S-20260912T100000-abcd]] - Topic: T-a (2026-09-12)\n- [[S-gone]] - Topic: T-a (2026-09-12)\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpVault, '.palee', 'hot.md'),
      '---\npalee_schema: 1\nmemory_id: H-active\nlast_session: S-20260912T100000-abcd\nactive_topic: T-a\nstarted_at: 2026-09-12T10:00:00.000Z\nupdated_at: 2026-09-12\n---\nStudied A.\n',
      'utf8'
    );

    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });

    // Sessions: sorted by filename, drafts flagged, parse outcomes kept.
    assert.strictEqual(context.sessions.length, 3);
    assert.deepStrictEqual(
      context.sessions.map((s) => s.sessionId),
      ['DRAFT-S-1a2b3c4d', 'S-20260912T100000-abcd', 'S-bad']
    );
    const draft = context.sessions[0];
    assert.strictEqual(draft.isDraft, true);
    assert.strictEqual(draft.frontmatter?.status, 'draft');
    const bad = context.sessions[2];
    assert.strictEqual(bad.frontmatter, null);
    assert.ok(bad.parseError !== undefined);

    // Index: parsed with refs in first-seen order.
    assert.strictEqual(context.sessionIndex.state, 'ok');
    assert.deepStrictEqual((context.sessionIndex as { refs: string[] }).refs, [
      'S-20260912T100000-abcd',
      'S-gone',
    ]);

    // Hot memory: classified ok.
    assert.strictEqual(context.hotMemory.state, 'ok');
    assert.strictEqual(context.hotMemory.frontmatter?.active_topic, 'T-a');

    // The broken session note (frontmatter null but READ fine — the
    // parse failed, not the read) must NOT set readIncomplete: parse
    // failures are schema-rule findings, not provisional-scan signals.
    assert.strictEqual(context.readIncomplete, false);
  });

  test('fresh vault has an empty memory subsystem and every memory rule passes', () => {
    const context = collectVault(tmpVault, { cache: new FileCache<LoadedTopic>() });
    assert.deepStrictEqual(context.sessions, []);
    assert.strictEqual(context.sessionIndex.state, 'missing');
    assert.strictEqual(context.hotMemory.state, 'missing');
    assert.strictEqual(context.readIncomplete, false);
  });
});
