/**
 * Auto-Chain Engine — Hierarchical Dependency Chaining (Issue #73)
 *
 * @remarks
 * Pure, fs-free dependency synthesis for `palee adopt --auto-chain` and the
 * wikilink roadmap format.
 *
 * Two responsibilities:
 * 1. **Chain planning** — derive a deterministic `depends_on` predecessor for
 *    every note from numbered directory/file prefixes (`01-foundations/`,
 *    `02-linux/01-processes.md`) and the fixed phase order
 *    `deep-dive → lab → exam`. Notes are grouped by immediate parent
 *    directory; each group chains internally in lesson order and the entry
 *    note of module N bridges to the exit note of module N−1. The plan is
 *    acyclic by construction (every note has at most one predecessor and
 *    edges always point backward in a total order), but callers still run
 *    cycle detection (`src/engine/dependency.ts`) over the merged graph before
 *    committing — the engine cannot see pre-existing vault cycles.
 * 2. **Wikilink parsing** — parse Obsidian `[[target]]`, `[[target|alias]]`,
 *    and `[[target#heading]]` links (anchors are stripped per #73). Vault
 *    resolution lives in `src/storage/wikilink.ts`; this module only parses.
 */

import {
  classifyNoteForChain,
  README_CLASS_STEMS,
  stemOf,
  type Tier0Decision,
  type Tier0SkipReason,
} from './tier0-hygiene';

/** Numeric prefix parsed from a directory or file basename. */
export interface NumericPrefix {
  /** The leading number, e.g. `1` for `01-foundations` */
  n: number;
  /** Remainder of the name after the prefix and its separator */
  rest: string;
}

/**
 * Leading digit run of a lesson number: at most 3 digits, then either its
 * separator (with the remainder captured) or the end of the name.
 *
 * `#73` review item 4. The original `/^(\d+)[-_.\s]?(.*)$/` made the separator
 * optional, so a digit leading a *word* silently claimed a lesson number:
 * `3d-printing` parsed as lesson 3 and chained between `02-` and `04-`, and
 * `2024-recap` parsed as lesson 2024 and landed after every real module.
 * Neither raised the `hasUnnumbered` alphabetical warning, so the placement was
 * invisible. Requiring a separator (or end-of-name) after the digits rejects
 * `3d-printing` and `01foundations`, while the 3-digit cap rejects year-shaped
 * `2024-recap` — a lesson index above 999 does not occur in numbered curricula.
 */
const NUMERIC_PREFIX = /^(\d{1,3})(?:[-_.\s](.*)|$)/;

/**
 * Parses a leading numeric prefix from a directory or file basename.
 *
 * @param name - Basename such as `01-foundations` or `02_lab.md`
 * @returns The parsed number and remainder, or `null` when the name is not a
 * numbered lesson — no leading digits, digits running into a word with no
 * separator (`3d-printing`, `01foundations`), or a 4-plus digit run (`2024-recap`)
 *
 * @example
 * ```typescript
 * parseNumericPrefix('01-foundations'); // { n: 1, rest: 'foundations' }
 * parseNumericPrefix('lab-01');         // null
 * parseNumericPrefix('3d-printing');    // null — a word, not lesson 3
 * parseNumericPrefix('2024-recap');     // null — a year, not lesson 2024
 * ```
 */
export function parseNumericPrefix(name: string): NumericPrefix | null {
  const match = NUMERIC_PREFIX.exec(name.trim());
  if (!match) {
    return null;
  }
  const n = parseInt(match[1], 10);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  return { n, rest: match[2] ?? '' };
}

/** Fixed pedagogical phase order for non-numeric lesson files (#73). */
const PHASE_KEYWORDS = ['deep-dive', 'lab', 'exam'] as const;

interface LessonRank {
  /** 0 = numeric prefix, 1 = phase keyword, 2 = everything else */
  rank: 0 | 1 | 2;
  n: number;
  phase: number;
}

/**
 * Reduces a lesson basename to its ordering rank: numeric prefix first, then
 * the {@link PHASE_KEYWORDS} pedagogical phases, then everything else.
 */
