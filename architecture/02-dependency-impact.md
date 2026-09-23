# PALEE CLI — dependency structure, coupling and change blast radius

**Route:** `architecture-visualization` → `dependency-impact-analyzer` + `graphviz`.
**Question this answers:** *what depends on what, and if I touch this file, what else can break?*
**Basis:** the 216-edge static import graph in [`_evidence/import-graph.json`](_evidence/import-graph.json). Regenerate with `node scripts/arch-import-graph.cjs`, re-render views with `node scripts/arch-render-dot.cjs`.
**Diagram sources:** [`dependency-graph.dot`](dependency-graph.dot) (all 60 modules, clustered by layer), [`layer-summary.dot`](layer-summary.dot) (layer aggregation), [`boundary-exceptions.dot`](boundary-exceptions.dot).

> **Note on direction.** "Dependents" below = modules that transitively import the module in question, i.e. the code that a change to it can silently affect. "Reaches" = the module's own transitive dependencies, i.e. how much machinery a change to it must be reasoned about against.

## Headline: the layering is clean

- **0 circular imports.** Tarjan SCC over all 60 modules returned no component larger than one node. For a codebase this size that is an achievement worth pinning, and it is the reason `agent.md`'s verification loop (`typecheck → lint → test → build → pack`) can be trusted to localise failures.
- **0 forbidden-direction edges.** Against the layer rules in `agent.md:9-16` (`engine` pure; `storage` owns vault IO; `cli` on top; `types` shared) every one of the 216 edges points the documented way. Nothing in `src/engine`, `src/storage` or `src/validation` imports `src/cli`.
- The exceptions are *not* import-direction violations — they are **IO** and **facade** violations. See the last two sections.

## Layer dependency summary

```
bin/palee.ts ──12──▶ src/cli ──22──▶ src/validation ──12──▶ src/storage ──9──▶ src/types
                       │ 11                │ 7                  ▲
                       │                   ▼                    │
                       ├────10────────▶ src/storage             │
                       └────8─────▶ src/engine ◀────(validation also depends on engine)
src/index.ts (public barrel) ──▶ types, engine, storage, validation   (src/root → 3 layers)
```

Numbers are import-edge counts between layers. Cohesion within a layer: `validation` 54, `cli` 31, `storage` 27, `engine` 4.

The shape is a **DAG with one shared base** (`src/types`) and **one wide consumer** (`src/validation`, which sits on top of both `storage` and `engine`). `src/engine` is a near-leaf: 5 modules, 1430 lines, exactly 2 outbound edges, both to `src/types`. That is the structural expression of "pure logic".

## Coupling hotspots — ranked by blast radius

| Module | Lines | Direct importers | Transitive dependents | Why it is on this list |
| --- | --- | --- | --- | --- |
| `src/types.ts` | 734 | 26 | **51 of 59** (86 %) | Single shared contract. Any export rename or shape change is a repo-wide change. |
| `src/storage/frontmatter.ts` | 160 | 8 | 45 | `computeFingerprint` + `parseFrontmatter` + `updateFrontmatter` sit under every write path and under `FileCache`. |
| `src/storage/lock.ts` | 529 | 2 | 41 | Only 2 direct importers, but it is on the critical path of every write, so reach is nearly total. |
| `src/storage/vault-walker.ts` | 289 | 4 | 41 | Every command that scans the vault. |
| `src/storage/atomic-write.ts` | 191 | 2 | 40 | Same story as `lock`: small fan-in, universal consequence. |
| `src/validation/types.ts` | 159 | **23** | 25 | Highest direct fan-in after `src/types.ts`. The `ValidationRule`/`ValidationIssue` contract. |
| `src/engine/mastery.ts` | 192 | 8 | 15 | `MASTERY_THRESHOLD` + `computeTopicMastery`/`resolveTopicMastery`, shared by CLI *and* a validation rule. |
| `src/cli/exit-codes.ts` | 39 | 12 | 12 | 39 lines, every handler. Contract, not logic — but its change is a CI-wide change. |
| `src/cli/config.ts` | 225 | 11 | 11 | `loadConfig()` is the documented first statement of every reading handler. |

**The asymmetry to keep in mind:** fan-in and blast radius are not the same number. `atomic-write.ts` has 2 direct importers and 40 transitive dependents. A reviewer looking only at "who imports this?" will under-rate it. Conversely `src/storage/index.ts` (11 importers, 14 dependents) looks important in fan-in terms and is mostly a pass-through.

## Per-command reach

| Command handler | Modules it reaches | cli | storage | validation |
| --- | --- | --- | --- | --- |
| `src/cli/validate.ts` | **45** | 3 | 13 | 25 |
| `src/cli/review.ts` | 19 | 3 | 13 | 0 |
| `src/cli/plan.ts` | 19 | 3 | 13 | 0 |
| `src/cli/adopt.ts` | 18 | 3 | 13 | 0 |
| `src/cli/session.ts` | 17 | 3 | 13 | 0 |

`validate` reaches **2.4× more modules than any other command** and is the only command that pulls in the validation subsystem at all. Every other command bottoms out at 13 storage modules + 3 cli helpers + engine. Two consequences:

1. `validate` is the natural canary for storage-contract regressions — it exercises the largest surface.
2. It is also the command most likely to be *blamed* for an unrelated change, because a rule's view of the data and the loader's view of the data both travel through it.

## Two structural frictions (measured, not stylistic)

### 1. `src/cli/validate.ts` is the widest module in the repo (fan-out 26)

`src/cli/validate.ts` imports `collectVault`, `runRules`, both formatters, `ValidationRule`, and then **each of the 19 rules individually** (`src/cli/validate.ts:13-31`), and builds the ordered `VALIDATION_RULES` array at `:42-77`.

