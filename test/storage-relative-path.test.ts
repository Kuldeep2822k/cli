/**
 * Vault-relative path resolution tests (#122 follow-up)
 *
 * Contracts under test:
 * - `relativeVaultPath` returns clean vault-relative POSIX paths even when
 *   the vault root is reached through a symlink (macOS temp dirs are the
 *   canonical case: `/var/folders/…` → `/private/var/folders/…`).
 * - `walkVault` resolves the root via realpath (#122), so walked file paths
 *   may carry a different prefix than the caller's root — consumers must
 *   not compute `path.relative` against the unresolved root.
 * - The fast path (non-symlinked roots) is exercised by the rest of the
 *   suite — every tmpdir-based test already pins it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { relativeVaultPath, walkVault } from '../src/storage/vault-walker';
import { scanNotes } from '../src/storage/scanner';
import { loadTopics, type LoadedTopic } from '../src/storage/loader';
import { FileCache } from '../src/storage/cache';
import { collectVault } from '../src/validation/collect-vault';

/** Symlink type that works on both POSIX and Windows. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

describe('relativeVaultPath: symlinked vault root (macOS temp-dir shape)', () => {
  test('symlinked root yields the same clean relative path as the direct root', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-real-root-'));
    fs.mkdirSync(path.join(realRoot, 'sub'));
    fs.writeFileSync(path.join(realRoot, 'topic.md'), '# T');
    fs.writeFileSync(path.join(realRoot, 'sub', 'note.md'), '# N');
    const linkRoot = path.join(os.tmpdir(), 'palee-link-root-' + Date.now());
    fs.symlinkSync(realRoot, linkRoot, LINK_TYPE);

    try {
      // Walked through the symlink: the root is realpath'd by walkVault
      // (#122), so walked paths may sit under the resolved prefix. The
      // relative path must still be vault-relative, not `../<target>/x.md`.
      const walked = walkVault(linkRoot);
      assert.ok(walked.length >= 2, 'walker must find the notes');
      for (const file of walked) {
        const rel = relativeVaultPath(linkRoot, file);
        assert.ok(
          !rel.startsWith('..'),
          `relative path escaped the vault root: ${rel} (file: ${file})`
        );
        assert.ok(!rel.includes('\\'), `relative path must be POSIX-style: ${rel}`);
      }
      // The exact filename must survive — macOS CI failed precisely here.
      assert.ok(
        walked.some((f) => relativeVaultPath(linkRoot, f) === 'topic.md'),
        'topic.md must resolve to exactly "topic.md" through the symlinked root'
      );
      // Agreement with the direct (non-symlinked) root's answer.
      assert.strictEqual(relativeVaultPath(realRoot, path.join(realRoot, 'sub', 'note.md')), 'sub/note.md');
    } finally {
      fs.rmSync(linkRoot, { force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  test('symlinked root does not corrupt scanner, loader, or collector paths', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-real-scan-'));
    const link = path.join(os.tmpdir(), 'palee-link-scan-' + Date.now());
    fs.symlinkSync(real, link, LINK_TYPE);
    try {
      fs.writeFileSync(
        path.join(real, 'topic.md'),
        '---\npalee_schema: 1\npalee_id: T-sym\ntitle: Sym\n---\n# S\n',
        'utf8'
      );

      // Storage layer: scanner + loader keep clean relative paths.
      const notes = scanNotes(link);
      assert.deepStrictEqual(notes.map((n) => n.relativePath), ['topic.md']);

      const topics = loadTopics(link, { cache: new FileCache<LoadedTopic>() });
      assert.deepStrictEqual(topics.map((t) => t.path), ['topic.md']);

      // Validation layer: collection wires both together.
      const ctx = collectVault(link);
      assert.deepStrictEqual(ctx.topics.map((t) => t.path), ['topic.md']);
      assert.deepStrictEqual(ctx.notes.map((n) => n.relativePath), ['topic.md']);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  test('a path genuinely outside the vault keeps its escaping relative path', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-outside-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-truly-outside-'));
    try {
      const rel = relativeVaultPath(vault, path.join(outside, 'note.md'));
      assert.ok(rel.startsWith('..'), `outside-vault path must stay escaping, got: ${rel}`);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('valid filenames starting with .. are not misread as parent traversal (Greptile P2)', () => {
    // A file legitimately named `..notes.md` is not a traversal attempt.
    // Under a symlinked root with caller-supplied file paths (the files
    // API — the walker's dot-file exclusion never runs), the containment
    // check must accept it and return the clean canonical relative path,
    // not mistake it for `..`/`../` and keep the escaping lexical garbage.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-real-dotdot-'));
    const link = path.join(os.tmpdir(), 'palee-link-dotdot-' + Date.now());
    fs.symlinkSync(real, link, LINK_TYPE);
    try {
      fs.writeFileSync(path.join(real, '..notes.md'), '# double-dot name\n', 'utf8');
      fs.mkdirSync(path.join(real, 'sub'));
      fs.writeFileSync(path.join(real, 'sub', '..nested.md'), '# nested\n', 'utf8');

      // Direct helper, root-level and nested double-dot names.
      assert.strictEqual(relativeVaultPath(link, path.join(real, '..notes.md')), '..notes.md');
      assert.strictEqual(relativeVaultPath(link, path.join(real, 'sub', '..nested.md')), 'sub/..nested.md');

      // Through the scanner's caller-supplied files API (symlinked root,
      // canonical file paths — the exact P2 trigger shape).
      const notes = scanNotes(link, {
        files: [path.join(real, '..notes.md'), path.join(real, 'sub', '..nested.md')],
      });
      assert.deepStrictEqual(notes.map((n) => n.relativePath), ['..notes.md', 'sub/..nested.md']);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
