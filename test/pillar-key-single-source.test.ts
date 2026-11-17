import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
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
 *
 * P3-10 amended the mechanism for one consumer, not the invariant: the pillar
 * list inside `src/cli/adopt-undo.ts`'s strip set moved with `PALEE_OWNED_KEYS`
 * itself into `src/engine/topic-scaffold.ts`, whose set splices the engine's
 * `PILLAR_KEYS` in. So `adopt-undo` satisfies this guard transitively — it must
 * import `PALEE_OWNED_KEYS` from `src/engine/`, and `topic-scaffold-single-
 * source.test.ts` pins that the imported set really does carry the pillars.
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

/**
 * Start lines of array literals carrying all four pillar keys as string
 * literals — i.e. a hand-written copy of the list.
 *
 * Parsed with the TypeScript compiler already installed for `npm run
 * typecheck`, because a line-oriented scan cannot see a copy whose entries sit
 * on separate lines (`['conceptual',\n 'practical', …]`, or the adopt-undo
 * shape where the pillars are entries mid-array). The AST also separates code
 * from comments for free: a doc mention is not an array, an incomplete or
 * object-shaped list is not this defect, and a spread of the canonical list is
 * the fix. Both quote styles parse to the same string-literal value, so neither
 * spelling escapes. Detection is independent of any import of `PILLAR_KEYS` —
 * importing the canonical list does not license a second hand-written copy.
 */
function hardcodedPillarCopies(text: string): number[] {
  const sourceFile = ts.createSourceFile('guard.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const flagged: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements
        .filter((element): element is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
          ts.isStringLiteralLike(element)
        )
        .map((element) => element.text);
      if (EXPECTED_PILLAR_KEYS.every((key) => values.includes(key))) {
        flagged.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return flagged;
}

/** Resolves a relative specifier from a source file to a repo-relative path. */
function resolvesTo(fromRel: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
}

/**
 * True when the file imports the pillar list from a relative specifier
 * resolving into `src/engine/` — either `PILLAR_KEYS` directly (the P3-09
 * wiring) or `PALEE_OWNED_KEYS` from the topic-scaffold module (the P3-10
 * wiring, whose set splices the engine's `PILLAR_KEYS` in). The brace-body
 * match spans newlines, so multi-line import blocks are covered.
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
    if (!names.includes('PILLAR_KEYS') && !names.includes('PALEE_OWNED_KEYS')) continue;
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

  test('each P3-09 consumer gets the pillar list from the engine and defines no local copy', () => {
    const problems: string[] = [];
    for (const rel of CONSUMER_FILES) {
      const text = readSource(rel);
      if (!importsPillarKeysFromEngine(rel, text)) {
        problems.push(`${rel} does not import PILLAR_KEYS (or PALEE_OWNED_KEYS) from src/engine/`);
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

  test('a copied pillar list split across lines is flagged like the one-line literal', () => {
    const multilineDoubleQuoted = [
      'export const PILLARS = [',
      '  "conceptual",',
      '  "practical",',
      '  "debug",',
      '  "feynman",',
      '] as const;',
    ].join('\n');
    assert.deepStrictEqual(
      hardcodedPillarCopies(multilineDoubleQuoted),
      [1],
      'the same four strings spread over five lines are the same copy'
    );

    // The adopt-undo shape P3-09 removed: the pillars embedded mid-array in a
    // longer owned-key list, one entry per line. A whole-file all-four shortcut
    // cannot tell this from four unrelated mentions; the copy is the array.
    const adoptUndoStyle = [
      'const PALEE_OWNED_KEYS = [',
      "  'palee_id',",
      "  'palee_schema',",
      "  'difficulty',",
      "  'depends_on',",
      "  'conceptual',",
      "  'practical',",
      "  'debug',",
      "  'feynman',",
      "  'topic_mastery',",
      "  'lapses',",
      '];',
    ].join('\n');
    assert.deepStrictEqual(
      hardcodedPillarCopies(adoptUndoStyle),
      [1],
      'a pillar tuple tucked into a larger owned-key array is still a second copy'
    );

    const embedded = ['// header', '', 'const PILLARS = [', "  'conceptual',", "  'practical',", "  'debug',", "  'feynman',", '];'].join('\n');
    assert.deepStrictEqual(
      hardcodedPillarCopies(embedded),
      [3],
      'the finding points at the array, not the file'
    );
  });

  test('detection does not depend on whether PILLAR_KEYS is also imported', () => {
    const text = [
      "import { PILLAR_KEYS } from '../engine/mastery';",
      '',
      'const local = [',
      "  'conceptual',",
      "  'practical',",
      "  'debug',",
      "  'feynman',",
      '];',
    ].join('\n');
    assert.ok(
      importsPillarKeysFromEngine('src/cli/validate.ts', text),
      'the import half recognises this file'
    );
    assert.deepStrictEqual(
      hardcodedPillarCopies(text),
      [3],
      'a rewired import does not license a hand-written copy beside it'
    );
  });

  test('scattered pillar mentions and non-list uses are not copies', () => {
    const proseInComments = [
      "// conceptual, practical, debug, and feynman are the four pillars",
      '/*',
      "  'conceptual', 'practical', 'debug', 'feynman'",
      '*/',
    ].join('\n');
    assert.deepStrictEqual(
      hardcodedPillarCopies(proseInComments),
      [],
      'comment prose naming all four pillars is not a list'
    );

    // Each pillar named once, in unrelated contexts: the whole-file
    // contains-all-four shortcut would cry wolf here; the detector must not.
    const scatteredUses = [
      "const conceptual = 'conceptual';",
      "const practical = 'practical';",
      "const debug = 'debug';",
      "const feynman = 'feynman';",
    ].join('\n');
    assert.deepStrictEqual(
      hardcodedPillarCopies(scatteredUses),
      [],
      'four individual string literals are not an array copy'
    );

    const threeOfFour = "const keys = ['conceptual', 'practical', 'debug'];";
    assert.deepStrictEqual(hardcodedPillarCopies(threeOfFour), [], 'an incomplete list is not the copy');

    const objectKeys = 'const rubric = { conceptual: 1, practical: 1, debug: 1, feynman: 1 };';
    assert.deepStrictEqual(
      hardcodedPillarCopies(objectKeys),
      [],
      'an object literal of scores is a different shape, not an array copy'
    );

    const spreadOfCanonical = "const all = [...PILLAR_KEYS, 'topic_mastery'];";
    assert.deepStrictEqual(
      hardcodedPillarCopies(spreadOfCanonical),
      [],
      'deriving from the canonical list is the fix, not the defect'
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
    // The P3-10 transit: adopt-undo now consumes the pillars through the
    // centralized owned-key set, imported from the topic-scaffold engine module.
    const transitImport = "import { PALEE_OWNED_KEYS } from '../engine/topic-scaffold';";
    assert.strictEqual(
      importsPillarKeysFromEngine('src/cli/adopt-undo.ts', transitImport),
      true,
      'the PALEE_OWNED_KEYS import from the topic-scaffold module must count'
    );
    assert.strictEqual(
      importsPillarKeysFromEngine(
        'src/cli/adopt-undo.ts',
        "import { PALEE_OWNED_KEYS } from './topic-scaffold';"
      ),
      false,
      "'./topic-scaffold' inside src/cli resolves outside src/engine and must not count"
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
