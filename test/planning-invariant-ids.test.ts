/**
 * Planning invariant-ID census (#195)
 *
 * Contracts under test:
 * - `planning/invariants.md` numbers every bullet with a stable ID in the
 *   canonical two-digit form, sequential in document order, and no bullet is
 *   left unnumbered.
 * - Every ID referenced by a file under `test/` resolves to a definition, so
 *   a citation cannot drift onto the wrong assertion.
 * - Test files address invariants by ID only: the two positional forms #195
 *   retired (an `invariants` filename with a trailing colon and line number,
 *   and the word `Invariant` followed by a bare hash number) stay absent.
 * - Modeled on test/validation-barrel-census.test.ts (#25).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '..');
const INVARIANTS_FILE = path.join(REPO_ROOT, 'planning', 'invariants.md');
const TEST_DIR = path.join(REPO_ROOT, 'test');

// A definition is anchored on the bullet-and-ID prefix, so prose that merely
// mentions an ID (such as the intro of the blueprint) is never a definition.
const DEFINITION = /^- \*\*(INV-\d{2})\*\* — /;
const ID_TOKEN = /\b(INV-\d+)\b/g;
const CANONICAL_ID = /^INV-\d{2}$/;

// Positional forms, assembled at runtime so this file's own source does not
// register as a positional citation of an invariant. Compared lowercased so the
// mid-sentence spelling of the hash-number form is caught as well as the capital.
const POSITIONAL_CITATIONS = [
  ['invariants', '.', 'md', ':'].join(''),
  ['Invariant', ' ', '#'].join(''),
];

/** Parses the blueprint and returns every defined `INV-` id in document order. */
function definedIds(): string[] {
  const text = fs.readFileSync(INVARIANTS_FILE, 'utf8');
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(DEFINITION);
    if (match) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/** Returns every bullet line in the blueprint, numbered or not. */
function bulletLines(): string[] {
  return fs
    .readFileSync(INVARIANTS_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '));
}

/** Recursively lists every file under `dir`, sorted for deterministic output. */
function testFiles(dir = TEST_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFiles(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Renders an absolute path as repo-relative POSIX for assertion messages. */
function show(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

describe('Planning Invariant IDs & Citation Census (#195)', () => {
  it('every INV-* ID referenced under test/ is defined in planning/invariants.md', () => {
    const defined = new Set(definedIds());
    const references = new Map<string, string[]>();

    for (const file of testFiles()) {
      const tokens = fs.readFileSync(file, 'utf8').match(ID_TOKEN) || [];
      for (const id of tokens) {
        const hit = references.get(id);
        if (hit) {
          hit.push(show(file));
        } else {
          references.set(id, [show(file)]);
        }
      }
    }

    // Floor: a scan that found nothing would pass vacuously. The migrated
    // citations guarantee at least one reference resolves today.
    assert.ok(
      references.size > 0,
      'no invariant ID is cited anywhere under test/ — the census is vacuous'
    );

    const unresolved: string[] = [];
    for (const [id, files] of references) {
      if (!defined.has(id)) {
        unresolved.push(`${id} (cited in ${files.join(', ')})`);
      }
    }
    assert.deepStrictEqual(
      unresolved,
      [],
      `cited ${unresolved.length === 1 ? 'ID' : 'IDs'} missing a definition:\n  ${unresolved.join('\n  ')}`
    );
  });

  it('INV- IDs in planning/invariants.md are canonical, unique, and gap-free from INV-01', () => {
    const ids = definedIds();
    assert.ok(ids.length > 0, 'no invariant IDs were parsed from the blueprint');

    // Every bullet must carry an ID — otherwise the count below would hide a
    // newly-added unnumbered invariant.
    assert.strictEqual(
      ids.length,
      bulletLines().length,
      'a bullet in the blueprint lacks a canonical `- **INV-nn** — ` prefix'
    );

    for (const id of ids) {
      assert.ok(
        CANONICAL_ID.test(id),
        `${id} is not in canonical zero-padded two-digit form`
      );
    }

    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepStrictEqual(duplicates, [], `duplicate IDs: ${[...new Set(duplicates)].join(', ')}`);

    const gaps: string[] = [];
    ids.forEach((id, i) => {
      const expected = `INV-${String(i + 1).padStart(2, '0')}`;
      if (id !== expected) {
        gaps.push(`position ${i + 1}: found ${id}, expected ${expected}`);
      }
    });
    assert.deepStrictEqual(
      gaps,
      [],
      `IDs are not contiguous INV-01..INV-${String(ids.length).padStart(2, '0')}:\n  ${gaps.join('\n  ')}`
    );
  });

  it('no test file cites an invariant by document position', () => {
    const offenders: string[] = [];
    for (const file of testFiles()) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const haystack = line.toLowerCase();
        for (const positional of POSITIONAL_CITATIONS) {
          if (haystack.includes(positional.toLowerCase())) {
            offenders.push(`${show(file)}:${i + 1} cites "${positional}"`);
          }
        }
      });
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `positional citations reappeared:\n  ${offenders.join('\n  ')}`
    );
  });
});
