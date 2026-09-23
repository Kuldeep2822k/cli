# Plan 004: Confine wikilink roadmap sections to `##` headings and close the malformed-link fail-open

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/storage/roadmap-parser.ts src/engine/auto-chain.ts test/storage-roadmap-parser.test.ts test/storage-wikilink.test.ts`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none (but land after plan 002 if both are in flight — they share
  `test/storage-wikilink.test.ts` fixtures)
- **Category**: bug / data-integrity
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

Every section head in a wikilink roadmap is written with `depends_on: []`, and
per the #137/#139 rule an explicit `[]` **clears** a note's existing
prerequisites (`src/cli/roadmap.ts:117`:
`depends_on: topic.depends_on ?? existingById?.depends_on ?? []`). So the number
of headings a parser invents equals the number of prerequisite lists it erases.

The heading regex accepts **levels 1 through 6**, so one intended track written
naturally as `## Junior Track` with `### Part 1` / `### Part 2` sub-headings
becomes three independent chains and the learner's curated `depends_on` on
`Part 2`'s first note is silently wiped. The function's own docstring
(`src/storage/roadmap-parser.ts:78`) and the PR description both say `## Track`.
The regex does not implement the documented contract.

Two smaller fail-opens in the same flow: `extractWikilinks` documents that
"malformed or nested `[[` sequences are skipped" but returns a real link from
`[[a[[b]]`, and the bullet regex counts Obsidian task items and nested
sub-bullets as top-level chain entries.

## Current state

- `src/storage/roadmap-parser.ts` — storage layer; classifies roadmap format and
  extracts wikilink sections. No `fs`.
- `src/engine/auto-chain.ts` — pure parser for `[[...]]` text; fs-free by
  architecture rule (`agent.md:11`).

The parser (`src/storage/roadmap-parser.ts:90-118`):