function lessonRank(basename: string): LessonRank {
  const prefix = parseNumericPrefix(basename);
  if (prefix !== null) {
    return { rank: 0, n: prefix.n, phase: -1 };
  }
  const lower = basename.toLowerCase();
  for (let i = 0; i < PHASE_KEYWORDS.length; i++) {
    const kw = PHASE_KEYWORDS[i];
    if (
      lower === kw ||
      lower.startsWith(kw + '-') ||
      lower.startsWith(kw + '_') ||
      lower.startsWith(kw + '.') ||
      lower.startsWith(kw + ' ')
    ) {
      return { rank: 1, n: -1, phase: i };
    }
  }
  return { rank: 2, n: -1, phase: -1 };
}

/**
 * Deterministic alphabetical tiebreak: case-insensitive first, then
 * case-sensitive, so equal-folded names still sort stably.
 */
function compareStrings(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compares two lesson basenames in auto-chain order: numeric-prefixed files
 * first by number, then the fixed `deep-dive → lab → exam` phase order, then
 * remaining files alphabetically (case-insensitive, deterministic).
 */
export function compareLessonOrder(aBasename: string, bBasename: string): number {
  const ra = lessonRank(aBasename);
  const rb = lessonRank(bBasename);
  if (ra.rank !== rb.rank) {
    return ra.rank - rb.rank;
  }
  if (ra.rank === 0 && ra.n !== rb.n) {
    return ra.n - rb.n;
  }
  if (ra.rank === 1 && ra.phase !== rb.phase) {
    return ra.phase - rb.phase;
  }
  return compareStrings(aBasename, bBasename);
}

/**
 * Basename of a `/`-separated path, split on `/` only.
 *
 * Kept instead of `path.basename`: this module is the fs-free engine layer
 * (`agent.md`), and `path.basename` on Windows also splits on `\` and strips a
 * trailing separator, so it is not a provably identical substitution.
 */
function baseNameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** Parent directory of a `/`-separated path; the root group is the `'.'` sentinel. */
function parentDirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) : '.';
}

/** One `/`-separated directory segment reduced to a number-plus-name sort key. */
interface DirSegmentKey {
  /** Numeric prefix of the segment, or `null` when it has none */
  n: number | null;
  /** Raw segment text */
  name: string;
}

/** Splits a directory into per-segment sort keys; the `'.'` root yields one unnumbered key. */
function dirSortKey(dir: string): DirSegmentKey[] {
  return dir.split('/').map((seg) => {
    const parsed = parseNumericPrefix(seg);
    return { n: parsed ? parsed.n : null, name: seg };
  });
}

/**
 * Compares two directories segment by segment, so an ancestor prefix decides
 * order before anything nested beneath it: numbered segments sort first and by
 * number, ties fall back to the segment name, and a parent group sorts before
 * its own children.
 */
function compareDirs(a: string, b: string): number {
  const ka = dirSortKey(a);
  const kb = dirSortKey(b);
  const len = Math.min(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const sa = ka[i];
    const sb = kb[i];
    if (sa.n !== null && sb.n !== null) {
      if (sa.n !== sb.n) {
        return sa.n - sb.n;
      }
    } else if (sa.n !== null) {
      return -1;
    } else if (sb.n !== null) {
      return 1;
    }
    const c = compareStrings(sa.name, sb.name);
    if (c !== 0) {
      return c;
    }
  }
  return ka.length - kb.length;
}

/** Deterministic dependency plan produced by {@link planAutoChain}. */
export interface ChainPlan {
  /** Relative paths in chain order; the first entry is the chain head */
  orderedPaths: string[];
  /** Map from relative path to its predecessor's relative path (`null` for the chain head) */
  predecessorOf: Map<string, string | null>;
  /**
   * True when alphabetical order actually decided a directory's position — some
   * segment level where two directories differ and one of them lacks a numeric
   * prefix — or when some file had neither a numeric prefix nor a phase
   * keyword. The CLI warns that those entries fell back to alphabetical order.
   */
  hasUnnumbered: boolean;
  /**
   * The directory half of {@link hasUnnumbered} on its own: true when two
   * directories differed at some segment level and at least one of them carries
   * no numeric prefix there, so the order between whole modules came from their
   * names. Split out because the flag's other half is about *files*, which the
   * hygiene plan reports as a concrete path list.
   */
  directoryOrderAlphabetical: boolean;
}

