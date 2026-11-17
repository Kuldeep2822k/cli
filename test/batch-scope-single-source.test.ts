import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  batchScopeExclusion,
  matchesPattern,
  matchesTags,
  type BatchScopeExclusion,
  type BatchScopeFilters,
} from '../src/storage/pattern-matcher';

/**
 * One batch-scope predicate for the `--include`/`--exclude`/`--tag` filters
 * (P3-11 of audit issue #565).
 *
 * The same three-filter decision was written out three times: `src/cli/adopt.ts`
 * twice (the `passesFilters` expression that decides which already-adopted notes
 * the chain planner may see, and the sequential checks that fill the batch
 * adoption counters) and `src/cli/adopt-undo.ts` once (the same sequential checks
 * filling reversal's counters). Three hand-kept copies of one decision is the
 * drift P3-11 removes: the verdict is now returned once by
 * `batchScopeExclusion` in `src/storage/pattern-matcher.ts`, beside the two
 * matchers it folds (`matchesPattern`, `matchesTags`) and the #312 tally that
 * audits their dialect, and each command keeps its own counters by routing the
 * verdict. P3-14 (#565) later moved the batch adoption's scan out of the
 * handler into `src/cli/adopt-scan.ts`, so that module is the consumer this
 * guard tracks on the adoption side — the handler in `src/cli/adopt.ts`
 * orchestrates the phases and applies no filter itself.
 *
 * The guard has two halves, like `topic-scaffold-single-source` and
 * `pillar-key-single-source`. The runtime half pins the verdict table and —
 * against the pre-P3-11 inline logic, re-stated here as the reference — that the
 * fold routes every (path, tags, filters) combination to the exact bucket the
 * separate checks filled: an include miss or an exclude hit is a pattern
 * exclusion, a tag miss is a tag exclusion, and a note failing several filters
 * lands in the bucket the first failing filter has always claimed. The static
 * half reads the shipped source tree: each consumer must import the predicate
 * from a module resolving into `src/storage/`, and neither may call the raw
 * matchers again — both detectors are fed the exact shapes P3-11 removed, so a
 * revert is named, not absorbed.
 */

const root = path.resolve(__dirname, '..');

/** The canonical module P3-11 put the predicate in. */
const CANONICAL_FILE = 'src/storage/pattern-matcher.ts';

/** The two consumers the item names, each with its own counters — adoption's
 * scan relocated to `src/cli/adopt-scan.ts` by the P3-14 phase split (#565). */
const CONSUMERS: readonly string[] = ['src/cli/adopt-scan.ts', 'src/cli/adopt-undo.ts'];

/** The path form every filter decision is measured against: vault-relative, `/`-separated. */
const PATHS: readonly string[] = [
  'MODULES/01-lesson.md',
  'drafts/01-draft.md',
  'templates/runbook-template.md',
  'notes/README.md',
  'deep/nested/topic.md',
];

/** The `tags` frontmatter values a scan can meet, including "no frontmatter at all". */
const TAG_VALUES: readonly unknown[] = [
  undefined,
  null,
  [],
  ['#cs/grade-a'],
  ['cs', 'math'],
  'unrelated',
  '#grade-a',
];

/** Filter flag combinations over the three batch flags. */
const FILTER_CASES: readonly BatchScopeFilters[] = [
  {},
  { include: 'MODULES/*' },
  { include: 'MODULES/*, drafts/*' },
  { exclude: '*template*' },
  { include: 'MODULES/*', exclude: '*lesson*' },
  { tag: 'cs' },
  { tag: 'grade-a' },
  { tag: 'cs, unrelated' },
  { include: 'MODULES/*', tag: 'cs' },
  { exclude: '**/*.md', include: 'MODULES/*' },
  { include: 'zzz/*.md', exclude: 'zzz/**', tag: 'cs' },
];

/** The buckets the counters fill, as the pre-P3-11 checks filled them. */
type CounterBucket = 'pattern' | 'tag' | null;

/**
 * The pre-P3-11 decision, verbatim from the three inline copies: include miss or
 * exclude hit filled `skippedByPattern`, tag miss filled `skippedByTag`, and the
 * checks ran in that fixed order.
 */
function legacyBucket(
  relPath: string,
  tags: unknown,
  filters: BatchScopeFilters
): CounterBucket {
  if (filters.include && !matchesPattern(relPath, filters.include)) return 'pattern';
  if (filters.exclude && matchesPattern(relPath, filters.exclude)) return 'pattern';
  if (filters.tag && !matchesTags(tags, filters.tag)) return 'tag';
  return null;
}

/** How each command's scan routes the shared verdict into its own counters. */
function routedBucket(exclusion: BatchScopeExclusion | null): CounterBucket {
  if (exclusion === null) return null;
  return exclusion === 'tag' ? 'tag' : 'pattern';
}

/**
 * Detector — a raw matcher call, the shape P3-11 removed from both commands.
 * Any `matchesPattern(`/`matchesTags(` in a consumer is a re-inlined decision,
 * because the predicate is that decision's only call path now.
 */
