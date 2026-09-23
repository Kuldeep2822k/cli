# Plan 005: Stop `--auto-chain` from fusing independent wikilink tracks, and un-overload `depends_on: []`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/cli/roadmap.ts src/storage/wikilink.ts src/types.ts test/cli-roadmap-wikilink.test.ts planning/invariants.md`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

`palee roadmap --auto-chain` on a two-track wikilink roadmap writes a dependency
from the second track's first note onto the first track's last note. Independent
learning tracks silently collapse into one chain, in the vault, on disk. This
was reproduced: `MODULES/02-advanced/01-gamma.md` was written with
`depends_on: [<id of 01-foundations/02-beta.md>]`.

The documented contract already forbids this — `docs/02-1` states
`--auto-chain` chains "YAML/frontmatter/codeblock topics". The code ignores the
format.

The root cause is a type-boundary problem, not a missing `if`: `depends_on: []`
means two different things at the same time. For the roadmap importer it means
"clear this note's prerequisites" (the #137 rule, live at
`src/cli/roadmap.ts:117`). For `applyRoadmapAutoChain` it means "this topic has
not been chained yet". `resolveWikilinkRoadmap` emits `[]` for every section head
with the first meaning; `applyRoadmapAutoChain` reads it with the second. This
plan fixes the behaviour and removes the ambiguity that caused it, so the next
caller cannot make the same mistake.

## Current state

- `src/cli/roadmap.ts` — the `roadmap` command handler.
- `src/storage/wikilink.ts` — resolves wikilink sections into a `RoadmapFile`.
- `src/types.ts` — shared types; per `agent.md:9` this is
  "single source of truth for shared types".
- `planning/invariants.md` — INV-46/47/48 were added by PR #204 (lines 69-73).

`applyRoadmapAutoChain` (`src/cli/roadmap.ts:38-54`) — note line 49:

```ts
function applyRoadmapAutoChain(topics: RoadmapTopic[]): void {
  const indexed = topics.map((topic, index) => ({ topic, index }));
  indexed.sort((a, b) => {
    const orderA = a.topic.order ?? Number.POSITIVE_INFINITY;
    const orderB = b.topic.order ?? Number.POSITIVE_INFINITY;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.index - b.index;
  });
  indexed.forEach(({ topic }, rank) => {
    if (!topic.depends_on || topic.depends_on.length === 0) {
      topic.depends_on = rank === 0 ? [] : [indexed[rank - 1].topic.id];
    }
  });
  console.log(`Auto-chain: ${topics.length} roadmap topics chained by order.`);
}
```

The call site ignores format (`src/cli/roadmap.ts:171-193`, abridged):

```ts
    let roadmap: RoadmapFile;
    if (parseResult.format === 'wikilink') {
      // Wikilink format (#73, INV-48): resolve [[...]] chains against the vault.
      // Ambiguous/unresolved targets fail closed here (exit 3) with zero writes.
      try {
        roadmap = resolveWikilinkRoadmap(vaultPath, parseResult.sections ?? []);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 3;
        return;
      }
      console.log(`Resolved ${roadmap.topics.length} wikilink topics from ${roadmapPath}`);
    } else {
      ...
      roadmap = parseResult.roadmap;
    }

    if (options.autoChain) {
      applyRoadmapAutoChain(roadmap.topics);
    }
```

Where `[]` is produced (`src/storage/wikilink.ts:220-228`):

```ts
      topics.push({
        id,
        title,
        path: resolved.relativePath,
        depends_on: previousId ? [previousId] : [],
        order: order++,
      });
      previousId = id;
```

And the two texts that are currently wrong or incomplete:

```
planning/invariants.md:72  INV-47 — `roadmap --auto-chain` chains topics by their
                           `order` field (...); an explicit non-empty
                           `depends_on` always wins over the synthesized chain.
src/storage/wikilink.ts:180-181  "`order` is assigned sequentially so
                           `roadmap --auto-chain` reproduces the same chain."
```

The #137 depends_on rule, for reference (`src/cli/roadmap.ts:117`, inside
`resolveTopicUpdates`): `depends_on: topic.depends_on ?? existingById?.depends_on ?? []`
— a **present** `[]` clears; an **absent** field preserves.

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| CLI test  | `node --import tsx --test test/cli-roadmap-wikilink.test.ts`        | all pass, 0 fail    |
| Storage   | `node --import tsx --test test/storage-wikilink.test.ts`            | all pass, 0 fail    |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |

## Scope

**In scope** (the only files you should modify):
- `src/cli/roadmap.ts`
- `src/storage/wikilink.ts`
- `src/types.ts` (only if Step 2 adds a field to `RoadmapTopic`)
- `test/cli-roadmap-wikilink.test.ts`
- `planning/invariants.md` (INV-47 wording only)

**Out of scope** (do NOT touch):
- `src/storage/roadmap-parser.ts` — heading scope is plan 004, format gating is
  plan 003.
- `src/cli/adopt.ts` — a different auto-chain implementation.
- `src/engine/auto-chain.ts`.
- `docs/*` — reconciled in plan 007 so the docs and invariants land in one
  pass; but do read `docs/02-1` §"Wikilink Roadmap" and the `roadmap` options
  table before starting, because that table is what makes Step 3 correct.
- The per-topic import loop (lines 329-409) — atomicity is plan 006's question.

## Git workflow

- Work on the open PR branch `feat/73-auto-chain`.
- Commit style: `fix(cli): keep --auto-chain out of the wikilink roadmap format (#73)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing regression test

In `test/cli-roadmap-wikilink.test.ts`, add a test with a **two-section**
wikilink roadmap and `--auto-chain`, asserting the second track's head has an
empty `depends_on`. The file already has a vault-builder and CLI-runner helper —
reuse them; read them before writing.

Model:

```ts
  test('--auto-chain does not fuse independent wikilink tracks', () => {
    const { vaultDir, configDir } = freshVault({
      'MODULES/01-foundations/01-alpha.md': '# Alpha\n',
      'MODULES/01-foundations/02-beta.md': '# Beta\n',
      'MODULES/02-advanced/01-gamma.md': '# Gamma\n',
      'roadmap.md':
        '## Foundations\n- [[MODULES/01-foundations/01-alpha]]\n- [[MODULES/01-foundations/02-beta]]\n\n' +
        '## Advanced\n- [[MODULES/02-advanced/01-gamma]]\n',
    });
    const result = runCLI(['roadmap', '--from', /* <abs path to roadmap.md> */, '--auto-chain', '-y'], configDir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/01-alpha.md'), []);
    assert.deepStrictEqual(dependsOn(vaultDir, 'MODULES/02-advanced/01-gamma.md'), []);
    assert.strictEqual(dependsOn(vaultDir, 'MODULES/01-foundations/02-beta.md').length, 1);
  });
```

Adapt `freshVault` / `runCLI` / `dependsOn` to the helpers this file actually
exports — if there is no `dependsOn` helper, add one modelled on the one in
`test/cli-adopt-autochain.test.ts`, which reads frontmatter via
`parseFrontmatter` from `../src/storage/frontmatter`.

**Verify**: `node --import tsx --test test/cli-roadmap-wikilink.test.ts`
→ expected: the new test **FAILS**, with gamma's `depends_on` containing beta's
`T-…` id. If it passes, STOP.

### Step 2: Remove the `[]` overload at the type boundary

`resolveWikilinkRoadmap` knows, at construction time, which topics are chain
heads. Say so in the data instead of leaving `[]` to be re-interpreted.

Add one optional boolean to `RoadmapTopic` in `src/types.ts`, next to the
existing `depends_on` declaration, with a JSDoc line in the file's style:

```ts
  /** True when this topic's `depends_on` is final and must not be re-chained (#73) */
  chained?: boolean;
```

Set `chained: true` on every topic pushed by `resolveWikilinkRoadmap`
(`src/storage/wikilink.ts:220-226`). Then make `applyRoadmapAutoChain` test
`!topic.chained` instead of `topic.depends_on.length === 0` at line 49:

```ts
    if (!topic.chained && (!topic.depends_on || topic.depends_on.length === 0)) {
```

This keeps INV-47's "explicit non-empty `depends_on` always wins" intact for
YAML roadmaps, and makes the wikilink path unambiguous without a second source
of truth about what `[]` means.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Gate the pass on the format as well

At `src/cli/roadmap.ts:191`, hoist the guard so the intent is explicit at the
call site too — the two checks are belt-and-braces on purpose: Step 2 makes the
data correct, this makes the flow readable, and `docs/02-1`'s options table
already promises exactly this scoping:

```ts
    // --auto-chain is scoped to YAML / frontmatter / code-block roadmaps
    // (INV-47). The wikilink format arrives already chained per `## Track`
    // section, so re-chaining it would fuse independent tracks.
    if (options.autoChain && parseResult.format !== 'wikilink') {
      applyRoadmapAutoChain(roadmap.topics);
    }
```

**Verify**: `node --import tsx --test test/cli-roadmap-wikilink.test.ts` → all
pass, including Step 1's new test.

### Step 4: Fix the two wrong sentences

- `src/storage/wikilink.ts:180-181` — the `@remarks` claims `order` is assigned
  "so `roadmap --auto-chain` reproduces the same chain". Replace with: `order`
  is assigned sequentially for stable display; the chain is final at resolution
  time and `--auto-chain` does not re-chain wikilink output (INV-47).
- `planning/invariants.md` INV-47 — append a clause recording the exemption,
  e.g. "; the wikilink format arrives already chained per `## Track` section and
  is exempt from this pass." Keep the file's existing one-bullet-per-invariant
  format and its `INV-NN` prefix — there is a test
  (`test/planning-invariant-ids.test.ts`) that asserts every bullet matches an
  ID regex, so do not renumber or split INV-47 into two bullets.

**Verify**: `node --import tsx --test test/planning-invariant-ids.test.ts` →
all pass.

### Step 5: Full gates

**Verify**: `npm run typecheck` → exit 0 · `npm run lint` → exit 0 ·
`node --import tsx --test "test/**/*.test.ts"` → `ℹ fail 0`.

## Test plan

- 1 new CLI test (Step 1) — the two-track fusion regression.
- Assert exact `depends_on` arrays, not lengths. `test/cli-adopt-autochain.test.ts`
  is the exemplar for how this repo asserts id-to-path mappings.
- Confirm the existing YAML-roadmap auto-chain test still passes **unchanged**;
  if it had to change, Step 2 broke the YAML path and you must STOP.
- Verification: `node --import tsx --test test/cli-roadmap-wikilink.test.ts` →
  all pass including 1 new; full suite `ℹ fail 0`.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0`
- [ ] `grep -n "format !== 'wikilink'" src/cli/roadmap.ts` returns one match at the auto-chain guard
- [ ] `grep -n "chained" src/types.ts src/storage/wikilink.ts src/cli/roadmap.ts` shows the field declared, set, and consulted
- [ ] The "reproduces the same chain" sentence is gone from `src/storage/wikilink.ts`
- [ ] INV-47 in `planning/invariants.md` names the wikilink exemption, and `test/planning-invariant-ids.test.ts` passes
- [ ] A two-track wikilink roadmap with `--auto-chain` leaves both section heads with `depends_on: []` — asserted by a passing test
- [ ] `git diff --name-only` lists only in-scope files
- [ ] `plans/README.md` status row for 005 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's test already passes.
- Adding `chained` to `RoadmapTopic` requires touching a YAML parser or
  serializer to strip it — then the field leaks into user-facing roadmap files,
  which is out of scope and contradicts "a user roadmap is never silently
  rewritten" (`agent.md:75`).
- `RoadmapTopic` in `src/types.ts` turns out to be a *public input* type that is
  validated field-by-field against an allow-list somewhere; adding an optional
  key could then be rejected as an unknown field. Find the validator before
  proceeding; if one exists, STOP.
- Any pre-existing test other than the ones named here changes behaviour.

## Maintenance notes

- After this, `chained` is the single signal for "this topic's dependencies are
  final". If a third roadmap format is ever added, it sets `chained` too rather
  than inventing a new sentinel.
- Reviewer should scrutinize that `depends_on: []` from a **user-authored YAML**
  roadmap still clears prerequisites (the #137 rule) — that is the behaviour the
  added field must not disturb, and it is why Step 2 keys off `chained` and not
  off emptiness alone.
- Consider, but do not implement here: making `applyRoadmapAutoChain` return the
  chained array instead of mutating `topic` objects in place. In-place mutation
  of parsed input is what let the two meanings of `[]` collide in the first
  place.