/**
 * Plans a hierarchical auto-chain over vault-relative note paths.
 *
 * @param relativePaths - Vault-relative note paths (POSIX or Windows separators)
 * @returns Chain order, predecessor map, and the unnumbered-fallback flag
 *
 * @remarks
 * Notes are grouped by immediate parent directory. Directories sort segment by
 * segment through their path (each segment by numeric prefix first, unnumbered
 * segments sorting after numbered ones), so an ancestor prefix always decides
 * order before a nested group's own number and a parent group precedes its own
 * children; equal-numbered segments fall back to alphabetical order. Within
 * each directory notes sort by {@link compareLessonOrder}. Each note's
 * predecessor is the previous note in its group, except the first note of each
 * group (after the first), which bridges to the last note of the previous
 * group — so module N's entry note depends on module N−1's exit note. Acyclic
 * by construction.
 */
export function planAutoChain(relativePaths: string[]): ChainPlan {
  const normalized = relativePaths.map((p) => p.replace(/\\/g, '/'));

  const groups = new Map<string, string[]>();
  for (const p of normalized) {
    const dir = parentDirOf(p);
    const list = groups.get(dir);
    if (list) {
      list.push(p);
    } else {
      groups.set(dir, [p]);
    }
  }

  // Alphabetical order only *decides* anything at a segment level where two
  // group directories actually differ, so that is the only place an unnumbered
  // segment can have caused a fallback. Testing every segment instead would
  // flag the canonical unnumbered `MODULES/` container from #73's own example
  // (`palee adopt "MODULES/" --auto-chain`) on essentially every vault and turn
  // the warning into noise. Reuses {@link dirSortKey} so the question is answered
  // with the same segmentation `compareDirs` sorts by.
  const dirKeys = [...groups.keys()].map(dirSortKey);
  const maxDepth = dirKeys.reduce((max, key) => Math.max(max, key.length), 0);
  let directoryOrderAlphabetical = false;
  for (let level = 0; level < maxDepth && !directoryOrderAlphabetical; level++) {
    const distinct = new Set<string>();
    for (const key of dirKeys) {
      if (level < key.length) {
        distinct.add(key[level].name);
      }
    }
    if (distinct.size < 2) {
      continue;
    }
    for (const key of dirKeys) {
      if (level < key.length && key[level].n === null) {
        directoryOrderAlphabetical = true;
        break;
      }
    }
  }
  let hasUnnumbered = directoryOrderAlphabetical;
  for (const p of normalized) {
    if (lessonRank(baseNameOf(p)).rank === 2) {
      hasUnnumbered = true;
    }
  }

  const sortedDirs = [...groups.keys()].sort(compareDirs);

  const orderedPaths: string[] = [];
  const predecessorOf = new Map<string, string | null>();
  let prev: string | null = null;
  for (const dir of sortedDirs) {
    const files = groups.get(dir)!.sort((a, b) => compareLessonOrder(baseNameOf(a), baseNameOf(b)));
    for (const f of files) {
      orderedPaths.push(f);
      predecessorOf.set(f, prev);
      prev = f;
    }
  }

  return { orderedPaths, predecessorOf, hasUnnumbered, directoryOrderAlphabetical };
}

/** Per-rule counters for B6: notes hygiene removed from the plan *or* demoted off the backbone. */
export type Tier0RuleCounts = Record<Tier0SkipReason, number>;

/** A {@link ChainPlan} refined by Tier-0 hygiene filtering (PAL-205 B1–B5). */
export interface HygieneChainPlan extends ChainPlan {
  /** Ordered chain paths that may gate other notes (backbone only) */
  backbonePaths: string[];
  /** Ordered chain paths that attach to the chain but never gate it */
  leafPaths: string[];
  /** Notes removed from the plan entirely, with their counted reason */
  excluded: Map<string, Tier0SkipReason>;
  /**
   * Planned notes whose position came from their name rather than from a
   * structure the author stated: no numeric prefix, no phase keyword, not
   * README-class, and not homework.
   *
   * @remarks
   * This is the set {@link ChainPlan.hasUnnumbered} was meant to describe and
   * does not. That flag is a coarse boolean over the pre-hygiene order, so it
   * fires on a fully numbered curriculum that merely has a module `README.md`
   * (rank 2 in the public comparator), and it says nothing about which paths
   * were affected. Homework names are excluded here on purpose: `assignment.md`
   * and `quiz.md` are placed last by a structural rule, so calling their order
   * alphabetical would be inaccurate, and a curriculum that numbers every
   * lesson but names its assignments would warn on every single run.
   */
  alphabeticalNotes: string[];
  /** Classification of every path that survived, keyed by normalized path */
  decisions: Map<string, Tier0Decision>;
  /** Totals the CLI prints verbatim on the dry-run and confirmation screens */
  counts: {
    backbone: number;
    leaf: number;
    byReason: Tier0RuleCounts;
  };
}

