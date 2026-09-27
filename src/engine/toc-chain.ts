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
 * Three responsibilities live here:
 * 1. **Link extraction** — pull inline markdown link destinations (including
 *    `<angle bracket>` and `%20`-escaped forms) out of a TOC document, in
 *    document order.
 * 2. **Target normalization** — turn a destination into a vault-relative
 *    POSIX candidate (folder links → `<dir>/README.md`, anchors stripped,
 *    trailing slashes tolerated and deduped, per-TOC-file base dir,
 *    lexical `.`/`..` fold). Backslashes are *literal characters*, never
 *    separators — the same rule `src/storage/wikilink.ts` enforces, because a
 *    Windows `path.resolve` would silently reinterpret them.
 * 3. **Chain planning + tier composition** — order the resolved TOC list
 *    (first-appearance dedup, directory grouping by first appearance, C1
 *    same-dir phase resort) and merge it with the numbered plan under C2
 *    numbering dominance: paths inside the numbered tree never take TOC
 *    edges, so where both tiers could speak, numbering always wins.
 *
 * Cycle-freedom is a constructed property (a strictly linear walk over a
 * deduplicated list), asserted in code by {@link assertBackwardEdges} rather
 * than trusted to tests alone.
 */

import { classifyNoteForChain } from './tier0-hygiene';
import {
  directoriesOrderedAlphabetically,
  parseNumericPrefix,
  stripFencedCodeBlocks,
  type HygieneChainPlan,
} from './auto-chain';
import type { DependsOnSource } from '../types';

/** Accepted values of `--chain-tier` (default `full`). */
export type AutoChainTier = 'strict' | 'toc' | 'full';

/** Which tier authored a note's `depends_on` (persisted as `depends_on_source`). Declared in `src/types.ts`, re-exported here for engine consumers. */
export type { DependsOnSource };

/** A markdown link destination that is intentionally not a chain target. */
export type TocSkipReason =
  | 'external'
  | 'self-anchor'
  | 'malformed'
  | 'empty';

/** One parsed link from a TOC document. */
export interface TocLink {
  /** Raw destination exactly as written, inside angle brackets if used */
  raw: string;
  /** Destination after percent-decoding and anchor stripping, before path folding; `null` when skipped */
  destination: string | null;
  /** Set only when `destination` is null */
  skip?: TocSkipReason;
}

/** Scheme-looking prefix of a destination (`http:`, `mailto:`, …). Drive letters match too, which is correct for vault-relative paths. */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Extracts inline markdown link destinations from a document, in order.
 *
 * @param text - Raw markdown of one TOC file
 * @returns Links with destinations decoded/normalized into {@link TocLink#destination},
 * or a {@link TocLink#skip} reason when the link can never name a chain note
 *
 * @remarks
 * Supported destination forms (all adversarially profiled in PAL-205 §8c):
 * `[label](path)`, `[label](<angle bracket path>)`, `[label](path "title")`,
 * trailing `/`, `%XX` escapes, `#anchor` suffixes. Images (`![alt](…)`),
 * reference-style tails, bare `#fragment` links, `http(s):`/`mailto:` targets
 * and malformed `%` escapes are skipped, never aborted on — a bad link must
 * only cost its own edge (under-chaining is the safe direction).
 *
 * Fenced code is blanked before scanning. A README documenting how to write a
 * link — `` `[setup](notes/install.md)` `` inside an example — is not
 * enumerating anything, and a note that happens to exist would otherwise enter
 * the chain and collect a persisted prerequisite from documentation.
 */
export function extractTocLinks(text: string): TocLink[] {
  const scanned = stripFencedCodeBlocks(text);
  const links: TocLink[] = [];
  let i = 0;
  while (i < scanned.length) {
    const open = scanned.indexOf('[', i);
    if (open < 0) break;
    // An image's label is not a link.
    if (open > 0 && scanned[open - 1] === '!') {
      i = open + 1;
      continue;
    }
    // `findLabelEnd` walks to end-of-text when a label never closes, and the
    // loop re-entered it for every remaining `[` — quadratic on a README of
    // stray brackets. If no `]` exists at or after `open`, none exists for any
    // later `[` either, so nothing past here can form a label.
    if (scanned.indexOf(']', open) < 0) break;
    const close = findLabelEnd(scanned, open);
    if (close < 0) {
      i = open + 1;
      continue;
    }
    if (scanned[close + 1] !== '(') {
      // Reference-style `[label][id]` or stray bracket — not an inline link.
      i = close + 1;
      continue;
    }
    // Same bail for the destination: `readDestination` scans forward until the
    // `(` balances, so one unclosed `(` made every later link pay for a full
    // text scan.
    if (scanned.indexOf(')', close + 2) < 0) break;
    const dest = readDestination(scanned, close + 2);
    if (!dest) {
      i = close + 2;
      continue;
    }
    links.push(normalizeTocLink(dest.raw));
    i = dest.next;
  }
  return links;
}

/** Finds the `]` closing a `[` label, tolerating one level of nested brackets. */
function findLabelEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface RawDestination {
  /** Destination text without its delimiters */
  raw: string;
  /** Index to resume scanning after the closing `)` */
  next: number;
}

/**
 * Reads a `(...)` destination: angle-bracket form or bare form up to the
 * matching `)`.
 *
 * @remarks
 * A bare destination may contain **balanced** parentheses — CommonMark allows
 * `[lesson](notes/intro(v2).md)` — so the scan tracks depth and only ends the
 * destination on the `)` that closes the one that opened it. Stopping at the
 * first `)` truncated that path to `notes/intro(v2`, which then resolved as a
 * missing note (or, worse, onto an unrelated note with the truncated name) and
 * silently lost the author's ordering edge.
 */
function readDestination(text: string, start: number): RawDestination | null {
  if (start >= text.length) return null;
  if (text[start] === '<') {
    let out = '';
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length && (text[i + 1] === '>' || text[i + 1] === '\\')) {
        out += text[i + 1];
        i++;
        continue;
      }
      if (ch === '>') {
        const close = text.indexOf(')', i + 1);
        if (close < 0) return null;
        return { raw: out, next: close + 1 };
      }
      out += ch;
    }
    return null;
  }
  let out = '';
  let depth = 0;
  /** Once whitespace is seen the destination is closed; the rest is a `"title"`. */
  let inTitle = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      // CommonMark allows `\)` and friends; keep the escaped char literal.
      if (!inTitle) out += text[i + 1];
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      if (!inTitle) out += ch;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) {
        depth--;
        if (!inTitle) out += ch;
        continue;
      }
      return { raw: out, next: i + 1 };
    }
    if (!inTitle && /\s/.test(ch)) {
      // Optional `"title"` follows whitespace; keep scanning for the paren that
      // actually closes the link, since a title may carry balanced parens.
      inTitle = true;
      continue;
    }
    if (!inTitle) out += ch;
  }
  return null;
}

