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
  stripUnfollowableMarkup,
  type HygieneChainPlan,
} from './auto-chain';
import type { DependsOnSource } from '../types';

/** Accepted values of `--chain-tier` (default `strict`, set in `src/cli/adopt.ts`). */
export type AutoChainTier = 'strict' | 'toc' | 'full';

/** Which tier authored a note's `depends_on` (persisted as `depends_on_source`). Declared in `src/types.ts`, re-exported here for engine consumers. */
export type { DependsOnSource };

/** A markdown link destination that is intentionally not a chain target. */
export type TocSkipReason =
  | 'external'
  | 'self-anchor'
  | 'malformed'
  | 'empty'
  /** A bare destination carrying an unescaped space: unparseable, never truncated (issue #262) */
  | 'unescaped-space';

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
 * Fenced code, HTML comments and inline code spans are blanked before scanning.
 * A README documenting how to write a link — `` `[setup](notes/install.md)` ``
 * inside an example — is not enumerating anything, and an entry the author
 * commented out of the Contents (`<!-- - [Intro](guide/intro.md) -->`) names a
 * note that really exists, so a destination that only appears inside one of those
 * regions would still enter the chain and collect a persisted prerequisite from
 * documentation. Same rule, one implementation: {@link stripUnfollowableMarkup}.
 */
export function extractTocLinks(text: string): TocLink[] {
  const scanned = stripUnfollowableMarkup(text);
  const links: TocLink[] = [];
  let i = 0;
  /** Built the first time a label fails to close; see {@link BracketBalance}. */
  let balance: BracketBalance | null = null;
  /** Built the first time a destination fails to close; the same table over `(`/`)`. */
  let destBalance: BracketBalance | null = null;
  /**
   * Built the first time an *angle* destination fails to close. Paren depth says
   * nothing about that form, so it gets its own table — see {@link AngleClosers}.
   */
  let angleClosers: AngleClosers | null = null;
  while (i < scanned.length) {
    const open = scanned.indexOf('[', i);
    if (open < 0) break;
    // An image's label is not a link.
    if (open > 0 && scanned[open - 1] === '!') {
      i = open + 1;
      continue;
    }
    if (balance !== null) {
      // Answered from the one balance pass instead of another walk: no closer
      // below this level means no `]` that this label — or any later one — can
      // still reach, so the walk below would only re-read the same text.
      if (labelCannotClose(balance, open)) {
        i = open + 1;
        continue;
      }
    } else {
      // `findLabelEnd` walks to end-of-text when a label never closes, and the
      // loop re-entered it for every remaining `[` — quadratic on a README of
      // stray brackets. If no `]` exists at or after `open`, none exists for any
      // later `[` either, so nothing past here can form a label.
      if (scanned.indexOf(']', open) < 0) break;
    }
    const close = findLabelEnd(scanned, open);
    if (close < 0) {
      // The walk that just failed is the last full one this scan pays for: from
      // here every open `[` is answered from the balance table instead. Without
      // it the bail above only skips one bracket, so a README holding a single
      // stray `]` — which defeats the bail, since a `]` does follow — put every
      // `[` back on the full-walk path. Issue #263 measured that at 64 s for
      // 160 KB of brackets, through the real `deriveTocEnumeration` API, where
      // one such file stalls `adopt --auto-chain` for the whole vault.
      balance ??= buildBracketBalance(scanned, '[', ']');
      i = open + 1;
      continue;
    }
    if (scanned[close + 1] !== '(') {
      // Reference-style `[label][id]` or stray bracket — not an inline link.
      i = close + 1;
      continue;
    }
    // Destination bails, the counterparts of the label pair above. The break
    // handles the document that holds no `)` at all from here on; the table handles
    // the one that holds plenty of them but never one at the depth this link's own
    // `(` left behind.
    const destStart = close + 2;
    if (scanned.indexOf(')', destStart) < 0) break;
    if (scanned[destStart] === '<') {
      // The angle form's own bound: paren depth answers nothing about a destination
      // that closes on `>` plus a plain `)`, so the table above deliberately declines
      // it (issue #287).
      if (angleClosers !== null && angleCannotClose(angleClosers, destStart)) {
        i = destStart;
        continue;
      }
    } else if (destBalance !== null && destinationCannotClose(destBalance, scanned, destStart)) {
      // Answered from the one paren-balance pass instead of another walk, exactly
      // as the label case above.
      i = destStart;
      continue;
    }
    const dest = readDestination(scanned, destStart);
    if (!dest) {
      // The destination counterpart of the label defect: a document whose
      // destinations never balance — `[a](b(c) ` repeated, where every `)` is
      // consumed at depth > 0 so the depth-0 closer the walk is looking for never
      // appears — made every remaining `[` pay one full `readDestination` walk to
      // end-of-text. Measured on this branch: 90 KB 1.4 s, 360 KB 20 s, 720 KB 79 s,
      // and the `TOC_MAX_SOURCE_BYTES` guard only caps one file at ~40 s.
      //
      // Each form builds only its own table. Building the paren one after an angle
      // failure paid two passes for a predicate that returns `false` on that form by
      // construction, and left the angle walk as unbounded as it had been —
      // `'[a](<b'.repeat(10 000) + ')'` still cost 1.7 s until the closer table
      // existed.
      if (scanned[destStart] === '<') angleClosers ??= buildAngleClosers(scanned);
      else destBalance ??= buildBracketBalance(scanned, '(', ')');
      i = destStart;
      continue;
    }
    links.push(dest.skip ? { raw: dest.raw, destination: null, skip: dest.skip } : normalizeTocLink(dest.raw));
    i = dest.next;
  }
  return links;
}

