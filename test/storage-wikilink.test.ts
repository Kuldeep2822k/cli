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
import { parseWikilink, extractWikilinks } from '../src/engine/auto-chain';

/** Parses a wikilink string, asserting it is well-formed, and returns it. */
function link(text: string) {
  const parsed = parseWikilink(text);
  assert.ok(parsed, `expected a valid wikilink: ${text}`);
  return parsed;
}

describe('Wikilink Resolution (Issue #73, INV-48)', () => {
  let vaultPath: string;
  let outsidePath: string;

  /**
   * Builds a `..`-escaping wikilink target for `<name>` in {@link outsidePath}
   * — a file that really exists outside the vault. The path is relative to the
   * vault root and POSIX-separated (how `resolveWikilinkTarget` interprets a
   * target), derived from realpaths so the fixture holds on symlinked temp
   * roots (macOS `/var` vs `/private/var`) as well as on Windows.
   */
  function escapingTarget(name: string): string {
    const fromVault = path
      .relative(fs.realpathSync(vaultPath), fs.realpathSync(outsidePath))
      .split(path.sep)
      .join('/');
    return `${fromVault}/${name}`;
  }

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
    // Non-Markdown asset: real bytes on disk, must never be a resolution target
    fs.mkdirSync(path.join(vaultPath, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'assets', 'diagram.png'), 'PNGDATA');
    // Dot-namespace note: invisible everywhere else in the CLI
    fs.mkdirSync(path.join(vaultPath, '.trash'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '.trash', 'deleted-note.md'), '# Deleted\n');
    // A real file *outside* the vault sharing a basename with an in-vault note,
    // so a failed escape check is observable as a hijack to the wrong file.
    // Lives in a sibling temp dir (not `vaultPath/..`, which is the OS temp
    // dir) so the `after()` hook removes it too.
    outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-wikilink-outside-'));
    fs.writeFileSync(path.join(outsidePath, 'outside-note.md'), '# Outside\n');
    fs.writeFileSync(path.join(vaultPath, 'outside-note.md'), '# In-vault namesake\n');
    // A note whose basename collides with the *unsafe* targets below, so a
    // missing guard is observable as a hijack onto this specific file.
    fs.writeFileSync(path.join(vaultPath, 'MODULES', 'note.md'), '# In-vault note\n');
  });

  after(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { recursive: true, force: true });
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
      // The fixture is real: the target exists *outside* the vault, so this
      // link genuinely reaches the containment check instead of merely
      // missing on `existsSync` (which is what made the original version of
      // this test pass vacuously).
      const escaping = escapingTarget('outside-note');
      assert.ok(fs.existsSync(path.join(outsidePath, 'outside-note.md')));
      assert.ok(escaping.startsWith('../'), 'target must escape the vault root');
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link(`[[${escaping}]]`), index),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedWikilinkError);
          assert.strictEqual((err as UnresolvedWikilinkError).link, escaping);
          return true;
        }
      );
      // The bare `..` form (nothing of that name exists at all) still rejects.
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[../outside]]'), index),
        (err: unknown) => err instanceof UnresolvedWikilinkError
      );
    });

    it('rejects a non-markdown target that exists on disk', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[assets/diagram.png]]'), index),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedWikilinkError);
          assert.strictEqual((err as UnresolvedWikilinkError).link, 'assets/diagram.png');
          return true;
        }
      );
    });

    it('rejects an embedded asset (`![[...]]`) extracted from a note body', () => {
      const index = buildVaultNoteIndex(vaultPath);
      const [embedded] = extractWikilinks('- ![[assets/diagram.png]]');
      assert.ok(embedded, 'the embed is parsed as a wikilink');
      assert.strictEqual(embedded.target, 'assets/diagram.png');
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, embedded, index),
        (err: unknown) => err instanceof UnresolvedWikilinkError
      );
    });

    it('rejects a dot-namespace target (.trash/...)', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[.trash/deleted-note]]'), index),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedWikilinkError);
          assert.strictEqual((err as UnresolvedWikilinkError).link, '.trash/deleted-note');
          return true;
        }
      );
    });

    it('rejects backslash-separated targets on every platform', () => {
      const index = buildVaultNoteIndex(vaultPath);
      // Wikilink targets are `/`-separated only (see `targetBaseName`). On
      // Windows `path.resolve` treats `\` as a separator, so without an
      // explicit reject this exact-path form resolves the note on Windows and
      // throws on POSIX. The backslash spelling of a note that really exists is
      // what makes this test non-vacuous: it must NOT resolve anywhere.
      const target = 'MODULES\\01-foundations\\01-systems';
      assert.ok(
        fs.existsSync(path.join(vaultPath, 'MODULES', '01-foundations', '01-systems.md')),
        'the slash-separated namesake exists on disk'
      );
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link(`[[${target}]]`), index),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedWikilinkError);
          assert.strictEqual((err as UnresolvedWikilinkError).link, target);
          return true;
        }
      );
    });

    it('fails closed on a vault escape instead of hijacking the basename match', () => {
      const index = buildVaultNoteIndex(vaultPath);
      // The hijack route is live: the namesake exists in the vault and the
      // basename lookup would happily return it.
      const namesake = resolveWikilinkTarget(vaultPath, link('[[outside-note]]'), index);
      assert.strictEqual(namesake.relativePath, 'outside-note.md');
      // …so an escaping path naming the same basename must throw, not return it.
      const target = escapingTarget('outside-note');
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link(`[[${target}]]`), index),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedWikilinkError);
          assert.strictEqual((err as UnresolvedWikilinkError).link, target);
          return true;
        }
      );
    });

    /**
     * Asserts the basename-hijack route is live before relying on it: `note.md`
     * is indexed exactly once, so a target that slips past the guards resolves
     * it instead of failing. Without this precondition the unsafe-target tests
     * below would pass vacuously via "no match at all".
     */
    function assertHijackRouteIsLive(index: Map<string, string[]>): void {
      const hits = index.get('note') ?? [];
      assert.strictEqual(hits.length, 1, 'the colliding basename must be indexed once');
      assert.ok(hits[0].endsWith('note.md'));
    }

    it('fails closed on an escaping target that does not exist on disk', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assertHijackRouteIsLive(index);
      // Neither path exists, so the pre-fix resolver skipped its guards
      // entirely (they ran only inside the `existsSync` branch) and fell
      // through to the basename lookup, returning `MODULES/note.md`.
      for (const target of ['../../outside/note', '../../missing/note']) {
        assert.ok(!fs.existsSync(path.join(vaultPath, `${target}.md`)), 'target is absent');
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link(`[[${target}]]`), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, target);
            return true;
          },
          `expected [[${target}]] to fail closed`
        );
      }
    });

    it('fails closed on an invisible-namespace target that does not exist on disk', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assertHijackRouteIsLive(index);
      // `.trash/` and `node_modules/` are invisible everywhere else in the CLI;
      // a link must not resurrect them, whether or not the file is there.
      for (const target of ['.trash/note', 'node_modules/note']) {
        assert.ok(!fs.existsSync(path.join(vaultPath, `${target}.md`)), 'target is absent');
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link(`[[${target}]]`), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, target);
            return true;
          },
          `expected [[${target}]] to fail closed`
        );
      }
    });

    it('rejects a path target naming an existing non-Markdown file instead of hijacking a namesake note', () => {
      // The hijack route must be live: a visible note whose basename minus
      // `.md` collides with the asset filename is exactly what the basename
      // lookup would return. Without it this test passes vacuously (no hit).
      const namesakeDir = path.join(vaultPath, 'other');
      const namesake = path.join(namesakeDir, 'diagram.png.md');
      fs.mkdirSync(namesakeDir, { recursive: true });
      fs.writeFileSync(namesake, '# Unrelated note\n');
      try {
        const index = buildVaultNoteIndex(vaultPath);
        assert.deepStrictEqual(
          (index.get('diagram.png') ?? []).map((p) => path.relative(vaultPath, p)),
          [path.join('other', 'diagram.png.md')]
        );
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link('[[assets/diagram.png]]'), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, 'assets/diagram.png');
            return true;
          }
        );
      } finally {
        fs.rmSync(namesakeDir, { recursive: true, force: true });
      }
    });

    it('fails closed when a symlinked ancestor escapes the vault', (t) => {
      // `vault/link -> outsidePath`, and `outsidePath` has no `note.md`, so the
      // exact candidate is missing and the resolver used to fall through to the
      // basename lookup and return the in-vault `MODULES/note.md` — a note the
      // link never named.
      const linkDir = path.join(vaultPath, 'link');
      try {
        fs.symlinkSync(outsidePath, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        t.skip('symlink creation is not permitted on this platform');
        return;
      }
      try {
        const index = buildVaultNoteIndex(vaultPath);
        assertHijackRouteIsLive(index);
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link('[[link/note]]'), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, 'link/note');
            return true;
          }
        );
      } finally {
        fs.rmSync(linkDir, { recursive: true, force: true });
      }
    });

    it('fails closed when the exact candidate is a directory, not a note', () => {
      // `dirnote/note.md` is a *directory*, so the exact branch's `isFile()`
      // fails and the pre-fix resolver fell through to the basename lookup,
      // which returned the unrelated in-vault `MODULES/note.md`.
      const dirCandidate = path.join(vaultPath, 'dirnote', 'note.md');
      fs.mkdirSync(dirCandidate, { recursive: true });
      try {
        const index = buildVaultNoteIndex(vaultPath);
        assertHijackRouteIsLive(index);
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link('[[dirnote/note]]'), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, 'dirnote/note');
            return true;
          }
        );
      } finally {
        fs.rmSync(path.join(vaultPath, 'dirnote'), { recursive: true, force: true });
      }
    });

    it('fails closed when the exact candidate is a dangling symlink', (t) => {
      // The symlink is named `dangling.md` and points nowhere, so `existsSync`
      // is false and the pre-fix resolver fell through to the basename lookup,
      // which returned the unrelated `MODULES/dangling.md`.
      const dangling = path.join(vaultPath, 'dangling.md');
      const namesake = path.join(vaultPath, 'MODULES', 'dangling.md');
      fs.writeFileSync(namesake, '# Unrelated dangling namesake\n');
      try {
        fs.symlinkSync(path.join(vaultPath, 'nowhere-at-all.md'), dangling, 'file');
      } catch {
        fs.rmSync(namesake, { force: true });
        t.skip('file symlink creation is not permitted on this platform');
        return;
      }
      try {
        const index = buildVaultNoteIndex(vaultPath);
        // `followSymlinks` is false, so only the real namesake is indexed —
        // exactly one hit, i.e. the hijack route is live.
        assert.strictEqual((index.get('dangling') ?? []).length, 1);
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link('[[dangling]]'), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, 'dangling');
            return true;
          }
        );
      } finally {
        fs.rmSync(dangling, { force: true });
        fs.rmSync(namesake, { force: true });
      }
    });

    it('fails closed when a path component is a regular file', () => {
      // `blocker.md` is a regular file, so `blocker.md/note.md` raises ENOTDIR;
      // the pre-fix ancestor walk treated that as "missing" and fell through to
      // the basename lookup, returning the unrelated `MODULES/note.md`.
      const blocker = path.join(vaultPath, 'blocker.md');
      fs.writeFileSync(blocker, '# Blocker file\n');
      try {
        const index = buildVaultNoteIndex(vaultPath);
        assertHijackRouteIsLive(index);
        assert.throws(
          () => resolveWikilinkTarget(vaultPath, link('[[blocker.md/note]]'), index),
          (err: unknown) => {
            assert.ok(err instanceof UnresolvedWikilinkError);
            assert.strictEqual((err as UnresolvedWikilinkError).link, 'blocker.md/note');
            return true;
          }
        );
      } finally {
        fs.rmSync(blocker, { force: true });
      }
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

    // `fs.realpathSync` performs no case conversion on a case-insensitive
    // volume, so `[[adopted]]` written in another casing resolved to the *same
    // file* under a different string. Every caller keys notes by that string,
    // so the lookup missed: the importer minted a fresh `palee_id` and wrote it
    // over the learner's existing one, and the same note could enter a chain
    // twice. Meaningful only where the volume folds case.
    describe('on a case-insensitive volume', () => {
      const adoptedMixed = (): string => path.join(vaultPath, 'Adopted Mixed.md');
      const caseInsensitiveVolume = (): boolean => {
        fs.writeFileSync(adoptedMixed(), '---\npalee_id: T-mixed-1\n---\n# Mixed\n');
        const folds = fs.existsSync(path.join(vaultPath, 'adopted mixed.md'));
        fs.rmSync(adoptedMixed(), { force: true });
        return folds;
      };

      it('reuses the palee_id of a note written in another casing', (t) => {
        if (!caseInsensitiveVolume()) {
          t.skip('the filesystem distinguishes case, so no divergence is possible');
          return;
        }
        fs.writeFileSync(
          adoptedMixed(),
          '---\npalee_id: T-mixed-1\npalee_schema: 1\ntitle: Mixed\ndepends_on: []\n---\n# Mixed\n'
        );
        try {
          const roadmap = resolveWikilinkRoadmap(vaultPath, [
            { track: '', links: [link('[[adopted mixed]]')] },
          ]);
          assert.strictEqual(
            roadmap.topics[0].id,
            'T-mixed-1',
            'a differently-cased link must not re-mint an adopted note\'s id'
          );
          assert.strictEqual(roadmap.topics[0].path, 'Adopted Mixed.md');
        } finally {
          fs.rmSync(adoptedMixed(), { force: true });
        }
      });

      it('detects one note listed under two casings as a duplicate', (t) => {
        if (!caseInsensitiveVolume()) {
          t.skip('the filesystem distinguishes case, so the two spellings are two notes');
          return;
        }
        fs.writeFileSync(adoptedMixed(), '# Mixed\n');
        try {
          assert.throws(
            () =>
              resolveWikilinkRoadmap(vaultPath, [
                {
                  track: '',
                  links: [link('[[adopted mixed]]'), link('[[Adopted Mixed]]')],
                },
              ]),
            /Duplicate wikilink target/
          );
        } finally {
          fs.rmSync(adoptedMixed(), { force: true });
        }
      });
    });

    it('rejects a note listed twice (it would depend on itself)', () => {      assert.throws(
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
