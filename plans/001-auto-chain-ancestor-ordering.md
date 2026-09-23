# Plan 001: Make auto-chain directory ordering ancestor-aware so nested module trees chain in pedagogical order

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/engine/auto-chain.ts test/engine-auto-chain.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

`palee adopt --auto-chain` is supposed to synthesize a prerequisite chain that a
learner can follow top-to-bottom. The directory comparator only reads the
**last** path segment's numeric prefix, so in a nested tree a deep folder inside
module 01 sorts by its own local number and lands *after* module 02. The
result: a foundational lesson ends up depending on a later module's note. It is
silent — every name is numbered, so the "unnumbered" warning never fires — and
acyclic, so the cycle detector never rejects it. Issue #73's acceptance criterion
"multi-level directory fixtures" is also unmet, which is why no test catches
this. This plan closes both at once.

## Current state

- `src/engine/auto-chain.ts` — pure, fs-free engine module. Plans the chain.
  **Must stay fs-free**: `agent.md:11` defines `src/engine/` as
  "pure, deterministic, fs-free logic". Do not add `fs`/`path` imports here.
- `test/engine-auto-chain.test.ts` — engine unit tests (`node:test`).

The defect (`src/engine/auto-chain.ts:183-196`):

```ts
  const sortedDirs = [...groups.keys()].sort((a, b) => {
    const pa = parseNumericPrefix(baseNameOf(a));
    const pb = parseNumericPrefix(baseNameOf(b));
    if (pa !== null && pb !== null) {
      if (pa.n !== pb.n) {
        return pa.n - pb.n;
      }
    } else if (pa !== null) {
      return -1;
    } else if (pb !== null) {
      return 1;
    }
    return compareStrings(a, b);
  });
```

`baseNameOf` (`src/engine/auto-chain.ts:118-121`) returns the segment after the
last `/`, so ancestors are never consulted.

Supporting facts you need:

```ts
// src/engine/auto-chain.ts:45-55 — prefix parser; returns null when the name
// does not start with digits. Do not change it.
export function parseNumericPrefix(name: string): NumericPrefix | null {
  const match = /^(\d+)[-_.\s]?(.*)$/.exec(name.trim());
  if (!match) {
    return null;
  }
  const n = parseInt(match[1], 10);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  return { n, rest: match[2] };
}

// src/engine/auto-chain.ts:88-96 — case-insensitive then code-unit compare.
// Reuse this; do not write a new string comparator.
function compareStrings(a: string, b: string): number {
```

Paths reaching `planAutoChain` are **always** `/`-separated: line 158 does
`relativePaths.map((p) => p.replace(/\\/g, '/'))`, and vault-relative paths come
from `relativeVaultPath` which normalizes to POSIX. So splitting on `/` is safe.
A vault-root note has directory `'.'` (from `parentDirOf`, line 123-126).

Existing fixture style to match (`test/engine-auto-chain.test.ts:61-67`) — flat,
`/`-separated string arrays:

```ts
    const plan = planAutoChain([
      'MODULES/01-foundations/01-a.md',
      'MODULES/01-foundations/02-b.md',
      'MODULES/02-linux/01-c.md',
      ...
```

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| One file  | `node --import tsx --test test/engine-auto-chain.test.ts`           | all pass, 0 fail    |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |
| Build     | `npm run build`                                                     | exit 0              |

There is **no vitest** in this repo. Tests run on `node:test` + `tsx`. Do not
add a vitest config or `npm install` anything.

## Scope

