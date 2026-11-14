/**
 * Auto-Chain Engine — Tier-0 Hygiene Planning (Issue #73)
 *
 * @remarks
 * Pure, fs-free dependency synthesis for `palee adopt --auto-chain` and the
 * wikilink roadmap format.
 *
 * P3-14 (#565) split the module's phases into focused modules: the numbered-
 * tree ordering substrate and the base planner ({@link planAutoChain}) live in
 * `./lesson-order`, wikilink parsing in `./wikilinks`, and the markup masking
 * both link scanners share in `./markup-masking` — all re-exported below, so
 * this module's public surface and the engine barrel's `autoChain.*`
 * re-exports over it are unchanged. This file keeps the hygiene planner:
 * {@link planAutoChainWithHygiene} re-plans {@link planAutoChain}'s order after
 * Tier-0 hygiene has removed repo noise and demoted non-lesson notes
 * (PAL-205 B1–B5), with the backbone/leaf rules, the justified-transition gate,
 * and the per-rule counts the CLI reports.
 */

import {
  classifyNoteForChain,
  README_CLASS_STEMS,
  stemOf,
  type Tier0Decision,
  type Tier0SkipReason,
} from './tier0-hygiene';
// P3-14 (#565): the ordering substrate and base planner live in `./lesson-order`;
// the names below are the hygiene planner's shared plumbing with it.
import {
  baseNameOf,
  compareStrings,
  dirSortKey,
  parentDirOf,
  parseNumericPrefix,
  PHASE_KEYWORDS,
  planAutoChain,
  type ChainPlan,
} from './lesson-order';

// P3-14 (#565): the parse/masking phases, re-exported so every importer of
// `./auto-chain` — the engine barrel's `autoChain.*` surface, the storage
// wikilink/note-title/roadmap/toc consumers, `./toc-chain`, `./toc-links`,
// `./prereq-text`, and the tests — sees exactly the names it always did.
export {
  compareLessonOrder,
  directoriesOrderedAlphabetically,
  parseNumericPrefix,
  planAutoChain,
} from './lesson-order';
export type { ChainPlan, NumericPrefix } from './lesson-order';
export { extractWikilinks, parseWikilink } from './wikilinks';
export type { ParsedWikilink } from './wikilinks';
export { stripFencedCodeBlocks, stripUnfollowableMarkup } from './markup-masking';

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
  /**
   * Planned notes that sit behind a same-directory note stating the identical
   * number or phase, so their order against it came from their filenames.
   *
   * @remarks
   * `alphabeticalNotes` cannot describe these: both `02-a.md` and `02-b.md`
   * carry a number, so the plan looked fully decided by numbering while the
   * edge that gates `02-b` was an alphabetical tie-break nobody reported. The
   * edge stays — a learner who writes `a` then `b` usually means that order —
   * but the CLI says out loud which order it invented.
   */
  alphabeticalTieNotes: string[];
  /** Classification of every path that survived, keyed by normalized path */
  decisions: Map<string, Tier0Decision>;
  /** Totals the CLI prints verbatim on the dry-run and confirmation screens */
  counts: {
    backbone: number;
    leaf: number;
    byReason: Tier0RuleCounts;
  };
}

/** Zeroed per-rule skip counts, so a rule that fired nothing reports that instead of vanishing. */
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
    // `i` is below both key lengths by construction; the guards keep the type
    // honest rather than asserting it.
    const keyA = a[i];
    const keyB = b[i];
    if (keyA === undefined || keyB === undefined) {
      continue;
    }
    if (keyA.name === keyB.name) {
      continue;
    }
    return keyA.n !== null && keyB.n !== null;
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
 * This comparator is local to the hygiene planner apart from one consumer:
 * `palee migrate --relabel-ties` needs it to confirm that the stored predecessor
 * is the note the planner would have placed *first*, because rank equality
 * alone does not say which end of the pair the edge should point at. The public
 * `compareLessonOrder` contract that Work Order A shipped against is unchanged.
 */
