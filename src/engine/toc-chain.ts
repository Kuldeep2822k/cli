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
import { parseNumericPrefix, type HygieneChainPlan } from './auto-chain';

/** Accepted values of `--auto-chain=<tier>` (default `full`). */
export type AutoChainTier = 'strict' | 'toc' | 'full';

/** Which tier authored a note's `depends_on` (persisted as `depends_on_source`). */
export type DependsOnSource = 'numbered' | 'toc';

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
 */
export function extractTocLinks(text: string): TocLink[] {
  const links: TocLink[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open < 0) break;
    // An image's label is not a link.
    if (open > 0 && text[open - 1] === '!') {
      i = open + 1;
      continue;
    }
    const close = findLabelEnd(text, open);
    if (close < 0) {
      i = open + 1;
      continue;
    }
    if (text[close + 1] !== '(') {
      // Reference-style `[label][id]` or stray bracket — not an inline link.
      i = close + 1;
      continue;
    }
    const dest = readDestination(text, close + 2);
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

/** Reads a `(...)` destination: angle-bracket form or bare form up to whitespace/`)`. */
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
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      // CommonMark allows `\)` and friends; keep the escaped char literal.
      out += text[i + 1];
      i++;
      continue;
    }
    if (ch === ')') return { raw: out, next: i + 1 };
    if (/\s/.test(ch)) {
      // Optional `"title"` follows whitespace; consume to the closing paren.
      const close = text.indexOf(')', i);
      if (close < 0) return null;
      return { raw: out, next: close + 1 };
    }
    out += ch;
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

type TocLessonRank = { rank: 0 | 1 | 2 | 3 | 4; n: number };

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
 * 2 → any other doc 3 (keeps document order) → assignment/quiz/solution 4,
 * LAST so homework never gates the docs that follow it — in the TOC run as
 * well as the numbered backbone.
 */
function tocLessonRank(basename: string): TocLessonRank {
  const stem = basename.toLowerCase().endsWith('.md') ? basename.slice(0, -3).toLowerCase() : '';
  if (stem === 'readme' || stem === 'summary') return { rank: 0, n: -1 };
  const prefix = parseNumericPrefix(basename);
  if (prefix !== null) return { rank: 1, n: prefix.n };
  if (TOC_PHASE_PREFIXES.some((kw) => hasKeywordPrefix(stem, kw))) return { rank: 2, n: -1 };
  if (TOC_ASSIGNMENT_PREFIXES.some((kw) => hasKeywordPrefix(stem, kw))) return { rank: 4, n: -1 };
  return { rank: 3, n: -1 };
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
  const dirFirstSeen = new Map<string, number>();
  normalized.forEach((p, i) => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (!dirFirstSeen.has(dir)) dirFirstSeen.set(dir, i);
  });

  const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p: string): string => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

  const orderedPaths = [...normalized].sort((a, b) => {
    const da = dirFirstSeen.get(parentOf(a))!;
    const db = dirFirstSeen.get(parentOf(b))!;
    if (da !== db) return da - db;
    const ra = tocLessonRank(baseOf(a));
    const rb = tocLessonRank(baseOf(b));
    if (ra.rank !== rb.rank) return ra.rank - rb.rank;
    if (ra.rank === 1 && ra.n !== rb.n) return ra.n - rb.n;
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
 *   *replace* whatever the alphabetical fallback would have assigned them —
 *   that replacement, not addition, is where the measured false edges die;
 * - `orderedPaths` keeps the numbered order first, then the TOC chain, so
 *   dry-run/verbose output still reads head-to-tail per tier;
 * - `hasUnnumbered` keeps its original meaning over the numbered plan only.
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
    // cross-dir gating was removed there), so a head keeps its existing
    // edge and its `numbered` label. The one unsafe shape is a kept
    // predecessor that is itself a TOC candidate: the TOC chain then runs
    // from this head through that note, and keeping the edge would close a
    // cycle — there the note opens the chain as intended.
    const keptPred = predecessorOf.get(p) ?? null;
    if (keptPred === null || !tocSet.has(keptPred)) continue;
    predecessorOf.set(p, null);
    sourceOf.delete(p);
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

  return {
    ...numbered,
    orderedPaths: finalOrder,
    predecessorOf,
    sourceOf,
    numberedEdgeCount: numberedEdges,
    tocEdgeCount: tocEdges,
    hasNumberedLayout,
    hasTocLayout: tocEdges > 0,
  };
}

/**
 * Parses the `--auto-chain[=<tier>]` value.
 *
 * @param raw - Commander's value: `true` for a bare flag, or the string given
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