/**
 * Finds the `]` closing a `[` label, tolerating one level of nested brackets.
 *
 * @remarks
 * Returns `-1` only after walking the rest of the text, which is the cost
 * {@link buildBracketBalance} exists to make unnecessary the second time.
 */
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

/**
 * The balance of one delimiter pair, read once, answering "can a scan starting
 * here still find its closer?" in constant time.
 *
 * @remarks
 * Both uses below start their scan at a position that cannot be part of a
 * backslash run — a `[`, and the character right after an unescaped `(` — so the
 * escape pairing from the scan's start onward is fixed by the text alone, and the
 * depth of a scan begun at `start` at any later position `j` is `after[j] -
 * after[start - 1]` (for a label, `1 + after[j] - after[open]`, since its own `[`
 * counts). A scan therefore closes exactly where `after` first comes back down to
 * the value it started from, and it never closes when no later position goes below
 * that — which is the question the two predicates ask, without walking. An escaped
 * delimiter follows the same rule: the pass that escaped it did not count it, and a
 * scan starting there still opens at depth 1, which is what the table holds.
 *
 * Only the failing case is worth a table: a scan that finds its closer moves the
 * loop past it, so successful walks already cost `O(text)` in total.
 */
interface BracketBalance {
  /** Balance just after each position — open delimiter +1, close delimiter -1, a backslash and its escapee both 0 */
  after: Int32Array;
  /** Lowest balance at any position at or after each index; the last entry is the empty-suffix sentinel */
  minFrom: Int32Array;
}

/**
 * One forward pass and one backward pass over `text`; paid for at most once per
 * scan and per delimiter pair.
 *
 * @param openCh - The delimiter that raises the depth
 * @param closeCh - The delimiter that lowers it, and that a failing scan is looking for
 */
function buildBracketBalance(text: string, openCh: string, closeCh: string): BracketBalance {
  const length = text.length;
  const after = new Int32Array(length);
  const minFrom = new Int32Array(length + 1);
  let bal = 0;
  let i = 0;
  while (i < length) {
    const ch = text[i];
    if (ch === '\\') {
      // Neither the backslash nor the character it escapes changes the depth.
      after[i] = bal;
      i++;
      if (i < length) {
        after[i] = bal;
        i++;
      }
      continue;
    }
    if (ch === openCh) bal++;
    else if (ch === closeCh) bal--;
    after[i] = bal;
    i++;
  }
  // A suffix with no characters left can supply no closer: the sentinel keeps
  // the check below reporting an empty suffix as unresolved rather than as a
  // balance of zero.
  const noCloser = 0x7fffffff;
  minFrom[length] = noCloser;
  let lowest = noCloser;
  for (let j = length - 1; j >= 0; j--) {
    if (after[j] < lowest) lowest = after[j];
    minFrom[j] = lowest;
  }
  return { after, minFrom };
}

