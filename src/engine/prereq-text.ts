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
 * True when a `requires` object reads as the name of a note.
 *
 * @remarks
 * Two screens, both learned from measuring the extractor over real curricula.
 *
 * A phrase containing any function word is a clause, not a name: "requires
 * patience and practice" and "requires a working knowledge of the material"
 * yield nothing. The cost is real — "Data Structures and Algorithms" is not read
 * from prose either — but a name written in a `## Prerequisites` link is,
 * because a link is unambiguous and a sentence is not.
 *
 * The first word must also begin capitalized. Across 11,168 notes in two Azure
 * curricula every prose candidate that named no note was lower-case prose
 * ("attention", "more complex implementation", "identifying which data must
 * persist versus", "careful condition management"), while the note names in
 * those same sections were capitalized. An uncapitalized object is a description
 * of what the lesson involves, and inventing a gate from one is the failure this
 * screen exists to stop. The miss it costs — "requires knowledge of python" —
 * loses an edge and keeps whatever the numbered tree justified.
 */
function isPlausibleName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length === 0 || words.length > 6) return false;
  if (!/^[A-Z]/.test(words[0] as string)) return false;
  return words.every((word) => {
    const core = word.toLowerCase().replace(/[^a-z]/g, '');
    return core.length > 0 && !FUNCTION_WORDS.has(core);
  });
}

/**
 * A subject standing between a comma-flanked aside and the verb being tested.
 *
 * A negation reaches only as far as the verb of its own clause, and the way to
 * tell an interruption from a new clause is whether the verb arrives with a
 * subject of its own. "does not, and it bears repeating, require" has nothing
 * in front of `require`, so the earlier `not` still governs it; "does not need
 * a calculator, but for the lab, it requires" hands `requires` to `it`, which
 * discharges the `not` on `need` instead.
 *
 * Pronouns and demonstratives only. The cost is a noun subject in that position
 * ("…, but for the lab, this lesson requires") reading as an interruption and
 * dropping a real prerequisite — a lost edge, which falls back to whatever the
 * numbered tree justified.
 */
const CLAUSE_SUBJECT = /\b(?:it|its|he|she|we|you|they|this|these|that|those)\b/i;

/**
 * A parenthetical aside: content set off by paired parentheses, paired dashes,
 * or a single comma-flanked insertion. Removed before clause analysis so a
 * negation reads across the interruption — "does not — strictly speaking —
 * require", "does not, however, require", "does not, and it bears repeating,
 * require" all reduce to "does not require". Comma pairs are consumed
 * left-to-right and only where no subject follows them; a pair that ends in
 * front of a new subject is a clause, not an aside, and is left to split the
 * clause below. A lone boundary comma ("…, but this lesson requires") has no
 * partner and survives for the same reason.
 */
const PAREN_ASIDE = /\([^()\n]*\)/g;
const DASH_ASIDE = /[—–][^—–\n]*[—–]/g;
const COMMA_ASIDE = /,[^,\n]*,/g;

/**
 * A clause boundary: a comma that outlived aside removal, or a conjunction or
 * conjunctive adverb that opens a fresh clause. The clause immediately
 * governing `require` is the segment after the last boundary.
 *
 * `yet`, `as`, `for`, and `nor` are deliberately absent from the bare set:
 * unpunctuated they read far more often as an adverb ("does not yet require")
 * or a preposition ("as it requires") than as a clause break, and a comma in
 * front of a real one ("…, yet this lesson requires") already splits it off.
 */
const CLAUSE_BOUNDARY =
  /(?:,|\b(?:and|but|or|so|unless|because|although|though|whereas|while|however|therefore|nevertheless|nonetheless|since|if|when)\b)/i;

/**
 * A verbal negation on the immediate clause's verb: `not`, `n't`, `never`,
 * `cannot`, `neither`, `nor`, `without`, or `no longer`.
 *
 * `no longer` belongs here rather than with the negative subjects because it
 * negates the verb, not the subject: "this lesson no longer requires Setup"
 * retires a prerequisite the note once had, which is the same denial of a gate.
 */
