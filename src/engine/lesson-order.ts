/**
 * Lesson Order — Numbered-Tree Ordering Substrate and Base Planner (Issue #73)
 *
 * @remarks
 * Pure, fs-free ordering substrate for the auto-chain engine, extracted from
 * `src/engine/auto-chain.ts` by the P3-14 phase split (#565): numeric-prefix
 * parsing, the lesson-rank comparators, the segment-wise directory order, and
 * {@link planAutoChain} — the deterministic `depends_on` predecessor plan
 * derived from numbered directory/file prefixes (`01-foundations/`,
 * `02-linux/01-processes.md`) and the fixed phase order
 * `deep-dive → lab → exam`. Notes are grouped by immediate parent directory;
 * each group chains internally in lesson order and the entry note of module N
 * bridges to the exit note of module N−1. The plan is acyclic by construction
 * (every note has at most one predecessor and edges always point backward in a
 * total order), but callers still run cycle detection
 * (`src/engine/dependency.ts`) over the merged graph before committing — the
 * engine cannot see pre-existing vault cycles.
 *
 * The Tier-0 hygiene planner in `./auto-chain` builds on this substrate and
 * imports a handful of its internals (`compareStrings`, `baseNameOf`,
 * `parentDirOf`, `dirSortKey`, `PHASE_KEYWORDS`); those are shared plumbing,
 * not public surface.
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
  // The regex's digit group is always filled on a match; the guard keeps the
  // type honest rather than asserting it.
  const digits = match[1];
  if (digits === undefined) {
    return null;
  }
  const n = parseInt(digits, 10);
  // No range guard: NUMERIC_PREFIX caps the digit run at 3, so `n` is always
  // 0..999 and `parseInt` of it can never be anything but a safe integer.
  return { n, rest: match[2] ?? '' };
}

/** Fixed pedagogical phase order for non-numeric lesson files (#73). Shared with the hygiene planner in `./auto-chain`. */
export const PHASE_KEYWORDS = ['deep-dive', 'lab', 'exam'] as const;

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
 * case-sensitive, so equal-folded names still sort stably. Shared with the
 * hygiene planner in `./auto-chain`.
 */
export function compareStrings(a: string, b: string): number {
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
 * Basename of a `/`-separated path, split on `/` only. Shared with the hygiene
 * planner in `./auto-chain`.
 *
 * Kept instead of `path.basename`: this module is the fs-free engine layer
 * (`agent.md`), and `path.basename` on Windows also splits on `\` and strips a
 * trailing separator, so it is not a provably identical substitution.
 */
export function baseNameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** Parent directory of a `/`-separated path; the root group is the `'.'` sentinel. Shared with the hygiene planner in `./auto-chain`. */
export function parentDirOf(p: string): string {
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

/** Splits a directory into per-segment sort keys; the `'.'` root yields one unnumbered key. Shared with the hygiene planner in `./auto-chain`. */
export function dirSortKey(dir: string): DirSegmentKey[] {
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
    // `i` is below both key lengths by construction; the guards keep the type
    // honest rather than asserting it.
    const sa = ka[i];
    const sb = kb[i];
    if (sa === undefined || sb === undefined) {
      continue;
    }
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
   * The directory half of {@link ChainPlan.hasUnnumbered} on its own: true when two
   * directories differed at some segment level and at least one of them carries
   * no numeric prefix there, so the order between whole modules came from their
   * names. The vault-root group never contributes — its position is the hygiene
   * planner's deliberate hoist, not an alphabetical choice. Split out because
   * the flag's other half is about *files*, which the hygiene plan reports as a
   * concrete path list.
   */
  directoryOrderAlphabetical: boolean;
}

/**
 * Whether the order between a set of note paths was decided by directory names.
 *
 * @param relativePaths - Vault-relative note paths (POSIX or Windows separators)
 * @returns True when the first segment at which some pair of directories
 * differs is carried by at least one of them without a numeric prefix
 *
 * @remarks
 * Two rules, both inherited from what {@link compareDirs} actually does:
 *
 * - **The vault-root group is excluded.** A note sitting at the root has no
 *   sibling directory to be ordered against by name: `planAutoChainWithHygiene`
 *   hoists the root group to the front on purpose (the owner-ruled README
 *   bridge, PAL-205-G2), so its position is structural. Counting the `'.'`
 *   sentinel made this report true for every vault with a root note *and* any
 *   directory — which is nearly all of them.
 * - **Only the first differing segment of a pair counts.** Once two directories
 *   disagree at some level, `compareDirs` has already chosen between them, so a
 *   deeper level cannot have decided anything: `01-a/deep-dive` beside
 *   `02-b/lab` is ordered by `01`/`02`, and the unnumbered `deep-dive`/`lab`
 *   pair beneath them is not a fallback the author never relied on. A level
 *   scan over all groups conflates those cases, which is why the comparison
 *   walks down shared prefixes instead.
 *
 * Exported because the TOC tier re-asks the question over the notes its
 * enumeration did not order, and both callers must use one implementation.
 */
export function directoriesOrderedAlphabetically(relativePaths: string[]): boolean {
  const dirs = new Set<string>();
  for (const raw of relativePaths) {
    const dir = parentDirOf(raw.replace(/\\/g, '/'));
    if (dir !== '.') {
      dirs.add(dir);
    }
  }
  return orderedBySegmentName([...dirs].map((dir) => dir.split('/')));
}

/**
 * Walks one directory level for a set of groups that share every deeper prefix.
 *
 * @param segments - Each group's remaining path segments, all under the same
 * parent by construction, so a difference here really is a choice between siblings
 * @returns Whether any sibling pair at this level was ordered by name
 */
function orderedBySegmentName(segments: string[][]): boolean {
  if (segments.length < 2) {
    return false;
  }
  const byName = new Map<string, string[][]>();
  for (const rest of segments) {
    // Segments are non-empty by construction (`split('/')` never yields `[]`
    // and recursion filters `rest.length > 0`); the guard keeps the type
    // honest rather than asserting it.
    const head = rest[0];
    if (head === undefined) {
      continue;
    }
    const list = byName.get(head);
    if (list) {
      list.push(rest.slice(1));
    } else {
      byName.set(head, [rest.slice(1)]);
    }
  }
  const names = [...byName.keys()];
  if (names.length >= 2) {
    // Distinct siblings at this level settle their own order here: by number
    // when both carry one, by name otherwise. That says nothing about the pairs
    // this level never separated, and those still get decided one level down —
    // `01-a/01-x.md, 02-b/deep-dive/y.md, 02-b/lab/z.md` has a numbered split at
    // the top and an alphabetical one inside `02-b`, which the single-group
    // equivalent below already reports as true.
    if (names.some((name) => parseNumericPrefix(name) === null)) {
      return true;
    }
    return [...byName.values()].some((group) =>
      orderedBySegmentName(group.filter((rest) => rest.length > 0))
    );
  }
  // Nothing was decided here; the only siblings share this prefix, so the
  // choice — if any — happens one level down. `byName` holds at least one key
  // (built from two or more segments), so a first name exists here.
  const firstName = names[0];
  if (firstName === undefined) {
    return false;
  }
  return orderedBySegmentName((byName.get(firstName) ?? []).filter((rest) => rest.length > 0));
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
  // segment can have caused a fallback (see
  // {@link directoriesOrderedAlphabetically}). Reuses the same predicate the TOC
  // tier calls so the two can never disagree about what the flag means.
  const directoryOrderAlphabetical = directoriesOrderedAlphabetically(normalized);
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