/** Decodes + anchor-strips one raw destination into a chainable target, or a skip reason. */
function normalizeTocLink(raw: string): TocLink {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { raw, destination: null, skip: 'empty' };
  }
  if (trimmed.startsWith('#')) {
    return { raw, destination: null, skip: 'self-anchor' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Malformed `%` escape: fail closed on this link only. Note the decode
    // runs BEFORE any filesystem matching and there is no raw-form fallback,
    // so a link can never resolve a file whose name literally contains `%XX`.
    return { raw, destination: null, skip: 'malformed' };
  }
  if (URI_SCHEME.test(decoded)) {
    return { raw, destination: null, skip: 'external' };
  }
  const hash = decoded.indexOf('#');
  const destination = hash >= 0 ? decoded.slice(0, hash) : decoded;
  if (destination.trim().length === 0) {
    return { raw, destination: null, skip: 'empty' };
  }
  return { raw, destination: destination.trim() };
}

/** Result of folding one destination against the TOC file's directory. */
export interface TocTargetCandidate {
  /** Vault-relative POSIX path (`01-x/README.md`); `''` when the link escaped the root */
  relativePath: string;
  /** True when the fold walked above the vault root — storage must reject it */
  escapedRoot: boolean;
}

/**
 * Folds one link destination into a vault-relative candidate path.
 *
 * @param destination - Post-decode, anchor-stripped destination from {@link extractTocLinks}
 * @param tocDir - Vault-relative POSIX directory of the TOC file itself (`''` for root)
 * @returns The lexical candidate plus the escape flag; extension/folder rules
 * applied (trailing `/` → `<dir>/README.md`, extension-less → append `.md`)
 *
 * @remarks
 * Backslashes are never treated as separators (they stay literal characters
 * of one segment). A leading `/` anchors at the vault root; anything else is
 * relative to {@link tocDir}. The `..` fold is lexical — the authoritative
 * containment guard remains `isWithinVault` in the storage layer, run on
 * canonical paths; {@link TocTargetCandidate#escapedRoot} is the early signal.
 */
export function foldTocDestination(destination: string, tocDir: string): TocTargetCandidate {
  const segments: string[] = [];
  const absolute = destination.startsWith('/');
  const source = absolute ? destination.slice(1) : `${tocDir}/${destination}`;
  for (const segment of source.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
      else {
        return { relativePath: '', escapedRoot: true };
      }
      continue;
    }
    segments.push(segment);
  }
  let last = segments[segments.length - 1] ?? '';
  if (destination.endsWith('/')) {
    // Folder link → its README. Trailing slash dedupes with an explicit
    // README.md link naturally via first-appearance dedup downstream.
    segments[segments.length - 1] = `${last}/README.md`;
  } else if (last.length > 0 && !last.toLowerCase().endsWith('.md')) {
    // No extension at all → a note path (Obsidian/GitHub both allow it).
    // An extension that merely isn't `.md` (`.pdf`, `.png`) is left alone so
    // the storage visibility check rejects it rather than inventing `x.pdf.md`.
    if (!last.includes('.')) {
      segments[segments.length - 1] = `${last}.md`;
    }
  }
  return { relativePath: segments.join('/'), escapedRoot: false };
}

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
    const pred = predecessorOf.get(orderedPaths[i]) ?? null;
    if (pred === null) continue;
    const predIndex = index.get(pred);
    if (predIndex === undefined || predIndex >= i) {
      throw new Error(
        `toc-chain invariant violated: ${orderedPaths[i]} gates on ${pred} which is not strictly earlier in the chain`
      );
    }
  }
}