/** True when {@link findLabelEnd} would walk this label to end-of-text and return `-1`. */
function labelCannotClose(balance: BracketBalance, open: number): boolean {
  return balance.minFrom[open + 1] >= balance.after[open];
}

/**
 * True when the bare branch of {@link readDestination} would walk this destination
 * to end-of-text and return `null`.
 *
 * @param balance - The `(`/`)` table for the same document
 * @param text - The document, needed only for the form check below
 * @param start - Index just after the link's own `(`, which the walk does not count:
 * it returns at the first `)` taking it below the balance that `(` left, so it
 * never returns exactly when no later position goes below `after[start - 1]`
 *
 * @remarks
 * The `<angle bracket>` branch closes on a `>` plus a plain `)`, so paren depth
 * answers nothing about it and this predicate declines it; that form is bounded by
 * {@link buildAngleClosers} instead, which is what `'[a](<b'.repeat(N)` needed and
 * the `)` bail in {@link extractTocLinks} alone never covered (issue #287).
 * If `readDestination`'s bare branch ever stops requiring a depth-0 `)`, this
 * predicate has to change with it — it is a claim about that function, not a
 * property of the text.
 */
function destinationCannotClose(balance: BracketBalance, text: string, start: number): boolean {
  if (text[start] === '<') return false;
  return balance.minFrom[start] >= balance.after[start - 1];
}

/**
 * Where an angle destination can still close, per index: the next unescaped `>`
 * at or after it, and the next `)` at or after that.
 *
 * @remarks
 * The `<angle bracket>` branch of {@link readDestination} answers nothing from
 * paren depth — it ends at the first unescaped `>` and then wants a plain `)`
 * after it — which is why #263's balance table deliberately skipped it and left
 * it on the walk (issue #287). Two suffix tables answer the same question in one
 * read per start, so a document of stray angle brackets costs one build instead of
 * one walk per `[`.
 */
interface AngleClosers {
  /** Index of the next candidate `>` at or after each position, `-1` when none */
  gt: Int32Array;
  /** Index of the next `)` at or after each position, `-1` when none */
  rp: Int32Array;
}

/**
 * Builds {@link AngleClosers}: one escape-aware forward pass, one backward pass.
 * Paid for at most once per scan, and only after an angle destination has already
 * failed to close.
 */
