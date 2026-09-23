# Plan 007: Reconcile PR #204's documentation, invariants, duplicated predicates, and compatibility shim

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Steps are independent; if one's precondition is not met, skip it and
> record that in your report rather than improvising a different fix.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/storage/roadmap-parser.ts src/storage/wikilink.ts src/cli/adopt.ts src/cli/roadmap.ts src/engine/auto-chain.ts src/engine/index.ts src/storage/index.ts docs planning agent.md CHANGELOG.md test`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans 003, 004, 005, 006 (all must be DONE — this plan
  documents what they decide; doing it earlier writes docs for code that is about
  to change)
- **Category**: docs / tech-debt
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

PR #204 moved two functions into new modules, added a fourth roadmap format, and
added three invariants — and left the documentation and the shared-utility layer
describing the old world. Specifically: three pinned doc links now point at blank
lines; `docs/02-1:150` still advertises "three curriculum formats"; the exit-code
table says `palee adopt` cannot exit 3 when `--auto-chain` makes it exit 3;
`agent.md:75` still says roadmap `--from` is YAML-only. A Wikilink roadmap
contract is stated in two places that disagree with each other and with the code.

On top of that, the PR created genuine structural debt: `WikilinkRoadmapSection`
is declared twice, the vault-escape predicate now exists in four places (two of
them inside one file), and a backwards-compatibility re-export survives only to
keep one test import compiling.

None of these break anything today. All of them make the next change to this
feature wrong, which is why they belong in the same PR that introduced them.

## Current state

Files and one line each on their role:

- `src/storage/roadmap-parser.ts` — format classification + wikilink section parsing
- `src/storage/wikilink.ts` — wikilink → vault-note resolution
- `src/cli/adopt.ts` — `adopt` handler; owns the batch writer
- `src/cli/roadmap.ts` — `roadmap` handler; owns the import loop
- `src/cli/exit-codes.ts` — the single source of truth for exit codes
- `src/engine/index.ts`, `src/storage/index.ts` — facade barrels re-exported by `src/index.ts`, i.e. the published npm API
- `agent.md` — the authoritative project guide; `docs/02-0`, `docs/02-1`,
  `docs/03-2` — user docs; `planning/invariants.md` — invariants

### 1. The duplicate section type

Identically-named, separately-declared interfaces:

```ts
// src/storage/roadmap-parser.ts:22-27
export interface WikilinkRoadmapSection {
  /** Section heading (track name); empty when bullets precede any heading */
  track: string;
  /** Ordered wikilink links found in this section's bullet lists */
  links: ParsedWikilink[];
}
```

```ts
// src/storage/wikilink.ts:158-163
/** One `## Track` section of a wikilink roadmap: an ordered chain of links. */
export interface WikilinkRoadmapSection {
  /** Section heading (track name) */
  track: string;
  /** Ordered wikilinks in this section */
  links: ParsedWikilink[];
}
```

`resolveWikilinkRoadmap`'s parameter is the **second** one, while
`src/storage/index.ts:132` exports only the **first**:

```ts
export type { ParsedRoadmapResult, WikilinkRoadmapSection, ResolvedWikilink, ... };
```

They are structurally identical so TypeScript accepts it. The published type and
the type the function actually takes will drift apart on the next edit to either.

### 2. The vault-escape predicate, four times

```
src/storage/wikilink.ts:83-91      isWithinVault(resolvedVault, absolutePath)   — own helper, 4-part check
src/cli/roadmap.ts:243-253         inline, inside the validation loop
src/cli/roadmap.ts:333-343         inline again, inside the import loop   <-- twice in one file
src/storage/vault-walker.ts:86     inline, relativePath.startsWith('..' + path.sep) ...
```

Plus a duplicated basename helper:
`src/storage/wikilink.ts:93-96 targetBaseName` ≡
`src/engine/auto-chain.ts:118-121 baseNameOf` ≡ `path.basename(p)` for
`/`-separated paths.

### 3. The compatibility re-export

```ts
// src/cli/adopt.ts:29-32
// Re-exported for backwards compatibility (implementation moved to src/storage/note-title.ts).
import { resolveNoteTitle } from '../storage/note-title';
export { resolveNoteTitle };
```

Its only remaining external consumer is a test
(`test/cli-adopt-batch.test.ts:8`: `import { resolveNoteTitle } from '../src/cli/adopt';`).
`adopt.ts:223` and `:529` use the local import. `src/storage/index.ts:46,88`
already exports it from the layer that owns it. The package version is `0.5.2` —
pre-1.0, so a cross-layer re-export of an internal helper is not a public API
promise worth keeping.

### 4. Hard-coded exit codes against the repo's own policy

```ts
// src/cli/exit-codes.ts:4-8 (module doc)
 * Single source of truth for the documented CLI exit-code contract
 * (see `docs/02-0-cli-commands.md`). Import `ExitCode` instead of
 * hard-coding numeric literals, ...