```ts
export function parseWikilinkSections(rawContent: string): WikilinkRoadmapSection[] | null {
  const { body } = parseFrontmatter(rawContent);
  const text = body ?? rawContent;
  // Strip fenced code blocks (``` and ~~~) so examples never count as links
  const stripped = text.replace(/(?:```|~~~)[^`~]*?\r?\n[\s\S]*?\r?\n\s*(?:```|~~~)/g, '');

  const sections: WikilinkRoadmapSection[] = [];
  let current: WikilinkRoadmapSection | null = null;

  for (const line of stripped.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { track: heading[1].trim(), links: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line) ?? /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!current) {
        current = { track: '', links: [] };
        sections.push(current);
      }
      current.links.push(...extractWikilinks(bullet[1]));
    }
  }

  const nonEmpty = sections.filter((s) => s.links.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : null;
}
```

The doc-claim mismatch (`src/engine/auto-chain.ts:261-267`):

```ts
/**
 * Extracts every well-formed wikilink from a line or block of text, in order.
 *
 * @param text - Text to scan (a bullet item, a paragraph, …)
 * @returns Parsed links; malformed or nested `[[` sequences are skipped
 */
export function extractWikilinks(text: string): ParsedWikilink[] {
```

`WIKILINK_GLOBAL` (`src/engine/auto-chain.ts:259`) excludes `[ ] | #` from the
target class, so on `[[a[[b]]` the scan simply starts later in the string and
matches `[[b]]` — the nested `[[` is not skipped, it is reinterpreted.

The declared section type lives at `src/storage/roadmap-parser.ts:22-27`; the
**duplicate** declaration in `src/storage/wikilink.ts:158-163` is handled by plan
007 — do not touch it here.

Existing test style to match: `test/storage-roadmap-parser.test.ts` uses
`describe`/`it` (or `test`) with `assert.deepStrictEqual` on
`result.sections`, and creates no files on disk — it is a pure string test.
Confirm by reading the file's existing wikilink cases before adding yours.

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| Parsers   | `node --import tsx --test test/storage-roadmap-parser.test.ts`      | all pass, 0 fail    |
| Engine    | `node --import tsx --test test/engine-auto-chain.test.ts`           | all pass, 0 fail    |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |

## Scope

**In scope** (the only files you should modify):
- `src/storage/roadmap-parser.ts`
- `src/engine/auto-chain.ts` — only `extractWikilinks` and its doc comment
- `test/storage-roadmap-parser.test.ts`
- `test/engine-auto-chain.test.ts`

**Out of scope** (do NOT touch):
- `src/storage/wikilink.ts` — resolution belongs to plan 002; the duplicate
  type declaration belongs to plan 007.
- `src/cli/roadmap.ts` — the `--auto-chain` interaction is plan 005.
- `src/cli/adopt.ts`.
- The fenced-code-block stripper (line 94). An *unclosed* fence leaks its
  contents and the scan is quadratic — both are known, low-impact, and
  intentionally excluded so this plan's diff stays about section scoping.
- `SINGLE_WIKILINK` and the `[[target|alias]]` / `[[target#heading]]` grammar —
  correct as written.

## Git workflow

- Work on the open PR branch `feat/73-auto-chain`.
- Commit style: `fix(storage): scope wikilink roadmap sections to h2 headings (#73)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing tests

In `test/storage-roadmap-parser.test.ts`:

1. **Sub-headings do not split a track** — input:
   `'## Junior Track\n- [[a]]\n### Part 2\n- [[c]]\n#### deep\n- [[d]]\n'`
   → assert exactly **one** section, `track: 'Junior Track'`, link targets
   `['a','c','d']` in document order.
2. **A document with no `##` heading and no list items yields no sections** —
   assert `parseWikilinkSections(...)` returns `null`. Use
   `'# Title\n### Sub\nprose only\n'`. **Do not** use a case that has a bullet:
   see the correction block below — bullets before any `##` intentionally
   collect into the empty-track section, so such an input returns one unnamed
   section, not `null`. Separately assert that `parseRoadmapContent` on a marked
   document with no list items yields `format !== 'wikilink'` and
   `sections === undefined`.
3. **`##` continues to work** — keep/regenerate the existing passing case
   unchanged; do not edit its expectations.

In `test/engine-auto-chain.test.ts`, add to the `extractWikilinks` block:

4. `'- [[a[[b]]'` → `assert.deepStrictEqual(extractWikilinks('- [[a[[b]]'), [])`
   (nested `[[` is malformed and must yield nothing).
5. `'- [ ] [[c]]'` → decide by reading the docs first: task-list items are not
   roadmap entries, so assert `[]`. If `docs/02-1` §4 explicitly documents task
   lists as valid, SKIP this test and say so in your report.

**Verify**: `node --import tsx --test test/storage-roadmap-parser.test.ts` and
`node --import tsx --test test/engine-auto-chain.test.ts`
→ expected: tests 1, 2 and 4 **FAIL**. Test 5 may fail; if it passes, note that
and continue.

### Step 2: Restrict the heading regex to level 2

In `src/storage/roadmap-parser.ts:100`, change `#{1,6}` to accept exactly two
hashes:

```ts
    const heading = /^##(?!#)\s+(.+?)\s*$/.exec(line);
```

`(?!#)` is required so `###` is not read as an `##` followed by a truncated
heading name. Keep the leading `^\s*` only if the existing regex had it — it did,
so indented `## ` still counts; do not tighten indentation in this step.

Now decide, and state your decision in the commit message, what a `###` line
does: with the regex above it is simply not a heading, so its bullet lines
continue the enclosing `##` section. That is the intent. Confirm the `###` line
itself is not also matched by the bullet regex (it is not).

Update the `@remarks` block at lines 85-88 so it says `##` sections specifically,
and that deeper heading levels do not start a new chain — because a section head
clears the note's existing `depends_on`, and inventing heads would erase
prerequisites.

**Verify**: `node --import tsx --test test/storage-roadmap-parser.test.ts` → all
pass including tests 1 and 2.

### Step 3: Make nested `[[` genuinely malformed

In `src/engine/auto-chain.ts`, `extractWikilinks` (lines 267-282) must skip a
match that was preceded by an unterminated `[[`. The minimal, direct way: after
`WIKILINK_GLOBAL.exec` returns a match, check the text preceding the match start
for an unclosed `[[` and skip the link when found. Do not add a second regex or a
parser class — this is a few lines and a comment.

Keep the existing `lastIndex` reset in the `finally` block. Leave the
`@returns` doc line as the contract you are now honouring.

**Verify**: `node --import tsx --test test/engine-auto-chain.test.ts` → all pass
including test 4.

### Step 4: Reject task-list items (only if Step 1's test 5 was added)

In `src/storage/roadmap-parser.ts:106`, make the bullet regex not match a Markdown
checkbox item, e.g. by rejecting a leading `[ ]` / `[x]` in the captured group.
If you skipped test 5, skip this step entirely.

**Verify**: `node --import tsx --test test/storage-roadmap-parser.test.ts` → all
pass.

### Step 5: Full gates

**Verify**: `npm run typecheck` → exit 0 · `npm run lint` → exit 0 ·
`node --import tsx --test "test/**/*.test.ts"` → `ℹ fail 0`.

Pay attention to `test/cli-roadmap-wikilink.test.ts` and
`test/storage-wikilink.test.ts`: their fixtures use `##` headings only, so
nothing there should change. If either fails, STOP and report the fixture — do
not edit it to match.

## Test plan

- 3 new tests in `test/storage-roadmap-parser.test.ts` (sub-heading grouping,
  no-`##`-heading returns null, existing `##` case preserved).
- 1-2 new tests in `test/engine-auto-chain.test.ts` (nested `[[`, task item).
- Model after the existing pure-string cases in
  `test/storage-roadmap-parser.test.ts` — same `assert.deepStrictEqual` on
  `sections`, no filesystem setup.
- Verification: both files pass; full suite reports `ℹ fail 0`.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0`
- [ ] `grep -n '#{1,6}' src/storage/roadmap-parser.ts` returns **no** match
- [ ] A `'## Track'` document with `### Part 2` produces exactly one section, asserted by a passing test
- [ ] `parseWikilinkSections('# T\n### S\n- [[a]]\n')` returns `null`, asserted by a passing test
- [ ] `extractWikilinks('- [[a[[b]]')` returns `[]`, asserted by a passing test
- [ ] `git diff --name-only` lists only the four in-scope files
- [ ] `plans/README.md` status row for 004 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- `docs/02-1` §4 or `planning/invariants.md` INV-48 documents heading levels
  other than `##` as meaningful. If so the documented contract is the regex, not
  the docstring, and the fix direction is the opposite of this plan.
- Making a `###` line non-terminal causes a real regression in a CLI test — that
  would mean links under sub-headings were expected to start chains.
- Step 3 requires lookahead beyond "was there an unclosed `[[` before this
  match". Anything more elaborate is the wrong layer; report instead.
- The `### ` line turns out to be captured by the bullet regex on some input,
  creating a link where none should exist.

## Corrections after execution (plan was wrong in two places)

Executed on `advisor/004-autofix` as `628d4e0` + `75b2238`, reviewer-verified.
Two statements in this plan were factually wrong; the executor caught both and
did the right thing rather than forcing them. Recorded here so nobody re-applies
them.

1. **Step 1 test 2 and Done criterion 6 were unsatisfiable.** They asserted that
   `parseWikilinkSections('# T\n### S\n- [[a]]\n')` returns `null` after Step 2.
   It does not — verified by execution: it returns
   `[{ track: '', links: [{ target: 'a' }] }]`. Under the plan's own regex a
   `#` or `###` line is not a heading at all, so that bullet is "before the first
   `##`" and collects into the unnamed section — which this plan's Maintenance
   notes call intentional and unchanged. The plan contradicted itself. The
   executor left the empty-track code alone and asserted the achievable contract
   instead: no named track is minted (`tracks` equals `['']`), plus a genuine
   `null` case (`'# Title\n### Sub\nprose only\n'` → `null`). Done criterion 6
   should read that way.
2. **Step 1 test 5 targeted the wrong layer.** It asked for
   `assert.deepStrictEqual(extractWikilinks('- [ ] [[c]]'), [])` at engine level.
   That can only pass by teaching the pure `[[...]]` scanner about Markdown
   checkbox syntax, while Step 4 correctly puts the rejection in
   `roadmap-parser`'s bullet regex. The engine-level assertion was not added; the
   assertion lives at the storage layer. `extractWikilinks('- [ ] [[c]]')` still
   returns `[{target:'c'}]` by design, because no caller passes it a checkbox
   item.

**Also fixed by the implementation beyond the plan's letter**: the new bullet
regex is `/^\s*[-*+]\s+(?!\[[ xX]\]\s)(.+)$/`, so `- [ ]` and `- [x]` are dropped
while `-`, `*`, `+` and `1.` / `1)` items still collect. Numbered checkbox items
(`1. [ ] [[x]]`) are not filtered — the second alternative has no guard. Left
as-is; numbered task items are not a Markdown construct.

**Follow-up for plan 007**: `docs/02-1:208` says "Each heading starts a new
chain section", which is now looser than the code. Must read "each `##` heading".

## Maintenance notes

- The deeper problem this plan mitigates but does not remove: `depends_on: []`
  means both "clear this note's prerequisites" and "this is a chain head". Plan
  005 addresses that overload at the type boundary.
- Reviewer should scrutinize that a roadmap whose **first** links appear before
  any `##` still collect into the empty-track section (lines 108-111) — that
  behaviour is intentional and unchanged.
- Deferred: unclosed-fence leakage and the quadratic fence scan at line 94.
