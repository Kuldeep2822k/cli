/**
 * TOC Tier — Author-Enumeration Chain Sources (Issue PAL-205-C, INV-46/47)
 *
 * @remarks
 * Pure, fs-free companion to the numbered-tree planner in `auto-chain.ts`.
 * Where a vault's numbered layout does not reach, the repo's *own* enumeration
 * (root `README.md`/`SUMMARY.md` and numbered-module READMEs) is the next-best
 * authority on lesson order: markdown links in document order become the
 * chain, labelled `depends_on_source: toc` so downstream tooling can treat
 * those edges more softly than hard numbering.
 *
 * P3-14 (#565) split the module's documented responsibilities into focused
 * modules: **link extraction** (the complexity-guarded document scanner) lives
 * in `./toc-links`, and **target normalization** (destination → vault-relative
 * candidate) in `./toc-targets` — both re-exported below, so this module's
 * public surface and the engine barrel's `tocChain.*` re-exports over it are
 * unchanged. This file keeps **chain planning + tier composition**: order the
 * resolved TOC list (first-appearance dedup, directory grouping by first
 * appearance, C1 same-dir phase resort) and merge it with the numbered plan
 * under C2 numbering dominance: paths inside the numbered tree never take TOC
 * edges, so where both tiers could speak, numbering always wins.
 *
 * Cycle-freedom is a constructed property (a strictly linear walk over a
 * deduplicated list), asserted in code by {@link assertBackwardEdges} rather
 * than trusted to tests alone.
 */

import { classifyNoteForChain } from './tier0-hygiene';
import {
  directoriesOrderedAlphabetically,
  parseNumericPrefix,
  type HygieneChainPlan,
} from './auto-chain';
import type { DependsOnSource } from '../types';

/** Accepted values of `--chain-tier` (default `strict`, set in `src/cli/adopt.ts`). */
export type AutoChainTier = 'strict' | 'full';

/** Which tier authored a note's `depends_on` (persisted as `depends_on_source`). Declared in `src/types.ts`, re-exported here for engine consumers. */
export type { DependsOnSource };

// P3-14 (#565): the parse phases of this module — link extraction from a TOC
// document (phase 1) and destination-to-candidate folding (phase 2) — live in
// `./toc-links` and `./toc-targets`; re-exported here so every importer of
// `./toc-chain` (the engine barrel's `tocChain.*` surface, `src/storage/toc.ts`,
// `src/engine/prereq-text.ts`, the CLI) sees exactly the names it always did.
export { extractTocLinks } from './toc-links';
export type { TocLink, TocSkipReason, TocScanStats } from './toc-links';
export { foldTocDestination } from './toc-targets';
export type { TocTargetCandidate } from './toc-targets';

/** Plan over an author-enumerated list; same shape as {@link ChainPlan} plus provenance. */
export interface TocChainPlan {
  /** TOC-chainable notes in final chain order (dedup, directory grouping, C1 resort applied) */
  orderedPaths: string[];
  /** Note → preceding note in the TOC chain (`null` only for the chain head) */
  predecessorOf: Map<string, string | null>;
}

/**
 * Throws when any predecessor does not sit strictly before its successor.
 *
 * @remarks
 * This is the coded invariant from PAL-205 §8c: a TOC chain is built by a
 * single forward walk over a deduplicated list, so a cycle is *structurally*
 * impossible — but the property the tier promises (stronger than the old
 * alphabetical chain had for free) deserves an executable check, not only a
 * test. If this ever throws, the construction changed under us.
 */
export function assertBackwardEdges(orderedPaths: string[], predecessorOf: Map<string, string | null>): void {
  const index = new Map<string, number>();
  orderedPaths.forEach((p, i) => index.set(p, i));
  for (let i = 0; i < orderedPaths.length; i++) {
    // `i` is in bounds, so this exists; the guard keeps the type honest
    // rather than asserting it.
    const path = orderedPaths[i];
    if (path === undefined) continue;
    const pred = predecessorOf.get(path) ?? null;
    if (pred === null) continue;
    const predIndex = index.get(pred);
    if (predIndex === undefined || predIndex >= i) {
      throw new Error(
        `toc-chain invariant violated: ${path} gates on ${pred} which is not strictly earlier in the chain`
      );
    }
  }
}