function emptyRuleCounts(): Tier0RuleCounts {
  return {
    'repo-meta': 0,
    translation: 0,
    template: 0,
    'phase-subtree': 0,
    'invalid-palee-id': 0,
  };
}

/**
 * Documents *why* a directory transition may or may not gate.
 *
 * @remarks
 * An edge from a note in one directory to a note in another is only justified
 * when the order between those two directories comes from structure rather
 * than from alphabetical enumeration:
 *
 * - the same directory always qualifies;
 * - **the vault root qualifies into the first numbered module** (owner ruling,
 *   PAL-205-G2): a root `README.md` is the document that introduces the
 *   curriculum, so `README → 01-…` is a real prerequisite edge, not an
 *   alphabetical invention. The module may sit under an unnumbered container —
 *   the layout every example in this project uses is
 *   `MODULES/01-foundations/01-intro.md`, and the ruling is about the numbered
 *   *module*, not about which level carries the digits. It is the *only* root
 *   exception — a root note reaching a directory that never states a lesson
 *   number still refuses, because nothing ordered that pair;
 * - an ancestor/descendant pair qualifies, because nesting is the signal;
 * - otherwise the first differing path segment decides, and the transition is
 *   justified only when **both** segments carry numeric prefixes — a numbered
 *   curriculum is the author stating an order.
 *
 * When either side is unnumbered, alphabetical order picked which sibling came
 * first, and a reference collection enumerated alphabetically is not a
 * prerequisite sequence. Such a transition must not gate: the note starts its
 * own chain instead, which is the same honest-refusal direction the rest of
 * Tier-0 takes (demote, never invent).
 */
function dirTransitionJustified(fromDir: string, toDir: string): boolean {
  if (fromDir === toDir) {
    return true;
  }
  if (fromDir === '.') {
    // Owner ruling: the vault-root README may gate into a numbered module.
    return leadsToNumberedSegment(toDir);
  }
  const a = dirSortKey(fromDir);
  const b = dirSortKey(toDir);
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i].name === b[i].name) {
      continue;
    }
    return a[i].n !== null && b[i].n !== null;
  }
  // One path is a prefix of the other: pure nesting, no alphabetical choice.
  return true;
}

/**
 * True when any segment of a directory path carries a numeric lesson prefix.
 *
 * @param dir - `/`-separated directory of a prospective chain successor
 * @returns Whether the path descends into a numbered module at some level
 *
 * @remarks
 * The root bridge is keyed on the module, not the depth at which the author
 * chose to number it: `01-foundations` and `MODULES/01-foundations` state the
 * same order, and only the second one is what a curriculum vault actually
 * looks like. A path with no number anywhere (`foo/`, `src/algorithms/caesar`)
 * states no order and stays a refusal.
 */
function leadsToNumberedSegment(dir: string): boolean {
  return dir.split('/').some((segment) => parseNumericPrefix(segment) !== null);
}

/**
 * Tier-0 within-directory lesson order: README-class first, then numeric
 * prefixes, then the `deep-dive → lab → exam` phases, then remaining names
 * alphabetically, with `assignment|quiz|solution` deliberately last.
 *
 * @remarks
 * The shipped `compareLessonOrder` puts README and `assignment.md` in the same
 * rank and breaks the tie alphabetically, so `assignment.md` sorted **before**
 * `README.md` and every module lesson ended up depending on its own homework.
 * Homework, quizzes and solutions follow the lesson they assess, so they close
 * the directory instead of opening it.
 *
 * This comparator is intentionally local to the hygiene planner: the public
 * `compareLessonOrder` contract that Work Order A shipped against is unchanged.
 */
