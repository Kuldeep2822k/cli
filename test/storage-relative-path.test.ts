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
});
