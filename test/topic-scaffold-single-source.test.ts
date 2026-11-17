import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { buildTopicScaffold, PALEE_OWNED_KEYS } from '../src/engine/topic-scaffold';
import { PILLAR_KEYS } from '../src/engine/mastery';
import * as validReviewFields from '../src/validation/rules/valid-review-fields';

/**
 * One topic scaffold and one owned-key set, imported from the engine
 * (P3-10 of audit issue #565).
 *
 * The seven SM-2 scheduling keys a never-reviewed topic carries
 * (`ease_factor`, `interval_days`, `repetition`, `lapses`, `last_quality`,
 * `last_reviewed_at`, `due_at`) were written out as literal blocks in four
 * places: `src/cli/adopt.ts` twice (the single-file and batch adoption
 * paths), `src/cli/roadmap.ts` (`resolveTopicUpdates`, the preserve-else-
 * default form), and `src/validation/rules/valid-review-fields.ts`
 * (`SM2_REVIEW_DEFAULTS`, the `--fix` reset map) — with the owned-key list
 * those writes imply hand-listed a fifth time in `src/cli/adopt-undo.ts`
 * (`PALEE_OWNED_KEYS`). Five hand-kept copies of one contract is the drift
 * P3-10 removes: the values are now built once by the engine's
 * `buildTopicScaffold`, and the strip set is defined once beside it, deriving
 * its SM-2 middle from the builder's own key order and its pillar middle from
 * the engine's `PILLAR_KEYS` (P3-09).
 *
 * The guard has two halves. The runtime half pins the documented scaffold —
 * values, key order, the preserve-else-default contract the roadmap import
 * relies on, and that the `--fix` reset map resets to the same values. The
 * static half reads the shipped source tree, like `pillar-key-single-source`
 * and the boundary tests: each named consumer must import its symbol from a
 * module resolving into `src/engine/`, and no file in the layers above the
 * engine may hand-write a scaffold default literal again. Both detectors are
 * fed the exact shapes P3-10 removed, so a reverted copy is named, not
 * absorbed.
 */

const root = path.resolve(__dirname, '..');

/** The canonical module P3-10 created. */
const CANONICAL_FILE = 'src/engine/topic-scaffold.ts';

/** The seven scaffold keys, in the order `adopt.ts` writes them. */
const SCAFFOLD_KEYS: readonly string[] = [
  'ease_factor',
  'interval_days',
  'repetition',
  'lapses',
  'last_quality',
  'last_reviewed_at',
  'due_at',
];

/** The scaffold values, paired with the keys above. */
const SCAFFOLD_VALUES: Readonly<Record<string, unknown>> = {
  ease_factor: 2.5,
  interval_days: 1,
  repetition: 0,
  lapses: 0,
  last_quality: null,
  last_reviewed_at: null,
  due_at: null,
};

/** The numeric/enum subset of the scaffold that `validate --fix` resets. */
const REPAIR_FIELDS = ['ease_factor', 'interval_days', 'repetition', 'lapses', 'last_quality'] as const;

const KEY_SOURCE = SCAFFOLD_KEYS.join('|');

/**
 * Detector A — a hand-written fresh scaffold: a property named with a scaffold
 * key whose value is one of the scaffold defaults (`ease_factor: 2.5`,
 * `last_quality: null`, …). Comment-looking lines are prose and skipped.
 */
const FRESH_DEFAULT_LINE = new RegExp(`\\b(${KEY_SOURCE})\\s*:\\s*(2\\.5|\\d+|null)\\b`);

/**
 * Detector B — a hand-written preserve-else-default scaffold, the roadmap
 * shape (`ease_factor: existingAtPath.ease_factor ?? 2.5`). Scoped to
 * `roadmap.ts`, where the other `??` guards (`palee_schema`, `topic_mastery`,
 * `assessed_at`, `depends_on`) are deliberately not scaffold keys.
 */
const PRESERVE_DEFAULT_LINE = new RegExp(`\\b(${KEY_SOURCE})\\s*:\\s*\\S+\\s*\\?\\?`);

/**
 * Detector C — a hand-listed owned-key set: a quoted owned key, the form
 * `PALEE_OWNED_KEYS` used before P3-09/P3-10 derived its middles. Scoped to
 * `adopt-undo.ts`; `--difficulty`-style flag names and the un-owned `title`
 * do not match.
 */
const QUOTED_OWNED_KEY = new RegExp(
  `['"](${KEY_SOURCE}|palee_id|palee_schema|difficulty|depends_on|topic_mastery|assessed_at|depends_on_source)['"]`
);

/** The owned-key head and tail around the derived middles. */
const OWNED_HEAD: readonly string[] = [
  'palee_id',
  'palee_schema',
  'difficulty',
  'depends_on',
  'topic_mastery',
  'assessed_at',
];
const OWNED_TAIL: readonly string[] = ['depends_on_source'];