const VERBAL_NEGATION = /\b(?:no\s+longer|not|never|cannot|neither|nor|without)\b|n['’]t\b/i;

/**
 * A negative subject opening the immediate clause: `No lesson`, `No student in
 * this class`, `None of the lessons`, `Neither`, `Nobody`, `Nothing`.
 */
const NEGATIVE_SUBJECT = /^(?:none|nobody|nothing|neither|no\s+one|no)\b/i;

/**
 * True when the clause leading up to a `requires` match negates it.
 *
 * @remarks
 * Rather than pattern-match whole sentences, this isolates the one clause that
 * governs `require` and asks a local question of it. Two steps:
 *
 * 1. Parenthetical asides — paired parentheses, paired dashes, and comma-flanked
 *    insertions — are removed, so the words that a negation is stretched across
 *    ("does not, under any circumstances, ever require") close back up ("does
 *    not ever require"). A comma pair that leaves a subject in front of the
 *    verb is not an aside and is left alone — see {@link CLAUSE_SUBJECT}.
 * 2. What remains is split on clause boundaries ({@link CLAUSE_BOUNDARY}) and
 *    the last segment — the clause `require` actually sits in — is tested.
 *
 * A prerequisite is negated when that immediate clause is verbally negated
 * ({@link VERBAL_NEGATION}, e.g. "…does not yet require Setup") or opens with a
 * negative subject ({@link NEGATIVE_SUBJECT}, e.g. "No lesson requires Setup").
 *
 * A negation in an earlier clause does not carry: "No calculator is needed, but
 * this lesson requires Matrices" and "This lesson does not need a calculator and
 * requires Setup" both keep the requirement, because the boundary (`but`, `and`)
 * ends the segment the negation lived in before `require` begins.
 *
 * Known hole, and it errs the unsafe way. When an aside is held back by a
 * subject belonging to a *later* insertion — "does not, under any
 * circumstances, when it is hard, require" — the boundary cuts `not` off from
 * the verb and the note reads as declaring a prerequisite the author denied.
 * Walking past that insertion was tried and breaks the case above: to a segment
 * test, "does not need a calculator" and "does not, when it is hard" are the
 * same shape, and only a verb-scope analysis knows that the first negation has
 * already been spent on a verb. Left open rather than traded away.
 */
function negatedBefore(text: string, index: number): boolean {
  const boundaries = [
    text.lastIndexOf('.', index),
    text.lastIndexOf('!', index),
    text.lastIndexOf('?', index),
    text.lastIndexOf(';', index),
    text.lastIndexOf(':', index),
    text.lastIndexOf('\n', index),
  ];
  const sentStart = Math.max(...boundaries);
  const prefix = text.slice(sentStart === -1 ? 0 : sentStart + 1, index);

  // Remove asides so a negation reads across them, then keep only the clause
  // that immediately governs `require`. A comma pair in front of a new subject
  // is held back: it separates clauses, and the removal would let an earlier
  // negation swallow a requirement belonging to the later one.
  const clause = prefix
    .replace(PAREN_ASIDE, ' ')
    .replace(DASH_ASIDE, ' ')
    .replace(COMMA_ASIDE, (aside, offset) =>
      CLAUSE_SUBJECT.test(prefix.slice(offset + aside.length)) ? aside : ' '
    );
  const segments = clause.split(CLAUSE_BOUNDARY);
  const immediateClause = (segments[segments.length - 1] ?? '').trim();

  // 1. Verbal negation on the immediate clause's verb:
  if (VERBAL_NEGATION.test(immediateClause)) {
    return true;
  }

  // 2. Negative subject opening the immediate clause:
  if (NEGATIVE_SUBJECT.test(immediateClause)) {
    return true;
  }

  return false;
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

