/**
 * TOC Link Extraction (Issue PAL-205-C, INV-46/47)
 *
 * @remarks
 * Phase 1 of the TOC tier, extracted from `src/engine/toc-chain.ts` by the
 * P3-14 phase split (#565): pull inline markdown link destinations (including
 * `<angle bracket>` and `%20`-escaped forms) out of a TOC document, in
 * document order. Everything here is the scanner machinery that keeps that
 * extraction linear — the balance tables behind the #263/#287 bail-outs —
 * plus the decode/anchor-strip pass ({@link normalizeTocLink}) that turns a
 * raw destination into a chainable one or a counted skip.
 *
 * Fenced code, HTML comments and inline code spans are blanked before
 * scanning: a README documenting how to write a link is not enumerating
 * anything, and an entry the author commented out of the Contents names a
 * note that really exists. Same rule, one implementation:
 * {@link stripUnfollowableMarkup}.
 */

import { stripUnfollowableMarkup } from './auto-chain';

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
 * Operation counts for one {@link extractTocLinks} scan.
 *
 * @remarks A single number on purpose: the complexity guards assert it stays
 * linear in the input length. It counts every character the scanner's own loop
 * and walks examine — `indexOf` probes, `findLabelEnd` / `readDestination`
 * walks, balance/closer table builds — plus one input length for the up-front
 * markup-blanking pass. Per-link `normalizeTocLink` decoding is linear in the
 * link text and is deliberately not counted.
 */
export interface TocScanStats {
  steps: number;
}

/**
 * Characters examined by a forward `indexOf` probe from `from`.
 *
 * @remarks `indexOf` looks at each position from `from` up to and including the
 * match, or to end-of-text when there is none — so the probe cost is exact
 * without replacing the native call.
 */
function probeSteps(text: string, found: number, from: number): number {
  return (found < 0 ? text.length : found + 1) - from;
}

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
 *
 * @param text - Raw markdown of one TOC file
 * @param stats - Optional accumulator receiving the scan's operation count
 * (see {@link TocScanStats}); the scan adds to any steps already recorded
 */