const RAW_MATCHER_CALL = /\b(?:matchesPattern|matchesTags)\s*\(/;

/** A local re-definition of the predicate instead of the import. */
const LOCAL_PREDICATE_DEF = /\bfunction\s+batchScopeExclusion\b/;

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

/** True when `rel` imports `identifier` from a specifier resolving into `src/storage/`. */
function importsFromStorage(rel: string, text: string, identifier: string): boolean {
  const importMatches = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)];
  for (const match of importMatches) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (!names.includes(identifier)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[2] ?? ''));
    if (resolved === 'src/storage' || resolved.startsWith('src/storage/')) return true;
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

describe('batch scope single source (P3-11, #565)', () => {
  test('no flags at all leaves every path in scope', () => {
    for (const relPath of PATHS) {
      for (const tags of TAG_VALUES) {
        assert.strictEqual(
          batchScopeExclusion(relPath, tags, {}),
          null,
          `the plain batch excludes nothing: ${relPath}`
        );
      }
    }
  });

  test('--include excludes exactly the paths no include pattern selects', () => {
    assert.strictEqual(batchScopeExclusion('drafts/01-draft.md', undefined, { include: 'MODULES/*' }), 'include');
    assert.strictEqual(batchScopeExclusion('MODULES/01-lesson.md', undefined, { include: 'MODULES/*' }), null);
    // The OR-fold and case-folding of the matcher dialect pass through untouched.
    assert.strictEqual(
      batchScopeExclusion('drafts/01-draft.md', undefined, { include: 'MODULES/*, drafts/*' }),
      null
    );
    assert.strictEqual(
      batchScopeExclusion('drafts/01-draft.md', undefined, { include: ['MODULES/*', 'drafts/*'] }),
      null
    );
    assert.strictEqual(
      batchScopeExclusion('MODULES/01-LESSON.md', undefined, { include: 'modules/01-lesson.md' }),
      null
    );
  });

  test('--exclude excludes exactly the paths an exclude pattern selects', () => {
    assert.strictEqual(batchScopeExclusion('drafts/01-draft.md', undefined, { exclude: '*draft*' }), 'exclude');
    assert.strictEqual(batchScopeExclusion('MODULES/01-lesson.md', undefined, { exclude: '*draft*' }), null);
    assert.strictEqual(
      batchScopeExclusion('templates/runbook-template.md', undefined, { exclude: '*draft*, *template*' }),
      'exclude'
    );
  });

  test('--tag excludes notes whose tags match none of the targets, hierarchies included', () => {
    // A note without frontmatter carries no tags, so a --tag scan excludes it.
    assert.strictEqual(batchScopeExclusion('notes/README.md', undefined, { tag: 'cs' }), 'tag');
    assert.strictEqual(batchScopeExclusion('notes/README.md', null, { tag: 'cs' }), 'tag');
    assert.strictEqual(batchScopeExclusion('notes/README.md', [], { tag: 'cs' }), 'tag');
    assert.strictEqual(batchScopeExclusion('notes/README.md', 'unrelated', { tag: 'cs' }), 'tag');
    // In scope: exact, prefix, suffix and infix tag matches, '#' folding included.
    assert.strictEqual(batchScopeExclusion('n.md', ['#cs/grade-a'], { tag: 'cs/grade-a' }), null);
    assert.strictEqual(batchScopeExclusion('n.md', ['#cs/grade-a'], { tag: 'cs' }), null);
    assert.strictEqual(batchScopeExclusion('n.md', ['#cs/grade-a'], { tag: 'grade-a' }), null);
    assert.strictEqual(batchScopeExclusion('n.md', ['domain/security/crypto'], { tag: 'security' }), null);
    assert.strictEqual(batchScopeExclusion('n.md', 'math, #algebra', { tag: 'MATH' }), null);
  });

  test('the verdict order is include, then exclude, then tag — the order the checks ran', () => {
    // A note that an include list would drop and an exclude list would drop:
    // 'include' is the verdict, the one the pattern counter has always claimed.
    assert.strictEqual(
      batchScopeExclusion('MODULES/01-lesson.md', ['#cs'], {
        include: 'zzz/*.md',
        exclude: 'MODULES/**',
        tag: 'cs',
      }),
      'include'
    );
    // An exclude hit and a tag miss both fire: 'exclude' wins, pattern bucket.
    assert.strictEqual(
      batchScopeExclusion('MODULES/01-lesson.md', undefined, { exclude: 'MODULES/**', tag: 'cs' }),
      'exclude'
    );
    // A passing include does not shadow a later exclude hit.
    assert.strictEqual(
      batchScopeExclusion('MODULES/01-lesson.md', undefined, { include: 'MODULES/*', exclude: '*lesson*' }),
      'exclude'
    );
    // A passing include and exclude do not shadow a tag miss.
    assert.strictEqual(
      batchScopeExclusion('MODULES/01-lesson.md', undefined, { include: 'MODULES/*', tag: 'cs' }),
      'tag'
    );
  });

  test('the fold routes every combination to the bucket the separate checks filled', () => {
    // The pre-P3-11 logic is re-stated in `legacyBucket`; the shared predicate
    // must agree with it on the whole matrix, or a scan's accounting changed.
    for (const relPath of PATHS) {
      for (const tags of TAG_VALUES) {
        for (const filters of FILTER_CASES) {
          const exclusion = batchScopeExclusion(relPath, tags, filters);
          assert.strictEqual(
            routedBucket(exclusion),
            legacyBucket(relPath, tags, filters),
            `drift at path=${relPath} tags=${JSON.stringify(tags)} ` +
              `filters=${JSON.stringify(filters)}: verdict ${String(exclusion)}`
          );
        }
      }
    }
  });

  test('the canonical module exports the predicate and no other src file defines it', () => {
    const text = readSource(CANONICAL_FILE);
    assert.match(text, /export type BatchScopeExclusion\b/);
    assert.match(text, /export interface BatchScopeFilters\b/);
    assert.match(text, /export function batchScopeExclusion\b/);
    // The fold must route through the two matchers, not re-derive the dialect.
    assert.match(
      text,
      /export function batchScopeExclusion[\s\S]*matchesPattern\(filePath, filters\.include\)[\s\S]*matchesTags\(noteTags, filters\.tag\)/,
      'the predicate folds matchesPattern and matchesTags, it does not re-derive them'
    );

    const offenders: string[] = [];
    for (const { rel, text: source } of scanSources(path.join(root, 'src'), 'src')) {
      if (rel === CANONICAL_FILE) continue;
      if (flaggedLines(source, LOCAL_PREDICATE_DEF).length > 0) offenders.push(rel);
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'the batch-scope predicate is defined once, in src/storage/pattern-matcher.ts (P3-11, #565)'
    );
  });

  test('each consumer imports the predicate from storage and re-inlines no matcher call', () => {
    const problems: string[] = [];
    for (const rel of CONSUMERS) {
      const text = readSource(rel);
      if (!importsFromStorage(rel, text, 'batchScopeExclusion')) {
        problems.push(`${rel} does not import batchScopeExclusion from src/storage/`);
      }
      const flagged = flaggedLines(text, RAW_MATCHER_CALL);
      if (flagged.length > 0) {
        problems.push(`${rel} calls a raw matcher at line(s) ${flagged.join(', ')}`);
      }
    }
    assert.deepStrictEqual(
      problems,
      [],
      'P3-11: the --include/--exclude/--tag decision is one predicate in ' +
        'src/storage/pattern-matcher.ts; adopt and adopt-undo import it instead of ' +
        'calling matchesPattern/matchesTags themselves'
    );
  });

  test('the guards still fire on the reverted P3-11 copies', () => {
    // A guard that cannot fail is worse than no guard. Feed each detector the
    // exact shapes P3-11 removed and it must name the defect.
    const revertedPlannerGate = [
      '        const passesFilters =',
      '          (!options.include || matchesPattern(relPath, options.include)) &&',
      '          !(options.exclude && matchesPattern(relPath, options.exclude)) &&',
      '          !(options.tag && !matchesTags(frontmatter.tags, options.tag));',
    ].join('\n');
    assert.deepStrictEqual(
      flaggedLines(revertedPlannerGate, RAW_MATCHER_CALL),
      [2, 3, 4],
      'the reverted planner-visibility expression must be flagged'
    );

    const revertedChecks = [
      '      if (options.include && !matchesPattern(relPath, options.include)) {',
      '        skippedByPattern.push(relPath);',
      '        continue;',
      '      }',
      '      if (options.exclude && matchesPattern(relPath, options.exclude)) {',
      '        skippedByPattern.push(relPath);',
      '        continue;',
      '      }',
      '      if (options.tag && !matchesTags(frontmatter?.tags, options.tag)) {',
      '        skippedByTag.push(relPath);',
      '        continue;',
      '      }',
    ].join('\n');
    assert.deepStrictEqual(
      flaggedLines(revertedChecks, RAW_MATCHER_CALL),
      [1, 5, 9],
      'the reverted sequential checks must be flagged'
    );

    // And the tolerated shapes must not trip it: prose about the fold, the
    // predicate's own definition, and a foreign call that is not the decision.
    assert.deepStrictEqual(
      flaggedLines('// reporting on it. `matchesPattern` OR-folds, so the run could only ever print', RAW_MATCHER_CALL),
      [],
      'prose mentions of the matcher are not calls'
    );
    assert.deepStrictEqual(
      flaggedLines('export function batchScopeExclusion(filePath: string): BatchScopeExclusion | null {', RAW_MATCHER_CALL),
      [],
      'the predicate definition itself is not a raw matcher call'
    );
    assert.deepStrictEqual(
      flaggedLines('function legacyBucket(filters: BatchScopeFilters): CounterBucket {', RAW_MATCHER_CALL),
      [],
      'an unrelated function shape is not a raw matcher call'
    );
  });
});