function buildAngleClosers(text: string): AngleClosers {
  const length = text.length;
  const gt = new Int32Array(length + 1).fill(-1);
  const rp = new Int32Array(length + 1).fill(-1);
  const candidate = new Uint8Array(length);

  // A backslash consumes the next character only when that character is ASCII
  // punctuation — the same rule the branch itself applies, so the table can never
  // promote a `>` the walk would have taken for data, nor hide one it would have
  // honoured. `\d` is two literal characters and stops nowhere near a delimiter.
  let i = 0;
  while (i < length) {
    if (text[i] === '\\' && i + 1 < length && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (text[i] === '>') candidate[i] = 1;
    i++;
  }

  // The `)` is *not* escape-filtered, because the branch looks for it with a plain
  // `indexOf(')', close + 1)` after the `>`. Mirroring that exactly is the point:
  // a tidier rule here would refuse to walk documents the walk closes successfully.
  let nextGt = -1;
  let nextRp = -1;
  for (let j = length - 1; j >= 0; j--) {
    if (candidate[j] === 1) nextGt = j;
    if (text[j] === ')') nextRp = j;
    gt[j] = nextGt;
    rp[j] = nextRp;
  }
  return { gt, rp };
}

/** True when the angle branch would walk this destination to end-of-text. */
function angleCannotClose(closers: AngleClosers, start: number): boolean {
  const gt = closers.gt[start];
  if (gt < 0) return true;
  return closers.rp[gt + 1] < 0;
}

interface RawDestination {
  /** Destination text without its delimiters */
  raw: string;
  /** Index to resume scanning after the closing `)` */
  next: number;
  /** Set when the destination text exists but cannot name a note; `raw` then holds that text exactly as written, not the readable prefix */
  skip?: TocSkipReason;
}

/**
 * CommonMark's `ASCII punctuation character` class (spec 0.31.2, §2.4): the
 * code-point ranges U+0021–2F, U+003A–40, U+005B–60 and U+007B–7E — 32
 * characters — and §2.4's rule that *any* of them may be backslash-escaped.
 *
 * @remarks
 * Stated as the spec's own ranges instead of a hand-maintained list, because a
 * list that drifts is the very defect this replaces: holding only
 * `\\ ( ) < > \` [ ] # % _ * -`, an escaped dot kept its backslash, so
 * `[a](notes/v1\.2.md)` looked up a file literally named `v1\.2.md` and the
 * author's edge silently vanished.
 *
 * Digits and letters fall outside these ranges by construction, which is the
 * behaviour issue #262 needs: `\0` is *not* an escape, and collapsing it merged
 * `01-a\02-b.md` onto the real sibling `01-a02-b.md`. Non-ASCII (including
 * lone surrogates, which is what `text` iterates) is above U+007E and so is
 * never escapable — exactly as in the spec.
 */
function isAsciiPunctuation(ch: string): boolean {
  const cp = ch.charCodeAt(0);
  return (
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e)
  );
}

/**
 * Whether one resolved escape keeps its backslash in the destination text.
 *
 * @param next - The character the backslash escaped
 * @returns `true` for `#`, `%` and `\`
 *
 * @remarks
 * Three characters are read *after* this scan, by {@link normalizeTocLink}: a `#`
 * is the fragment separator, a `%` opens a percent-escape, and a `\` is what tells
 * the two apart from data. Consuming their backslash here is what made
 * `[a](notes/c\#2.md)` resolve onto `notes/c` and `[a](notes/a\%20b.md)` onto
 * `notes/a b.md` — each a different, real note (#262 review). Keeping the mark
 * costs nothing downstream, because the marks are resolved before the destination
 * is ever folded or looked up; every other escapable character is resolved here,
 * where nothing later re-reads it.
 */
function keepsEscapeMark(next: string): boolean {
  return next === '#' || next === '%' || next === '\\';
}

/**
 * Is the text after a bare destination's first whitespace exactly one CommonMark title?
 *
 * @param rest - Everything after the first unescaped whitespace, with every escape
 * but the three marks {@link keepsEscapeMark} preserves already resolved
 * @returns `true` only when one delimited sequence fills the text
 *
 * @remarks
 * A title is *one* sequence, and nothing may follow it: `"one" "two"` starts and
 * ends on a quote yet is two titles, which CommonMark has no such link for. Reading
 * that prefix as a title accepted `[a](notes/my "one" "two")` and wrote an ordering
 * edge onto `notes/my` — the same class #262 refuses, one step later. The closing
 * delimiter must therefore be the last character with no unescaped copy of either
 * delimiter before it. A title whose own quote was escaped is indistinguishable
 * here, because the scanner resolves those first: such a destination is declined as
 * `unescaped-space`, never truncated.
 */
function looksLikeTitle(rest: string): boolean {
  const t = rest.trim();
  if (t.length < 2) return false;
  const open = t[0];
  if (open !== '"' && open !== "'" && open !== '(') return false;
  const close = open === '(' ? ')' : open;
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === close) return i === t.length - 1;
    // An unescaped `(` inside a `(...)` title is not a title; the spec closes the
    // sequence on the first unescaped `)` and this has no way to mean otherwise.
    if (open === '(' && ch === '(') return false;
  }
  return false;
}