`src/validation/index.ts` already re-exports exactly that catalog — with the comment *"registration order mirrors src/cli/validate.ts"* (`src/validation/index.ts:55`) — and is imported by **only** `src/index.ts`.

So the rule catalog is maintained in two places, and the second one exists solely to publish the npm surface. Adding rule #20 means editing: the new rule file, `src/validation/index.ts`, `src/cli/validate.ts` (import + array position), and `test/validation-barrel-census.test.ts` (which ADR-0008:59 says pins the count). The `validation/index.ts` barrel is imported by exactly one module: `src/index.ts`.

The `src/validation/index.ts:55` comment ("registration order mirrors src/cli/validate.ts") is a **manual synchronisation note**, not an enforced invariant: nothing in `typecheck`, `lint`, or the barrel-census test would fail if the barrel's *order* drifted, because today only the CLI's array order determines output order. The duplication is real regardless. Confidence: high for the duplication itself; medium for "and therefore drift is likely" — the barrel's order has no functional consumer today, so a drift would be latent rather than immediately visible.

### 2. The engine facade is bypassed by every consumer except the package barrel

`src/engine/index.ts` exports 17 symbols and is imported by exactly one module (`src/index.ts`). All 8 real CLI→engine edges are deep:

```
src/cli/adopt.ts:23     -> src/engine/mastery
src/cli/dashboard.ts:6  -> src/engine/mastery
src/cli/plan.ts:9       -> src/engine/dependency
src/cli/plan.ts:10      -> src/engine/mastery
src/cli/progress.ts:9   -> src/engine/mastery
src/cli/review.ts:11    -> src/engine/sm2
src/cli/review.ts:12    -> src/engine/mastery
src/cli/roadmap.ts:21   -> src/engine/dependency
```

`src/storage` is the counter-example: 10 of 12 CLI modules import it *through* `src/storage/index.ts`. So "go through the facade" is a convention that holds in exactly one of three layers. This is not a bug — deep imports are how you keep `engine/index.ts` from becoming a re-export tax — but it does mean **any doc that draws CLI commands attaching to the engine facade is drawing something that does not exist** (see finding `D6` in the audit).

## Where writes can go wrong: the IO duplication

`src/storage/atomic-write.ts:20-24` and `src/storage/lock.ts:43-47` each declare the same five Windows retry constants (`WINDOWS_RETRY_ATTEMPTS=5`, `_INITIAL_DELAY=50`, `_MULTIPLIER=2`, `_JITTER=0.25`, `_MAX_DELAY=300`). Two tunables for the same platform behaviour, in two files, with no shared source and no test that asserts they agree. A future "increase Windows retry budget" change that edits one file only will produce a lock layer and a write layer with different retry semantics — which is precisely the class of bug the retry loop exists to prevent. Confidence: high (both literal blocks read off source).

Separately, `src/cli/config.ts:104-126` re-implements atomic writing (`mkdirSync` → `openSync` temp → write → `renameSync` → `unlinkSync` cleanup) for the config file, without `Lock`, without a fingerprint, and without `fsyncSync`. It is outside the vault, so the *narrow* vault invariant still holds; the *broad* "No raw `fs` outside storage" claim does not. Details in `03-docs-audit-findings.md`, finding `D2`.

## Change-impact playbook

| You are changing… | Blast radius | Minimum verification |
| --- | --- | --- |
| an export or field in `src/types.ts` | up to 51 modules | `npm run typecheck` is authoritative here; then full `npm test` |
| `src/storage/frontmatter.ts` / `atomic-write.ts` / `lock.ts` | every write path (≈40 modules) | `npm run test:fast` **plus** `test/stress-concurrency.test.ts` and `test/fault-injection.test.ts`; both platforms matter (Windows retry paths) |
| `src/engine/dependency.ts` | 15 modules via `plan`/`roadmap`/graph rules | `test/engine-dependency.test.ts`, `test/validation-*` cycle rules; check the #79 quarantine semantics still hold |
| `MASTERY_THRESHOLD` in `src/engine/mastery.ts` | 15 modules — CLI *and* `valid-topic-mastery` rule | `test/engine-mastery.test.ts` + `test/engine-dependency.test.ts` (readiness gate uses the same 0.7) |
| adding a validation rule | `src/cli/validate.ts` registry + `src/validation/index.ts` + the barrel census test | `test/validation-barrel-census.test.ts` will fail on a count change; output *order* is not automatically checked |
| a command's `--json` shape | consumers + `test/cli-json-output.test.ts` | that suite plus `docs/06-2`'s command matrix, which is hand-maintained |
| `src/cli/exit-codes.ts` | `bin` + all 11 handlers, and CI asserts on codes | `test/cli-exit-codes.test.ts`; re-read README's exit-code table and `agent.md:24` |

## Unknowns worth resolving before relying on this view

- **Runtime reach is not measured here.** This is a static import graph; it cannot show which rules a given vault actually fires, or how often the lock retry loop engages. `coverage/` exists in the repo and would close part of that gap.
- **The `windows-*` CI matrix cannot be observed from this machine**, so the Windows-specific retry and stale-lock paths are asserted from code reading and the tests named in `docs/06-1`, not from a green run.
- Whether the deep-import style is *intended* or simply how the code grew is not recorded in any ADR. ADR-0006 documents the storage barrel as a deliberate isolation move; no ADR covers the engine or validation barrels. That asymmetry is the single cheapest thing to settle, and it changes the recommendation in finding `D6` from "fix the docs" to "fix the code".