export function compareLessonOrderTier0(aBasename: string, bBasename: string): number {
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

/**
 * True when two names in the same directory state the *same* order, so
 * {@link compareLessonOrderTier0} falls through to comparing them by filename.
 *
 * @remarks
 * Every rank is reported, because the fall-through happens for every rank: two
 * rank-4 notes (`assignment.md`, `quiz.md`) are placed by their filenames exactly
 * as `02-a.md` and `02-b.md` are. Narrowing to ranks 1 and 2 left the pairs that
 * look the least decided — a module's own coursework, or a `README` beside a
 * `SUMMARY` — carrying a `numbered` label and therefore gating, while the tie
 * warning that exists to surface them stayed silent. A rank-3 pair appears here
 * *and* in {@link HygieneChainPlan.alphabeticalNotes}: that report describes the
 * directory, this one names the edge.
 *
 * Exported because `palee migrate --relabel-ties` re-asks exactly this question
 * about edges written before the `tie` label existed. Restating the test inside
 * the migration is how the two would drift and a numbering decision that really
 * was made get demoted to advisory.
 */
export function tiedByName(aBasename: string, bBasename: string): boolean {
  const ra = tier0LessonRank(aBasename);
  const rb = tier0LessonRank(bBasename);
  if (ra.rank !== rb.rank) {
    return false;
  }
  if (ra.rank === 1 && ra.n !== rb.n) {
    return false;
  }
  if (ra.rank === 2 && ra.phase !== rb.phase) {
    return false;
  }
  return true;
}

/** Within-directory rank of a note under {@link compareLessonOrderTier0}. */
interface Tier0LessonRank {
  /** 0 README-class, 1 numeric, 2 phase, 3 other, 4 homework/solution last */
  rank: 0 | 1 | 2 | 3 | 4;
  n: number;
  phase: number;
}

/**
 * Ranks one note inside its directory: README-class first, then numeric lesson
 * prefixes, then `deep-dive` / `lab` / `exam` in that order, then any remaining name,
 * with homework last so a lesson never depends on its own assignment.
 *
 * @param basename - The note's filename, extension included
 * @returns The rank, plus the lesson number or phase index where the name states one
 */
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
      excluded.set(normalized, decision.reason);
      byReason[decision.reason] += 1;
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
  /** Closes the run in progress: orders it by name rank and records it under its directory. */
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
    // `rootAt > 0` means the splice removed exactly one run; the guard keeps
    // the type honest rather than asserting it.
    if (rootRun !== undefined) {
      runs.unshift(rootRun);
    }
  }

  const orderedPaths: string[] = [];
  for (const r of runs) {
    orderedPaths.push(...r.files);
  }

  const backbonePaths: string[] = [];
  const leafPaths: string[] = [];
  const alphabeticalTieNotes: string[] = [];
  const predecessorOf = new Map<string, string | null>();
  let lastBackbone: string | null = null;
  let walkingDir: string | null = null;
  /** Last backbone of the group being walked that is not homework. */
  let lessonOfGroup: string | null = null;
  /** How many backbone notes the group being walked has held. */
  let backbonesInGroup = 0;
  /** The same for the group just left — what a cross-directory bridge may use. */
  let exitOfLastGroup: string | null = null;
  for (const p of orderedPaths) {
    const dir = parentDirOf(p);
    if (dir !== walkingDir) {
      // Two different kinds of empty-handed group, and they must not be
      // conflated. A group of leaves alone never claimed to be a module, so the
      // bridge carries on from the last group that did — which is what walking
      // `lastBackbone` forward did before homework was demoted. A group whose
      // backbones are all homework IS a module, and it has no lesson to hand on:
      // its exit is nothing, so the next module opens its own chain instead of
      // inheriting a lesson from two modules back and silently skipping the quiz.
      if (backbonesInGroup > 0) exitOfLastGroup = lessonOfGroup;
      lessonOfGroup = null;
      backbonesInGroup = 0;
      walkingDir = dir;
    }
    const cls = decisions.get(p)?.cls ?? 'leaf';
    // A module's exit note is the one the next module opens with. Placing
    // `assignment|quiz|solution` last inside its own directory — which is what
    // stops a lesson depending on its own homework — also made homework the exit
    // note of every module, so `02-search/01-b` ended up gated behind
    // `01-foundations/assignment.md`: 48 of 88 measured edges in
    // ML-For-Beginners, 29 of 72 in Web-Dev. The bridge uses the group's last
    // lesson instead. A module whose only backbone is homework exports nothing,
    // and the chain carries on from the last real lesson rather than restarting:
    // `01-a/01-x → 01-a/assignment → 02-b/quiz → 03-c/01-y` gates the quiz and
    // the next lesson on `01-x`, never on homework.
    const spine = lastBackbone !== null && parentDirOf(lastBackbone) === dir ? lastBackbone : exitOfLastGroup;
    const candidate = spine !== null && dirTransitionJustified(parentDirOf(spine), dir) ? spine : null;
    if (candidate !== null && parentDirOf(candidate) === parentDirOf(p) && tiedByName(baseNameOf(candidate), baseNameOf(p))) {
      alphabeticalTieNotes.push(p);
    }
    if (cls === 'backbone') {
      backbonePaths.push(p);
      predecessorOf.set(p, candidate);
      lastBackbone = p;
      backbonesInGroup += 1;
      if (tier0LessonRank(baseNameOf(p)).rank !== 4) lessonOfGroup = p;
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
    alphabeticalTieNotes,
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
