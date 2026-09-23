# PALEE architecture — evidence register

Companion to [`palee-architecture.dsl`](palee-architecture.dsl). Machine-readable form with **all 276 sourceRefs**: [`_evidence/evidence-model.json`](_evidence/evidence-model.json). Raw scan output: [`_evidence/import-graph.json`](_evidence/import-graph.json), [`_evidence/import-graph.md`](_evidence/import-graph.md).

**Model state:** current · **Version audited:** `@kuldeep2822k/palee` v0.5.2 at commit `d4e02a4` · **Modelled:** 2026-09-22 · **`sourceRefPolicy`: resolvable** (every cited path exists in this working tree; verified by check, see *Traceability*).

Confidence: **high** = read directly from code/config or an authoritative doc; **medium** = several partial signals agree; **low** = inferred from naming or layout.

## Nodes

| id | label | type | state | sourceRefs (representative) | conf |
| --- | --- | --- | --- | --- | --- |
| `student` | Learner (vault owner) | actor | current | `bin/palee.ts:25-124`, `README.md:94-149` | high |
| `ci` | CI runner | actor | current | `.github/workflows/ci.yml:19-154`, `agent.md:59-67` | high |
| `obsidian` | Obsidian vault | external-system | current | `planning/storage_design.md:3-5`, `agent.md:45-50` | high |
| `npmregistry` | npm registry | external-system | current | `.github/workflows/release.yml:82-124`, `package.json:2-14` | high |
| `process` | palee CLI process | service (container) | current | `bin/palee.ts:1,146`, `package.json:12-14,76-78` | high |
| `bin` | Composition root | module | current | `bin/palee.ts:1-146` (11 `.command()` blocks at `:31-124`) | high |
| `cli` | CLI layer | module | current | `src/cli/` — 13 modules, 3076 lines | high |
| `types` | Shared contract | module | current | `src/types.ts` (734 lines, 39 exported symbols, 26 importers) | high |
| `engine` | Engine layer | module | current | `src/engine/` — 5 modules, 1430 lines; no `fs` import present | high |
| `storage` | Storage layer | module | current | `src/storage/` — 13 modules, 3758 lines | high |
| `validation` | Validation layer | module | current | `src/validation/` — 26 modules, 3072 lines; 19 rules registered at `src/cli/validate.ts:42-77` | high |
| `publicapi` | Public package API | module | current | `src/index.ts:11-26`, `package.json:10-11` | high |
| `cmdlinelib` / `yamllib` | commander / yaml | dependency | current | `package.json:64-66` (the only runtime deps) | high |
| `configstore` | Per-user config file | database (file) | current | `src/cli/config.ts:26-40` | high |
| `vaultdir` | Vault notes + `.palee/` | database (file) | current | `src/storage/vault-walker.ts`, `src/storage/memory.ts`, `src/storage/lock.ts:25-47` | high |
| *`ai-layer`* | Phase-2 AI module | capability | **target** | `planning/PHASE_2_GAPS.md`, `docs/08-2`, `agent.md:81` | — deliberately not in the current model |

## Edges

Counts are static import edges; per-file detail is in `_evidence/evidence-model.json` (`edges[].sourceRefs`) and `_evidence/import-graph.json`.

| from → to | type | edges | protocol | sourceRefs (representative) | conf |
| --- | --- | --- | --- | --- | --- |
| `bin` → `cli` | depends-on | 12 | in-process | `bin/palee.ts:10-23` | high |
| `cli` → `validation` | depends-on | 22 | in-process | `src/cli/validate.ts:10-31` | high |
| `cli` → `storage` | depends-on | 10 | in-process (barrel) | `src/cli/{adopt:12,dashboard:4,migrate:4,next:7,plan:7,progress:7,review:4,roadmap:11,session:11}` + `src/cli/exit-codes.ts:10` → `src/storage/index.ts` | high |
| `cli` → `engine` | depends-on | 8 | in-process (deep) | `src/cli/{adopt:23,dashboard:6,plan:9,plan:10,progress:9,review:11,review:12,roadmap:21}` | high |
| `cli` → `types` | depends-on | 11 | in-process | one per handler, e.g. `src/cli/review.ts:14` | high |
| `cli` → `configstore` | reads+writes | — | file | `src/cli/config.ts:59` (read), `:104-126` (write) | high |
| `validation` → `storage` | depends-on | 12 | in-process | `src/validation/collect-vault.ts`, `src/validation/types.ts` → `loader`/`sessions`/`memory` | high |
| `validation` → `engine` | depends-on | 7 | in-process | `rules/{no-dependency-cycle:13→detectCyclesBounded, no-missing-dependency:32→findMissingDependencies, valid-topic-mastery:27→computeTopicMastery, valid-palee-schema:17, valid-session-schema:37, valid-topic-id-format:29, valid-topic-status:22}` — the last four import constants from `engine/topic-id` | high |
| `validation` → `types` | depends-on | 3 | in-process (all `import type`) | `src/validation/rules/no-dependency-cycle.ts`, `no-missing-dependency.ts`, `src/validation/types.ts` | high |
| `engine` → `types` | depends-on | 2 | in-process | `src/engine/{sm2,dependency}.ts` | high |
| `storage` → `types` | depends-on | 9 | in-process | `src/storage/{atomic-write,cache,frontmatter,loader,lock,memory,roadmap-parser,scanner,vault-walker}.ts` | high |
| `storage` → `yamllib` | calls | — | library | `src/storage/frontmatter.ts` (`parseDocument`, `doc.toString()`) | high |
| `publicapi` → `types`/`engine`/`storage`/`validation` | re-exports | 4 | in-process | `src/index.ts:17-26` | high |
| `storage` → `vaultdir` | reads+writes | — | file | `src/storage/atomic-write.ts:119-152`, `src/storage/lock.ts` | high |
| `validation` → `vaultdir` | reads | — | file | `src/validation/collect-vault.ts` | high |
| `process` → `npmregistry` | deploys-from / publishes-to | — | https | `.github/workflows/release.yml:109-124` | high |

