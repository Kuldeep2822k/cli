import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildVaultNoteIndex,
  resolveWikilinkTarget,
  resolveWikilinkRoadmap,
  AmbiguousWikilinkError,
  UnresolvedWikilinkError,
  type WikilinkRoadmapSection,
} from '../src/storage/wikilink';
import { parseWikilink } from '../src/engine/auto-chain';

function link(text: string) {
  const parsed = parseWikilink(text);
  assert.ok(parsed, `expected a valid wikilink: ${text}`);
  return parsed;
}

describe('Wikilink Resolution (Issue #73, INV-48)', () => {
  let vaultPath: string;

  before(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-wikilink-'));
    fs.mkdirSync(path.join(vaultPath, 'MODULES', '01-foundations'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'MODULES', '02-linux'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'MODULES', '01-foundations', '01-systems.md'),
      '---\ntitle: Systems Thinking\n---\n# Systems Thinking\n'
    );
    fs.writeFileSync(
      path.join(vaultPath, 'MODULES', '02-linux', '01-processes.md'),
      '# Linux Processes\n'
    );
    // Two notes sharing a basename -> ambiguity fixture
    fs.writeFileSync(path.join(vaultPath, 'MODULES', '01-foundations', 'dup.md'), '# Dup A\n');
    fs.writeFileSync(path.join(vaultPath, 'MODULES', '02-linux', 'dup.md'), '# Dup B\n');
    // Exact-case tiebreak fixture: same lowercase basename, different case
    fs.writeFileSync(path.join(vaultPath, 'Case.md'), '# Case upper\n');
    fs.writeFileSync(path.join(vaultPath, 'MODULES', 'case.md'), '# case lower\n');
  });

  after(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  describe('buildVaultNoteIndex', () => {
    it('indexes every note by lowercased basename', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.ok((index.get('01-systems') ?? []).length === 1);
      assert.ok((index.get('dup') ?? []).length === 2);
      assert.strictEqual(index.get('missing'), undefined);
    });
  });

  describe('resolveWikilinkTarget', () => {
    it('resolves an exact vault-relative path with or without .md', () => {
      const index = buildVaultNoteIndex(vaultPath);
      const withExt = resolveWikilinkTarget(
        vaultPath,
        link('[[MODULES/01-foundations/01-systems.md]]'),
        index
      );
      assert.strictEqual(withExt.relativePath, 'MODULES/01-foundations/01-systems.md');

      const withoutExt = resolveWikilinkTarget(
        vaultPath,
        link('[[MODULES/02-linux/01-processes]]'),
        index
      );
      assert.strictEqual(withoutExt.relativePath, 'MODULES/02-linux/01-processes.md');
    });

    it('resolves a unique basename case-insensitively', () => {
      const index = buildVaultNoteIndex(vaultPath);
      const resolved = resolveWikilinkTarget(vaultPath, link('[[01-PROCESSES]]'), index);
      assert.strictEqual(resolved.relativePath, 'MODULES/02-linux/01-processes.md');
    });

    it('prefers an exact-case match when several notes share a lowercase basename', () => {
      const index = buildVaultNoteIndex(vaultPath);
      const resolved = resolveWikilinkTarget(vaultPath, link('[[Case]]'), index);
      assert.strictEqual(resolved.relativePath, 'Case.md');
    });

    it('throws AmbiguousWikilinkError listing every candidate', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[dup]]'), index),
        (err: unknown) => {
          assert.ok(err instanceof AmbiguousWikilinkError);
          assert.deepStrictEqual(err.candidates, [
            'MODULES/01-foundations/dup.md',
            'MODULES/02-linux/dup.md',
          ]);
          return true;
        }
      );
    });

    it('throws UnresolvedWikilinkError for unknown targets', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[no-such-note]]'), index),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedWikilinkError);
          assert.strictEqual((err as UnresolvedWikilinkError).link, 'no-such-note');
          return true;
        }
      );
    });

    it('rejects vault-escape targets', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[../outside]]'), index),
        (err: unknown) => err instanceof UnresolvedWikilinkError
      );
    });
  });

  describe('resolveWikilinkRoadmap', () => {
    it('chains each section and mints IDs for unadopted notes', () => {
      const sections: WikilinkRoadmapSection[] = [
        {
          track: 'Foundations',
          links: [link('[[MODULES/01-foundations/01-systems]]'), link('[[01-processes]]')],
        },
        { track: 'Extra', links: [link('[[Case]]')] },
      ];
      const roadmap = resolveWikilinkRoadmap(vaultPath, sections);
      assert.strictEqual(roadmap.topics.length, 3);

      const [first, second, third] = roadmap.topics;
      assert.strictEqual(first.path, 'MODULES/01-foundations/01-systems.md');
      assert.strictEqual(first.title, 'Systems Thinking');
      assert.deepStrictEqual(first.depends_on, []);
      assert.ok(/^T-/.test(first.id), 'unadopted note gets a minted T- id');

      assert.strictEqual(second.path, 'MODULES/02-linux/01-processes.md');
      assert.deepStrictEqual(second.depends_on, [first.id]);

      // New section starts a fresh chain
      assert.deepStrictEqual(third.depends_on, []);
      assert.strictEqual(third.order, 2);
    });

    it('reuses palee_id for already-adopted notes', () => {
      const adopted = path.join(vaultPath, 'adopted.md');
      fs.writeFileSync(
        adopted,
        '---\npalee_id: T-existing-1\npalee_schema: 1\ntitle: Adopted Note\ndepends_on: []\n---\n# Adopted\n'
      );
      const roadmap = resolveWikilinkRoadmap(vaultPath, [
        { track: '', links: [link('[[adopted]]')] },
      ]);
      assert.strictEqual(roadmap.topics[0].id, 'T-existing-1');
      assert.strictEqual(roadmap.topics[0].title, 'Adopted Note');
      fs.rmSync(adopted);
    });

    it('rejects a note listed twice (it would depend on itself)', () => {
      assert.throws(
        () =>
          resolveWikilinkRoadmap(vaultPath, [
            {
              track: '',
              links: [link('[[Case]]'), link('[[Case|Same Note]]')],
            },
          ]),
        /Duplicate wikilink target/
      );
    });
  });
});
