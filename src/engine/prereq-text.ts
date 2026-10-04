import { extractWikilinks, stripFencedCodeBlocks } from './auto-chain';
import { extractTocLinks } from './toc-chain';

/**
 * Reads a note's own `## Prerequisites` section for the links it names.
 *
 * A lesson that writes `## Prerequisites` and links its predecessors is making
 * an author statement — the same class as a hand-written `depends_on`, and
 * unlike an order inferred from where a file happens to sit in a listing.
 * Edges from here therefore gate.
 *
 * Sentences are a different class, and this module deliberately does not read
 * them. An earlier revision scanned prose for `requires X` phrases; measured
 * over 11,168 notes in two Azure curricula, every edge the feature produced came
 * from a link, and the prose branch produced none — while supplying the whole
 * defect list: "requires patience and practice", "requires more complex
 * implementation", and a run of negations ("does not require X", "no longer
 * requires X") that each needed clause analysis to reject. A sentence cannot be
 * told apart from a description of what a lesson involves, and a wrong guess
 * here hides a note from `palee plan` permanently, because mastery only falls
 * and a gate never lifts itself. A prerequisite worth gating on is a link.
 *
 * fs-free by design: extraction turns text into candidate names and
 * {@link resolveDeclaredPrerequisites} turns names into targets through a
 * caller-supplied lookup, so nothing here knows what a vault is.
 */

/** One prerequisite reference found in a note's own text, before resolution. */
export interface DeclaredPrereqRef {
  /**
   * Reference exactly as written: a wikilink target or a markdown link
   * destination. Never reduced to a basename — the directory a link carries is
   * the part that makes it unique.
   */
  name: string;
  /**
   * Which form carried it, because each has a different resolution rule: a
   * wikilink names a vault path or a note name, a markdown link is relative to
   * the note holding it.
   */
  form: 'wikilink' | 'mdlink';
}

/** Why a candidate did not become an edge. */
export type DeclaredPrereqSkip = 'missing' | 'ambiguous';

/** Outcome of resolving a note's declared references against an index. */
export interface DeclaredPrereqResolution<T> {
  /** Unique hits, in the order the note wrote them */
  resolved: { name: string; target: T }[];
  /** Candidates that named no single target, counted so a report can say so */
  skipped: { name: string; reason: DeclaredPrereqSkip }[];
}

/**
 * Headings that introduce a note's own prerequisites. Deliberately narrow: the
 * heading must consist of the trigger phrase and nothing else, so
 * `## Prerequisites for the lab` does not turn an arbitrary section into a
 * dependency list.
 */
const PREREQ_HEADING =
  /^\s{0,3}#{1,6}\s+(?:prior\s+)?(?:prerequisites?|requires?|required\s+knowledge|(?:depends?|dependen(?:t|cy))\s+on)s?\s*:?\s*$/i;

/** Any ATX heading closes a prerequisites section. */
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;

/** A bullet or numbered list item's content. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

/**
 * A task-list item (`- [ ]`, `1. [x]`). Skipped whole rather than stripped to
 * its content: a checkbox is an unfinished intention, and importing one hands a
 * gating edge to a note the author had not actually written.
 */
const TASK_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/;

/**
 * Extracts the prerequisites a note declares about itself.
 *
 * @param text - Note text (a frontmatter block in it is harmless)
 * @returns Candidates in written order, deduplicated case-insensitively. Empty
 * means the note declares nothing, which is the common case.
 *
 * @remarks
 * A declaration is a heading matching {@link PREREQ_HEADING} collecting links
 * from its lines until the next heading of any level. Text under such a heading
 * that is not a link names nothing: `- Setup` is read for its `[[Setup]]` or its
 * `(setup.md)`, and a bare word is not a reference the engine can resolve
 * without guessing.
 *
 * Fenced code is blanked first, so a `## Prerequisites` block inside a
 * documentation example — exactly how a course teaches its own template —
 * declares nothing. Escaped wikilinks are skipped by {@link extractWikilinks}
 * and images and reference-style links by {@link extractTocLinks}, for the same
 * reason: a link written to be read is not a link written to be followed.
 *
 * Task items are dropped too. An unchecked `- [ ] [[todo]]` is a to-do the
 * author has not committed to, and reading one invents a gate.
 */
export function extractDeclaredPrerequisites(text: string): DeclaredPrereqRef[] {
  const scanned = stripFencedCodeBlocks(text);
  const lines = scanned.split(/\r?\n/);
  const refs: DeclaredPrereqRef[] = [];
  const seen = new Set<string>();
  const push = (name: string, form: DeclaredPrereqRef['form']): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const key = `${form}:${trimmed.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ name: trimmed, form });
  };

  let inSection = false;
  for (const line of lines) {
    if (ANY_HEADING.test(line)) {
      inSection = PREREQ_HEADING.test(line);
      continue;
    }
    if (!inSection) continue;
    if (TASK_ITEM.test(line)) continue;
    const item = LIST_ITEM.exec(line);
    const content = (item ? item[1] : line).trim();
    if (content.length === 0) continue;
    for (const link of extractWikilinks(content)) {
      push(link.target, 'wikilink');
    }
    for (const link of extractTocLinks(content)) {
      if (link.destination !== null) push(link.destination, 'mdlink');
    }
  }

  return refs;
}

/**
 * Resolves declared references to targets through a caller-owned lookup.
 *
 * @param refs - Candidates from {@link extractDeclaredPrerequisites}
 * @param lookup - Every target a reference could mean, possibly none. What a
 * reference means is the caller's business, and the whole {@link DeclaredPrereqRef}
 * is handed over because a link resolves against the note holding it while a
 * bare name resolves against an index — a name alone cannot tell those apart.
 * @returns Unique hits and the counted misses
 *
 * @remarks
 * Fail-closed and never fatal, matching the TOC tier's discipline: a name
 * naming nothing is `missing`, a name naming several is `ambiguous`, and either
 * costs its own edge and nothing else. Several lookup hits that are the same
 * target are not ambiguous — a basename index can report one note twice.
 */
export function resolveDeclaredPrerequisites<T>(
  refs: DeclaredPrereqRef[],
  lookup: (ref: DeclaredPrereqRef) => readonly T[]
): DeclaredPrereqResolution<T> {
  const resolved: { name: string; target: T }[] = [];
  const skipped: { name: string; reason: DeclaredPrereqSkip }[] = [];
  const taken = new Set<T>();

  for (const ref of refs) {
    const matches: T[] = [];
    for (const candidate of lookup(ref)) {
      if (!matches.includes(candidate)) matches.push(candidate);
    }
    if (matches.length === 0) {
      skipped.push({ name: ref.name, reason: 'missing' });
      continue;
    }
    if (matches.length > 1) {
      skipped.push({ name: ref.name, reason: 'ambiguous' });
      continue;
    }
    if (taken.has(matches[0])) continue;
    taken.add(matches[0]);
    resolved.push({ name: ref.name, target: matches[0] });
  }

  return { resolved, skipped };
}