/**
 * Operation count for one {@link assertAcyclicPlan} run.
 *
 * @remarks One unit per node the walk traverses. A node already resolved by an
 * earlier start ends that walk before the step is counted, so the count is the
 * work the memo saves. The plan's complexity guard asserts it stays linear as
 * the spine grows, the node-visit counterpart of {@link TocScanStats}.
 */
export interface TocWalkStats {
  steps: number;
}

/**
 * Throws when following {@link predecessorOf} pointers reaches any node twice.
 *
 * @param predecessorOf - The merged plan's one-predecessor map
 * @param stats - Optional accumulator receiving the number of nodes the walk
 * traversed; the run adds to any steps already recorded
 *
 * @remarks
 * The graph-level companion of {@link assertBackwardEdges} for merged plans:
 * composition can legitimately interleave tiers (a numbered note may gate on a
 * TOC-ordered note), so list position no longer proves acyclicity — this walk
 * does. Each node has at most one predecessor, so a three-color iterative walk
 * is linear and cannot miss a loop.
 */
export function assertAcyclicPlan(predecessorOf: Map<string, string | null>, stats?: TocWalkStats): void {
  const counter: TocWalkStats = stats ?? { steps: 0 };
  const done = new Set<string>();
  for (const start of predecessorOf.keys()) {
    if (done.has(start)) continue;
    const walking = new Set<string>();
    let node: string | null | undefined = start;
    while (node !== null && node !== undefined) {
      if (walking.has(node)) {
        throw new Error(`toc-chain invariant violated: predecessor cycle through ${node}`);
      }
      if (done.has(node)) break;
      counter.steps++;
      walking.add(node);
      node = predecessorOf.get(node) ?? null;
    }
    for (const n of walking) done.add(n);
  }
}

/** C1 phase ranks restricted to what a TOC run needs; ties keep document order. */
const TOC_PHASE_PREFIXES = ['deep-dive', 'lab', 'exam'];
const TOC_ASSIGNMENT_PREFIXES = ['assignment', 'quiz', 'solution'];

type TocLessonRank = { rank: 0 | 1 | 2 | 3 | 4; n: number; phase: number };

/** Word-boundary keyword match, mirroring `tier0-hygiene`'s content-doc rule. */
function hasKeywordPrefix(stem: string, kw: string): boolean {
  return (
    stem === kw ||
    stem.startsWith(kw + '-') ||
    stem.startsWith(kw + '_') ||
    stem.startsWith(kw + '.') ||
    stem.startsWith(kw + ' ')
  );
}

/**
 * Ranks one TOC-run basename for the same-directory phase resort (C1),
 * mirroring the hygiene planner's `compareLessonOrderTier0` from the PAL-205-B
 * rework exactly: README-class 0 → numeric 1 (by number) → deep-dive/lab/exam
 * 2 (in that pedagogical order) → any other doc 3 (keeps document order) →
 * assignment/quiz/solution 4, LAST so homework never gates the docs that follow
 * it — in the TOC run as well as the numbered backbone.
 *
 * @remarks
 * The phase index is the part that has to survive the mirroring: rank 2 alone
 * made `deep-dive`, `lab` and `exam` tie and fall back to document order, so a
 * README that listed a lab before its deep dive produced a chain where the
 * deep dive depended on the lab — the reverse of the order the numbered tier
 * states for the same three names.
 */
