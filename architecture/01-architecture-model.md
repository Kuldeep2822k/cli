# PALEE CLI — current-state architecture model

**Route:** `architecture-visualization` → `system-modeler` (structure and boundaries) + `c4model` (view source).
**Question this answers:** *what is this repo's architecture today, as the imports actually are rather than as the docs describe them?*
**State:** current, Phase 1, `@kuldeep2822k/palee` v0.5.2. Modelled 2026-09-22.
**Canonical diagram source:** [`palee-architecture.dsl`](palee-architecture.dsl) (Structurizr; four views). Dense dependency views: [`dependency-graph.dot`](dependency-graph.dot), [`layer-summary.dot`](layer-summary.dot), [`boundary-exceptions.dot`](boundary-exceptions.dot).
**Confidence labels** follow the plugin evidence contract: **high** = code/config/authoritative doc, **medium** = several partial signals, **low** = inferred from naming or structure.

---

## One-paragraph answer

PALEE is a **single short-lived Node.js process** that treats an Obsidian vault as its database. There is no server, no daemon, no queue, and — in Phase 1 — no network at all. Inside the process the code is arranged in five import-reachable layers: a `bin/palee.ts` composition root, a `src/cli` handler layer, a pure `src/engine`, an `src/storage` layer that owns all vault IO, and an `src/validation` rule engine, all sharing one `src/types.ts` contract that `src/index.ts` re-exports as the public library surface. The layering is genuinely clean: **0 forbidden-direction edges and 0 circular imports** across 60 modules and 216 internal edges. The interesting structure is not the layer diagram — it is that the two facades named in `agent.md` (`src/engine/index.ts`, `src/validation/index.ts`) serve *only the npm package surface*, while the CLI deep-imports through them, and that the layer with the most files (`src/validation`, 26 modules) is absent from the heading that claims to enumerate the layers.

## Reading order

1. This page — elements, boundaries, and what is *not* connected.
2. [`02-dependency-impact.md`](02-dependency-impact.md) — coupling, hotspots, blast radius.
3. [`03-docs-audit-findings.md`](03-docs-audit-findings.md) — where the docs and 53 Mermaid diagrams disagree with the above.
4. [`04-stakeholder-explainer.md`](04-stakeholder-explainer.md) — the same model retold for a non-owner audience.
5. [`palee-architecture.evidence.md`](palee-architecture.evidence.md) — the node/edge evidence register with `file:line` refs.

## Levels

### L1 — system context

| Element | Type | Notes | Confidence |
| --- | --- | --- | --- |
| Learner (vault owner) | actor | Runs `palee <cmd>`; reads plain text or `--json`; branches on exit codes 0–5 | high — `bin/palee.ts:25-124`, README exit-code table |
| CI runner | actor | `npm run check` / `test:coverage` / `build` / `pack` + `scripts/verify-tarball.js` | high — `.github/workflows/ci.yml`, `agent.md:59-67` |
| **PALEE CLI** | the system | npm package `@kuldeep2822k/palee`, bin name `palee` | high — `package.json:2,12-14` |
| Obsidian vault | external file store | Canonical data. `.md` notes + a hidden `.palee/` directory owned by PALEE | high — `planning/storage_design.md`, `agent.md:45-50` |
| Per-user config | external file store | `PALEE_CONFIG_DIR` override, else `%LOCALAPPDATA%\palee\config.json` / `~/.config/palee/config.json` | high — `getConfigPath` at `src/cli/config.ts:26` |
| npm registry | external | publish target and install source for the two runtime deps | high — `.github/workflows/release.yml`, `package.json:64-66` |

**Boundary fact worth stating out loud:** PALEE's only "integration points" are files. It has no API, no database driver, and no HTTP client — `src` and `bin` contain zero imports of `http`, `https`, `net`, or `dns`, and the dependency list is exactly `commander` + `yaml` (`package.json:64-66`). ADR-0002 and `agent.md:80` make the no-network property a deliberate invariant, not an accident of scope.

### L2 — containers

One container, two filesystem stores. This is the level where the docs overreach most often: several pages diagram PALEE as if `CLI`, `Engine`, `Storage` and `NPM` were separately deployed things. They are one process; nothing else runs.

| Container | Technology | Ownership |
| --- | --- | --- |
| `palee CLI process` | Node.js ≥ 22, CommonJS | one process per invocation; `bin/palee.ts` → `program.parseAsync` (`bin/palee.ts:146`) |
| `Per-user config file` | JSON | written by `src/cli/config.ts`, **not** by the storage layer |
| `Vault notes + .palee/` | Markdown + YAML frontmatter | read/written only through `src/storage` (topic notes) — canonical `sessions/`, derived `index.md` + `hot.md`, lock dirs under `.palee/locks/` |

### L3 — components, measured not asserted

Counts are from `node scripts/arch-import-graph.cjs` (60 modules, 216 internal import edges, 33 of them `import type`).

| Layer | Modules | Lines | Intra-layer edges | Cross-layer out-edges |
| --- | --- | --- | --- | --- |
| `bin` | 1 | 147 | — | 12 → cli |
| `src/` root (`types.ts`, `index.ts`) | 2 | 763 | 1 | 3 → engine/storage/validation |
| `src/cli` | 13 | 3076 | 31 | 22 → validation, 11 → root, 10 → storage, 8 → engine |
| `src/engine` | 5 | 1430 | 4 | 2 → root |
| `src/storage` | 13 | 3758 | 27 | 9 → root |
| `src/validation` | 26 | 3072 | 54 | 12 → storage, 7 → engine, 3 → root |

Two things fall out of this table that no prose doc states:

