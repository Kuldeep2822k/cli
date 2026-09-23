# Plan 006: Make `adopt --auto-chain` bridge to already-adopted notes, or stop claiming it does

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. **This plan has a decision point in Step 0 — resolve it before
> writing code.** If you cannot resolve it, stop and report.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/cli/adopt.ts src/engine/auto-chain.ts test/cli-adopt-autochain.test.ts`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (variant A) | S (variant B)
- **Risk**: MED
- **Depends on**: plan 001 (ancestor-aware ordering) — do not start before it is DONE
- **Category**: bug / spec-alignment
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

Two places in PR #204 promise that auto-chain bridges over already-adopted
notes:

```
CHANGELOG.md:11          "...bridges modules and excluded/already-adopted notes..."
docs/03-2-dependency-graph-engine.md:235
                         "...bridging modules and excluded/adopted notes..."
docs/02-1  §4 item 2     "Excluded or already-adopted notes are bridged over, never rewritten."
```

It does not. This was reproduced: a vault where `MODULES/01-foundations/01-sys.md`
is already adopted (`palee_id: T-EXISTING-1`), then
`palee adopt MODULES --auto-chain --yes` writes
`01-foundations/02-lab.md → depends_on: []` and
`02-linux/01-kern.md → depends_on: [02-lab]`, reporting "Auto-chained: 1
dependency edges wired across 2 notes". `02-lab` was never linked to
`T-EXISTING-1`. The chain restarts at the first note of each batch.

Half the promise is true: `--exclude`d notes *are* bridged over correctly, and a
passing test proves it (`test/cli-adopt-autochain.test.ts:187`). Already-adopted
notes are not, because the plan is computed only over notes being adopted.

The consequence is practical, not cosmetic. Issue #73's motivating workflow is a
300-note curriculum adopted folder by folder. Each run produces a chain head with
no prerequisite, so incremental adoption silently yields a forest of
disconnected chains in a tool whose entire purpose is a prerequisite graph. There
is no user-facing signal: the summary line even reports success.

A dead branch in the code suggests the author intended to handle this and it was
never wired up (`src/cli/adopt.ts:391-399`, quoted below): its "out of scope
predecessor" warning is unreachable, because `predecessorOf` values are always
drawn from the same path set as `idByPath`.

## Current state

- `src/cli/adopt.ts` — the `adopt` handler; owns the batch scan and the
  two-phase writer.
- `src/engine/auto-chain.ts` — pure planner; **must stay fs-free** (`agent.md:11`).
- `src/storage/loader.ts` — `loadTopics(vaultPath)` returns existing topics.
- `test/cli-adopt-autochain.test.ts` — CLI integration tests with a
  temp-vault + `PALEE_CONFIG_DIR` harness.

Step 1 of the scan drops already-adopted notes before planning
(`src/cli/adopt.ts:320-330`):

```ts
    for (const filePath of allFiles) {
      const relPath = relativeVaultPath(vaultPath, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      // Check already adopted
      if (frontmatter && frontmatter.palee_id) {
        alreadyAdopted.push(relPath);
        continue;
      }
```

`alreadyAdopted` is therefore a `string[]` of **vault-relative POSIX paths**, in
scope, at the point where the plan is built. That is the missing input.

The plan block (`src/cli/adopt.ts:366-405`, abridged — this is the code you
change in variant A):

```ts
    let chainPlan: ChainPlan | null = null;
    const chainDependsOn = new Map<string, string[]>();
    if (options.autoChain && toAdopt.length > 0) {
      // Mint IDs up front: the planned graph is keyed by palee_id.
      const idByPath = new Map<string, string>();
      for (const note of toAdopt) {
        note.topicId = generateTopicId();
        idByPath.set(note.relativePath, note.topicId);
      }

      chainPlan = planAutoChain(toAdopt.map((n) => n.relativePath));
      ...
      const plannedGraph = new Map<string, TopicNode>();
      for (const relPath of chainPlan.orderedPaths) {
        const id = idByPath.get(relPath);
        if (!id) {
          continue;
        }
        const predecessorPath = chainPlan.predecessorOf.get(relPath) ?? null;
        const predecessorId = predecessorPath ? idByPath.get(predecessorPath) : undefined;
        const dependsOn: string[] = [];
        if (predecessorId) {
          dependsOn.push(predecessorId);
        } else if (predecessorPath) {
          console.log(
            `⚠ Warning: chain predecessor ${predecessorPath} is out of scope; ` +
              `${relPath} keeps an empty depends_on.`
          );
        }
        chainDependsOn.set(relPath, dependsOn);
        plannedGraph.set(id, { palee_id: id, depends_on: dependsOn, topic_mastery: 0 });
      }
```

Writes consult `chainDependsOn` **only for notes in `toAdopt`**
(`src/cli/adopt.ts:550`):

```ts
        depends_on: options.autoChain ? (chainDependsOn.get(note.relativePath) ?? []) : [],
```

`LoadedTopic` (`src/storage/loader.ts:36-49`) gives you what variant A needs:

```ts
export interface LoadedTopic extends TopicNode {
  id: string;
  title: string;
  /** Relative POSIX path from the vault root */
  path: string;
  /** Absolute filesystem path to the Markdown note */
  filePath: string;
  ...
}
```

Existing merged-graph context, just after the block above
(`src/cli/adopt.ts:~406-415`), already calls `loadTopics(vaultPath)` to pull
existing topics into `plannedGraph` for cycle checking — reuse that call, do not
make it a second one.

## The decision (Step 0) — RESOLVED

**RESOLVED 2026-09-22: the operator authorized Variant A (implement the
bridge).** Do not re-litigate it; skip the choice and execute "Steps — Variant
A". Leave Variant B in this file as the recorded alternative, but do not run its
steps.

For context on what A commits you to:

**Variant A (authorized): implement the bridge.** Change the planner input from
"notes to adopt" to "notes to adopt **plus** notes already adopted that are
inside the scanned scope", then keep writes restricted to `toAdopt`. This is
small, and `alreadyAdopted` already holds exactly the right path set. It makes
all three doc claims true and makes incremental adoption work.

**Variant B (not chosen): de-scope the claim.** Keep behaviour, delete the false
promises: reword `CHANGELOG.md:11`, `docs/03-2:235`, and `docs/02-1` §4 item 2 to
say bridging applies to `--exclude`d notes only, and that an already-adopted note
is not linked to — the chain restarts at each batch. Also delete the unreachable
warning at `src/cli/adopt.ts:395-399`, and add a note to
`planning/invariants.md` INV-46 recording the limitation so the next contributor
does not re-add the claim.

The accepted tradeoff of A, which the reviewer will verify fails closed: an
already-adopted note inside the scan scope becomes a real chain predecessor, so a
pre-existing cycle that runs through it can now block adoption of unrelated new
notes in that scope. That must surface as exit `3` with zero writes, never as a
partial write.

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| Adopt CLI | `node --import tsx --test test/cli-adopt-autochain.test.ts`         | all pass, 0 fail    |
| Engine    | `node --import tsx --test test/engine-auto-chain.test.ts`           | all pass, 0 fail    |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |

## Scope

**In scope** (the only files you should modify):
- Variant A: `src/cli/adopt.ts`, `test/cli-adopt-autochain.test.ts`
- Variant B: `src/cli/adopt.ts`, `CHANGELOG.md`,
  `docs/03-2-dependency-graph-engine.md`, `docs/02-1-topic-management-commands.md`,
  `planning/invariants.md`, `test/cli-adopt-autochain.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `src/engine/auto-chain.ts` — `planAutoChain` takes a path array and needs no
  change in either variant. It must remain fs-free.
- `src/cli/roadmap.ts` / `src/storage/wikilink.ts` — plans 002 and 005.
- The two-phase writer and rollback journal (`src/cli/adopt.ts:510-606`) —
  correct as implemented; do not "improve" it.
- Any behaviour for `--exclude`d notes. `test/cli-adopt-autochain.test.ts:187`
  proves the current behaviour is right and must keep passing.

## Git workflow

- Work on the open PR branch `feat/73-auto-chain`.
- Commit style, variant A: `fix(cli): bridge auto-chain across already-adopted notes (#73)`
- Commit style, variant B: `docs: correct --auto-chain bridging claim to excluded notes only (#73)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps — Variant A (implement the bridge)

Skip this whole section if you chose B.

### A1: Add the failing regression test

In `test/cli-adopt-autochain.test.ts`, add a test modelled on the existing
`'excluded notes are bridged over in the chain'` at line 187 — same
`freshVault` / `runCLI` / `idToPath` / `dependsOn` helpers.

Fixture: `MODULES/01-foundations/01-sys.md` pre-adopted with a known
`palee_id: T-EXISTING-1` and `palee_schema: 1` frontmatter;
`MODULES/01-foundations/02-lab.md` and `MODULES/02-linux/01-kern.md` unadopted.
Run `adopt MODULES --auto-chain --yes`. Assert:

- `02-lab.md` depends on exactly `['T-EXISTING-1']` — the bridge
- `01-kern.md` depends on `02-lab`'s minted id
- `01-sys.md`'s frontmatter is **byte-identical** to the fixture (read the file
  before and after and compare; this is the "never rewritten" guarantee, and no
  existing test asserts it at byte level)

**Verify**: `node --import tsx --test test/cli-adopt-autochain.test.ts`
→ the new test **FAILS**, with `02-lab.md` reporting `depends_on: []`.

### A2: Include in-scope adopted notes in the plan

In `src/cli/adopt.ts`, inside the `if (options.autoChain && toAdopt.length > 0)`
block, build the planner input as the union of `toAdopt` paths and
`alreadyAdopted` paths, and seed `idByPath` for the adopted ones from the
existing `loadTopics(vaultPath)` result, keyed on `LoadedTopic.path`
(vault-relative POSIX) mapping to `LoadedTopic.id`.

Order matters: compute the union, then `planAutoChain(unionPaths)`, then derive
`chainDependsOn` **only for paths present in `toAdopt`** — the write loop looks
the map up per note, so entries for adopted notes are inert by construction, but
do not add them to `chainDependsOn` anyway, to keep the map's meaning exact.

Do **not** mint new ids for adopted notes, and do not add them to
`plannedGraph` twice — the existing merge loop already inserts them guarded by
`if (!plannedGraph.has(topic.id))`.

**Verify**: `node --import tsx --test test/cli-adopt-autochain.test.ts` → the
new test passes and `'excluded notes are bridged over in the chain'` still
passes **unchanged**. If you find yourself editing that test, STOP — you have
swept `--exclude`d notes into the plan, which is wrong.

### A3: Make the edge count honest

`src/cli/adopt.ts:592-598` counts edges from `chainDependsOn.values()`. Confirm
it still reports only edges written for adopted notes after A2, and that the
`--dry-run` chain print (`:472-482`) shows the bridged edge — the dry-run is how
a user verifies this before committing, so a bridge that appears on write but
not in dry-run is a defect.

**Verify**: run the dry-run path in a new assertion in the A1 test
(`adopt MODULES --auto-chain --dry-run`) and `assert.match(result.stdout, /01-sys/)`
— the plan preview must name the adopted predecessor.

### A4: Reconcile the docs

The three doc sentences become true, so no rewording is needed — but add
`planning/invariants.md` INV-46 a clause: the plan spans notes already adopted
within the scanned scope, and such notes are used as predecessors but never
rewritten. There is a test asserting invariant ID format
(`test/planning-invariant-ids.test.ts`); keep INV-46 as one bullet.

**Verify**: `node --import tsx --test test/planning-invariant-ids.test.ts` → pass.

## Steps — Variant B (de-scope the claim)

Skip this whole section if you chose A.

### B1: Delete the unreachable branch

Remove `src/cli/adopt.ts:395-399` (the `else if (predecessorPath)` warning).
It cannot fire: every `predecessorOf` value is an element of the input path set,
which is the same set `idByPath` is keyed by. Verify that reasoning against the
live code before deleting; if you cannot prove it unreachable, STOP.

Also reconsider `:387-389`'s `if (!id) continue` — it is the only silent
no-op path. Change it to `throw new Error(...)` naming the unmatched path so a
future key-space mismatch fails loudly instead of degrading to
"adopt everything with `depends_on: []`". If it cannot be reached, delete it and
say so in the commit message.

### B2: Correct the three claims

- `CHANGELOG.md:11` — replace "bridges modules and excluded/already-adopted
  notes" with wording that says bridging spans `--exclude`d notes, and that
  adoption restarts the chain at each batch because already-adopted notes are
  never relinked.
- `docs/03-2-dependency-graph-engine.md:235` — same correction, in the table's
  existing terse style.
- `docs/02-1-topic-management-commands.md` §4 item 2 — "Excluded notes are
  bridged over; already-adopted notes are neither rewritten nor linked to, so
  each `--auto-chain` run starts a new chain."

### B3: Record the limitation as an invariant

Append to INV-46 (keeping it a single bullet): the auto-chain plan covers only
notes adopted by the current invocation, so an already-adopted note is never a
chain predecessor.

**Verify**: `node --import tsx --test test/planning-invariant-ids.test.ts` → pass.

### B4: Add the test that documents the behaviour

In `test/cli-adopt-autochain.test.ts`, add a test asserting the *current*
behaviour explicitly — with a pre-adopted interior note, the first adopted note
of the next group has `depends_on: []`. A named, tested limitation is worth more
than a prose promise.

**Verify**: `node --import tsx --test test/cli-adopt-autochain.test.ts` → all
pass, including 1 new.

## Test plan

- Variant A: 1 new CLI test (bridge + byte-identical untouched adopted note) and
  a dry-run preview assertion; the existing excluded-note test must pass
  untouched.
- Variant B: 1 new CLI test pinning the restart behaviour as documented.
- Verification in both cases: `node --import tsx --test "test/**/*.test.ts"` →
  `ℹ fail 0`.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0`
- [ ] The variant chosen in Step 0 is named in the commit message
- [ ] Variant A: a pre-adopted note inside the scan scope appears as the
      `depends_on` predecessor of the first new note that follows it, asserted by
      a passing test, and that note's file bytes are unchanged
- [ ] Variant B: `grep -rn "already-adopted notes are bridged\|excluded/already-adopted\|excluded/adopted" CHANGELOG.md docs/` returns **no** match
- [ ] `test/cli-adopt-autochain.test.ts`'s existing
      `'excluded notes are bridged over in the chain'` test passes unmodified
      (variant A) or is accompanied by the new limitation test (variant B)
- [ ] `git diff --name-only` lists only in-scope files for the chosen variant
- [ ] `plans/README.md` status row for 006 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- You are executing Variant B. Variant B was **not** authorized — the operator
  chose A on 2026-09-22. If you reached these steps, STOP and re-read Step 0.
- `alreadyAdopted` turns out not to be in scope at the plan block (it is built in
  the scan loop above it — confirm the variable is live where you need it).
- The existing `'excluded notes are bridged over in the chain'` test fails under
  variant A. Mixing excluded and already-adopted notes into one path set is the
  central hazard of this plan; if they cannot be separated cleanly, STOP.
- Bridging creates a cycle for some fixture — plausible when an adopted note
  already depends on a note that the new batch would chain to. Variant A must
  then fail closed with exit 3, and you must verify it does rather than
  special-casing it away.
- You cannot prove `src/cli/adopt.ts:395-399` unreachable (variant B step B1).

## Maintenance notes

- Variant A makes `planAutoChain`'s input "the curriculum being laid", not "the
  rows being inserted". Any future partial-scope flag (`--include`, `--tag`)
  must decide explicitly whether matched-but-untouched notes join the plan;
  this is the seam where that question will come back.
- **CORRECTED after execution — this claim was false and must not be repeated.**
  I wrote that under Variant A "a pre-existing cycle that includes an in-scope
  adopted note can block adoption more often." It cannot. The merge loop already
  called `loadTopics(vaultPath)` over the **whole vault**, so any vault cycle
  already blocked `--auto-chain` before this change; and a cycle created *by* the
  bridge edge is unconstructible, because the successor's id is minted at plan
  time and no pre-existing edge can name it. Verified by the executor: its new
  cycle test passes against the pre-fix `adopt.ts` too, so it is a guard against
  future suppression of the check, not a regression test for this change.
- The one genuinely load-bearing subtlety, which the plan did not anticipate: an
  already-adopted note must get **no** `plannedGraph` node from the chain loop.
  Because the merge loop is guarded by `if (!plannedGraph.has(topic.id))`,
  inserting the adopted note there with a chain-derived `depends_on` would
  replace its real on-disk edges and could **mask** a cycle. The implementation
  gates the chain-loop body on a `toAdoptPaths` set for exactly this reason.
- Reviewer should scrutinize the id source: an existing note's id must come from
  `loadTopics` (`LoadedTopic.id`), never from a freshly minted
  `generateTopicId()`.
