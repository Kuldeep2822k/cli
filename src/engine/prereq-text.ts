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
 * An item under such a heading is the next class along, and the one #232 left
 * unexamined while it was closing negation holes in the prose branch: there a
 * link carries the reference, and the words around it only qualify it.
 * Qualification decides whether the item is still a statement the author stands
 * behind. A negation (`does not require [[x]]`) denies the very gate it names; a
 * disjunction (`requires [[x]] or [[y]]`) offers a choice that
 * `areDependenciesSatisfied`, which knows only AND, cannot honour either way;
 * and a reversal (`this note is a prerequisite for [[x]]`) states something true
 * about the other direction, which this section does not author. So the section
 * filter is a filter, not a parser: a hedged item contributes nothing and an
 * unambiguous one still authors its gating edge, exactly as before. The cost is
 * a real-but-hedged prerequisite — one edge lost, the numbered tree's still in
 * place, which is the direction this module chooses everywhere else.
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
 * An HTML comment. Blanked whole, across lines, like a fenced block: nothing
 * between `<!--` and `-->` is a statement the reader is meant to act on.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * A single-line inline code span, run of one or two backticks on each side.
 *
 * @remarks
 * Deliberately line-local. A code span may legally cross lines, and matching
 * one that does would let a single unpaired backtick blank the rest of the note
 * and silently drop every real declaration after it. A span left unmatched is
 * the rare case and costs its own edge; a blank that over-reaches costs the
 * document.
 */
const INLINE_CODE = /``[^`\n]*``|`[^`\n]*`/g;

/** Blank a span, keeping the newlines it held so line scans stay aligned. */
function blankKeepingLines(span: string): string {
  return span.replace(/[^\n]/g, ' ');
}

/**
 * Why an item under a prerequisites heading was refused.
 *
 * @remarks
 * Kept distinct because the three are different claims about the link, and a
 * report that called a reversal a negation would teach the next reader the
 * wrong rule: the reversal is true, just pointed the other way.
 */
export type DeclaredPrereqCue = 'negation' | 'reversal' | 'disjunction';

/**
 * A verbal negation: `not`, `n't`, `no longer`, `never`, `cannot`, `neither`,
 * `nor`, `without`. Reused verbatim from the screen #232 grew for its prose
 * branch, and retired with that branch when sentences stopped being an edge
 * source. The wording is what matters: two ideas of what a negation reads like
 * is how one of them gets fixed and the other keeps gating.
 */
const VERBAL_NEGATION = /\b(?:no\s+longer|not|never|cannot|neither|nor|without)\b|n['’]t\b/i;

/** A negative subject opening the item: `No lesson`, `Nothing`, `Neither`. */
const NEGATIVE_SUBJECT = /^(?:none|nobody|nothing|neither|no\s+one|no)\b/i;

/**
 * The author offered a choice rather than a requirement. `and/or` arrives free,
 * because the word boundary in front of `or` is satisfied by the slash.
 */
const DISJUNCTION_CUE = /\b(?:either|or)\b/i;

/**
 * The link is the dependent, not the prerequisite: `a prerequisite for X`,
 * `required by X`, `X requires this note`, `X depends on this lesson`.
 *
 * @remarks
 * Deliberately a short list, and the phrasings #261 reported. An unrecognised
 * way of saying the same thing still gates, which is the direction a section
 * filter should fail in: a hedge the engine cannot see is indistinguishable
 * from a statement, and inventing a reverse edge to fix it is a bigger claim
 * than this module makes about any sentence.
 */
const REVERSAL_CUE =
  /\b(?:prerequisites?|requirements?|required|requiring)\s+for\b|\brequired\s+by\b|\b(?:requires?|needs?)\s+(?:this|these|the\s+current)\b|\bdepend\w*\s+(?:up)?on\s+(?:this|these|the\s+current)\b/i;

/**
 * A link and its delimiters, as written: wikilink (with `!` embed), markdown
 * link, or a bare label.
 */
const LINK_SPAN = /!?\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\)|\[[^\]]*\]/g;

/**
 * The qualifier that disqualifies a prerequisite item.
 *
 * @param content - One item's content as the section scan sees it: the text
 * after the list marker, with fenced code, comments and inline code already
 * blanked
 * @returns The cue that fired, in the order negation, reversal, disjunction, or
 * `null` when the item reads as an unambiguous declaration
 *
 * @remarks
 * The window is the item, and the item's prose only.
 *
 * Item-level because each bullet is its own declaration: a section that lists
 * `[[a]]`, `does not require [[b]]`, `[[c]]` gates on `a` and `c` and reads
 * nothing from `b`. Line-level would be the same thing here — one item per
 * line is what the scan reads — but the rule is about the declaration, not the
 * newline. Section-level would let one hedge disarm a whole list.
 *
 * Prose only because the reference is the author's chosen name, and names say
 * things: `[[m/01-or-basics]]` and `[[x|either of the two]]` are not the author
 * hedging, so {@link LINK_SPAN} is blanked before the cue is looked for. A cue
 * that survives that blanking qualifies the whole item, and an item with two
 * links and one `or` between them loses both rather than guessing which half
 * the author meant.
 *
 * No clause analysis, on purpose. `does not need a calculator, but requires
 * [[a]]` is one item holding both a denial and a requirement, and #232's answer
 * was a rule-chain — aside removal, clause boundaries, a subject test — that
 * measured zero edges over 11,168 notes and still had a documented hole. Here
 * the chain would only ever decide whether to keep one gate a link already
 * justifies, so the simpler reading stands: a hedge anywhere in the item is a
 * statement the engine does not lock a learner out on.
 */
export function declaredPrereqCue(content: string): DeclaredPrereqCue | null {
  const prose = content.replace(LINK_SPAN, ' ').trim();
  if (prose.length === 0) return null;
  if (VERBAL_NEGATION.test(prose) || NEGATIVE_SUBJECT.test(prose)) return 'negation';
  if (REVERSAL_CUE.test(prose)) return 'reversal';
  if (DISJUNCTION_CUE.test(prose)) return 'disjunction';
  return null;
}

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
 * declares nothing. HTML comments and inline code spans are blanked the same
 * way: `<!-- [[setup]] -->` and `` `[[setup]]` `` are written to be read, not
 * followed. Escaped wikilinks are skipped by {@link extractWikilinks}
 * and images and reference-style links by {@link extractTocLinks}, for the same
 * reason: a link written to be read is not a link written to be followed.
 *
 * Task items are dropped too. An unchecked `- [ ] [[todo]]` is a to-do the
 * author has not committed to, and reading one invents a gate.
 *
 * An item carrying a qualifier {@link declaredPrereqCue} recognises — a
 * negation, a reversal, a disjunction — is dropped with its links. The heading
 * makes the section an author statement, but the sentence inside it says the
 * statement does not hold, and `declared` is the label nothing downstream
 * questions.
 */
export function extractDeclaredPrerequisites(text: string): DeclaredPrereqRef[] {
  const scanned = stripFencedCodeBlocks(text)
    .replace(HTML_COMMENT, blankKeepingLines)
    .replace(INLINE_CODE, blankKeepingLines);
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
    if (declaredPrereqCue(content) !== null) continue;
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