function compareLessonOrderTier0(aBasename: string, bBasename: string): number {
  const ra = tier0LessonRank(aBasename);
  const rb = tier0LessonRank(bBasename);
  if (ra.rank !== rb.rank) {
    return ra.rank - rb.rank;
  }
  if (ra.rank === 1 && ra.n !== rb.n) {
    return ra.n - rb.n;
  }
  if (ra.rank === 2 && ra.phase !== rb.phase) {
    return ra.phase - rb.phase;
  }
  return compareStrings(aBasename, bBasename);
}

/** Within-directory rank of a note under {@link compareLessonOrderTier0}. */
interface Tier0LessonRank {
  /** 0 README-class, 1 numeric, 2 phase, 3 other, 4 homework/solution last */
  rank: 0 | 1 | 2 | 3 | 4;
  n: number;
  phase: number;
}

function tier0LessonRank(basename: string): Tier0LessonRank {
  const stem = stemOf(basename);
  if (README_CLASS_STEMS.includes(stem)) {
    return { rank: 0, n: -1, phase: -1 };
  }
  const prefix = parseNumericPrefix(stem);
  if (prefix !== null) {
    return { rank: 1, n: prefix.n, phase: -1 };
  }
  for (let i = 0; i < PHASE_KEYWORDS.length; i++) {
    const kw = PHASE_KEYWORDS[i];
    if (
      stem === kw ||
      stem.startsWith(kw + '-') ||
      stem.startsWith(kw + '_') ||
      stem.startsWith(kw + '.') ||
      stem.startsWith(kw + ' ')
    ) {
      return { rank: 2, n: -1, phase: i };
    }
  }
  if (ASSIGNMENT_LAST_PREFIXES.some((kw) => stem === kw || stem.startsWith(kw + '-') || stem.startsWith(kw + '_') || stem.startsWith(kw + '.') || stem.startsWith(kw + ' '))) {
    return { rank: 4, n: -1, phase: -1 };
  }
  return { rank: 3, n: -1, phase: -1 };
}

/** Names that assess a lesson, so they follow it rather than precede it. */
const ASSIGNMENT_LAST_PREFIXES = ['assignment', 'quiz', 'solution'] as const;

/**
 * Plans an auto-chain over the same order {@link planAutoChain} produces, after
 * Tier-0 hygiene has removed repo noise and demoted non-lesson notes.
 *
 * @param relativePaths - Vault-relative note paths (POSIX or Windows separators)
 * @param paleeIdOf - Lookup of a note's parsed frontmatter `palee_id`. **Optional
 * by signature only, not by contract: the plan classifies with it, so a caller
 * that has ids available and withholds them gets a different graph.** `adopt.ts`
 * wires it, and any other consumer (the TOC tier) must too whenever ids are
 * known — B7 demotion is applied here as well as at the scan, deliberately, so
 * the two can never disagree about what may gate.
 * @returns The hygiene-filtered plan, with per-tier counts for reporting
 *
 * @remarks
 * The directory grouping and directory ordering come from `planAutoChain` so the
 * two plans cannot drift apart. Two things are then corrected here, and only
 * here:
 *
 * 1. **Within a directory**, notes are re-sorted by {@link compareLessonOrderTier0}
 *    so a lesson's README precedes its assignment instead of the reverse.
 * 2. **Across directories**, {@link dirTransitionJustified} decides whether a
 *    transition may gate at all, so alphabetical order between unnumbered
 *    sibling directories stops fabricating prerequisites.
 *
 * On top of that the leaf rule holds: a backbone note's predecessor is the
 * previous *backbone* note that it is justified in following, a leaf's
 * predecessor is that same nearest preceding backbone note (so it carries a
 * `depends_on` for graph coverage without anything chaining off it), and
 * excluded notes appear nowhere. Acyclicity is preserved: every edge still
 * points strictly backward in the same total order.
 */