function tocLessonRank(basename: string): TocLessonRank {
  const lower = basename.toLowerCase();
  const stem = lower.endsWith('.md') ? lower.slice(0, -3) : lower;
  if (stem === 'readme' || stem === 'summary') return { rank: 0, n: -1, phase: -1 };
  const prefix = parseNumericPrefix(stem);
  if (prefix !== null) return { rank: 1, n: prefix.n, phase: -1 };
  for (let i = 0; i < TOC_PHASE_PREFIXES.length; i++) {
    // `i` is in bounds, so this exists; the guard keeps the type honest
    // rather than asserting it.
    const keyword = TOC_PHASE_PREFIXES[i];
    if (keyword === undefined) continue;
    if (hasKeywordPrefix(stem, keyword)) return { rank: 2, n: -1, phase: i };
  }
  if (TOC_ASSIGNMENT_PREFIXES.some((kw) => hasKeywordPrefix(stem, kw))) {
    return { rank: 4, n: -1, phase: -1 };
  }
  return { rank: 3, n: -1, phase: -1 };
}

/**
 * Plans the TOC chain over resolved, in-scope note paths in document order.
 *
 * @param documentOrderPaths - Vault-relative POSIX paths as enumerated by the
 * TOC files (already discovered/read/resolved by `src/storage/toc.ts`)
 * @returns Deduplicated, phase-resorted chain with a linear predecessor map
 *
 * @remarks
 * Ordering rules, all from PAL-205-C3:
 * - first-appearance dedup (`a/` and `a/README.md` collapse);
 * - groups of the same directory are kept together, groups in
 *   first-appearance order of their directory;
 * - inside a group the C1 same-dir resort runs (README-class first,
 *   numeric by number, deep-dive/lab/exam, assignment/quiz/solution last,
 *   everything else in the author's document order);
 * - the result is one linear chain — the head has no predecessor;
 * - {@link assertBackwardEdges} re-verifies cycle-freedom on the way out.
 */
export function planTocChain(documentOrderPaths: string[]): TocChainPlan {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of documentOrderPaths) {
    const p = raw.replace(/\\/g, '/');
    if (seen.has(p)) continue;
    seen.add(p);
    normalized.push(p);
  }

  const docIndex = new Map<string, number>();
  normalized.forEach((p, i) => docIndex.set(p, i));

  const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p: string): string => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

  // The grouping key and the sort's lookup key are the same `parentOf` by
  // construction, which is the whole guarantee here: two separate inline
  // computations could have drifted and made the comparison sort against
  // `undefined`. An assert over these same paths could not fail, so there is
  // none — unlike `assertBackwardEdges`, which checks a property of data that
  // arrives from elsewhere and genuinely can violate it.
  const dirFirstSeen = new Map<string, number>();
  normalized.forEach((p, i) => {
    const dir = parentOf(p);
    if (!dirFirstSeen.has(dir)) dirFirstSeen.set(dir, i);
  });

  const orderedPaths = [...normalized].sort((a, b) => {
    const da = dirFirstSeen.get(parentOf(a))!;
    const db = dirFirstSeen.get(parentOf(b))!;
    if (da !== db) return da - db;
    const ra = tocLessonRank(baseOf(a));
    const rb = tocLessonRank(baseOf(b));
    if (ra.rank !== rb.rank) return ra.rank - rb.rank;
    if (ra.rank === 1 && ra.n !== rb.n) return ra.n - rb.n;
    if (ra.rank === 2 && ra.phase !== rb.phase) return ra.phase - rb.phase;
    // Same intent class: the author's own document order is the tiebreak —
    // alphabetical would be exactly the arbitrary chaining this ticket was
    // opened to remove. Every rank still standing at this point shares that
    // tiebreak, which is why nothing branches on `ra.rank` here.
    return docIndex.get(a)! - docIndex.get(b)!;
  });

  const predecessorOf = new Map<string, string | null>();
  let prev: string | null = null;
  for (const p of orderedPaths) {
    predecessorOf.set(p, prev);
    prev = p;
  }
  assertBackwardEdges(orderedPaths, predecessorOf);
  return { orderedPaths, predecessorOf };
}