/** The consumers P3-10 rewired, with the engine symbol each must import. */
const CONSUMERS: Readonly<Record<string, string>> = {
  'src/cli/adopt.ts': 'buildTopicScaffold',
  'src/cli/roadmap.ts': 'buildTopicScaffold',
  'src/validation/rules/valid-review-fields.ts': 'buildTopicScaffold',
  'src/cli/adopt-undo.ts': 'PALEE_OWNED_KEYS',
};

/**
 * Extra per-file detectors, scoped to the file whose reverted shape they catch:
 * the preserve-else-default form lived only in `roadmap.ts`, the hand-listed
 * owned-key set only in `adopt-undo.ts`. Applying them file-wide would cry wolf
 * on legitimate neighbours — `valid-review-fields.ts`'s bounds table quotes the
 * field names (`field: 'ease_factor'`), and `plan`/`progress`/`dashboard` carry
 * `??` guards over the loader's normalized fields.
 */
const EXTRA_DETECTORS: Readonly<Record<string, ReadonlyArray<readonly [string, RegExp]>>> = {
  'src/cli/roadmap.ts': [['preserve-else-default literal', PRESERVE_DEFAULT_LINE]],
  'src/cli/adopt-undo.ts': [['hand-listed owned key', QUOTED_OWNED_KEY]],
};

/** The layers above the engine, where the four scaffold copies used to live. */
const SWEPT_DIRS: readonly string[] = ['src/application', 'src/cli', 'src/validation'];

/** Non-comment source lines of `text` that match `pattern`, as 1-based numbers. */
function flaggedLines(text: string, pattern: RegExp): number[] {
  const flagged: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    assert.ok(line !== undefined);
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (pattern.test(trimmed)) flagged.push(index + 1);
  }
  return flagged;
}

/** Resolves a relative specifier from a source file to a repo-relative path. */
function resolvesTo(fromRel: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
}

/** True when `rel` imports `identifier` from a specifier resolving into `src/engine/`. */
function importsFromEngine(rel: string, text: string, identifier: string): boolean {
  const importMatches = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)];
  for (const match of importMatches) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (!names.includes(identifier)) continue;
    const resolved = resolvesTo(rel, match[2] ?? '');
    if (resolved === 'src/engine' || resolved.startsWith('src/engine/')) return true;
  }
  return false;
}

/** Reads a repo-relative file under the repo root. */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

/** Recursively collects `.ts` files under `dir` as `{ rel, text }`. */
function scanSources(dir: string, relDir: string): Array<{ rel: string; text: string }> {
  const found: Array<{ rel: string; text: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...scanSources(full, rel));
    } else if (entry.name.endsWith('.ts')) {
      found.push({ rel, text: fs.readFileSync(full, 'utf8') });
    }
  }
  return found;
}