/**
 * Reads a `(...)` destination: angle-bracket form or bare form up to the
 * matching `)`.
 *
 * @remarks
 * Both forms resolve a backslash plus ASCII punctuation into that literal
 * character ({@link isAsciiPunctuation}); only their delimiters differ, and the
 * branches below are deliberately not merged.
 *
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
      if (ch === '\\' && i + 1 < text.length && isAsciiPunctuation(text[i + 1])) {
        // The escape grammar here is the *same* {@link isAsciiPunctuation} rule
        // the bare branch below uses — CommonMark resolves `\` + punctuation in
        // both forms (§2.4; verified against commonmark.js and markdown-it:
        // `<foo\.bar>` and `<foo\<bar>` are `foo.bar` and `foo<bar`). The two
        // forms differ only in their **delimiters**, and that is the part that
        // must not be unified: this one ends at the first unescaped `>` and
        // takes raw spaces and parentheses as data, while the bare form ends at
        // the `)` that balances the link and refuses outright on a raw space.
        // So `\>` below is data and deliberately does not close the destination.
        // `#`, `%` and `\` keep their marks for `normalizeTocLink` — see
        // {@link keepsEscapeMark}.
        out += keepsEscapeMark(text[i + 1]) ? ch + text[i + 1] : text[i + 1];
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
  /** Text after the first unescaped whitespace; a CommonMark title, or a malformed destination. */
  let afterSpace = '';
  let depth = 0;
  let sawSpace = false;
  const emit = (ch: string): void => {
    if (sawSpace) afterSpace += ch;
    else out += ch;
  };
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (isAsciiPunctuation(next)) {
        // An escape sequence: the backslash is syntax, the character is data.
        // Same class as the angle-bracket branch — see {@link isAsciiPunctuation}.
        // `#`, `%` and `\` keep their marks for `normalizeTocLink` — see
        // {@link keepsEscapeMark}.
        emit(keepsEscapeMark(next) ? ch + next : next);
        i++;
        continue;
      }
      // Not escapable (a digit or a letter), so the backslash is part of the
      // path. Deleting it merged `01-a\02-b.md` onto a real sibling
      // `01-a02-b.md` (issue #262).
      emit(ch);
      continue;
    }
    if (ch === '(') {
      depth++;
      emit(ch);
      continue;
    }
    if (ch === ')') {
      if (depth > 0) {
        depth--;
        emit(ch);
        continue;
      }
      if (sawSpace && !looksLikeTitle(afterSpace)) {
        // A bare destination may not contain a space: `[a](notes/my note.md)` is
        // not a link, and reading it as `notes/my` silently linked a different,
        // real note. Obsidian accepts the spelling, so it must be declined, not
        // truncated — `<angle brackets>` and `%20` are the ways to mean a space.
        // `raw` is the whole text as written (`text.slice`), never `out`: a skip
        // is reported to the author, and `notes/my` is a path they did not type.
        return { raw: text.slice(start, i), next: i + 1, skip: 'unescaped-space' };
      }
      return { raw: out, next: i + 1 };
    }
    if (!sawSpace && /\s/.test(ch)) {
      // Optional `"title"` follows whitespace; keep scanning for the paren that
      // actually closes the link, since a title may carry balanced parens.
      sawSpace = true;
      continue;
    }
    emit(ch);
  }
  return null;
}

/**
 * Index of the first `#` that is destination data rather than the fragment
 * separator, or -1 when there is none.
 *
 * @remarks
 * A backslash consumes the character after it, which is how the marks
 * {@link keepsEscapeMark} preserved stay invisible to the split: `notes/c\#2.md`
 * has no fragment at all, while `notes/c#2.md` cuts at the hash as it always did.
 */
function literalHash(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '#') return i;
  }
  return -1;
}

/**
 * Percent-decodes a destination, leaving a protected `%` alone.
 *
 * @param text - Destination text, fragment separator already removed
 * @returns The decoded text, marks still in place
 * @throws {URIError} On a `%` that begins no valid escape — the caller's `malformed` skip
 *
 * @remarks
 * `decodeURIComponent` over the whole string cannot express this: `\%20` is a
 * literal percent the author escaped precisely so it would *not* decode, and
 * decoding anyway looked up `notes/a b.md` for a note named `notes/a\%20b.md`.
 * Runs decode as one unit — `%E4%B8%AD` is a single character and each pair on its
 * own is an invalid sequence — and an unprotected `%` that starts no valid escape
 * throws exactly where `decodeURIComponent` would have.
 */
