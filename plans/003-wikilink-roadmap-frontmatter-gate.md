# Plan 003: Require a wikilink roadmap to declare itself in frontmatter

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/storage/roadmap-parser.ts src/cli/roadmap.ts test/storage-roadmap-parser.test.ts test/cli-roadmap-wikilink.test.ts`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P1 — highest in this set
- **Effort**: S
- **Risk**: MED (intentional user-visible format change; see CHANGELOG step)
- **Depends on**: none. Land before plan 004 if both are in flight — they edit the
  same function.
- **Category**: bug / data-integrity
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

Issue #73's wikilink format is detected by a single test: the `--from` file's
extension is `.md` and the document contains at least one heading plus one
`[[...]]` bullet. That is true of a large fraction of ordinary Obsidian notes.
So `palee roadmap --from <any note>` imports that note's outbound links as a
curriculum and **rewrites the `depends_on` of every note it points at**.

This was reproduced against `6bce46d`. A `daily-log.md` containing:

```markdown
# Daily log

- reviewed [[MODULES/beta]] today
- recap [[MODULES/alpha]]
```

run through `palee roadmap --from daily-log.md -y` exited **0** and inverted the
learner's hand-authored prerequisite graph:

| note | `depends_on` before | after |
|---|---|---|
| `MODULES/beta.md` | `[T-A]` | `[]` |
| `MODULES/alpha.md` | `[]` | `[T-B]` |

Before PR #204 the same command exited 2 with `Roadmap must have a "topics"
array` — the safe answer. PR #204 turned a rejection into a silent graph
rewrite. The two notes above sit at the bottom of the blast radius: bullet order
decides which hand-written prerequisite list gets erased, and nothing warns the
user.

This directly violates a rule the project states about itself, at `agent.md:75`:

> Roadmaps: `--from` is YAML-only; roadmap import validates before mutating,
> never touches the network, and **a user roadmap is never silently rewritten**.

The fix the maintainer chose is to make the *document* declare itself a roadmap.
An ordinary note cannot be misread as one no matter which path a user passes,
and this matches how PALEE already marks a note's role — `palee_id` and
`palee_schema` frontmatter keys decide whether a note is an adopted topic
(`src/cli/adopt.ts:327`: `if (frontmatter && frontmatter.palee_id)`).

## Current state

- `src/storage/roadmap-parser.ts` — classifies roadmap input into one of four
  formats. Pure string work; no `fs`.
- `src/cli/roadmap.ts` — the `roadmap` handler; branches on `parseResult.format`.
- `src/storage/frontmatter.ts` — `parseFrontmatter(content)` returns
  `{ frontmatter, body, error }`.
- `test/storage-roadmap-parser.test.ts` — pure string tests, no filesystem.
- `test/cli-roadmap-wikilink.test.ts` — CLI tests against temp vaults.

The format ladder, verbatim from `src/storage/roadmap-parser.ts:142-230`
(abridged; step numbers are the code's own comments):

```ts
export function parseRoadmapContent(rawContent: string, filePath?: string): ParsedRoadmapResult {
  const isMdFile = filePath ? /\.(md|markdown)$/i.test(filePath) : false;
  const isYamlFile = filePath ? /\.(ya?ml)$/i.test(filePath) : false;

  // 1. If it's a Markdown file or contains frontmatter delimiters, try frontmatter first
  if (isMdFile || rawContent.trimStart().startsWith('---')) {
    const fmResult = parseFrontmatter(rawContent);
    if (fmResult.error) {
      return { roadmap: null, error: `Invalid frontmatter YAML: ${fmResult.error}` };
    }
    if (fmResult.frontmatter && Array.isArray(fmResult.frontmatter.topics)) {
      ...
      return { roadmap: normalized.roadmap, format: 'frontmatter' };
    }
  }

  // 2. Try Embedded YAML Code Blocks (...)
  const codeBlockRegex = /```(?:ya?ml)[^\n\r]*\r?\n([\s\S]*?)\r?\n```/gi;
  ...
  // 3. Try Pure YAML: ...
  // 4. Wikilink format (#73): Markdown sections of wikilink bullet lists.
  // Each `## Track` section's ordered `[[...]]` items form one dependency chain.
  if (isMdFile) {                                  // <-- THE ONLY GATE. Fix this.
    const sections = parseWikilinkSections(rawContent);
    if (sections) {
      return { roadmap: null, format: 'wikilink', sections };
    }
  }

  // 5. Fallback: Return structured codeblock error if found, otherwise missing topics array error
  return {
    roadmap: null,
    error: codeBlockError || 'Roadmap must have a "topics" array.\nSupported formats:\n  • Markdown Frontmatter: ---\n    topics: [...]\n    ---\n  • Markdown YAML Code Block: ```yaml\n    topics: [...]\n    ```\n  • Pure YAML: topics: [...]\n  • Wikilink lists: ## Track\\n    - [[Note One]]\\n    - [[Note Two]]',
  };
}
```

Note `fmResult` at line 148 is scoped inside the `if` block at 147-168 and is not
visible at line 221. You will either re-parse or hoist — Step 2 says which.

`parseWikilinkSections` already throws away the frontmatter it parses
(`src/storage/roadmap-parser.ts:91`: `const { body } = parseFrontmatter(rawContent);`)
— leave it alone; the gate belongs in `parseRoadmapContent`, which owns format
selection.

Conventions to match:
- Frontmatter keys are snake_case with a `palee_` prefix for PALEE-owned
  metadata (`palee_id`, `palee_schema`). New key: **`palee_roadmap`**.
  Per `agent.md:15`: "Data-model fields are snake_case (`palee_id`,
  `interval_days`); code identifiers camelCase."
- `ParsedRoadmapResult` is declared at `src/storage/roadmap-parser.ts:31-44`
  with a JSDoc line per field, including `format?: 'yaml' | 'frontmatter' |
  'codeblock' | 'wikilink'`.

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| Parsers   | `node --import tsx --test test/storage-roadmap-parser.test.ts`      | all pass, 0 fail    |
| CLI wikilink | `node --import tsx --test test/cli-roadmap-wikilink.test.ts`     | all pass, 0 fail    |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |
| Build     | `npm run build`                                                     | exit 0              |

No vitest; `node:test` + `tsx`. Install nothing.

## Scope

**In scope** (the only files you should modify):
- `src/storage/roadmap-parser.ts`
- `test/storage-roadmap-parser.test.ts`
- `test/cli-roadmap-wikilink.test.ts` (only to add the marker to its fixtures)
- `CHANGELOG.md`
- `planning/invariants.md` (INV-48 wording only)

**Out of scope** (do NOT touch):
- `src/cli/roadmap.ts` — do not add a second marker check there. Format
  selection must have exactly one home; `parseRoadmapContent` owns it.
- `src/storage/wikilink.ts` — resolution rules are plan 002's.
- `src/storage/frontmatter.ts` — `parseFrontmatter` is correct as-is.
- Heading-level scope, nested-`[[` handling, task-list bullets — plan 004.
- `docs/*` — reconciled in plan 007, which documents the merged behaviour of
  plans 003-006 in one pass. **But** do not leave `docs/02-1` §4's example
  actively wrong if you happen to be in the file; if you touch docs at all,
  record it in your report so plan 007 does not double-edit.

## Git workflow

- Work on the open PR branch `feat/73-auto-chain`.
- Commit style: `fix(storage): require palee_roadmap frontmatter for wikilink roadmaps (#73)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing regression tests

In `test/storage-roadmap-parser.test.ts`, add (pure strings, no files):

1. **An ordinary note is not a roadmap.** Input:
   `'# Daily log\n\n- reviewed [[MODULES/beta]] today\n- recap [[MODULES/alpha]]\n'`
   with `filePath` `'daily-log.md'`. Assert
   `result.format === undefined` and `result.sections === undefined`, and that
   `result.error` is a non-empty string. This is the exact reproduction case.
2. **A marked document still is.** Same body, prefixed with
   `'---\npalee_roadmap: true\n---\n'`. Assert `result.format === 'wikilink'`
   and `result.sections` has the expected links.
3. **The marker alone is not enough.** Input `'---\npalee_roadmap: true\n---\n# Notes\n\nprose only\n'`
   → assert `result.format` is not `'wikilink'` and `result.error` mentions the
   roadmap being marked but containing no resolvable `[[...]]` list items. (This
   is a new, specific message — Step 2 adds it.)
4. **`topics:` frontmatter still wins.** Input
   `'---\npalee_roadmap: true\ntopics:\n  - id: T-1\n    title: One\n    path: one.md\n---\n'`
   → assert `result.format === 'frontmatter'`, documenting the precedence.

**Verify**: `node --import tsx --test test/storage-roadmap-parser.test.ts`
→ tests 1 and 3 **FAIL**; 2 and 4 pass. If 1 already passes, STOP — the gate
already exists and this plan is void.

### Step 2: Gate branch 4 on `palee_roadmap: true`

In `src/storage/roadmap-parser.ts`, hoist the frontmatter parse out of the
`if (isMdFile || ...)` block so line 221 can see it, rather than parsing twice.
Concretely:

- declare `let mdFrontmatter: Record<string, unknown> | null = null;` above
  step 1's block
- inside it, after the `fmResult.error` early return, assign
  `mdFrontmatter = fmResult.frontmatter ?? null;`
- replace the branch-4 gate with:

```ts
  // 4. Wikilink format (#73): Markdown sections of wikilink bullet lists.
  // Each `## Track` section's ordered `[[...]]` items form one dependency chain.
  // Opt-in only: an ordinary note has a heading and [[links]] too, and importing
  // one would rewrite depends_on on every note it links to.
  if (isMdFile && mdFrontmatter?.palee_roadmap === true) {
    const sections = parseWikilinkSections(rawContent);
    if (sections) {
      return { roadmap: null, format: 'wikilink', sections };
    }
    return {
      roadmap: null,
      error: 'Roadmap is marked `palee_roadmap: true` but contains no wikilink list items.\nExpected a `## Track` heading with `- [[Note]]` bullets.',
    };
  }
```

Use `=== true` strictly — do not accept the strings `'true'` or `'yes'`.
`parseFrontmatter` returns real YAML booleans, so a strict check is correct and
anything else is silent leniency at a data-loss boundary.

Update the `parseRoadmapContent` `@remarks` list (lines 120-132) so format 4
reads "Wikilink bullet lists in a Markdown document marked `palee_roadmap: true`".
Update the step-5 fallback error string's last bullet the same way, since that
message is how a user discovers the requirement.

**Verify**: `node --import tsx --test test/storage-roadmap-parser.test.ts` → all
four new tests pass.

### Step 3: Fix the CLI test fixtures

`test/cli-roadmap-wikilink.test.ts` builds `roadmap.md` fixtures that will no
longer be recognised. Add `---\npalee_roadmap: true\n---\n` to the head of each
wikilink roadmap fixture. Do not change any assertion in that file.

**Verify**: `node --import tsx --test test/cli-roadmap-wikilink.test.ts` → all
pass. If an assertion (not a fixture) needs to change, STOP — that means a test
was relying on the un-gated behaviour and needs review, not repair.

### Step 4: Add the CLI-level non-rewrite test

In `test/cli-roadmap-wikilink.test.ts`, add the reproduction as a permanent
regression test. Build a vault with two adopted notes carrying hand-written
`depends_on`, plus an ordinary daily note that links them, run
`roadmap --from <daily note> -y`, and assert:

- exit status is `2` (usage/validation rejection — the pre-#204 behaviour)
- **both** notes' `depends_on` are unchanged
- the whole vault file listing is unchanged

For the last assertion, snapshot `path -> content` for every `.md` under the
vault before the run and `assert.deepStrictEqual` after. This repo's other
"zero writes" claims assert only that one file lacks a `palee_id`, which passes
even on a corrupted file; the full-vault content snapshot is the assertion that
can actually fail. Model the file-reading loop on the `idToPath` helper in
`test/cli-adopt-autochain.test.ts:53-66`.

**Verify**: `node --import tsx --test test/cli-roadmap-wikilink.test.ts` → all
pass, including this test. Confirm it genuinely fails if Step 2's gate is
temporarily removed — then put the gate back. Report that you did this check.

### Step 5: Record the invariant and the breaking change

- `planning/invariants.md` INV-48 currently claims wikilink resolution is
  "fail-closed **and scoped to roadmap files**". Make "roadmap files" mean
  something: state that the wikilink format is recognised only in a Markdown
  document whose frontmatter sets `palee_roadmap: true`, and that any other
  `.md` passed to `--from` is rejected without mutation. Keep INV-48 as one
  `INV-48` bullet — `test/planning-invariant-ids.test.ts` asserts the ID format.
- `CHANGELOG.md`: PR #204's `### Added (feat)` block describes the wikilink
  format. Add the marker requirement there, and add a `### Changed` section
  under `[Unreleased]` recording that `palee roadmap --from <note.md>` no longer
  imports a document that is not explicitly marked as a roadmap, matching the
  file's existing heading style (`### Added (feat)` / `### Fixes (fix)`).

**Verify**: `node --import tsx --test test/planning-invariant-ids.test.ts` → pass.

### Step 6: Full gates

**Verify**: `npm run typecheck` → exit 0 · `npm run lint` → exit 0 ·
`npm run build` → exit 0 · `node --import tsx --test "test/**/*.test.ts"` →
`ℹ fail 0`.

## Test plan

- 4 parser tests (Step 1) + 1 CLI non-rewrite test with a full-vault content
  snapshot (Step 4).
- Fixtures updated, assertions untouched (Step 3).
- The Step 4 test must be proven to fail without the gate (Step 4's verify note).
- Verification: full suite `ℹ fail 0`; new test count is 5.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run build` exits 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0`
- [ ] `grep -n "palee_roadmap" src/storage/roadmap-parser.ts` shows the gate using `=== true`
- [ ] `grep -n "if (isMdFile) {" src/storage/roadmap-parser.ts` returns **no** match
- [ ] An unmarked `.md` with a heading and a `[[link]]` bullet exits `2` with every vault file byte-identical — asserted by a passing test
- [ ] A marked roadmap document still imports normally (existing CLI tests pass with only fixture edits)
- [ ] `parseFrontmatter` is called **once** per `.md` input (no double parse added)
- [ ] INV-48 names the `palee_roadmap: true` gate and `test/planning-invariant-ids.test.ts` passes
- [ ] `CHANGELOG.md` has a `### Changed` entry for the narrowed detection
- [ ] `git diff --name-only` lists only in-scope files
- [ ] `plans/README.md` status row for 003 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's test 1 already passes — the gate exists and this plan is void.
- Hoisting `fmResult` changes behaviour for a **non**-`.md` input. The frontmatter
  block runs when `isMdFile || rawContent.trimStart().startsWith('---')`, so a
  `.yaml` file beginning with `---` also parses frontmatter there; make sure
  `mdFrontmatter` remains `null` unless that block ran, and that the YAML branch
  still executes for `.yaml` inputs.
- `parseFrontmatter` returns `palee_roadmap` as the string `'true'` for
  `palee_roadmap: true` in the fixture. That would mean the YAML layer is not
  producing real booleans and a strict `=== true` silently disables the format —
  check with a one-off assertion in Step 1's test 2 before writing Step 2. STOP
  and report if the value is not boolean `true`.
- A CLI test's assertion (not fixture) must change to survive (Step 3).
- You find any code path that reaches `resolveWikilinkRoadmap` without going
  through `parseRoadmapContent` — then the gate has a second entrance and must be
  enforced at the `src/cli/roadmap.ts` branch instead.

## Maintenance notes

- After this, `parseRoadmapContent` is the single authority on "is this
  document a roadmap, and of which kind". Keep it that way; a second format
  sniff in a CLI handler is how the two drift.
- `palee_roadmap` becomes PALEE's third reserved frontmatter key alongside
  `palee_id` / `palee_schema`. If a future `--dry-run` for `roadmap` is added,
  it should report the marker state, since that is now the difference between
  "imported" and "rejected".
- Reviewer should scrutinize: that an ordinary note produces exit **2**, not
  exit 3. Exit 3 means "validation failure" in this CLI's contract
  (`agent.md:24`); a file that was never a roadmap is a usage error.
- Related but separate: `palee_roadmap` on an **adopted topic note** (one that
  also has `palee_id`) is meaningless and currently ignored. Not this plan's
  concern; do not add validation for it here.