export function planAutoChainWithHygiene(
  relativePaths: string[],
  paleeIdOf?: (relPath: string) => unknown
): HygieneChainPlan {
  const excluded = new Map<string, Tier0SkipReason>();
  const decisions = new Map<string, Tier0Decision>();
  const byReason: Tier0RuleCounts = emptyRuleCounts();

  const kept: string[] = [];
  for (const raw of relativePaths) {
    const normalized = raw.replace(/\\/g, '/');
    const decision = classifyNoteForChain(normalized, paleeIdOf ? paleeIdOf(normalized) : undefined);
    if (decision.cls === 'excluded') {
      const reason = decision.reason ?? 'repo-meta';
      excluded.set(normalized, reason);
      byReason[reason] += 1;
      continue;
    }
    decisions.set(normalized, decision);
    kept.push(normalized);
  }

  const base = planAutoChain(kept);

  // Re-sort inside each directory run, keeping the directory sequence that
  // planAutoChain already chose. planAutoChain emits groups contiguously, so a
  // run is a maximal stretch of paths sharing a parent directory.
  const runs: { dir: string; files: string[] }[] = [];
  let runDir: string | null = null;
  let run: string[] = [];
  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    run.sort((a, b) => compareLessonOrderTier0(baseNameOf(a), baseNameOf(b)));
    runs.push({ dir: runDir!, files: run });
    run = [];
  };
  for (const p of base.orderedPaths) {
    const dir = parentDirOf(p);
    if (runDir !== null && dir !== runDir) {
      flushRun();
    }
    runDir = dir;
    run.push(p);
  }
  flushRun();

  // Owner ruling (PAL-205-G2): the vault root is the entry point of a numbered
  // curriculum, so the root group leads. planAutoChain ranks the unnumbered
  // `'.'` group *after* every numbered module, which would strand a root
  // README at the end of the chain and make README → module-01 unrepresentable
  // as a backward edge. Hoisting it here keeps that correction inside the
  // hygiene plan — the exported planAutoChain ordering Work Orders A/C/D are
  // stacked on is left exactly as it was.
  const rootAt = runs.findIndex((r) => r.dir === '.');
  if (rootAt > 0) {
    const [rootRun] = runs.splice(rootAt, 1);
    runs.unshift(rootRun);
  }

  const orderedPaths: string[] = [];
  for (const r of runs) {
    orderedPaths.push(...r.files);
  }

  const backbonePaths: string[] = [];
  const leafPaths: string[] = [];
  const predecessorOf = new Map<string, string | null>();
  let lastBackbone: string | null = null;
  for (const p of orderedPaths) {
    const cls = decisions.get(p)?.cls ?? 'leaf';
    const candidate =
      lastBackbone !== null && dirTransitionJustified(parentDirOf(lastBackbone), parentDirOf(p))
        ? lastBackbone
        : null;
    if (cls === 'backbone') {
      backbonePaths.push(p);
      predecessorOf.set(p, candidate);
      lastBackbone = p;
    } else {
      leafPaths.push(p);
      // A leaf hangs off the chain; it never becomes the chain's spine.
      predecessorOf.set(p, candidate);
    }
  }

  for (const decision of decisions.values()) {
    if (decision.cls === 'backbone') continue;
    if (decision.reason) byReason[decision.reason] += 1;
  }

  const alphabeticalNotes = orderedPaths.filter((p) => tier0LessonRank(baseNameOf(p)).rank === 3);

  return {
    orderedPaths,
    predecessorOf,
    hasUnnumbered: base.hasUnnumbered,
    directoryOrderAlphabetical: base.directoryOrderAlphabetical,
    alphabeticalNotes,
    backbonePaths,
    leafPaths,
    excluded,
    decisions,
    counts: {
      backbone: backbonePaths.length,
      leaf: leafPaths.length,
      byReason,
    },
  };
}

/** A parsed Obsidian wikilink. */
export interface ParsedWikilink {
  /** Link target with any `#heading`/`#^block` anchor and `.md` suffix stripped */
  target: string;
  /** Display alias from `[[target|alias]]`, when present */
  alias?: string;
}