export function extractTocLinks(text: string, stats?: TocScanStats): TocLink[] {
  const counter: TocScanStats = stats ?? { steps: 0 };
  const scanned = stripUnfollowableMarkup(text);
  counter.steps += text.length; // the blanking pass above: one linear read
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
    counter.steps += probeSteps(scanned, open, i);
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
      const closerProbe = scanned.indexOf(']', open);
      counter.steps += probeSteps(scanned, closerProbe, open);
      if (closerProbe < 0) break;
    }
    const close = findLabelEnd(scanned, open, counter);
    if (close < 0) {
      // The walk that just failed is the last full one this scan pays for: from
      // here every open `[` is answered from the balance table instead. Without
      // it the bail above only skips one bracket, so a README holding a single
      // stray `]` — which defeats the bail, since a `]` does follow — put every
      // `[` back on the full-walk path. Issue #263 measured that at 64 s for
      // 160 KB of brackets, through the real `deriveTocEnumeration` API, where
      // one such file stalls `adopt --auto-chain` for the whole vault.
      balance ??= buildBracketBalance(scanned, '[', ']', counter);
      i = open + 1;
      continue;
    }
    if (scanned[close + 1] !== '(') {
      // Reference-style `[label][id]` or stray bracket — not an inline link.
      i = close + 1;
      continue;
    }
    // Destination bails, the counterparts of the label pair above.
    //
    // When the table for this form already exists and says the destination
    // cannot close, answer from it in O(1) — the `)` probe below scans to a
    // possibly distant `)`, so running it first would put every link back on a
    // full scan of the remainder (quadratic on stray-angle documents, where the
    // native probe is merely fast enough to hide under a clock bound).
    const destStart = close + 2;
    if (scanned[destStart] === '<') {
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
    // The break handles the document that holds no `)` at all from here on; the
    // table handles the one that holds plenty of them but never one at the depth
    // this link's own `(` left behind. The probe still runs once per link, but a
    // successful link advances past the closer it just found, so the scans never
    // overlap and the total work stays linear instead of re-walking to a distant
    // paren for every link.
    const parenProbe = scanned.indexOf(')', destStart);
    counter.steps += probeSteps(scanned, parenProbe, destStart);
    if (parenProbe < 0) break;
    const dest = readDestination(scanned, destStart, counter);
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
      if (scanned[destStart] === '<') angleClosers ??= buildAngleClosers(scanned, counter);
      else destBalance ??= buildBracketBalance(scanned, '(', ')', counter);
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
function findLabelEnd(text: string, open: number, counter: TocScanStats): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    counter.steps++;
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
function buildBracketBalance(text: string, openCh: string, closeCh: string, counter: TocScanStats): BracketBalance {
  const length = text.length;
  const after = new Int32Array(length);
  const minFrom = new Int32Array(length + 1);
  let bal = 0;
  let i = 0;
  counter.steps += length; // forward pass: every character examined once
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
  counter.steps += length; // backward pass: every character examined once
  for (let j = length - 1; j >= 0; j--) {
    // Every index below `length` was filled by the forward scan; the guard
    // keeps the type honest rather than asserting it.
    const bal = after[j];
    if (bal !== undefined && bal < lowest) lowest = bal;
    minFrom[j] = lowest;
  }
  return { after, minFrom };
}

/** True when {@link findLabelEnd} would walk this label to end-of-text and return `-1`. */
function labelCannotClose(balance: BracketBalance, open: number): boolean {
  // `open` is an index into the same text the table was built from, so both
  // reads are in bounds; when the table cannot answer, decline the bail and
  // let the real walk decide rather than asserting.
  const min = balance.minFrom[open + 1];
  const bal = balance.after[open];
  if (min === undefined || bal === undefined) return false;
  return min >= bal;
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
  // `start` points at or after a real `)` in the same text the table was built
  // from, so both reads are in bounds; when the table cannot answer, decline
  // the bail and let the real walk decide rather than asserting.
  const min = balance.minFrom[start];
  const bal = balance.after[start - 1];
  if (min === undefined || bal === undefined) return false;
  return min >= bal;
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
function buildAngleClosers(text: string, counter: TocScanStats): AngleClosers {
  const length = text.length;
  const gt = new Int32Array(length + 1).fill(-1);
  const rp = new Int32Array(length + 1).fill(-1);
  const candidate = new Uint8Array(length);

  // A backslash consumes the next character only when that character is ASCII
  // punctuation — the same rule the branch itself applies, so the table can never
  // promote a `>` the walk would have taken for data, nor hide one it would have
  // honoured. `\d` is two literal characters and stops nowhere near a delimiter.
  let i = 0;
  counter.steps += length; // forward pass: every character examined once
  while (i < length) {
    // `i + 1 < length` is implied by the read succeeding: past-the-end reads
    // yield `undefined` and never satisfy the punctuation check.
    const next = text[i + 1];
    if (text[i] === '\\' && next !== undefined && isAsciiPunctuation(next)) {
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
  counter.steps += length; // backward pass: every character examined once
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
  // `start` indexes the same text the tables were built from, so the reads are
  // in bounds; when a table cannot answer, decline the bail and let the real
  // walk decide rather than asserting.
  const gt = closers.gt[start];
  if (gt === undefined) return false;
  if (gt < 0) return true;
  const rp = closers.rp[gt + 1];
  if (rp === undefined) return false;
  return rp < 0;
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
function readDestination(text: string, start: number, counter: TocScanStats): RawDestination | null {
  if (start >= text.length) return null;
  if (text[start] === '<') {
    let out = '';
    for (let i = start + 1; i < text.length; i++) {
      counter.steps++;
      const ch = text[i];
      // `i + 1 < text.length` is implied by the read succeeding: past-the-end
      // reads yield `undefined` and never satisfy the punctuation check.
      const nextCh = text[i + 1];
      if (ch === '\\' && nextCh !== undefined && isAsciiPunctuation(nextCh)) {
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
        out += keepsEscapeMark(nextCh) ? ch + nextCh : nextCh;
        i++;
        continue;
      }
      if (ch === '>') {
        const close = text.indexOf(')', i + 1);
        counter.steps += probeSteps(text, close, i + 1);
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
    counter.steps++;
    // `i` is in bounds, so this exists; the guard keeps the type honest
    // rather than asserting it.
    const ch = text[i];
    if (ch === undefined) {
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      // The `i + 1 < text.length` guard above means this exists; the check
      // keeps the type honest rather than asserting it.
      const next = text[i + 1];
      if (next !== undefined && isAsciiPunctuation(next)) {
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
    // `i + 1 < text.length` is implied by the read succeeding: past-the-end
    // reads yield `undefined` and never satisfy the mark check.
    const next = text[i + 1];
    if (text[i] === '\\' && next !== undefined && keepsEscapeMark(next)) {
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