/**
 * True when the predecessor walk starting at `from` reaches `target`.
 *
 * @param predecessorOf - The merged plan's one-predecessor map
 * @param from - Note to start walking from
 * @param target - Note whose re-arrival would mean a cycle
 * @returns Whether adding `target → from` would close a cycle
 *
 * @remarks
 * Every note carries at most one predecessor in a plan, so the walk is a chain
 * and "would this edge close a cycle" is a plain reachability question. The
 * `seen` guard makes a pre-existing cycle answer `false` rather than spin: this
 * call site must not null a justified edge for a cycle it did not create, and
 * {@link assertAcyclicPlan} still reports that condition before any write.
 */
function reachesPredecessor(
  predecessorOf: Map<string, string | null>,
  from: string,
  target: string
): boolean {
  const seen = new Set<string>();
  let node: string | null | undefined = from;
  while (node !== null && node !== undefined) {
    if (node === target) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    node = predecessorOf.get(node) ?? null;
  }
  return false;
}

/**
 * A {@link HygieneChainPlan} refined with tier provenance for
 * `depends_on_source`. Carrying the hygiene fields through unchanged keeps
 * the B6 per-tier report valid after composition: classification (backbone,
 * leaf, excluded) is Tier-0's; only edges were recomputed.
 */
export interface TieredChainPlan extends HygieneChainPlan {
  /** Note → which tier authored its predecessor edge (only notes with an edge) */
  sourceOf: Map<string, DependsOnSource>;
  /** Edges authored by the numbered tree (backbone + leaf attach) */
  numberedEdgeCount: number;
  /** Edges authored by author enumeration (TOC tier) */
  tocEdgeCount: number;
  /**
   * Distinct notes the enumeration offered that the full tier could order,
   * whether or not the selected tier consumed any. A README may reach one note
   * through several spellings, and the advice is about notes, so duplicates
   * collapse exactly as {@link planTocChain} collapses them. The CLI's
   * `--chain-tier full` advice is honest only above one: the first candidate is
   * a chain head and writes no edge.
   */
  tocCandidateCount: number;
  /** True when any scoped path carries a numeric prefix (the C4 refusal gate) */
  hasNumberedLayout: boolean;
  /** True when the TOC tier contributed at least one edge */
  hasTocLayout: boolean;
}

/** Composition options for {@link composeTieredChain}. */
export interface TieredComposition {
  /** Selected `--auto-chain` tier; `strict` never consumes TOC edges */
  tier: AutoChainTier;
  /** Hygiene-filtered numbered plan (`planAutoChainWithHygiene`) */
  numbered: HygieneChainPlan;
  /** Resolved TOC enumeration in document order, already limited to scan scope */
  tocPaths: string[];
}

/**
 * Whether a note is covered by the numbered tree — any directory segment or
 * the basename carries a numeric prefix.
 *
 * @remarks
 * This predicate *is* C2 (numbering dominance): such paths are never handed
 * TOC edges because the TOC tier filters them out before planning, so where
 * numbering and a README enumerate differently, numbering structurally wins.
 * (Measured raw-TOC regressions: 4/271 — all of this shape.)
 */
export function isInNumberedTree(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    // `i` is below `segments.length - 1`, so this exists; the guard keeps the
    // type honest rather than asserting it.
    const segment = segments[i];
    if (segment === undefined) continue;
    if (parseNumericPrefix(segment) !== null) return true;
  }
  // `split` never yields an empty array, so the last segment exists; the guard
  // keeps the type honest rather than asserting it.
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  return parseNumericPrefix(last) !== null;
}

/**
 * True when a TOC-enumerated path may take part in the TOC chain.
 *
 * Exclusions: anything Tier-0 hygiene removes, and anything whose only reason
 * to be off the backbone is a phase subtree or a translation demotion — the
 * author's README is not lesson order inside `solution/` or `translations/`.
 */
function tocChainable(relPath: string, paleeId?: unknown): boolean {
  const decision = classifyNoteForChain(relPath, paleeId);
  if (decision.cls === 'excluded') return false;
  return decision.reason !== 'phase-subtree' && decision.reason !== 'translation';
}

