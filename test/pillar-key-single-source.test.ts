import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as engineMastery from '../src/engine/mastery';
import * as recordAssessment from '../src/application/record-assessment';

/**
 * One pillar-key list, imported from the engine (P3-09 of audit issue #565).
 *
 * The four assessment pillar frontmatter keys (`conceptual`, `practical`,
 * `debug`, `feynman`) were written out as a local array literal in six places:
 * `src/engine/mastery.ts` (the canonical `PILLAR_KEYS`) plus five consumers —
 * `src/application/record-assessment.ts`, `src/cli/validate.ts`,
 * `src/validation/rules/valid-assessment-fields.ts`,
 * `src/validation/rules/valid-topic-mastery.ts`, and `src/cli/adopt-undo.ts`
 * (inside `PALEE_OWNED_KEYS`). Six hand-kept copies of the same tuple is the
 * drift P3-09 removes: every consumer now derives its list from the engine's
 * `PILLAR_KEYS`, so a pillar added, renamed, or reordered in the engine
 * propagates everywhere at once.
 *
 * The guard has two halves. The runtime half pins that the one exported list
 * (`PILLARS` from the application write core) *is* the engine's array — a
 * reverted local literal is a different reference and fails. The static half
 * reads the shipped source tree, like `ai-network-boundary.test.ts` and
 * `engine-import-boundary.test.ts`: no file outside the canonical engine
 * module may carry a quoted four-pillar list, and each named consumer must
 * import `PILLAR_KEYS` from a module resolving into `src/engine/`.
 */

const root = path.resolve(__dirname, '..');

/** The consumers P3-09 rewired, as repo-relative source paths. */
const CONSUMER_FILES: readonly string[] = [
  'src/application/record-assessment.ts',
  'src/cli/validate.ts',
  'src/validation/rules/valid-assessment-fields.ts',
  'src/validation/rules/valid-topic-mastery.ts',
  'src/cli/adopt-undo.ts',
];

/** The engine module that owns the canonical list. */
const CANONICAL_FILE = 'src/engine/mastery.ts';

/** The four pillar keys, in the order `adopt.ts` writes them (INV-21's inputs). */
const EXPECTED_PILLAR_KEYS: readonly string[] = ['conceptual', 'practical', 'debug', 'feynman'];

/** The quoted forms a hand-written copy of the list cannot avoid. */
const QUOTED_PILLARS: readonly string[] = ["'conceptual'", "'practical'", "'debug'", "'feynman'"];

/**
 * Non-comment source lines carrying all four quoted pillar names — i.e. a
 * hand-written copy of the list. Comment-looking lines (`//`, `*`, `/*`) are
 * prose, not imports, and are skipped so a doc mention cannot cry wolf.
 */
function hardcodedPillarCopies(text: string): number[] {
  const flagged: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    assert.ok(line !== undefined);
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (QUOTED_PILLARS.every((name) => trimmed.includes(name))) {
      flagged.push(index + 1);
    }
  }
  return flagged;
}

/** Resolves a relative specifier from a source file to a repo-relative path. */
function resolvesTo(fromRel: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
}

/**
 * True when the file imports the identifier `PILLAR_KEYS` from a relative
 * specifier resolving into `src/engine/`. The brace-body match spans newlines,
 * so multi-line import blocks are covered.
 */
function importsPillarKeysFromEngine(rel: string, text: string): boolean {
  const importMatches = [
    ...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g),
  ];
  for (const match of importMatches) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (!names.includes('PILLAR_KEYS')) continue;
    const resolved = resolvesTo(rel, match[2] ?? '');
    if (resolved === 'src/engine' || resolved.startsWith('src/engine/')) return true;
  }
  return false;
}

/** Reads a repo-relative file under the repo root. */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

describe('pillar-key single source (P3-09, #565)', () => {
  test('the engine exports the canonical PILLAR_KEYS in the documented order', () => {
    const text = readSource(CANONICAL_FILE);
    assert.ok(
      /export\s+const\s+PILLAR_KEYS\b/.test(text),
      `${CANONICAL_FILE} must export PILLAR_KEYS — the single list every pillar consumer imports`
    );
  });

  test('PILLARS from the assessment write core IS the engine array, not a copy', () => {
    // Reference identity, not deep equality: a reverted local
    // `['conceptual', ...] as const` is a different array and must fail.
    assert.strictEqual(
      recordAssessment.PILLARS,
      engineMastery.PILLAR_KEYS,
      'src/application/record-assessment.ts must re-export the engine PILLAR_KEYS, not define its own list'
    );
    assert.deepStrictEqual(
      [...engineMastery.PILLAR_KEYS],
      EXPECTED_PILLAR_KEYS,
      'the engine pillar list is the four documented keys in adopt.ts write order'
    );
  });

  test('each P3-09 consumer imports PILLAR_KEYS from the engine and defines no local copy', () => {
    const problems: string[] = [];
    for (const rel of CONSUMER_FILES) {
      const text = readSource(rel);
      if (!importsPillarKeysFromEngine(rel, text)) {
        problems.push(`${rel} does not import PILLAR_KEYS from src/engine/`);
      }
      const copies = hardcodedPillarCopies(text);
      if (copies.length > 0) {
        problems.push(`${rel} hand-writes the pillar list at line(s) ${copies.join(', ')}`);
      }
    }
    assert.deepStrictEqual(
      problems,
      [],
      'P3-09: the four pillar keys are defined once in src/engine/mastery.ts (PILLAR_KEYS) — ' +
        'every consumer imports them from the engine instead of retyping the tuple'
    );
  });

  test('no file outside the engine carries a quoted four-pillar list', () => {
    // Whole-tree sweep so a new sixth copy anywhere in src/ is flagged, not
    // only a revert of the five known consumers.
    const offenders: string[] = [];
    const scan = (dir: string, relDir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
          scan(full, rel);
        } else if (entry.name.endsWith('.ts') && rel !== CANONICAL_FILE) {
          const copies = hardcodedPillarCopies(fs.readFileSync(full, 'utf8'));
          if (copies.length > 0) offenders.push(`${rel} line(s) ${copies.join(', ')}`);
        }
      }
    };
    scan(path.join(root, 'src'), 'src');
    assert.deepStrictEqual(
      offenders,
      [],
      'the quoted pillar-key tuple belongs to src/engine/mastery.ts alone (P3-09, #565)'
    );
  });

  test('the guards still fire on the reverted P3-09 copies', () => {
    // A guard that cannot fail is worse than no guard. Feed each detector the
    // exact shape P3-09 removed and it must name the defect.
    const revertedLiteral =
      "export const PILLARS = ['conceptual', 'practical', 'debug', 'feynman'] as const;";
    assert.deepStrictEqual(
      hardcodedPillarCopies(revertedLiteral),
      [1],
      'a hand-written pillar tuple must be flagged'
    );
    const revertedImport = "import { PILLAR_KEYS } from './mastery';";
    assert.strictEqual(
      importsPillarKeysFromEngine('src/application/record-assessment.ts', revertedImport),
      false,
      "'./mastery' inside src/application resolves outside src/engine and must not count"
    );
    const engineImport = "import { computeTopicMastery, PILLAR_KEYS } from '../engine/mastery';";
    assert.strictEqual(
      importsPillarKeysFromEngine('src/cli/validate.ts', engineImport),
      true,
      'the rewired import must be recognised'
    );
    assert.strictEqual(
      importsPillarKeysFromEngine(
        'src/application/record-assessment.ts',
        "import { normalizeScore } from '../engine/mastery';"
      ),
      false,
      'an engine import without PILLAR_KEYS must not count'
    );
  });
});
