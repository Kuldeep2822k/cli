# ADR-0007: Hot-Memory Read-State Contract

## Status
Accepted

## Context
`planning/memory_design.md` defines `.palee/hot.md` as a derived working-memory view that must be tolerant of external edits (Obsidian, sync daemons, manual text editing). ADR-0006 established the write side of that contract — `resetHotMemory`, `rebuildHotAndIndex`, `updateHotMemory` in `src/storage/memory.ts`, all behind the `src/storage/index.ts` facade.

The read side was never owned. Until #130, `src/cli/session.ts` hand-rolled its own `parseFrontmatter` on hot.md content at six call sites, and each site re-implemented its own notion of what a "bad" read looked like. When those sites were consolidated behind a single `readHotMemory()` accessor (#130), the classification itself became an exported contract (`HotMemoryReadState`) without ever being formally decided — first flagged in #145 review.

One semantic question was left implicit: which `palee_schema` values count as supported. The pre-accessor code checked truthiness (`!frontmatter.palee_schema`), so `palee_schema: 2`, `true`, and `"1"` all classified as `ok`. That is inconsistent with the rest of the codebase: `palee migrate` rejects non-v1 schemas as unrecognized, ADR-0005's migration path converges notes on `palee_schema: 1`, and every hot-memory writer pins version `1` (`HotMemoryData`).

## Decision
`readHotMemory(vaultPath)` classifies `.palee/hot.md` into exactly five states and enforces the accessor boundary:

1. **Five-state classification** (`HotMemoryReadState`):
   - `ok` — frontmatter parses and carries `palee_schema: 1`.
   - `schema-invalid` — frontmatter parses but `palee_schema` is absent **or not the supported version**. Strict equality (`=== 1`) rejects `2`, `true`, and `"1"`; tolerant fields are still exposed for policy-free inspection.
   - `no-frontmatter` — no parsable fences (absent, or `---\n---` empty fence).
   - `corrupt` — fences present, YAML parse failed.
   - `missing` — file does not exist (`ENOENT`).

2. **Accessor boundary** (unchanged from #130): `ENOENT` maps to `missing`; **all other filesystem errors are thrown**, so callers keep deciding whether to swallow; unknown frontmatter keys are ignored, never rejected; no rebuild, no mutation, no output. The read joins `.palee/hot.md` directly rather than via `getPaleeDir()` (which creates the directory) — a read must never have that side effect.

3. **Session policy stays in the CLI layer**, deliberately un-normalized because the flows are intentionally different:
   - topic resolution swallows every read failure → null
   - `session start` rebuilds `corrupt`/`schema-invalid`, tolerates `no-frontmatter` without rebuilding, propagates non-`ENOENT` errors to the command catch (exit 5)
   - `session draft` / `session end` keep their own age/skew rules (24h/no-future; no age limit + 60s future-skew clamp)

4. **Compatibility boundary**: only `palee_schema: 1` is supported. A v2 (or foreign) hot.md is `schema-invalid`, so `session start` rebuilds it from the newest confirmed session rather than trusting derived state it cannot interpret — matching `memory_design.md`'s rule that a missing **or invalid** hot.md is rebuilt, and ADR-0005's stance that unknown schema versions are not silently consumed.

## Consequences

### Positive
- The derived file's schema finally has a single read-side owner; adding a hot.md field touches `memory.ts` and `types.ts`, not six scattered parsers.
- `session start` no longer trusts a v2 hot.md whose fields it may misinterpret; it self-heals via the documented rebuild path.
- Callers keep their deliberately different policies — the accessor is classification, not a hidden session-policy object.

### Negative / Tradeoffs
- `session start` rebuilds a hot.md that a hypothetical future schema version wrote. That is intended (rebuild is lossless: hot.md is derived from confirmed sessions), but the rebuild discards body text of the invalid file. Characterization tests pin the rebuild path so the tradeoff stays visible.

## Alternatives Considered

1. **Keep the pre-accessor truthiness check** (behavior-preservation only):
   - *Why Rejected*: `palee_schema: 2` classified as `ok`, letting `session start` skip the rebuild the design doc mandates for invalid files. Preserving a bug through a refactor was worse than fixing it; the fix is pinned by its own tests.
2. **Consume-and-upgrade unknown schema versions on read** (ADR-0005's `migrate --fix` pattern, applied to hot.md):
   - *Why Rejected*: read-path mutation violates the accessor boundary and the read-only idempotency invariant ADR-0005 established for read commands. hot.md is derived and rebuildable; self-healing via rebuild needs no upgrade path.
3. **Move session policy into the accessor** (return e.g. a "shouldRebuild" verdict):
   - *Why Rejected*: collapses deliberately different caller policies into one, exactly what #130 flagged as the original smell.
