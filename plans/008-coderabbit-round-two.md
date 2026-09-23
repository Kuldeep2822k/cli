# Plan 008: Close the basename-hijack fall-through, fix `hasUnnumbered` without false positives, and re-scope the cycle test's claim

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If any STOP condition occurs, stop and report — do not improvise.
> Skip the plan's instruction to update `plans/README.md`; your reviewer
> maintains the index. Audit every claim in your report against an actual tool
> result from this session.

## Status

- **Priority**: P1 (N-A is a data-integrity hole in a fix already shipped)
- **Effort**: S
- **Risk**: MED
- **Depends on**: none — base is the pushed PR head
- **Category**: bug / tests
- **Planned at**: commit `7f43797`, 2026-09-22

## Why this matters

CodeRabbit's re-review of `7f43797` posted three findings. Two are real; one of
its *proposed patches* is wrong and must not be applied as written.

**N-A (Major, real, and a gap in a fix already shipped).** `resolveWikilinkTarget`
validates a path target against the vault boundary and note-visibility rules only
*after* `fs.existsSync` confirms the candidate exists. When the candidate does
not exist, control falls through to the basename lookup, which can select a
completely different in-vault note. Reproduced against `7f43797` with a vault
containing only `MODULES/note.md`:

```
[[../../outside/note]]   -> RESOLVED MODULES/note.md
[[.trash/note]]          -> RESOLVED MODULES/note.md
[[node_modules/note]]    -> RESOLVED MODULES/note.md
[[../../missing/note]]   -> RESOLVED MODULES/note.md
```

Every one of those resolved a note the user never named, and the roadmap
importer would then rewrite its `depends_on`. Plan 002 closed the
*candidate-exists* case and left this open.

**N-B (Minor, finding valid, proposed patch invalid).** `hasUnnumbered` inspects
only `baseNameOf(dir)`, so a genuinely unnumbered ancestor segment goes
unreported. But CodeRabbit's suggested fix —

```diff
-    if (parseNumericPrefix(baseNameOf(dir)) === null) {
+    if (dir.split('/').some((segment) => parseNumericPrefix(segment) === null)) {
```

— flags the **canonical layout from issue #73's own example** (`palee adopt
"MODULES/" --auto-chain`), because `MODULES` has no numeric prefix. Verified by
execution: that rule yields `hasUnnumbered = true` for `['MODULES/01-foundations']`.
The warning would then print on essentially every real vault, which makes it
meaningless. The correct condition is narrower: a segment only *decides* order
when two directories actually differ at that level, so only those levels can fall
back to alphabetical.

Verified against the same three shapes, current shipped behaviour:

| input | shipped | CodeRabbit's rule | correct |
|---|---|---|---|
| `MODULES/01-foundations/01-x.md` | `false` | **`true`** (false positive) | `false` |
| `guides/01-module/01-n.md` | `false` | `true` | `false` (one top dir; nothing compared) |
| `MODULES/01-a/01-x.md` + `OTHER/01-b/01-y.md` | **`false`** | `true` | **`true`** (level 0 decides, unnumbered) |

The third row is the real bug: level 0 genuinely falls back to alphabetical and
nothing warns.

**N-C (Trivial, valid as a test-honesty issue).**
`test/cli-adopt-autochain.test.ts:283` is named `'a cycle through an in-scope
adopted note fails closed with exit 3 and zero writes'`, implying it covers the
plan-006 bridge. It does not: the fixture's cycle (`T-SYS` ↔ `T-LAB`) already
exists on disk, so the test passes whether or not the new-to-existing bridge is
emitted. What it actually guards is the *whole-vault merge* into the planned
graph. Renaming it to say so is the fix; do not contort the fixture.

A cycle created *by* the bridge edge is **unconstructible**, and the executor of
plan 006 proved it: the new note's id is minted at plan time from
`crypto.randomBytes`, so no pre-existing on-disk `depends_on` can name it, and
`buildEdgeMap` drops edges to unknown ids. Say that in the comment so nobody
spends time trying again.

## Current state

- `src/storage/wikilink.ts` — `resolveWikilinkTarget` (lines 143-177 shown
  below). `isWithinVault` is defined and exported from this same file (~line 111);
  `isResolvableNotePath` is imported from `./vault-walker`.
- `src/engine/auto-chain.ts` — pure, fs-free. `hasUnnumbered` block is at lines
  227-237; `compareDirs`/`dirSortKey` are the segment-wise comparators added by
  plan 001; the root directory sentinel is `'.'`.
- `test/cli-adopt-autochain.test.ts` — CLI tests; cycle test at line 283.