/**
 * Merges the numbered plan and the TOC enumeration into one final plan.
 *
 * @param composition - Tier, numbered (hygiene) plan, and in-scope TOC paths
 * @returns The plan the adopt batch consumes: one predecessor per note plus
 * per-edge provenance and the C4 refusal signals
 *
 * @remarks
 * Rules, in order:
 * - `strict` returns the numbered plan with every edge labelled `numbered`;
 * - TOC candidates drop numbered-tree paths (C2) and non-chainable ones;
 * - the surviving candidates get a {@link planTocChain} run whose edges
 *   *replace* the numbered plan's predecessor for every note except a chain
 *   head — including a structure-justified same-directory edge, not only an
 *   alphabetical fallback — and that replacement, not addition, is where the
 *   measured false edges die;
 * - `orderedPaths` keeps the numbered order first, then the TOC chain, so
 *   dry-run/verbose output still reads head-to-tail per tier;
 * - `hasUnnumbered` keeps its original meaning over the numbered plan, but the
 *   two claims the warning is built from are recomposed: a note the enumeration
 *   placed is no longer reported as ordered by name.
 */
export function composeTieredChain(composition: TieredComposition): TieredChainPlan {
  const { tier, numbered, tocPaths } = composition;
  const sourceOf = new Map<string, DependsOnSource>();
  const predecessorOf = new Map(numbered.predecessorOf);
  const numberedSet = new Set<string>();
  const tieNotes = new Set(numbered.alphabeticalTieNotes);
  for (const p of numbered.orderedPaths) {
    if (isInNumberedTree(p)) numberedSet.add(p);
    // A pair that `tiedByName` reports is ordered by filename collation alone,
    // which the numbered tree did not decide and the author never stated. Labelled
    // `tie` so the gate rule can decline it, while the edge still ranks the note
    // and still takes part in cycle detection.
    if (numbered.predecessorOf.get(p)) sourceOf.set(p, tieNotes.has(p) ? 'tie' : 'numbered');
  }
  const numberedEdgeCount = sourceOf.size;
  const orderedPaths = [...numbered.orderedPaths];

  const hasNumberedLayout = numberedSet.size > 0;

  // Computed for every tier, including `strict`, which consumes none of it. The
  // CLI tells a learner running `strict` to try `--chain-tier full`; that advice is
  // only worth giving when the enumeration holds something the full tier could
  // actually order, and this is the one place that knows which paths those are.
  // Counted as notes, not links: a README that reaches the same lesson twice
  // offers the full tier one note, and `planTocChain` deduplicates to that, so
  // counting links advised a tier that would then write nothing.
  const tocCandidates: string[] = [];
  const seenCandidate = new Set<string>();
  for (const raw of tocPaths) {
    const p = raw.replace(/\\/g, '/');
    if (seenCandidate.has(p)) continue;
    seenCandidate.add(p);
    if (numberedSet.has(p)) continue;
    if (!tocChainable(p)) continue;
    tocCandidates.push(p);
  }

  if (tier === 'strict') {
    return {
      ...numbered,
      orderedPaths,
      predecessorOf,
      sourceOf,
      numberedEdgeCount,
      tocEdgeCount: 0,
      tocCandidateCount: tocCandidates.length,
      hasNumberedLayout,
      hasTocLayout: false,
    };
  }

  const candidates = tocCandidates;

  const tocPlan = planTocChain(candidates);
  const tocSet = new Set(tocPlan.orderedPaths);
  let tocEdges = 0;
  /** TOC chain heads that are keeping a structurally-justified numbered edge. */
  const keptHeads: { node: string; kept: string }[] = [];
  for (const p of tocPlan.orderedPaths) {
    const tocPred = tocPlan.predecessorOf.get(p) ?? null;
    if (tocPred !== null) {
      predecessorOf.set(p, tocPred);
      sourceOf.set(p, 'toc');
      tocEdges++;
      continue;
    }
    // C-defect-1 (PAL-205-C rework): a TOC chain HEAD must never silently
    // delete a justified numbered edge. Since the B rework every non-null
    // numbered predecessor is structurally justified (alphabetical
    // cross-dir gating was removed there), so a head keeps its existing edge
    // and its `numbered` label — unless keeping it closes a cycle.
    const keptPred = predecessorOf.get(p) ?? null;
    if (keptPred !== null) keptHeads.push({ node: p, kept: keptPred });
  }
  // The unsafe shape is wider than "the kept predecessor is itself a TOC
  // candidate". A partial enumeration leaves notes it never mentioned on their
  // numbered edges, so a chain can run `kept → … → head` without every link
  // being a candidate: README listing `m/lab-03` before `m/lab-01` and omitting
  // `m/lab-02` gave `lab-03` a kept edge to `lab-02` while `lab-02` still
  // pointed at `lab-01`, which the TOC had just re-parented onto `lab-03`. Ask
  // the real question instead — does walking predecessors from the kept note
  // reach this head? — and there the note opens the chain as intended.
  for (const head of keptHeads) {
    if (!reachesPredecessor(predecessorOf, head.kept, head.node)) continue;
    predecessorOf.set(head.node, null);
    sourceOf.delete(head.node);
  }
  // Display order: numbered rows the TOC tier took over move to the TOC
  // section so each tier still reads head-to-tail in dry-run output. The
  // merged list is not a cross-tier topological order — what the coded
  // invariant checks is acyclicity of the merged graph.
  const finalOrder = orderedPaths.filter((p) => !tocSet.has(p)).concat(tocPlan.orderedPaths);
  assertAcyclicPlan(predecessorOf);

  // Recompute from the final labels: a TOC edge that replaced an alphabetical
  // fallback edge removes that note from the numbered count. `tie` counts here
  // too — the count answers "did any planner write an edge", which is the C4
  // refusal's question, and a same-rank tie is still an edge the numbered
  // planner produced. Only the *gate* treats `tie` as advisory.
  let numberedEdges = 0;
  for (const source of sourceOf.values()) {
    if (source === 'numbered' || source === 'tie') numberedEdges++;
  }

  // The hygiene plan derived its two alphabetical claims from the numbered
  // order, and for every note this enumeration just placed, that order came
  // from the author's README instead. Carrying the claims through unchanged
  // made the CLI say notes "chain in alphabetical order" two lines above a plan
  // showing every one of their edges authored by `toc`, and suggest excluding
  // notes the tier had sequenced correctly. Recomputed over what the TOC tier
  // did not cover; with no TOC paths the recomputation is the identity, so no
  // special case is needed.
  const unenumerated = numbered.orderedPaths.filter((p) => !tocSet.has(p));

  return {
    ...numbered,
    orderedPaths: finalOrder,
    predecessorOf,
    sourceOf,
    alphabeticalNotes: numbered.alphabeticalNotes.filter((p) => !tocSet.has(p)),
    alphabeticalTieNotes: numbered.alphabeticalTieNotes.filter((p) => !tocSet.has(p)),
    directoryOrderAlphabetical: directoriesOrderedAlphabetically(unenumerated),
    numberedEdgeCount: numberedEdges,
    tocEdgeCount: tocEdges,
    tocCandidateCount: tocCandidates.length,
    hasNumberedLayout,
    hasTocLayout: tocEdges > 0,
  };
}

/**
 * Parses the `--chain-tier` value.
 *
 * @param raw - The string Commander captured. A bare `true` is *not* a tier:
 * `--auto-chain` is a plain boolean since #223 and its default tier is `strict`
 * (`src/cli/adopt.ts`), so reading `true` as `full` here would silently widen the
 * reach of a flag that never asked for it - the one thing INV-46 forbids.
 * @returns The tier, or `null` for anything outside `strict|full` (the CLI
 * turns `null` into a usage error — never a silent default)
 */
export function parseAutoChainTier(raw: unknown): AutoChainTier | null {
  if (raw === undefined || raw === false) return null;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'strict' || value === 'full' ? value : null;
}