/**
 * Throws when following {@link predecessorOf} pointers reaches any node twice.
 *
 * @remarks
 * The graph-level companion of {@link assertBackwardEdges} for merged plans:
 * composition can legitimately interleave tiers (a numbered note may gate on a
 * TOC-ordered note), so list position no longer proves acyclicity — this walk
 * does. Each node has at most one predecessor, so a three-color iterative walk
 * is linear and cannot miss a loop.
 */
export function assertAcyclicPlan(predecessorOf: Map<string, string | null>): void {
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
  const stem = basename.toLowerCase().endsWith('.md') ? basename.slice(0, -3).toLowerCase() : '';
  if (stem === 'readme' || stem === 'summary') return { rank: 0, n: -1, phase: -1 };
  const prefix = parseNumericPrefix(basename);
  if (prefix !== null) return { rank: 1, n: prefix.n, phase: -1 };
  for (let i = 0; i < TOC_PHASE_PREFIXES.length; i++) {
    if (hasKeywordPrefix(stem, TOC_PHASE_PREFIXES[i])) return { rank: 2, n: -1, phase: i };
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

  const dirFirstSeen = new Map<string, number>();
  normalized.forEach((p, i) => {
    const dir = parentOf(p);
    if (!dirFirstSeen.has(dir)) dirFirstSeen.set(dir, i);
  });

  // The grouping key above and the lookup key below must be produced by the
  // same expression, or a directory present in the plan is missing from
  // `dirFirstSeen` and the comparison sorts against `undefined` — which the `!`
  // assertions cannot catch and which silently reorders the whole tier. Asserted
  // rather than trusted, in the manner of `assertBackwardEdges`.
  for (const p of normalized) {
    const dir = parentOf(p);
    if (!dirFirstSeen.has(dir)) {
      throw new Error(`toc-chain invariant violated: no first-seen rank for directory "${dir}"`);
    }
  }

  const orderedPaths = [...normalized].sort((a, b) => {
    const da = dirFirstSeen.get(parentOf(a))!;
    const db = dirFirstSeen.get(parentOf(b))!;
    if (da !== db) return da - db;
    const ra = tocLessonRank(baseOf(a));
    const rb = tocLessonRank(baseOf(b));
    if (ra.rank !== rb.rank) return ra.rank - rb.rank;
    if (ra.rank === 1 && ra.n !== rb.n) return ra.n - rb.n;
    if (ra.rank === 2 && ra.phase !== rb.phase) return ra.phase - rb.phase;
    if (ra.rank === 4 || ra.rank === 2 || ra.rank === 3) {
      // Same intent class: the author's own document order is the tiebreak —
      // alphabetical would be exactly the arbitrary chaining this ticket was
      // opened to remove.
      return docIndex.get(a)! - docIndex.get(b)!;
    }
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
    if (parseNumericPrefix(segments[i]) !== null) return true;
  }
  return parseNumericPrefix(segments[segments.length - 1]) !== null;
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
  for (const p of numbered.orderedPaths) {
    if (isInNumberedTree(p)) numberedSet.add(p);
    if (numbered.predecessorOf.get(p)) sourceOf.set(p, 'numbered');
  }
  const numberedEdgeCount = sourceOf.size;
  const orderedPaths = [...numbered.orderedPaths];

  const hasNumberedLayout = numberedSet.size > 0;

  if (tier === 'strict') {
    return {
      ...numbered,
      orderedPaths,
      predecessorOf,
      sourceOf,
      numberedEdgeCount,
      tocEdgeCount: 0,
      hasNumberedLayout,
      hasTocLayout: false,
    };
  }

  const candidates: string[] = [];
  for (const raw of tocPaths) {
    const p = raw.replace(/\\/g, '/');
    if (numberedSet.has(p)) continue;
    if (!tocChainable(p)) continue;
    candidates.push(p);
  }

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
  // fallback edge removes that note from the numbered count.
  let numberedEdges = 0;
  for (const source of sourceOf.values()) {
    if (source === 'numbered') numberedEdges++;
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
    hasNumberedLayout,
    hasTocLayout: tocEdges > 0,
  };
}

/**
 * Parses the `--chain-tier` value.
 *
 * @param raw - The string Commander captured, or `true` for a bare
 * `--auto-chain` (which means `full`)
 * @returns The tier, or `null` for anything outside `strict|toc|full` (the CLI
 * turns `null` into a usage error — never a silent default)
 */
export function parseAutoChainTier(raw: unknown): AutoChainTier | null {
  if (raw === undefined || raw === false) return null;
  if (raw === true) return 'full';
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'strict' || value === 'toc' || value === 'full' ? value : null;
}