```ts
// src/storage/wikilink.ts:151-177 (current)
  // 1. Exact vault-relative path match.
  // ... (comment block explaining md-only) ...
  const candidate = target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
  const absoluteCandidate = path.resolve(resolvedVault, candidate);
  if (fs.existsSync(absoluteCandidate) && fs.statSync(absoluteCandidate).isFile()) {
    const canonical = fs.realpathSync(absoluteCandidate);
    if (!isWithinVault(resolvedVault, canonical)) {
      throw new UnresolvedWikilinkError(target);
    }
    const relativePath = relativeVaultPath(vaultPath, canonical);
    if (!isResolvableNotePath(relativePath)) {
      throw new UnresolvedWikilinkError(target);
    }
    return { absolutePath: canonical, relativePath };
  }
```

```ts
// src/engine/auto-chain.ts:227-237 (current)
  let hasUnnumbered = false;
  for (const dir of groups.keys()) {
    if (parseNumericPrefix(baseNameOf(dir)) === null) {
      hasUnnumbered = true;
    }
  }
  for (const p of normalized) {
    if (lessonRank(baseNameOf(p)).rank === 2) {
      hasUnnumbered = true;
    }
  }
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | exit 0 |
| Wikilink tests | `node --import tsx --test test/storage-wikilink.test.ts` | 14 + new, 0 fail |
| Engine tests | `node --import tsx --test test/engine-auto-chain.test.ts` | 14 + new, 0 fail |
| Adopt CLI tests | `node --import tsx --test test/cli-adopt-autochain.test.ts` | 9, 0 fail |
| Full suite | `node --import tsx --test "test/**/*.test.ts"` | `1001 + new`, 0 fail |

`npm install` is NOT needed and must not be run. No vitest. **Run the full suite
alone** — do not run it concurrently with another suite; these CLI tests spawn
`npx tsx` subprocesses and starve each other, producing false failures.

## Scope

**In scope:**
- `src/storage/wikilink.ts`
- `src/engine/auto-chain.ts`
- `test/storage-wikilink.test.ts`
- `test/engine-auto-chain.test.ts`
- `test/cli-adopt-autochain.test.ts` (rename + comment on line 283's test only)

**Out of scope — do NOT touch:**
- `src/cli/roadmap.ts`, `src/cli/adopt.ts` — N-A is fixed at the resolver, the
  single choke point. Do not add a second guard in a caller.
- `src/storage/vault-walker.ts`, `src/storage/roadmap-parser.ts`.
- `docs/`, `planning/invariants.md`, `CHANGELOG.md` — reconcile separately if at
  all.
- Do not apply CodeRabbit's proposed `hasUnnumbered` patch. It is wrong; see
  "Why this matters".

## Steps

### Step 1: Failing tests for N-A first

In `test/storage-wikilink.test.ts`, add to the `resolveWikilinkTarget` block. The
fixture vault already contains `MODULES/note.md`-style notes from earlier plans —
read the `before` block and reuse whatever in-vault note exists, or add one.
Every test asserts `UnresolvedWikilinkError`, because all four must fail closed:

- `[[../../outside/note]]` — escaping path whose target does **not** exist
- `[[../../missing/note]]` — same shape, different spelling
- `[[.trash/note]]` — dot-namespace, target does not exist
- `[[node_modules/note]]` — excluded dir, target does not exist

The assertion must prove the hijack did not happen, i.e. that it **threw** rather
than returned `MODULES/note.md`. `assert.throws` with an `instanceof` predicate,
matching the file's existing style.

**Verify**: `node --import tsx --test test/storage-wikilink.test.ts` → the 4 new
tests **FAIL** today with `Missing expected exception`. If they pass, STOP — the
hole is already closed and this plan is void.

### Step 2: Validate the lexical candidate before touching the filesystem

In `src/storage/wikilink.ts`, move the two safety checks **above**
`fs.existsSync`, and keep the post-`realpathSync` checks as they are (a symlink
can still escape). Shape:

1. compute `candidate` and `absoluteCandidate` exactly as today
2. `if (!isWithinVault(resolvedVault, absoluteCandidate)) throw new UnresolvedWikilinkError(target);`
   — this is a lexical check; `isWithinVault` is pure `path.relative` arithmetic
   and needs no filesystem access
3. derive the lexical relative form and normalise separators before handing it to
   `isResolvableNotePath`, which splits on `/`:
   `path.relative(resolvedVault, absoluteCandidate).split(path.sep).join('/')`
4. `if (!isResolvableNotePath(lexicalRelative)) throw new UnresolvedWikilinkError(target);`
5. only now `fs.existsSync` / `isFile` / `realpathSync` / re-check both predicates
   on the canonical path / return

Update the comment to say *why* the checks precede existence: a target that is
unsafe must never reach the basename lookup, otherwise `[[../missing/note]]`
resolves an unrelated in-vault `note.md`. Update the `@remarks` resolution-order
sentence accordingly.

**Verify**: `node --import tsx --test test/storage-wikilink.test.ts` → all pass,
including the 4 new ones and the pre-existing `rejects vault-escape targets`,
`throws AmbiguousWikilinkError listing every candidate`, and every legitimate
relative-path resolution test. `npx tsc --noEmit` → exit 0.

### Step 3: Failing tests for N-B

In `test/engine-auto-chain.test.ts`, add to the `planAutoChain` block. First run
`grep -n "hasUnnumbered" test/` and read what already asserts it — the plan's
author believes nothing does, and any existing assertion is a STOP condition if
your change would flip it.

Assert exactly these four:

| input | expected `hasUnnumbered` |
|---|---|
| `['MODULES/01-foundations/01-x.md']` | `false` — canonical #73 layout, must not warn |
| `['guides/01-module/01-n.md']` | `false` — single top-level dir, nothing compared |
| `['MODULES/01-a/01-x.md', 'OTHER/01-b/01-y.md']` | **`true`** — level 0 differs and is unnumbered |
| `['01-a/01-x.md', '02-b/01-y.md']` | `false` — both levels numbered |

**Verify**: `node --import tsx --test test/engine-auto-chain.test.ts` → the third
case **FAILS** today (shipped value is `false`). The other three already pass;
confirm and say so, because they are the guard against CodeRabbit's over-broad
rule.

### Step 4: Make `hasUnnumbered` level-aware

Replace the directory loop in `src/engine/auto-chain.ts` (lines 227-231) with the
discriminating-level rule: collect, per segment index, the set of distinct
segment names across all group directories; a level can only have fallen back to
alphabetical order if two or more directories differ there; if such a level
contains a segment with no numeric prefix, set `hasUnnumbered`.

Leave the second loop (the `lessonRank(...) === 2` file check) untouched. Do not
export anything new; the engine must stay fs-free — do not add a `path` import.

Comment the *why*: checking every segment would flag the canonical `MODULES/`
container from #73 on every vault and make the warning noise.

**Verify**: `node --import tsx --test test/engine-auto-chain.test.ts` → all pass,
including the 4 new cases and plan 001's two multi-level ordering tests
unchanged.

### Step 5: Re-scope N-C's test claim

In `test/cli-adopt-autochain.test.ts`, rename the test at line 283 to state what
it guards — a pre-existing vault cycle blocks adoption with zero writes, i.e. it
guards the whole-vault merge into the planned graph. Add a comment recording that
a cycle created *by* the plan-006 bridge edge is unconstructible (the new note's
id is minted at plan time, so no on-disk `depends_on` can name it) and that the
bridge itself is covered by the test at line 214. **Do not change the fixture or
the assertions** — only the name and comment.

**Verify**: `node --import tsx --test test/cli-adopt-autochain.test.ts` → 9 tests,
0 fail.

### Step 6: Full gates

**Verify**: `npx tsc --noEmit` → 0 · `npx eslint .` → 0 · full suite run **alone**
→ `ℹ fail 0`, total = `1001 + your new tests`.

## Done criteria

- [ ] `npx tsc --noEmit` and `npx eslint .` exit 0
- [ ] Full suite reports `ℹ fail 0`
- [ ] All four N-A targets (`../../outside/note`, `../../missing/note`, `.trash/note`, `node_modules/note`) throw `UnresolvedWikilinkError`, each asserted by a passing test
- [ ] The safety checks appear **before** `fs.existsSync` in `src/storage/wikilink.ts`
- [ ] `hasUnnumbered` is `false` for `['MODULES/01-foundations/01-x.md']` and `true` for `['MODULES/01-a/…', 'OTHER/01-b/…']`, both asserted by passing tests
- [ ] CodeRabbit's `dir.split('/').some(...)` patch was **not** applied — `grep -n "split('/').some" src/engine/auto-chain.ts` returns no match
- [ ] `src/engine/auto-chain.ts` still imports nothing from `node:` — `grep -n "^import" src/engine/auto-chain.ts` returns no match
- [ ] Line 283's test name no longer claims bridge coverage; its assertions are byte-identical
- [ ] `git diff --name-only 7f43797..HEAD` lists only the five in-scope files

## STOP conditions

- Step 1's tests already pass.
- `grep -n "hasUnnumbered" test/` shows an existing assertion your Step 4 change
  would flip. Report the assertion; do not edit it.
- Any legitimate wikilink resolution test breaks in Step 2. Do not weaken it.
- `isWithinVault` turns out not to be safe to call on a non-existent path (it is
  pure arithmetic, so it should be).
- Your full-suite run shows failures only in `session-*`, `smoke`,
  `storage-atomic-write`, or the stress harness — re-run it **alone** before
  concluding anything; those suites are wall-clock sensitive and starve when run
  concurrently.

## Maintenance notes

- After this, `resolveWikilinkTarget` is fail-closed on *every* unsafe path
  target whether or not the file exists. Any future resolver must reuse it.
- Reviewer should scrutinize that Step 2 did not break the ambiguity path:
  `[[dup]]` where `dup.md` does not exist at the vault root must still fall
  through to the basename index and raise `AmbiguousWikilinkError`, not
  `UnresolvedWikilinkError`.
- The `hasUnnumbered` rule now measures "did alphabetical order actually decide
  anything", which is what the warning text claims. If the warning wording
  changes, this rule must change with it.