```

`ExitCode.Validation = 3` exists. Both handlers already import from
`./exit-codes` — `src/cli/adopt.ts:11` imports `exitCodeFor`, and
`src/cli/roadmap.ts:11` imports `{ ExitCode, exitCodeFor }` and uses
`ExitCode.Conflict` / `ExitCode.PartialImport` / `ExitCode.Success` at lines
416/422. Yet PR #204 adds bare numerics:

```
src/cli/adopt.ts:426      process.exitCode = 3;      (auto-chain cycle)
src/cli/roadmap.ts:178    process.exitCode = 3;      (wikilink resolve failure)
```

### 5. Documentation gaps (each verified against the live files)

| Location | Says | Should say |
|---|---|---|
| `docs/02-1:84` | `resolveNoteTitle()` pinned at `src/cli/adopt.ts#L36-L91` | implementation is `src/storage/note-title.ts`; `adopt.ts:36-38` are blank lines |
| `docs/02-1:344` | pinned at `src/cli/adopt.ts#L23-28` | that is now the import block; the id generator is `src/engine/topic-id.ts` |
| `docs/02-1:345-349` | pinned at `src/cli/adopt.ts#L447/448/437` | those lines moved when the auto-chain block was inserted |
| `docs/02-1` §4 "Wikilink Roadmap (`.md`)" (~lines 206-222) | The example roadmap is a bare `# DevOps Roadmap` + `## Foundations` + `- [[...]]` bullets, with **no frontmatter** | Plan 003 gates the format on `palee_roadmap: true`, so this example would now be **rejected**. The example must start with `---\npalee_roadmap: true\n---\n` and the prose must state the marker is required. Highest-priority row in this table: it is a user-facing example that is now actively wrong. |
| `docs/02-1:208` | "Each heading starts a new chain section" | Level-agnostic and now wrong: plan 004 restricted sections to `##` only, because every section head is written with `depends_on: []`, which clears a note's existing prerequisites. Must read "each `##` heading starts a new chain section; deeper levels do not." |
| `planning/invariants.md` INV-48 | (plan 003 already rewrote this bullet) | Verify it also states the `##`-only section rule from plan 004, in one bullet. |
| `planning/invariants.md` INV-46 (line ~71) | ends "…and never modifies already-adopted notes." | **Hand-off from plan 006, whose Step A4 asked for this but whose Variant A Scope excluded `planning/invariants.md`, so it was correctly not applied.** Append one clause, keeping INV-46 a single bullet: the plan spans every note in the scanned scope including notes already adopted there, and such notes are used as chain predecessors but never rewritten. |
| `plans/006-*.md` maintenance note / any prose claiming Variant A makes cycles "block adoption more often" | That claim is **false** and must not be repeated in docs. Verified: `loadTopics(vaultPath)` already merged the whole vault into `plannedGraph` before plan 006, so any vault cycle already blocked `--auto-chain`; and a bridge-created cycle is unconstructible because the new note's id is minted at plan time and is therefore unknowable to any pre-existing edge. Plan 006's new cycle test passes against the pre-fix code — it is a guard against future suppression, not a regression test. Do not write user docs implying behaviour changed here. |
| `docs/02-1` §4 wikilink body text | "A Markdown file whose headings and bullet/numbered lists contain Obsidian wikilinks" | Must say "a Markdown document marked `palee_roadmap: true` whose …". Also document that an unmarked `.md` exits `2`, so a user who hits it knows why. |
| `docs/02-1:150` | "parses **three** curriculum formats" | four — `#### 4. Wikilink Roadmap` is documented later in the same file |
| `docs/02-0:81` (`palee adopt` row), Exit Code 3 cell | `N/A` | exit 3 now happens: auto-chain cycle in the planned graph |
| `agent.md:75` | "Roadmaps: `--from` is YAML-only" | `--from` accepts YAML, Markdown frontmatter, YAML code fences, and the wikilink format |
| `src/engine/auto-chain.ts:17` | `{@link detectCyclesBounded}` | unresolvable — that symbol is not imported or declared in this module; make it plain text naming `src/engine/dependency.ts` |