const SINGLE_WIKILINK = /^\[\[([^[#\]|]+?)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]$/;

/**
 * Parses a single Obsidian wikilink string.
 *
 * @param text - A complete `[[...]]` link
 * @returns The parsed target and optional alias, or `null` for malformed input
 *
 * @example
 * ```typescript
 * parseWikilink('[[MODULES/01-a|Alias]]'); // { target: 'MODULES/01-a', alias: 'Alias' }
 * parseWikilink('[[note#heading]]');       // { target: 'note' }
 * parseWikilink('[[broken');              // null
 * ```
 */
export function parseWikilink(text: string): ParsedWikilink | null {
  const match = SINGLE_WIKILINK.exec(text.trim());
  if (!match) {
    return null;
  }
  let target = match[1].trim();
  if (target.length === 0) {
    return null;
  }
  if (target.toLowerCase().endsWith('.md')) {
    target = target.slice(0, -3).trim();
  }
  if (target.length === 0) {
    return null;
  }
  const result: ParsedWikilink = { target };
  const alias = match[2] !== undefined ? match[2].trim() : '';
  if (alias.length > 0) {
    result.alias = alias;
  }
  return result;
}

const WIKILINK_GLOBAL = /\[\[([^[#\]|]+?)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

/**
 * Extracts every well-formed wikilink from a line or block of text, in order.
 *
 * @param text - Text to scan (a bullet item, a paragraph, …)
 * @returns Parsed links; malformed, nested `[[` and backslash-escaped sequences
 * are skipped
 */
export function extractWikilinks(text: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  WIKILINK_GLOBAL.lastIndex = 0;
  try {
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_GLOBAL.exec(text)) !== null) {
      // The global scan resumes inside `[[a[[b]]` and reports `[[b]]`, so a
      // well-formed tail of an unterminated link would still slip through.
      // A match whose prefix still has an open `[[` is nested, not a link.
      const prefix = text.slice(0, match.index);
      if (prefix.lastIndexOf('[[') > prefix.lastIndexOf(']]')) {
        continue;
      }
      // `\[[Alpha]]` is an escaped bracket, not a link: it renders as literal
      // `[[Alpha]]` text, which is how a roadmap documents a link without
      // activating it. Importing it would rewrite Alpha's `depends_on` from an
      // example the author deliberately switched off.
      if (match.index > 0 && text[match.index - 1] === '\\') {
        continue;
      }
      const parsed = parseWikilink(match[0]);
      if (parsed) {
        links.push(parsed);
      }
    }
  } finally {
    WIKILINK_GLOBAL.lastIndex = 0;
  }
  return links;
}

/** A fence this scanner is currently inside: its marker character and run length. */
interface OpenFence {
  char: '`' | '~';
  length: number;
}

/** ≤3 spaces of indentation, then a run of 3+ backticks or 3+ tildes, then the info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Blank-preserving mask so a fenced region keeps its line and column shape. */
function maskLine(line: string): string {
  return line.replace(/\S/g, ' ');
}

/**
 * Replaces the content of every fenced code block with spaces, keeping the
 * document's line structure intact.
 *
 * @param text - Raw markdown text
 * @returns The same text with fence bodies and fence lines blanked out
 *
 * @remarks
 * CommonMark fence rules, because a caller's whole job is telling real content
 * from an example: a fence opens on 3+ backticks **or** 3+ tildes indented at
 * most three spaces, and closes only on the **same character**, run at least as
 * long, with nothing after it. A mixed pair therefore never matches — the one
 * regex this replaced allowed ` ``` ` to close a `~~~` block, which leaked an
 * example's `[[links]]` and `# headings` back into the roadmap parser and the
 * title resolver. An info string carrying a backtick cannot open a backtick
 * fence, and an unclosed fence runs to the end of the document.
 *
 * Line structure is preserved rather than the block spliced out so that
 * downstream line scans (`## Track` headings, list bullets) still see the same
 * lines in the same order.
 */
export function stripFencedCodeBlocks(text: string): string {
  const parts = text.split(/(\r?\n)/);
  let fence: OpenFence | null = null;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.length === 0 || /^\r?\n$/.test(line)) {
      continue;
    }
    const marker = FENCE_LINE.exec(line);
    if (fence === null) {
      if (!marker) {
        continue;
      }
      const run = marker[1];
      // An info string may not contain the opening character: ```` ```js ````
      // opens, ```` ``` a`b ```` is just text that starts with backticks.
      if (run[0] === '`' && marker[2].includes('`')) {
        continue;
      }
      fence = { char: run[0] as '`' | '~', length: run.length };
      parts[i] = maskLine(line);
      continue;
    }
    parts[i] = maskLine(line);
    if (
      marker &&
      marker[1][0] === fence.char &&
      marker[1].length >= fence.length &&
      marker[2].trim().length === 0
    ) {
      fence = null;
    }
  }
  return parts.join('');
}
