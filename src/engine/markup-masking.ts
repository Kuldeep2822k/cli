/**
 * Markup Masking — Regions Written to Be Read, Not Followed
 *
 * @remarks
 * Pure, fs-free text utilities extracted from `src/engine/auto-chain.ts` by
 * the P3-14 phase split (#565). Blanks every region of a document in which a
 * link is written to be *read* rather than followed — fenced code blocks,
 * HTML comments, inline code spans — while preserving line and character
 * offsets, so callers that scan by index keep seeing the same lines in the
 * same order.
 *
 * One implementation because two consumers of the same rule drift: the TOC
 * link scanner (`extractTocLinks` in `./toc-links`) and the prerequisite
 * prose scanner (`extractDeclaredPrerequisites` in `./prereq-text`) both read
 * a real Obsidian vault, where a README documents a lesson while taking it
 * out of the Contents and a note quotes a link as an example. The wikilink
 * and fenced-code scanners here are also consumed directly by the roadmap
 * parser and the note-title resolver.
 */

/** A fence this scanner is currently inside: its marker character and run length. */
interface OpenFence {
  char: '`' | '~';
  length: number;
}

/** ≤3 spaces of indentation, then a run of 3+ backticks or 3+ tildes, then the info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Blank-preserving mask so a fenced region keeps its line and column shape. */
function maskLine(line: string): string {
  return line.replace(/\S/g, ' ');
}

/**
 * Replaces the content of every fenced code block with spaces, keeping the
 * document's line structure intact.
 *
 * @param text - Raw markdown text
 * @returns The same text with fence bodies and fence lines blanked out
 *
 * @remarks
 * CommonMark fence rules, because a caller's whole job is telling real content
 * from an example: a fence opens on 3+ backticks **or** 3+ tildes indented at
 * most three spaces, and closes only on the **same character**, run at least as
 * long, with nothing after it. A mixed pair therefore never matches — the one
 * regex this replaced allowed ` ``` ` to close a `~~~` block, which leaked an
 * example's `[[links]]` and `# headings` back into the roadmap parser and the
 * title resolver. An info string carrying a backtick cannot open a backtick
 * fence, and an unclosed fence runs to the end of the document.
 *
 * Line structure is preserved rather than the block spliced out so that
 * downstream line scans (`## Track` headings, list bullets) still see the same
 * lines in the same order.
 */
export function stripFencedCodeBlocks(text: string): string {
  const parts = text.split(/(\r?\n)/);
  let fence: OpenFence | null = null;
  for (let i = 0; i < parts.length; i++) {
    // `split` always yields at least one element and `i` is in bounds, so
    // this exists; the guard keeps the type honest rather than asserting it.
    const line = parts[i];
    if (line === undefined) {
      continue;
    }
    if (line.length === 0 || /^\r?\n$/.test(line)) {
      continue;
    }
    const marker = FENCE_LINE.exec(line);
    // A match always fills both capture groups (the fence run and the rest of
    // the line); the guards keep the type honest rather than asserting it.
    const run = marker?.[1];
    const info = marker?.[2] ?? '';
    if (fence === null) {
      if (run === undefined) {
        continue;
      }
      // An info string may not contain the opening character: ```` ```js ````
      // opens, ```` ``` a`b ```` is just text that starts with backticks.
      if (run[0] === '`' && info.includes('`')) {
        continue;
      }
      fence = { char: run[0] as '`' | '~', length: run.length };
      parts[i] = maskLine(line);
      continue;
    }
    parts[i] = maskLine(line);
    if (
      run !== undefined &&
      run[0] === fence.char &&
      run.length >= fence.length &&
      info.trim().length === 0
    ) {
      fence = null;
    }
  }
  return parts.join('');
}

/**
 * A single-line inline code span, run of one or two backticks on each side.
 *
 * @remarks
 * Deliberately line-local. A code span may legally cross lines, and matching one
 * that does would let a single unpaired backtick blank the rest of the document
 * and silently drop every real link after it — the failure #262 was filed to
 * stop, arriving from the other end. A span left unmatched is the rare case and
 * costs its own edge; a blank that over-reaches costs the document.
 */
const INLINE_CODE = /``[^`\n]*``|`[^`\n]*`/g;

/** Blank a span, keeping the newlines it held so line scans stay aligned. */
function blankKeepingLines(span: string): string {
  return span.replace(/[^\n]/g, ' ');
}

/**
 * Blanks HTML comments the way the previous `/<!--[\s\S]*?-->/g` did, without
 * the lazy rescan: on a document full of unterminated `<!--` openers the regex
 * retries to end-of-text for every one of them (O(n²)), which is exactly the
 * adversarial shape the `extractTocLinks` complexity guards feed in. Each
 * `indexOf` resumes where the previous match ended, and the first opener with
 * no closer proves every later opener has none either.
 *
 * An HTML comment is blanked whole, across lines, like a fenced block: nothing
 * between `<!--` and `-->` is a statement the reader is meant to act on.
 */
function blankHtmlComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open === -1) break;
    const close = text.indexOf('-->', open + 4);
    // Unterminated: blank nothing, like the regex this replaced.
    if (close === -1) break;
    out += text.slice(from, open) + blankKeepingLines(text.slice(open, close + 3));
    from = close + 3;
  }
  return out + text.slice(from);
}

/**
 * Blanks every region of a document in which a link is written to be *read*
 * rather than followed: fenced code blocks, HTML comments, inline code spans.
 *
 * @param text - Raw markdown text
 * @returns The same text, same length, with those three regions blanked
 *
 * @remarks
 * One function because two consumers of the same rule drift. `extractTocLinks`
 * enumerates a Contents into ordering edges and `extractDeclaredPrerequisites`
 * reads a `## Prerequisites` section into authored ones; both read a real Obsidian
 * vault, where a README documents a lesson while taking it out of the Contents
 * (`<!-- - [Intro](guide/intro.md) -->`) and a note quotes one as an example
 * (`` `[setup](notes/install.md)` ``). Before #261 the second carried its own copy
 * of these two patterns and the first had only the fence, so the hole was opened
 * twice by one edit. Line and character offsets survive — every blank is
 * length-preserving — because the callers scan by index, not by re-parsed lines.
 *
 * Deliberately not blanked: an *unterminated* comment or code span. Each is the
 * document that stops mid-sentence, and blanking to end-of-text on that reading
 * would withdraw links the author did mean.
 */
export function stripUnfollowableMarkup(text: string): string {
  return blankHtmlComments(stripFencedCodeBlocks(text)).replace(INLINE_CODE, blankKeepingLines);
}
