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
  let hasUnnumbered = false;
  for (let level = 0; level < maxDepth && !hasUnnumbered; level++) {
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
        hasUnnumbered = true;
        break;
      }
    }
  }
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

  return { orderedPaths, predecessorOf, hasUnnumbered };
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
 * @returns Parsed links; malformed or nested `[[` sequences are skipped
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