describe('topic scaffold single source (P3-10, #565)', () => {
  test('the builder returns the documented never-reviewed scaffold in the documented order', () => {
    const scaffold = buildTopicScaffold();
    assert.deepStrictEqual(Object.keys(scaffold), SCAFFOLD_KEYS);
    assert.deepStrictEqual({ ...scaffold }, SCAFFOLD_VALUES);
  });

  test('the builder preserves what a note already carries and defaults only what is absent', () => {
    // The roadmap-import contract: a carried value passes through verbatim
    // (frontmatter is untrusted — forwarding, not normalizing), an absent key
    // gets the adoption default, and null coalesces to the default exactly as
    // the `??` semantics the import has always used.
    const carried = buildTopicScaffold({
      ease_factor: 'soon',
      interval_days: 6,
      lapses: 7,
      last_quality: 3,
    });
    assert.strictEqual(carried.ease_factor, 'soon');
    assert.strictEqual(carried.interval_days, 6);
    assert.strictEqual(carried.repetition, 0);
    assert.strictEqual(carried.lapses, 7);
    assert.strictEqual(carried.last_quality, 3);
    assert.strictEqual(carried.last_reviewed_at, null);
    assert.strictEqual(carried.due_at, null);
    assert.strictEqual(buildTopicScaffold({ ease_factor: null }).ease_factor, 2.5);
    assert.deepStrictEqual({ ...buildTopicScaffold({}) }, SCAFFOLD_VALUES);
  });

  test('PALEE_OWNED_KEYS is the documented set in the documented order, derived not retyped', () => {
    assert.deepStrictEqual([...PALEE_OWNED_KEYS], [
      ...OWNED_HEAD,
      ...PILLAR_KEYS,
      ...SCAFFOLD_KEYS,
      ...OWNED_TAIL,
    ]);
    // The middles must be the engine's own lists — a revert that hand-lists
    // them in a different order, or drops or duplicates an entry, fails above.
    // `title` stays un-owned (ADR-0022's --drop-title contract).
    assert.ok(!PALEE_OWNED_KEYS.includes('title'), 'title must stay un-owned');
    assert.strictEqual(new Set(PALEE_OWNED_KEYS).size, PALEE_OWNED_KEYS.length);
  });

  test('the --fix reset map resets review fields to the scaffold values, not a local copy', () => {
    const scaffold = buildTopicScaffold();
    for (const field of REPAIR_FIELDS) {
      assert.ok(field in validReviewFields.SM2_REVIEW_DEFAULTS, `${field} must be reset`);
      assert.deepStrictEqual(
        validReviewFields.SM2_REVIEW_DEFAULTS[field],
        scaffold[field],
        `SM2_REVIEW_DEFAULTS.${field} must be the scaffold default`
      );
    }
  });

  test('the canonical module exports the builder and the owned-key set', () => {
    const text = readSource(CANONICAL_FILE);
    assert.match(text, /export function buildTopicScaffold\b/);
    assert.match(text, /export const PALEE_OWNED_KEYS\b/);
    assert.match(
      text,
      /export const PALEE_OWNED_KEYS[\s\S]*\.\.\.Object\.keys\(buildTopicScaffold\(\)\)/,
      'the owned set must derive its SM-2 middle from the builder, not retype it'
    );
  });

  test('each P3-10 consumer imports its symbol from the engine and writes no local copy', () => {
    const problems: string[] = [];
    for (const [rel, identifier] of Object.entries(CONSUMERS)) {
      const text = readSource(rel);
      if (!importsFromEngine(rel, text, identifier)) {
        problems.push(`${rel} does not import ${identifier} from src/engine/`);
      }
      const detectors: ReadonlyArray<readonly [string, RegExp]> = [
        ['fresh scaffold literal', FRESH_DEFAULT_LINE],
        ...(EXTRA_DETECTORS[rel] ?? []),
      ];
      for (const [label, pattern] of detectors) {
        const flagged = flaggedLines(text, pattern);
        if (flagged.length > 0) problems.push(`${rel} hand-writes a ${label} at line(s) ${flagged.join(', ')}`);
      }
    }
    assert.deepStrictEqual(
      problems,
      [],
      'P3-10: the topic scaffold is built once by src/engine/topic-scaffold.ts and the ' +
        'owned-key set is defined once beside it — consumers import them instead of retyping'
    );
  });

  test('no file above the engine hand-writes a fresh scaffold default', () => {
    const offenders: string[] = [];
    for (const dir of SWEPT_DIRS) {
      for (const { rel, text } of scanSources(path.join(root, ...dir.split('/')), dir)) {
        const flagged = flaggedLines(text, FRESH_DEFAULT_LINE);
        if (flagged.length > 0) offenders.push(`${rel} line(s) ${flagged.join(', ')}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'the scaffold default literals belong to src/engine/topic-scaffold.ts alone (P3-10, #565)'
    );
  });

  test('the guards still fire on the reverted P3-10 copies', () => {
    // A guard that cannot fail is worse than no guard. Feed each detector the
    // exact shapes P3-10 removed and it must name the defect.
    const revertedAdopt = [
      '        ease_factor: 2.5,',
      '        interval_days: 1,',
      '        repetition: 0,',
      '        lapses: 0,',
      '        last_quality: null,',
      '        last_reviewed_at: null,',
      '        due_at: null,',
    ];
    assert.deepStrictEqual(
      flaggedLines(revertedAdopt.join('\n'), FRESH_DEFAULT_LINE),
      [1, 2, 3, 4, 5, 6, 7],
      'a hand-written fresh scaffold must be flagged'
    );
    const revertedRoadmap =
      'ease_factor: existingAtPath.ease_factor ?? 2.5,\n' +
      'topic_mastery: existingAtPath.topic_mastery ?? 0.0,\n' +
      'palee_schema: existingAtPath.palee_schema ?? 1,\n';
    assert.deepStrictEqual(
      flaggedLines(revertedRoadmap, PRESERVE_DEFAULT_LINE),
      [1],
      'the reverted preserve-else-default scaffold must be flagged, while the ' +
        'non-scaffold ?? guards beside it are not'
    );
    const revertedUndo = [
      "const PALEE_OWNED_KEYS: readonly string[] = [",
      "  'palee_id',",
      "  'assessed_at',",
      "  'ease_factor',",
      "  'last_reviewed_at',",
      "  'depends_on_source',",
      "];",
    ].join('\n');
    assert.deepStrictEqual(
      flaggedLines(revertedUndo, QUOTED_OWNED_KEY),
      [2, 3, 4, 5, 6],
      'a hand-listed owned-key set must be flagged'
    );
    assert.deepStrictEqual(
      flaggedLines("const TITLE_KEY = 'title';\nconflicting.push('--difficulty');", QUOTED_OWNED_KEY),
      [],
      'the un-owned title key and --flag names must not count'
    );
    // Deliberate exemptions, stated so a future editor does not "fix" them:
    // the loader's normalization defaults (storage) and the engine's own
    // processReview defaults (sm2.ts) are different contracts with their own
    // pins, not scaffold copies.
    assert.deepStrictEqual(
      flaggedLines(
        'ease_factor: parseNumber(frontmatter.ease_factor, 2.5),\nease_factor = 2.5,',
        FRESH_DEFAULT_LINE
      ),
      [],
      'the loader parse-default and the sm2 destructuring default are not scaffold copies'
    );
  });
});
