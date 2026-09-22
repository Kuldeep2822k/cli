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
 *    {@link detectCyclesBounded} over the merged graph before committing —
 *    the engine cannot see pre-existing vault cycles.
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
 * Parses a leading numeric prefix from a directory or file basename.
 *
 * @param name - Basename such as `01-foundations` or `02_lab.md`
 * @returns The parsed number and remainder, or `null` when the name does
 * not start with digits
 *
 * @example
 * ```typescript
 * parseNumericPrefix('01-foundations'); // { n: 1, rest: 'foundations' }
 * parseNumericPrefix('lab-01');         // null
 * ```
 */
export function parseNumericPrefix(name: string): NumericPrefix | null {
  const match = /^(\d+)[-_.\s]?(.*)$/.exec(name.trim());
  if (!match) {
    return null;
  }
  const n = parseInt(match[1], 10);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  return { n, rest: match[2] };
}

/** Fixed pedagogical phase order for non-numeric lesson files (#73). */
const PHASE_KEYWORDS = ['deep-dive', 'lab', 'exam'] as const;

interface LessonRank {
  /** 0 = numeric prefix, 1 = phase keyword, 2 = everything else */
  rank: 0 | 1 | 2;
  n: number;
  phase: number;
}

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

function baseNameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function parentDirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) : '.';
}

/** Deterministic dependency plan produced by {@link planAutoChain}. */
export interface ChainPlan {
  /** Relative paths in chain order; the first entry is the chain head */
  orderedPaths: string[];
  /** Map from relative path to its predecessor's relative path (`null` for the chain head) */
  predecessorOf: Map<string, string | null>;
  /**
   * True when some directory lacked a numeric prefix or some file had
   * neither a numeric prefix nor a phase keyword — the CLI warns that those
   * entries fell back to alphabetical order.
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
 * Notes are grouped by immediate parent directory. Directories sort by
 * numeric prefix (unnumbered directories sort after, alphabetically); within
 * each directory notes sort by {@link compareLessonOrder}. Each note's
 * predecessor is the previous note in its group, except the first note of
 * each group (after the first), which bridges to the last note of the
 * previous group — so module N's entry note depends on module N−1's exit
 * note. Acyclic by construction.
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

  let hasUnnumbered = false;
  for (const dir of groups.keys()) {
    if (parseNumericPrefix(baseNameOf(dir)) === null) {
      hasUnnumbered = true;
    }
  }
  for (const p of normalized) {
    if (lessonRank(baseNameOf(p)).rank === 2) {
      hasUnnumbered = true;
    }
  }

  const sortedDirs = [...groups.keys()].sort((a, b) => {
    const pa = parseNumericPrefix(baseNameOf(a));
    const pb = parseNumericPrefix(baseNameOf(b));
    if (pa !== null && pb !== null) {
      if (pa.n !== pb.n) {
        return pa.n - pb.n;
      }
    } else if (pa !== null) {
      return -1;
    } else if (pb !== null) {
      return 1;
    }
    return compareStrings(a, b);
  });

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