### 6. Barrel surface added with no consumers

`src/engine/index.ts:53-68` and `src/storage/index.ts:86-91` re-export new
symbols, and `src/index.ts` re-exports both facades, so these become part of the
published npm API. Grep of `src/` and `test/` finds **zero** consumers for:
`parseWikilinkSections`, `buildVaultNoteIndex`, `resolveWikilinkTarget`,
`AmbiguousWikilinkError`, `UnresolvedWikilinkError`, `ResolvedWikilink`,
`compareLessonOrder`, `parseNumericPrefix`. (`planAutoChain`, `parseWikilink`,
`extractWikilinks`, `generateTopicId`, `resolveNoteTitle` do have consumers.)
Production code imports the modules directly; tests import
`../src/storage/wikilink`.

### 7. Whitespace left behind by the extraction

`src/cli/adopt.ts:33-38` — five consecutive blank lines where `generateTopicId`
and `resolveNoteTitle` used to be, plus stray doubles around lines 260-261 and
565-566.

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| Build     | `npm run build`                                                     | exit 0              |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |
| Inv IDs   | `node --import tsx --test test/planning-invariant-ids.test.ts`      | all pass            |

## Scope

**In scope** (the only files you should modify):
- `src/storage/wikilink.ts`, `src/storage/roadmap-parser.ts`, `src/storage/index.ts`
- `src/cli/adopt.ts`, `src/cli/roadmap.ts`, `src/cli/exit-codes.ts`
  (only if a shared escape predicate is placed here — see Step 2's note)
- `src/engine/auto-chain.ts` (doc-comment line 17 only), `src/engine/index.ts`
- `test/cli-adopt-batch.test.ts` (the import line only)
- `docs/02-0-cli-commands.md`, `docs/02-1-topic-management-commands.md`,
  `docs/03-2-dependency-graph-engine.md`, `planning/invariants.md`, `agent.md`,
  `CHANGELOG.md`

**Out of scope** (do NOT touch):
- Behaviour of any resolver, planner, or writer — plans 001-006 own behaviour.
  This plan changes structure and prose only.
- `src/types.ts` beyond what Step 1's type consolidation strictly requires.
- `src/storage/vault-walker.ts` internals; `walkVault` is correct as-is.
- The `palee validate` command or its rules directory.

## Git workflow

- Work on the open PR branch `feat/73-auto-chain`.
- Prefer 3 commits: `refactor(storage): consolidate wikilink types and shared vault-path guards (#73)`,
  `docs: reconcile auto-chain and wikilink roadmap documentation (#73)`,
  `chore: trim unused facade exports (#73)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One declaration of `WikilinkRoadmapSection`

Keep the declaration in `src/storage/roadmap-parser.ts` (the module that
*produces* sections) and delete the copy at `src/storage/wikilink.ts:158-163`,
importing the type from `./roadmap-parser` instead. Merge the better of the two
doc comments — the producer's field docs are more precise, the consumer's header
line ("an ordered chain of links") is the better summary; keep both ideas in one
comment.

Then confirm `src/storage/index.ts:132` still exports the surviving type, and
that `resolveWikilinkRoadmap`'s signature resolves.

**Verify**: `npm run typecheck` → exit 0 ·
`grep -c "interface WikilinkRoadmapSection" src/storage/*.ts` → exactly one file
reports `1`, the other `0`.

### Step 2: One vault-escape predicate

Pick a single home and use it everywhere. Recommended: export a function from
`src/storage/vault-walker.ts`, which already owns vault-path policy and is
importable by both `src/storage/wikilink.ts` and `src/storage/vault-walker.ts`'s
own callers. **`src/cli/` importing a storage helper is fine and already the
norm** (`src/cli/roadmap.ts` imports `loadTopics`, `parseFrontmatter`, etc.).

Name it `isWithinVault(vaultRootAbsolute, candidateAbsolute): boolean` and give
it the union of the current checks — the `wikilink.ts:83-91` form is the most
complete and should be the body:

```ts
function isWithinVault(resolvedVault: string, absolutePath: string): boolean {
  const rel = path.relative(resolvedVault, absolutePath);
  return (
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !rel.split(path.sep).includes('..')
  );
}
```

Replace the four call sites:
- `src/storage/wikilink.ts` — delete the local copy, import the shared one
- `src/cli/roadmap.ts:243-253` and `:333-343` — replace both inline blocks
- `src/storage/vault-walker.ts:86` — reuse it if the values at hand are
  comparable; if that site checks a *relative* path rather than an absolute one,
  **leave it alone** and say so in the commit message. Do not contort a shared
  helper to cover a differently-shaped call site — that is how a second, worse
  copy gets created.

Also delete `targetBaseName` (`src/storage/wikilink.ts:93-96`) and `baseNameOf`
(`src/engine/auto-chain.ts:118-121`) in favour of `path.basename(p)` — for the
`/`-separated POSIX paths these receive, `path.basename` on win32 splits on both
separators, which is a behaviour change. **Verify that claim before doing it**:
if `path.basename` on a `\`-containing input would differ, keep the local helper
and note why. `baseNameOf` in the engine must not import `path` if that pulls in
a Node builtin the engine does not otherwise use — check whether
`src/engine/` already imports Node builtins before deciding; `agent.md:11`
requires the engine to be fs-free, and a `path` import is a boundary judgement
call, so if in doubt leave `baseNameOf` in place and only delete
`targetBaseName`.

**Verify**: `npm run typecheck` → exit 0 · `npm run lint` → exit 0 ·
`grep -rn "split(path.sep).includes('..')" src/ | wc -l` → `1` (the shared
helper) · full suite `ℹ fail 0`.

### Step 3: Use `ExitCode.Validation`

Replace `process.exitCode = 3` with `process.exitCode = ExitCode.Validation` at
`src/cli/adopt.ts:426` (add `ExitCode` to its existing `./exit-codes` import on
line 11) and `src/cli/roadmap.ts:178`. Then sweep both files for other bare
numerics the PR introduced (`= 2` for the usage guards at `adopt.ts:179`,
`:197`, `roadmap.ts:151`, `:163`, `:185`) and use `ExitCode.Usage`. Do not change
numerics that predate PR #204 unless the sweep makes them inconsistent — if you
find yourself touching code outside the auto-chain/wikilink blocks, stop there
and report what remains.

**Verify**: `grep -n "process.exitCode = [0-9]" src/cli/adopt.ts src/cli/roadmap.ts`
→ no matches inside the #73 blocks.

### Step 4: Delete the compatibility re-export

- Change `test/cli-adopt-batch.test.ts:8` to
  `import { resolveNoteTitle } from '../src/storage/note-title';`
- Delete `src/cli/adopt.ts:29-32`'s `export { resolveNoteTitle };` and its
  comment. **Keep** the plain `import` on line 31 — `adopt.ts:223` and `:529`
  still call it.
- Do not add a re-export to `src/storage/index.ts`; line 46 already imports it
  there and line 88 already exports it.

**Verify**: `node --import tsx --test test/cli-adopt-batch.test.ts` → all pass ·
`npm run typecheck` → exit 0.

### Step 5: Trim the facade exports

Remove from `src/engine/index.ts:53-68` and `src/storage/index.ts:86-91` the
exports listed as having zero consumers in §6 above — with one exception:
`buildVaultNoteIndex` is a reasonable candidate for a future public API, but the
rule for this plan is *export what is consumed*. Keep `planAutoChain`,
`parseWikilink`, `extractWikilinks`, `generateTopicId`, `resolveNoteTitle`,
`resolveWikilinkRoadmap`, `AmbiguousWikilinkError`, `UnresolvedWikilinkError`
(the last two are needed by callers who must catch them across the facade —
verify a test or `src/` consumer actually catches them by name before keeping; if
nothing does, remove them too and report).

Re-run the grep for each symbol you keep, and list the kept-symbol evidence in
the commit message so the next reviewer does not repeat the survey.

**Verify**: `npm run typecheck` → exit 0 · full suite `ℹ fail 0` (tests import
`../src/storage/wikilink` directly, so removing facade entries must not affect
them — if a test breaks, that test was using the facade and you must fix the
import, not the export).

### Step 6: Fix the whitespace, the dead `{@link}`, and a vestigial loop

Collapse the blank runs at `src/cli/adopt.ts:33-38`, `:260-261`, `:565-566` to a
single blank line. Replace `{@link detectCyclesBounded}` at
`src/engine/auto-chain.ts:17` with plain text naming
`src/engine/dependency.ts`, since that symbol is not reachable from this module.

Also, **if plan 002 landed**: its fix reduced `pathCandidates` in
`src/storage/wikilink.ts` to a single element in both branches
(`[target]` when the target ends in `.md`, otherwise `` [`${target}.md`] ``), so
the `for (const candidate of pathCandidates)` loop can now never iterate twice —
it is dead structure left behind by that change. Replace it with a single
candidate value and one straight-line resolution block, keeping the existence,
`isFile`, `realpath`, `isWithinVault` and `isResolvableNotePath` checks and their
comments exactly as plan 002 wrote them. This is behaviour-preserving; the
existing `storage-wikilink` tests are the regression net.

**Verify**: `npm run lint` → exit 0 (lint enforces the blank-line rule; if it
does not, that part is cosmetic and still required for reviewability) ·
`node --import tsx --test test/storage-wikilink.test.ts` → all pass, unchanged
count.

### Step 7: Documentation reconciliation

Apply every row of the table in §5, plus:

- `CHANGELOG.md`: add a behaviour-change note describing whatever plan 003
  decided — if 003 gated the wikilink format behind an explicit signal, that is a
  user-visible format requirement and belongs under a `### Changed` heading, not
  only under `### Added`.
- `planning/invariants.md`: make INV-47 and INV-48 agree with the merged code
  (INV-47 carries the wikilink exemption from plan 005; INV-48's "scoped to
  roadmap files" must state the actual gate from plan 003). Keep each invariant a
  single `INV-NN` bullet — `test/planning-invariant-ids.test.ts` asserts the ID
  format.
- `docs/02-1`: change "three curriculum formats" to four; add a
  `--auto-chain`-does-not-apply note to the Wikilink Roadmap section; document the
  `order` field, which is the load-bearing input for `roadmap --auto-chain` and is
  currently undocumented in the examples.
- `docs/02-0:81`: fill the `palee adopt` Exit Code 3 cell with the auto-chain
  cycle case, matching the wording style of the neighbouring cells in that table.
- `docs/03-2:235`: state the bridging behaviour that plan 006 actually
  implemented.
- `agent.md:75`: replace "`--from` is YAML-only" with the real format list.
  Treat this as the highest-value line in the step — `agent.md` is what every
  future agent session reads first, and a stale constraint there gets
  re-propagated.

**Verify**: `node --import tsx --test "test/**/*.test.ts"` → `ℹ fail 0`, and
`node --import tsx --test test/planning-invariant-ids.test.ts` → pass.

### Step 8: Check no doc link is still stale

The pinned links are GitHub URLs with `#L..` line anchors into `main`. Confirm
each one you rewrote now names a file whose path is right; you cannot verify line
anchors locally because they point at `main`, not this branch. Note that
explicitly in your report rather than claiming they were checked.

**Verify**: `grep -rn "src/cli/adopt.ts#L" docs/` → returns only links whose
targets still exist in `src/cli/adopt.ts`.

## Test plan

- No new behaviour tests — this plan is structure and prose by design.
- Regression safety net: the full existing suite must pass untouched. If any
  existing test needs an edit other than `test/cli-adopt-batch.test.ts:8`'s
  import, STOP and report: that means a "pure" refactor changed behaviour.
- Verification: `node --import tsx --test "test/**/*.test.ts"` → `ℹ fail 0`.

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm run build` all exit 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0` with no existing test body modified
- [ ] `grep -c "interface WikilinkRoadmapSection" src/storage/*.ts` totals 1
- [ ] `grep -rn "split(path.sep).includes('..')" src/ | wc -l` equals 1
- [ ] No `export { resolveNoteTitle }` remains in `src/cli/adopt.ts`; `test/cli-adopt-batch.test.ts` imports from `src/storage/note-title`
- [ ] `grep -n "process.exitCode = [0-9]" src/cli/adopt.ts src/cli/roadmap.ts` shows no bare numerics in the #73 code paths
- [ ] `grep -rn "three curriculum formats" docs/` → no match
- [ ] `grep -rn "is YAML-only" agent.md` → no match
- [ ] `grep -n "{@link detectCyclesBounded}" src/engine/auto-chain.ts` → no match
- [ ] `docs/02-0-cli-commands.md`'s `palee adopt` row Exit Code 3 cell is no longer `N/A`
- [ ] `git diff --name-only` lists only in-scope files
- [ ] `plans/README.md` status row for 007 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Any of the §5 table rows is already fixed — plans 003-006 may have landed
  doc edits; verify before rewriting.
- Step 2's `path.basename` substitution would change behaviour on `\`-separated
  input. Keeping a local helper is acceptable; a silent semantic change is not.
- Step 2's `src/engine/` boundary question (§ Step 2, last paragraph) cannot be
  settled from `agent.md` plus what `src/engine/` already imports. Ask rather
  than deciding — the engine-is-pure rule is load-bearing in this repo.
- Removing a facade export in Step 5 breaks a **published API** expectation:
  check `README.md`, `docs/`, and `src/index.ts` for any documented import of
  that symbol before removing it. If it is documented, it stays and you note it.
- Step 7 requires changing a doc statement that contradicts behaviour you were
  told plans 003-006 established. That means a plan landed differently than this
  plan assumes — report the contradiction instead of writing prose for code that
  does not exist.

## Maintenance notes

- After this, `WikilinkRoadmapSection` and `isWithinVault` each have one home.
  Any new resolver or importer must use them; that is the point.
- Reviewer should scrutinize Step 5 hardest: trimming facade exports changes the
  published npm surface. If this package has any downstream users at 0.5.x,
  verify with the operator before removing, and prefer documenting over deleting.
- Deferred deliberately: the case-insensitive-filesystem divergence in
  `resolveWikilinkTarget` (branch 1 can match a differently-cased file on NTFS
  that Linux's branch 2 would not). It needs a decision about whether the vault
  is case-sensitive, not a cleanup.
- Also deferred: `resolveNoteTitle`'s SM-2 interaction —
  `src/cli/adopt.ts:545-564` writes `ease_factor: 2.5`, `repetition: 0`,
  `due_at: null` unconditionally, discarding pre-existing review fields on a note
  that has SM-2 data but no `palee_id`. That is **pre-existing**, not introduced
  here; `--auto-chain` widens its blast radius by minting ids across whole trees.
  It needs its own plan.