function decodePercents(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      out += ch;
      if (i + 1 < text.length) out += text[++i];
      continue;
    }
    if (ch !== '%') {
      out += ch;
      continue;
    }
    let run = '';
    let j = i;
    while (text[j] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(j + 1, j + 3))) {
      run += text.slice(j, j + 3);
      j += 3;
    }
    if (run.length === 0) throw new URIError(`malformed percent escape at index ${i}`);
    out += decodeURIComponent(run);
    i = j - 1;
  }
  return out;
}

/**
 * Resolves the marks {@link keepsEscapeMark} preserved. Last step, after the split
 * and the decode: until here a `\#` still meant "not a fragment" and a `\%` still
 * meant "not an escape".
 *
 * @remarks
 * Only those three marks resolve. A backslash before anything else reached this
 * function as *data*, not as an escape — `01-a\02-b.md` is a filename with a
 * backslash in it, and consuming that backslash here is the collapse #262 refuses.
 */
function applyEscapeMarks(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && keepsEscapeMark(text[i + 1])) {
      out += text[++i];
      continue;
    }
    out += text[i];
  }
  return out;
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
    // The fragment separator is a LITERAL `#`. Splitting before the decode is
    // what keeps `%23` a `#` inside the path: decoding first turned
    // `notes/c%23.md` into `notes/c#.md`, then the split cut it to `notes/c` —
    // which resolved onto a different, real note (issue #262). The split reads
    // the *unescaped* hash for the same reason one step earlier: `notes/c\#2.md`
    // names a file, not a fragment (#262 review).
    const hash = literalHash(trimmed);
    decoded = decodePercents(hash >= 0 ? trimmed.slice(0, hash) : trimmed);
  } catch {
    // Malformed `%` escape: fail closed on this link only. Note the decode
    // runs BEFORE any filesystem matching and there is no raw-form fallback,
    // so a link can never resolve a file whose name literally contains `%XX`.
    return { raw, destination: null, skip: 'malformed' };
  }
  if (URI_SCHEME.test(decoded)) {
    return { raw, destination: null, skip: 'external' };
  }
  // Whitespace-only is `empty`; a space the destination *encoded* is data.
  // `decoded.trim()` here re-opened the defect this function closes: it turned
  // `notes/file.md%20` into a lookup for `notes/file.md`, the same truncation the
  // raw form refuses outright as `unescaped-space`.
  if (decoded.trim().length === 0) {
    return { raw, destination: null, skip: 'empty' };
  }
  const destination = applyEscapeMarks(decoded);
  if (destination.length === 0) {
    return { raw, destination: null, skip: 'empty' };
  }
  return { raw, destination };
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
  /**
   * Distinct notes the enumeration offered that a toc/full tier could order,
   * whether or not the selected tier consumed any. A README may reach one note
   * through several spellings, and the advice is about notes, so duplicates
   * collapse exactly as {@link planTocChain} collapses them. The CLI's
   * `--chain-tier toc` advice is honest only above one: the first candidate is
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
  // CLI tells a learner running `strict` to try `--chain-tier toc`; that advice is
  // only worth giving when the enumeration holds something the toc tier could
  // actually order, and this is the one place that knows which paths those are.
  // Counted as notes, not links: a README that reaches the same lesson twice
  // offers the toc tier one note, and `planTocChain` deduplicates to that, so
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
 * @returns The tier, or `null` for anything outside `strict|toc|full` (the CLI
 * turns `null` into a usage error — never a silent default)
 */
export function parseAutoChainTier(raw: unknown): AutoChainTier | null {
  if (raw === undefined || raw === false) return null;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'strict' || value === 'toc' || value === 'full' ? value : null;
}