**In scope** (the only files you should modify):
- `src/engine/auto-chain.ts`
- `test/engine-auto-chain.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `src/cli/adopt.ts` — it consumes `ChainPlan`; the shape is unchanged.
- `src/engine/index.ts` — the barrel already re-exports `planAutoChain`.
- `hasUnnumbered` semantics (lines 171-181) — a separate, known issue
  (see `plans/README.md` rejected list). Not this plan.
- `lessonRank` / `compareLessonOrder` (lines 57-116) — intra-directory order is
  correct; changing it here would confound the regression test.
- The `@param`/`@remarks` doc block at lines 142-156 **may** be updated for the
  new ordering description, but nothing else in the file's prose.

## Git workflow

- Work on the open PR branch `feat/73-auto-chain` (these fixes belong to PR #204).
- One commit, conventional-commit style matching `git log`, e.g.:
  `fix(engine): order auto-chain directories by full path, not leaf prefix (#73)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing regression tests first

In `test/engine-auto-chain.test.ts`, inside the existing `describe` block that
covers `planAutoChain`, add two tests. Assert the exact ordered array and the
exact predecessor of the nested note — do not assert "contains" or lengths.

Test A — nested group must stay inside its ancestor module:

```ts
    const plan = planAutoChain([
      'MODULES/02-linux/01-kernel.md',
      'MODULES/01-foundations/09-labs/01-first.md',
      'MODULES/01-foundations/01-systems.md',
    ]);
    assert.deepStrictEqual(plan.orderedPaths, [
      'MODULES/01-foundations/01-systems.md',
      'MODULES/01-foundations/09-labs/01-first.md',
      'MODULES/02-linux/01-kernel.md',
    ]);
    assert.strictEqual(
      plan.predecessorOf.get('MODULES/01-foundations/09-labs/01-first.md'),
      'MODULES/01-foundations/01-systems.md'
    );
```

Test B — parent sorts before its own child, and an unnumbered nested group still
stays under its numbered ancestor:

```ts
    const plan = planAutoChain([
      'MODULES/01-foundations/01-a.md',
      'MODULES/01-foundations/deep-dive/01-b.md',
      'MODULES/02-linux/01-c.md',
    ]);
    assert.deepStrictEqual(plan.orderedPaths, [
      'MODULES/01-foundations/01-a.md',
      'MODULES/01-foundations/deep-dive/01-b.md',
      'MODULES/02-linux/01-c.md',
    ]);
```

**Verify**: `node --import tsx --test test/engine-auto-chain.test.ts`
→ expected: **both new tests FAIL**, with actual order putting
`MODULES/01-foundations/09-labs/01-first.md` after `MODULES/02-linux/01-kernel.md`.
If they pass already, STOP — the code has drifted or you edited the wrong test.

### Step 2: Replace the leaf-only comparator with a segment-wise one

In `src/engine/auto-chain.ts`, delete the inline comparator at lines 183-196 and
replace it with `const sortedDirs = [...groups.keys()].sort(compareDirs);`.

Add two module-private helpers immediately above `planAutoChain` (after
`parentDirOf`, ~line 126). Keep them unexported — the public surface must not
grow.

- `dirSortKey(dir: string)` → maps the directory into one
  `{ n: number | null; name: string }` per `/`-separated segment, using
  `parseNumericPrefix(seg)` for `n` and the raw segment for `name`.
  `'.'` (the vault-root sentinel) must map to a one-element key whose `n` is
  `null` — `parseNumericPrefix('.')` already returns `null`, so no special case
  is needed beyond not splitting it awkwardly.
- `compareDirs(a, b)` → walks the two key arrays in lockstep up to
  `min(len)`. At each index: if both `n` are non-null and differ, return
  `a.n - b.n`; if only one is non-null, the numbered segment sorts first;
  otherwise fall back to `compareStrings(sa.name, sb.name)` and return it when
  non-zero. After the common prefix, return `ka.length - kb.length` so a parent
  directory sorts before its own children.

The resulting comparator, for reference (adapt names/comments to the file's
style, which uses `@remarks`-free one-line JSDoc on private helpers):

```ts
interface DirSegmentKey {
  n: number | null;
  name: string;
}

function dirSortKey(dir: string): DirSegmentKey[] {
  return dir.split('/').map((seg) => {
    const parsed = parseNumericPrefix(seg);
    return { n: parsed ? parsed.n : null, name: seg };
  });
}

function compareDirs(a: string, b: string): number {
  const ka = dirSortKey(a);
  const kb = dirSortKey(b);
  const len = Math.min(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const sa = ka[i]!;
    const sb = kb[i]!;
    if (sa.n !== null && sb.n !== null) {
      if (sa.n !== sb.n) return sa.n - sb.n;
    } else if (sa.n !== null) {
      return -1;
    } else if (sb.n !== null) {
      return 1;
    }
    const c = compareStrings(sa.name, sb.name);
    if (c !== 0) return c;
  }
  return ka.length - kb.length;
}
```

`tsconfig` in this repo is strict. `ka[i]!` non-null assertions are acceptable
here because the loop bound guarantees presence; if `npm run lint` rejects the
assertion, index via a local `const` from a destructured pair instead — do not
add `as` casts or loosen types.

Update the `@remarks` block of `planAutoChain` (lines 148-155) so it says
directories sort **segment by segment**, ancestor prefixes first, and a parent
group precedes its own children.

**Verify**: `node --import tsx --test test/engine-auto-chain.test.ts`
→ all tests pass, including the two new ones, and every pre-existing
`planAutoChain` assertion still passes unchanged.

### Step 3: Confirm the CLI-level chain builder is unaffected

`src/cli/adopt.ts:376` calls `planAutoChain(toAdopt.map(n => n.relativePath))`
and only reads `orderedPaths`, `predecessorOf`, `hasUnnumbered`. No shape change.

**Verify**: `node --import tsx --test test/cli-adopt-autochain.test.ts` → all pass.

### Step 4: Full gates

**Verify**: `npm run typecheck` → exit 0 · `npm run lint` → exit 0 ·
`npm run build` → exit 0 · `node --import tsx --test "test/**/*.test.ts"` →
`ℹ fail 0`, and the total test count is **984** (982 + your 2 new tests).

## Test plan

- Two new tests in `test/engine-auto-chain.test.ts` (Step 1), modelled on the
  existing `planAutoChain` cases at lines 61-84 — same flat array input, same
  `deepStrictEqual` on `orderedPaths`, same `strictEqual` on `predecessorOf`.
- These satisfy issue #73's "multi-level directory fixtures" criterion at engine
  level. The CLI-level deep fixture is deferred (see Maintenance notes).
- Verification: `node --import tsx --test test/engine-auto-chain.test.ts` → all
  pass, including 2 new.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run build` exits 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0` and `ℹ tests 984`
- [ ] `grep -n "baseNameOf(a))" src/engine/auto-chain.ts` returns no match inside the sort (the old comparator is gone)
- [ ] `grep -c "function compareDirs" src/engine/auto-chain.ts` → `1`; `grep -c "function dirSortKey" src/engine/auto-chain.ts` → `1`
- [ ] `git diff --name-only` lists only `src/engine/auto-chain.ts` and `test/engine-auto-chain.test.ts`
- [ ] `plans/README.md` status row for 001 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's tests do **not** fail before the fix — the defect may already be
  fixed upstream, or you edited a different file.
- A **pre-existing** `planAutoChain` test breaks after Step 2. The segment-wise
  comparator must be a strict improvement for flat trees; if an existing
  single-level expectation changes, STOP and report the before/after arrays
  rather than editing the old assertion.
- The nested-tree case you need to handle requires consulting the vault on disk
  (e.g. real directory depth). This engine module must stay fs-free — that is a
  documented architecture rule, not a preference.
- `npm run lint` rejects the plan's suggested code shape after two reasonable
  attempts.

## Maintenance notes

- This changes chain order for nested vaults, which is the point. If a
  `--dry-run` golden output is ever added under `test/`, it will need regenerating.
- Reviewer should scrutinize: the `'.'` root sentinel path, and that `compareDirs`
  is a strict weak ordering (no inconsistent comparator for mixed numbered /
  unnumbered siblings) — `Array.prototype.sort` silently produces garbage
  otherwise.
- **Follow-up, deliberately deferred**: add a CLI-level deep-tree fixture to
  `test/cli-adopt-autochain.test.ts` (three files across
  `MODULES/01-foundations/09-labs/` and `MODULES/02-linux/`). Kept out of this
  plan so the engine fix stays reviewable in one commit.