### Absent edges (asserted, not drawn)

`engine→storage`, `engine→validation`, `engine→cli`, `storage→cli`, `storage→engine`, `storage→validation`, `validation→cli`: **0 edges each.** No `http`/`https`/`net`/`dns` import anywhere in `src` or `bin`. **0 circular imports** (Tarjan SCC over 60 modules). Confidence: high — static scan of every specifier.

## Rule provenance and where the code disagrees

| Documented rule | Source | Status in code |
| --- | --- | --- |
| Four layers: types / engine / storage / cli | `agent.md:9-14` | **incomplete** — `src/validation` (26 modules) is not listed; `docs/01-2:13` instead says "three-layer" |
| `src/types.ts` is the single shared contract | `agent.md:11` | **holds** — 26 importers, no competing contract module |
| Engine is pure, deterministic, fs-free | `agent.md:12` | **holds** — no `fs`, no `Date.now()`, no `Math.random()` under `src/engine` |
| No raw `fs` outside storage | `agent.md:13` | **does not hold as written** — 7 `src/cli` modules import `fs`; only `src/cli/config.ts` mutates, and it writes the config store, not the vault |
| All vault writes go through `atomicWrite` | `agent.md:45-46` | **holds** |
| Engine/storage reached via their `index.ts` facades | `agent.md:12-13` | **partial** — true for `storage` (10 of 12 handlers); `engine/index.ts` and `validation/index.ts` are imported only by `src/index.ts` |
| Exit codes 0–5 are load-bearing | `agent.md:24`, `README.md:208-216` | **holds** — 1–12 `process.exitCode` assignments per handler, asserted by `test/cli-exit-codes.test.ts` |
| Phase 1 opens no sockets, no DNS | `agent.md:80` | **holds** |
| Only `commander` + `yaml` at runtime | `agent.md:16,83` | **holds** — `package.json:64-66` |

Details, severity and fixes: [`03-docs-audit-findings.md`](03-docs-audit-findings.md).

## Traceability

| Check | Command | Result on 2026-09-22 |
| --- | --- | --- |
| every `sourceRef` in the evidence model resolves to a file in this tree | ad-hoc check over `_evidence/evidence-model.json` | **276 refs checked, 0 unresolved** |
| import graph, cycles, forbidden-direction edges | `node scripts/arch-import-graph.cjs` | 60 modules · 216 edges · 33 `import type` · **0 cycles · 0 forbidden edges** |
| regenerate both DOT views from the graph | `node scripts/arch-render-dot.cjs` | `dependency-graph.dot` (60/216), `layer-summary.dot` (6/18) |
| Mermaid frame and delimiter checks over every diagram in `docs/`, `architecture/`, `planning/` | `node scripts/mermaid-lint.cjs` | **53 blocks in `docs/` (55 scanned), 0 findings** |
| the linter's own checks can fail | `node scripts/mermaid-lint.cjs --self-test` | **8/8 behaved as intended**; fixture kept at `_fixtures/negative-mermaid.md` |

**What that lint does and does not prove.** It is a dependency-free regex check, so it is *stricter* than Mermaid on one axis and *weaker* on another. Stricter: Mermaid silently auto-creates an undeclared node ID or participant, so "endpoint never declared" and "undeclared participant" enforce the plugin's grounding rule rather than parse validity — confirmed against the real parser, which accepted `B -- yes --> UNDECLARED_TARGET` while rejecting the malformed `C[x"]` two lines later. Weaker: it cannot reject syntax it does not model (bad `classDiagram` members, malformed `stateDiagram` transitions, unsupported directives). "0 findings" therefore means *clean under these checks*, not *verified by Mermaid*. A real `mermaid.parse()` gate needs a DOM (`jsdom`, or `@mermaid-js/mermaid-cli`) that is not installed here.
| diagrams render as images | `dot -Tsvg` / `-Tpng` over all four views | **rendered with Graphviz 16.1.0, no warnings, inspected as images** (in `export/`) |
| Structurizr model parses | needs `structurizr-cli` + a JVM | **not run** — open `palee-architecture.dsl` in Qoder's C4 viewer instead |

## Unknowns to close

1. Is the engine deep-import style intended or incidental? No ADR covers it (ADR-0006 covers the *storage* barrel). This decides whether finding F6 is a docs fix or a code fix.
2. Should `saveConfig` move into `src/storage` (making "no raw fs outside storage" literally true), or should the rule be narrowed to vault paths?
3. Cycle detection moved from 3-color DFS to Tarjan-SCC + Johnson enumeration (#79) with no ADR. Should one be written, given `agent.md`, `docs/03-0`, `docs/03-2`, `docs/02-1`, `docs/06-x`, `docs/09` and `planning/palee_cli_spec.md` all still describe the old algorithm?
4. Runtime reach: which rules a given vault actually fires is unmeasured. `coverage/` exists and could feed a runtime-observation view.
