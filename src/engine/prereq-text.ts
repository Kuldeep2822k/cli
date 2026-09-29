import { extractWikilinks, stripFencedCodeBlocks } from './auto-chain';
import { extractTocLinks } from './toc-chain';

/**
 * Reads a note's own text for the prerequisites it states about itself.
 *
 * A lesson that writes `## Prerequisites` and names its predecessors, or says
 * "requires knowledge of X" in prose, is making an author statement — the same
 * class as a hand-written `depends_on`, and unlike an order inferred from where
 * a file happens to sit in a listing. Edges from here therefore gate.
 *
 * fs-free by design: extraction turns text into candidate names and
 * {@link resolveDeclaredPrerequisites} turns names into targets through a
 * caller-supplied lookup, so nothing here knows what a vault is.
 */

/** One prerequisite reference found in a note's own text, before resolution. */
export interface DeclaredPrereqRef {
  /**
   * Reference exactly as written: a wikilink target, a markdown link
   * destination, or the object of a `requires` phrase. Never reduced to a
   * basename — the directory a link carries is the part that makes it unique.
   */
  name: string;
  /**
   * Which form carried it, because each has a different resolution rule: a
   * wikilink names a vault path or a note name, a markdown link is relative to
   * the note holding it, and prose names a note the author expects to be found.
   */
  form: 'wikilink' | 'mdlink' | 'prose';
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
  /^\s{0,3}#{1,6}\s+(?:prior\s+)?(?:prerequisites?|requires?|required\s+knowledge|dependen(?:t|cy)\s+on)s?\s*:?\s*$/i;

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
 * `requires X`, `requires knowledge of X`, `requiring a working knowledge of X`.
 * The object stops at sentence punctuation, and {@link isPlausibleName} then
 * rejects the shapes that begin a clause rather than a name.
 */
const REQUIRES_PHRASE =
  /\b(?:requires?|requiring)\s+(?:(?:prior|working|basic|some)\s+)*(?:knowledge\s+of\s+|understanding\s+of\s+|of\s+)?([A-Za-z][^\s.,;:!?)\]]*(?:\s+[A-Za-z0-9][^\s.,;:!?)\]]*){0,5})/gi;

/** Words that mark a phrase as prose rather than the name of a note. */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'but', 'by', 'for', 'from',
  'if', 'in', 'into', 'is', 'it', 'its', 'no', 'not', 'of', 'on', 'or', 'our', 'so',
  'than', 'that', 'the', 'this', 'to', 'we', 'with', 'you', 'your',
]);

/**
 * True when a `requires` object reads as a name rather than the start of a clause.
 *
 * @remarks
 * The screen rejects a phrase containing any function word, so
 * "requires patience and practice" and "requires a working knowledge of the
 * material" yield no candidate while "requires Gradient Descent" does. The cost
 * is a real one: "Data Structures and Algorithms" is not read from prose either.
 * A name written in a `## Prerequisites` link is still read, because a link is an
 * unambiguous statement and a sentence is not — and an unread declaration loses an
 * edge, while an invented one gates a learner behind a note nobody named.
 */
function isPlausibleName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length === 0 || words.length > 6) return false;
  return words.every((word) => {
    const core = word.toLowerCase().replace(/[^a-z]/g, '');
    return core.length > 0 && !FUNCTION_WORDS.has(core);
  });
}

/** A negation anywhere in the clause before `requires` means the note rules the name out. */
const NEGATION = /(?:\b(?:not|no|never|neither|without|nor|skip)\b|n['’]t\b)/i;

/**
 * True when the clause leading up to a `requires` match negates it.
 *
 * @remarks
 * Bounded by the nearest sentence terminator before the verb, so "This lesson
 * does not require Setup" yields nothing while "Requires care. Set up first, as
 * it requires Setup" still reads the second clause. A negated requirement is the
 * worst possible invention: the author stated the note is *not* needed, and a
 * gating edge would lock the learner behind exactly that note.
 */
function negatedBefore(text: string, index: number): boolean {
  const boundaries = [
    text.lastIndexOf('.', index),
    text.lastIndexOf('!', index),
    text.lastIndexOf('?', index),
    text.lastIndexOf('\n', index),
  ];
  const start = Math.max(0, ...boundaries) + 1;
  return NEGATION.test(text.slice(start, index));
}

/**
 * Extracts the prerequisites a note declares about itself.
 *
 * @param text - Note text (a frontmatter block in it is harmless)
 * @returns Candidates in written order, deduplicated case-insensitively. Empty
 * means the note declares nothing, which is the common case.
 *
 * @remarks
 * A section is a heading matching {@link PREREQ_HEADING} collecting links from
 * its list items until the next heading of any level; prose is a `requires …`
 * phrase anywhere in the rest of the text.
 *
 * Fenced code is blanked before either scan, so a `## Prerequisites` block
 * inside a documentation example — exactly how a course teaches its own
 * template — declares nothing. Escaped wikilinks are skipped by
 * {@link extractWikilinks} and images and reference-style links by
 * {@link extractTocLinks}, for the same reason: a link written to be read is
 * not a link written to be followed.
 *
 * Task items are dropped from both scans, not just the section one, and a
 * `requires` phrase preceded by a negation in its own clause is dropped. Both
 * are gate-invention paths: an unchecked `- [ ] requires X` is a to-do the
 * author has not committed to, and "does not require X" says the opposite of a
 * prerequisite.
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

  const prose = lines.map((line) => (TASK_ITEM.test(line) ? '' : line)).join('\n');
  REQUIRES_PHRASE.lastIndex = 0;
  try {
    let match: RegExpExecArray | null;
    while ((match = REQUIRES_PHRASE.exec(prose)) !== null) {
      const candidate = match[1];
      if (candidate === undefined || !isPlausibleName(candidate)) continue;
      if (negatedBefore(prose, match.index)) continue;
      push(candidate, 'prose');
    }
  } finally {
    REQUIRES_PHRASE.lastIndex = 0;
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