- **`src/validation` is the largest layer by file count and by internal cohesion** (26 modules, 54 intra-layer edges — more than `src/cli`'s 31 and close to `src/storage`'s 27). It is a full subsystem: a collector, a deterministic runner, 19 rules, and two formatters.
- **`src/engine` is the smallest and the most isolated** (5 modules, 1430 lines, exactly 2 outbound edges, both to `src/types.ts`). That isolation is the load-bearing property: it is why the SM-2 and graph invariants are unit-testable without touching a disk.

### The public surface

`src/index.ts:11-26` is the only library entry point: `version` plus `export *` of the types, engine, storage and validation barrels. `test/smoke.test.ts` pins that it loads and that `version` matches `package.json`. Anything a consumer can reach is therefore whatever those four barrels re-export — which matters because the CLI itself does not use two of them (next section).

## Edges that do **not** exist (the property that makes this codebase safe to change)

Verified against the import graph; re-check any time with `node scripts/arch-import-graph.cjs`.

| Absent edge | Why it matters |
| --- | --- |
| `src/engine` → `src/storage` | Engine stays fs-free, so SM-2/mastery/DAG logic has no IO to mock or forget to mock |
| `src/engine` → `src/cli`, `src/engine` → `src/validation` | No upward dependency out of the pure layer |
| `src/storage` → `src/cli`, `→ src/engine`, `→ src/validation` | Storage is a leaf above `types`; nothing below depends on something above |
| `src/validation` → `src/cli` | Rules stay reusable by tests and the library API |
| any → `http`/`https`/`net`/`dns` | Phase-1 "no sockets, no DNS lookups" (`agent.md:80`) holds mechanically |
| circular imports | Tarjan SCC over all 60 modules found **no** component larger than one node |

Confidence: **high** (static scan of every `import`/`export…from`/`require` specifier in `src` and `bin`).

## Where implementation diverges from the documented boundary

These are stated here once, neutrally; the fix list and severity are in `03-docs-audit-findings.md`.

1. **`src/validation` is missing from the heading that names the layers.** `agent.md:9` reads `## Architecture (four layers)` and its four bullets are `src/types.ts`, `src/engine/`, `src/storage/`, `src/cli/`. `src/validation/` is not among them, yet it is exported from the public barrel and is the biggest module tree by file count. Confidence: high.
2. **"No raw `fs` outside storage" (`agent.md:13`) is not true as written.** Seven `src/cli` modules import `fs`: `adopt`, `config`, `migrate`, `onboarding`, `review`, `roadmap`, `session`. Only `src/cli/config.ts` *mutates* through it (`fs.mkdirSync:105`, `openSync:114`, `renameSync:119`, `unlinkSync:126`) — and that file writes the config store, not the vault. The narrow rule (`agent.md:45-46`, all *vault writes* go through `atomicWrite`) does hold. So this is a documentation overstatement plus one genuine second implementation of the atomic-write pattern outside storage. Confidence: high.
3. **Both named facades serve only the package surface.** `src/engine/index.ts` (17 exports) and `src/validation/index.ts` (22 exports incl. all 19 rules) are each imported by exactly one module: `src/index.ts`. The eight CLI→engine edges are all deep (`engine/sm2`, `engine/mastery`, `engine/dependency`), and `src/cli/validate.ts` imports the 19 rules one by one instead of the barrel. `src/storage/index.ts` is the opposite — 10 of 12 CLI modules go through it. Confidence: high.
4. **`palee validate` never reaches the engine directly.** `src/cli/validate.ts` has no import of `src/engine/*`; its only route into the engine is through the rules — `cli/validate → src/validation/rules/no-dependency-cycle.ts:13 → detectCyclesBounded` and `no-missing-dependency.ts:32 → findMissingDependencies` (the other five engine edges out of `src/validation` carry `computeTopicMastery` and `engine/topic-id` constants). Confidence: high.

## Assumptions and gaps

- The import scan is regex-based, not AST-based: it reads `import`/`export…from`/`require` specifiers. Dynamic or computed specifiers would be missed. `src`/`bin` contain none (every internal specifier is a static relative literal), so coverage is complete for internal edges.
- Line and file counts are of `.ts` sources under `src/` and `bin/`, excluding `.d.ts`, `dist/`, `coverage/`, and the stale `.worktrees/201/` copy that also sits in this working directory.
- **Phase-1 vs Phase-2 is not a drift question.** Commands and fields that exist only in README/docs — `palee test`, `palee tutor`, `roadmap` guided interview, `validate --fix`, `config set-provider` with `base_url`/`api_key`, the nested `Topic`/`Assessment`/`Review` interfaces — are deliberate forward declarations (`planning/PHASE_2_GAPS.md`, `docs/08-2`). This model marks them as *target*, not as missing implementation, and `03-docs-audit-findings.md` keeps them in a separate class from real drift.
- Behavioural claims about *runtime* (which code paths actually execute for a given vault) are out of scope: there is no trace or coverage-driven view here. `coverage/` exists in the repo and could feed one; it was not used.

## Maintenance

| If you change… | Also update… |
| --- | --- |
| a module's imports | re-run `node scripts/arch-import-graph.cjs` then `node scripts/arch-render-dot.cjs`; the DOT views regenerate themselves |
| the layer set or its rules | `agent.md:9-16`, `architecture/palee-architecture.dsl` element list, and this page's L3 table |
| a facade's exports | `src/<layer>/index.ts` doc comment, and the `FacadeBypass` view if the CLI starts or stops using it |
| the 19-rule catalog | `src/cli/validate.ts` registry **and** `src/validation/index.ts` (registration order is mirrored in both today) |
