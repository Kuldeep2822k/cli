# PALEE docs & diagrams vs code — architecture-health audit

**Route:** `architecture-visualization` → `architecture-health` (freshness, traceability, living-architecture checks).
**Question this answers:** *do the architecture docs and the 53 Mermaid diagrams describe the code that is actually in `src/`?*
**Audit date:** 2026-09-22. **Code audited:** `@kuldeep2822k/palee` v0.5.2, working tree at `d4e02a4`.
**Branch caveat:** `d4e02a4` is on `docs/audit-remediation`, which is **18 commits ahead of and 6 behind `origin/main`**. The six missing commits are the merged fixes #196, #197, #198, #199, #200 and #189. Every finding below was therefore re-checked against `origin/main`: F1-F6 all still stand there (`agent.md` still says 3-color DFS, still calls `session end` a stub, still says "No raw `fs` outside storage", still lists four layers; `docs/01-2` still says "three-layer" and still names `computeNextState`). F8's "actual location" column is **branch-specific** — `src/types.ts` is 734 lines here and 740 on main — so re-derive those numbers on whichever commit you are fixing.
**Scope audited:** `agent.md`, `README.md`, 8 ADRs, 28 docs pages (53 Mermaid blocks), `planning/*.md`, `.github/workflows/*` (9 files), `.c8rc.json`.
**Baseline for "reality":** the generated import graph ([`_evidence/import-graph.md`](_evidence/import-graph.md)) plus direct reads of the cited source lines. Every finding below was re-checked against source by this session; nothing is quoted from a summariser.

---

## Verdict

The **code is in better shape than the docs about it**. Layering, purity and cycle-freedom all check out with zero violations. The documentation problem is not typos — it is that three of the most load-bearing architecture statements (which layers exist, which algorithm `detectCycle` uses, whether the CLI touches `fs`) are contradicted by the source, and the flagship overview page diagrams functions and classes that do not exist anywhere in the repo.

None of this is a runtime bug. All of it is a **change-safety** problem, and in this repo specifically, because `agent.md` is the file AI coding agents are instructed to read first: a stale algorithm description in `agent.md` will be re-implemented, and a wrong "does this exist?" claim in `docs/01-2` will be believed.

Severity scale used below: **P1** = an agent or human following the doc would write wrong code; **P2** = the doc misstates a real, checkable property; **P3** = citation rot / numeric drift; **P4** = cosmetic or consistency-only.

## P1 — following the doc would produce wrong code

### F1 · `detectCycle` is documented as 3-color DFS. It is iterative Tarjan SCC + Johnson-style enumeration + lexicographic greedy search.

| | |
| --- | --- |
| **Doc claims** | `agent.md:41` "`detectCycle` = 3-color DFS returning the exact repeated-start path or `null`" · `docs/03-2:102-136` a whole section "3-Color DFS Cycle Detection Algorithm" with White/Gray/Black states, `visiting = new Set<string>()`, `pathStack` · `docs/03-2:139-177` a **full TypeScript body presented as `src/engine/dependency.ts` code** · `docs/03-0:21,59,138` · `docs/02-1:212` · `docs/06-0:56`, `docs/06-1:57` · `docs/09:45,183` · `planning/palee_cli_spec.md:173` |
| **Code reality** | `src/engine/dependency.ts:485-487` `detectCycle` → `buildEdgeMap` then `computeSccs`; `:375` "Iterative Tarjan strongly connected components"; `:92` "explicit-stack adaptation of Johnson's algorithm"; `:489-511` picks the minimum cyclic node, then searches in-SCC in ascending ID order for the lexicographically-first cycle. **`grep` for `pathStack` and `visiting.has` in `src/` returns zero hits.** |
| **Why P1** | The semantic contract in `agent.md:41` ("returns the exact repeated-start path or `null`") is still true, which makes the stale half easy to trust. An agent told to "keep the 3-color DFS invariant" while editing cycle code will reintroduce a removed algorithm — and `docs/03-2:139-177` hands it the code to paste. Cycle detection is what gates the learner's whole curriculum, and issue #79's quarantine semantics depend on the SCC behaviour the doc no longer describes. |
| **Fix** | Rewrite `docs/03-2` §"3-Color DFS…" as "SCC-based cycle detection (iterative Tarjan + Johnson enumeration, lexicographically-first representative)", delete the pasted code block or mark it explicitly as a historical pre-#79 implementation, and correct `agent.md:41` to the current contract. One ADR entry would help too: the change from DFS to SCC/Johnson has **no ADR**, though it is exactly the kind of decision ADRs exist for. |
| **Confidence** | high |

### F2 · `agent.md` says `session end` is a Phase-1 stub. It is implemented.

| | |
| --- | --- |
| **Doc claims** | `agent.md:72` "`validate --fix` and `session end` are Phase-1 stubs (\"not implemented\")" · same framing echoed in `docs/08-x` planning summaries |
| **Code reality** | `grep -rn "not implemented" src/` returns **one** hit: `src/cli/validate.ts:137` (`--fix`). `src/cli/session.ts:318-319` writes `ended_at` and `duration_minutes`, matching `docs/02-4:110-125` and README:125, which document `session end` as working. |
| **Why P1** | This is the inverse hazard from F1: an agent instructed that the command is a stub will not test against it, or will "fix" the docs by deleting correct documentation. The docs are right here; `agent.md` is wrong. |
| **Fix** | Drop `session end` from `agent.md:72`; keep `validate --fix`. Worth a line in `planning/PHASE_2_GAPS.md` confirming `session end` moved out of the stub set. |
| **Confidence** | high |

### F3 · The authoritative overview page diagrams functions and classes that do not exist

| | |
| --- | --- |
| **Doc claims** | `docs/01-2:61-63` Mermaid nodes `recordReview()`, `SM2.computeNextState()`, `get_progress()` · `docs/01-2:120` "The `SM2` and `DependencyGraph` **classes** are side-effect free" · `docs/08-1` also names `computeNextState (engine/sm2.ts)` |
| **Code reality** | 0 occurrences of `computeNextState`, `recordReview`, `get_progress`, `class SM2`, or `class DependencyGraph` anywhere in `src/` or `bin/`. The engine exports plain functions (`processReview`, `computeDueDate`, `computeTopicMastery`, `detectCycle`, …); there are **no classes at all in `src/engine`**. `resolveTopic` (also in `docs/01-2`) exists only as a local identifier inside `src/cli/session.ts`/`src/storage`, not as an engine API. |
| **Why P1** | `docs/01-2` is the *architecture overview* — the page a newcomer or agent reads to build a mental model. It is the one diagram in the corpus whose names match no code, and it is the second page in the docs nav. |
| **Fix** | Replace with real symbols, and reuse the L3 view in [`palee-architecture.dsl`](palee-architecture.dsl) rather than hand-drawn names. The `FacadeBypass` view already states the true CLI→engine edges. |
| **Confidence** | high |

## P2 — real properties, misstated

### F4 · "Four layers" vs "three layers" vs the five the imports show

| | |
| --- | --- |
| **Doc claims** | `agent.md:9` "## Architecture (four layers)" → bullets are `src/types.ts`, `src/engine/`, `src/storage/`, `src/cli/` · `docs/01-2:13` "structured as a **three-layer** system" and `:17` "three distinct layers with a strict downward dependency flow" · `docs/01-0:27,133` three layers |
| **Code reality** | Six import-reachable groups: `bin`, `src/types.ts` + `src/index.ts` (root), `src/cli` (13 modules / 3076 ln), `src/engine` (5 / 1430), `src/storage` (13 / 3758), **`src/validation` (26 / 3072)**. `src/validation` is the largest module tree by file count, is re-exported from the public barrel (`src/index.ts:26`), and holds 54 intra-layer edges. It appears in **none** of the layer enumerations. |
| **Why P2** | Three docs give three different layer counts, and every one of them omits the layer that grew most recently. Anyone reasoning about "where does this check belong?" has no documented answer for validation. |
| **Fix** | Pick the enumeration the imports support — 4 internal layers + a shared contract + a composition root, with validation named — and state it identically in `agent.md:9-16` and `docs/01-2`. Then make the docs cite the generated layer table instead of restating counts. |
| **Confidence** | high |

### F5 · "No raw `fs` outside storage" is contradicted by 7 CLI modules, one of which mutates

| | |
| --- | --- |
| **Doc claims** | `agent.md:13` "**No raw `fs` outside storage.**" · `docs/01-2:121` "CLI commands in `src/cli/` never call `fs` directly" · `docs/02-4:163` "**zero direct `fs.unlinkSync` or `fs.mkdirSync` calls in CLI handlers**" · `docs/04-0:23` "CLI command handlers are strictly forbidden from performing raw filesystem mutations (`fs.unlinkSync`, `fs.mkdirSync`, `fs.rmSync`)" |
| **Code reality** | `import fs from 'fs'` appears in `src/cli/{adopt,config,migrate,onboarding,review,roadmap,session}.ts` — 7 modules. `docs/02-4:163` names the two offending calls exactly: `src/cli/config.ts:105` `fs.mkdirSync` and `:126` `fs.unlinkSync` (plus `:114 openSync`, `:119 renameSync`). The other 6 CLI modules only read (`readFileSync`/`statSync`/`existsSync`/`readdirSync`). |
| **The nuance that matters** | The **narrow** rule holds and is worth keeping: no *vault* write bypasses `atomicWrite` (`agent.md:45-46`). `src/cli/config.ts` writes the per-user config store, which lives outside the vault and is not fingerprinted or locked. `src/cli/review.ts:73-78` re-reads the note with raw `fs` purely as the OCC TOCTOU check. |
| **Why P2** | The broad sentence is false, the narrow one is true, and `config.ts` is a second, unprotected implementation of the temp-file+rename pattern that will drift from `atomic-write.ts` (no `fsyncSync`, no `Lock`). A lint rule written from the doc's wording would fail today; one written from the narrow rule would pass — so the wording decides whether the guard can actually be enforced. |
| **Fix** | Either restate the rule as "no raw `fs` **writes to vault paths** outside `src/storage`" (true today, enforceable), or route `saveConfig` through a storage helper and keep the strict wording. Then add the ESLint boundary rule (see *Recommendation* at the end). |
| **Confidence** | high |

### F6 · Diagrams attach the CLI to facades the CLI does not import

| | |
| --- | --- |
| **Doc claims** | `docs/03-0` block A (lines 31-95): `subgraph API ["Public Engine API (src/engine/index.ts)"]` receives direct edges from `CmdReview`, `CmdAssess`, `CmdPlan`, **and `CmdVal["palee validate"] --> ExpDep`** (line 75) · `docs/03-0:27` "the computational core between the Storage Layer … and the CLI Layer" |
| **Code reality** | `src/engine/index.ts` is imported by exactly one module: `src/index.ts`. The 8 CLI→engine edges are all deep (`src/cli/{adopt:23,dashboard:6,plan:9,10,progress:9,review:11,12,roadmap:21}`). `src/cli/validate.ts` has **no engine import at all** — its only route into the engine is `cli/validate → src/validation/rules/no-dependency-cycle.ts:13 → detectCyclesBounded`, plus `no-missing-dependency.ts:32 → findMissingDependencies`. |
| **Why P2** | Two claims in one diagram are false: the facade as the CLI's entry point, and `validate` calling the engine directly. Both are the kind of statement a reader turns into a mental model of "where do I hook in". Contrast with `src/storage`, where the barrel really is the CLI's entry point (10 of 12 handlers) — the docs describe uniform facade discipline that the code does not have. |
| **Fix** | Draw the true edges (see `FacadeBypass` view and `boundary-exceptions.dot`), and decide which way round this should be: either an ADR recording "engine is deep-imported by design; the facade exists for the package surface only", or move the CLI onto the barrel. Settling this also tells you whether F6 is a docs fix or a code fix. |
| **Confidence** | high |

### F7 · `agent.md`'s engine facade inventory is 5 of 17 exports, and its storage module list is 6 of 12 files

| | |
| --- | --- |
| **Doc claims** | `agent.md:12` "`index.ts` facade (exports `processReview`, `computeDueDate`, `detectCycle`, `getReadyTopics`, `validateDependencyGraph`)" · `agent.md:13` "`vault-walker`, `frontmatter`, `lock`, `atomic-write`, `cache`, `memory`" |
| **Code reality** | `src/engine/index.ts` exports **17** symbols, including the whole #79 cycle family (`detectCycles`, `detectCyclesBounded`, `quarantineCyclicTopics`, `findCyclicSccNodes`), the mastery family (`MASTERY_THRESHOLD`, `computeTopicMastery`, `normalizeScore`, `resolveTopicMastery`), `areDependenciesSatisfied`, `getTopicDependencies`, `findMissingDependencies`. `src/storage/` has 12 non-index modules — `agent.md:13` omits `loader`, `scanner`, `sessions`, `dependencies`, `roadmap-parser`, `pattern-matcher`, four of which are exported from the barrel. |
| **Why P2** | `agent.md` is the agent's primary brief. An agent that believes the facade has five exports will re-implement cycle enumeration or mastery resolution that already exists, and the omission of `dependencies.ts` hides the one place legacy `dependencies` aliases are normalized (`docs/03-2:32` documents it correctly). |
| **Fix** | Replace hand-maintained export inventories with a pointer plus a generated count, or add a check that fails when the doc list and the barrel diverge. |
| **Confidence** | high |

## P3 — citation rot (systematic, and the easiest class to fix permanently)

### F8 · Line-range citations into `src/` no longer resolve to what they cite

Docs cite symbols by `file#Lxx-Lyy`. The ranges have drifted, and pages disagree with each other about the same symbol. Sampling `src/types.ts` (734 lines, 39 exported symbols) against the three data-model pages:

| Symbol | Actual location | `docs/05-0` | `docs/05-1` | `docs/05-2` |
| --- | --- | --- | --- | --- |
| `Assessment` | `src/types.ts:21` | `#17-28` | `#3-9` | — |
| `Review` | `:46` | `#38-53` | `#11-19` | — |
| `Difficulty` | `:66` | `#58` (and `#21`) | — | `#21` |
| `Topic` | `:117` | `#104-125` | `#49-59` | — |
| `PaleeConfig` | `:330` | `#238-245` | — | `#104-108` |
| `HotMemoryData` | `:221` | `#182-193` | — | — |
| `LockData` | `:347` | `#255-266` | — | — |
| `ValidationError`/`Result` | `:452`/`:472` | `#311-336` | — | — |
| CLI `*Options` group | `:545-648` | `#396-484` | — | `#166-206`, and `ValidateOptions #564-578` (actual `:605`) |

Other confirmed instances of the same disease: `src/cli/config.ts` functions cited as `#11-25`/`#27-39`/`#41-50`, actual `:26`/`:56`/`:100`. `src/storage/lock.ts` constants cited as `#13`/`#14`/`#15`, actual `:25`/`:27`/`:29`. `src/session.ts` `resolveSessionTopic` cited as `#L24-L54` in `docs/02-4:27` and `#L23-L53` in `docs/09:172`, actual `:41`. `.github/workflows/ci.yml` steps cited as `#33-34`/`#65-66`, actual `:39`/`:73`.

**Why this happens:** the anchors are *positions*, and positions move. `docs/adr/0008` and the #199 review round already hit this once for invariants.
**Fix:** cite `file.ts` + the exported symbol name (`src/types.ts → PaleeConfig`), not a line range; where a deep link is genuinely wanted, link the GitHub permalink to a tag, not to `main#L564`.

### F9 · Numeric drift in CI/release and coverage docs

| Claim | Source | Reality |
| --- | --- | --- |
| release smoke test retries install "up to **12** times, waiting 10 s" | `docs/07-2:97` (anchor `#150-165`) | `.github/workflows/release.yml:168` `for i in {1..30}`, `(attempt $i/30)` at `:173`, "after 5 minutes" at `:176` |
| coverage thresholds are "60% line/statement, 75% function" | `docs/07-1:171` | `.c8rc.json` also sets **`"branches": 65`** (`:11`) — undocumented in the audited pages |
| coverage reporters are "text and `lcov`" | `docs/06-0:83` | `.c8rc.json:6` = `["text","lcov","html","json-summary"]` |
| CI matrix is "Node.js versions (22.x, 24.x)" | `docs/07-0:68` | `ci.yml:53-54` — PR matrix is 3 combos (ubuntu 22.x, ubuntu 24.x, windows 24.x); the push matrix is 7, adding ubuntu 26.x and both macOS entries |
| "`npm audit` **every PR**" / "**weekly** full audit" | `docs/07-1:152-153` | `security.yml:8-10` gates `pull_request` on `paths:` (only the two manifests), and the non-PR job runs on any non-PR event including push to `main` — the weekly cron (`:12`) is not the only trigger |
| "four test tiers" | `docs/06-0:117` | the very next diagram declares **Tier 1 … Tier 5** (`docs/06-0:128-132`) |
| workflow-pinning audit table, 17 rows | `docs/07-1:119-137` | the *pinning discipline itself is real* — all `uses:` in all 9 workflows are 40-char SHA-pinned with a `# vX.Y.Z` comment. But 5 rows disagree with the workflows (e.g. `actions/labeler` `8558be7…# v5.0.0` vs `pr-labeler.yml:18` `bf12e9b…# v7.0.0`; `configure-pages` v5 vs `deploy-docs.yml:47` v6) and `skylos.yml` + `sync-project-fields.yml` have no rows at all despite `:115` claiming "all PALEE workflows" |
| `.npmignore| cited as lines 1-25 | `docs/07-2:129` | file is 33 lines, and `package.json:15-20` declares a `files:` **allowlist** which npm treats as authoritative over `.npmignore` |

**Confidence:** high (each side read directly).

## P4 — consistency and naming

| # | Finding | Evidence |
| --- | --- | --- |
| F10 | The acronym expands two different ways *inside shipped code*: `src/index.ts:2` "Personal **Adaptive Learning Environment** Engine" vs `bin/palee.ts:27`, README:15, `docs/index.md:6`, `docs/.vitepress/config.mts:12` "Personal **Active Learning & Evaluation** Engine". `src/index.ts` is the odd one out and is the string that lands in the published `.d.ts`. | verified by grep across `src bin README.md docs/*.md` |
| F11 | Fourth pillar is called "**teaching**" in `README:27` and `feynman` everywhere else (code field, ADR-0004, docs/03-x, `agent.md:54`). | verified |
| F12 | Config path stated two ways: `docs/05-0:162` "`~/.palee/config.json`" vs `docs/05-2:36` and `src/cli/config.ts:38` "`~/.config/palee/config.json`". The latter is correct. | verified |
| F13 | `docs/03-0` block A declares node `DP`-equivalent `dependencies.ts` in `docs/04-0` block A (line 52) with **no edges at all**, while the `Facade -->` chain at `:62` lists the other 11 storage modules. The code agrees (the barrel does not re-export `dependencies.ts`), but the diagram never says *why* — a reader has to conclude it is an omission. Add a `note` or drop the node. | verified against `src/storage/index.ts` |
| F14 | `docs/04-2` cites the same `updateHeartbeat` snippet as `#187-197` (twice) and its quarantine steps as `#190-194`/`#196-201`/`#197-206` — overlapping ranges for different statements. | verified in-page |
| F15 | `docs/02-2`/`docs/02-1` describe the lapse branch as unconditional for `q < 3`, while `agent.md:33` and `planning/invariants.md` pin "lapses += 1 **only if** `repetition > 0`". Code follows `agent.md`. | `planning/invariants.md` SM-2 section; `agent.md:33` |
| F16 | `.c8rc.json:3` carries a key `"src": ["src"]` that is not a c8 option (`include`/`exclude` at `:4-5` do the work). Harmless, but it is the kind of line that makes a reader distrust the rest of the block. | verified by reading the file |

## Deliberate Phase-2 surface — do **not** "fix" these

Verified as intentional, and recorded so the next audit does not re-file them: `palee test` / `palee tutor` (README:121-122, no handlers in `bin/palee.ts`), `roadmap` guided AI interview (README:129; `--from` is YAML-only), `config set-provider` with `base_url`/`api_key` (README:133; `PaleeConfig` has neither field), "starts AI tutor if provider is configured" on `session start` (README:124), `dashboard` "interactive" (text summary only), nested `Topic`/`Assessment`/`Review`/`Session` interfaces as the on-disk model (`agent.md:54`: Phase-2 reserved; runtime shape is flat `LoadedTopic`), and `validate --fix` (the one remaining genuine stub, `src/cli/validate.ts:137`).

These are forward declarations of an unshipped layer, documented as such in `planning/PHASE_2_GAPS.md` and `docs/08-2`. The one improvement worth making is *labelling*: `docs/05-1:21-29` presents the nested `Topic` interface as the live runtime entity without that qualifier, which is what makes it look like drift.

## What the audit also found to be **correct**

Worth stating, because an audit that only produces complaints is not calibrated:

- The 19-rule catalog is real and matches exactly: `src/cli/validate.ts:42-77` registers 19 rules and `src/validation/index.ts:46-75` exports the same set; `docs/02-3:190`'s "nineteen registered rules" and its **eleven error-default / eight warning-default split** both check out against the `severity:` declarations in the rule files.
- `MASTERY_THRESHOLD = 0.7` (`src/engine/mastery.ts:19`), the EF floor `1.3`, the ΔEF formula, `MAX_HOT_WORDS = 250` (`src/storage/memory.ts:27`), `UNSETTLED_HORIZON = 2000` (`src/storage/cache.ts:20`), heartbeat `15000` and stale timeouts `60000`/`120000` (`src/storage/lock.ts:25-29`), and the six exit codes all match their documented values.
- `AssessmentPillars` really is in `src/engine/mastery.ts:24` and `Review` really is in `src/types.ts` — `docs/03-1`'s attributions are right.
- SHA-pinning discipline across all 9 workflows is genuinely complete, as `docs/07-1:115` claims. Only the audit table under it is stale.
- The `depends_on`-canonical / `dependencies`-alias story is consistent and correct across `docs/03-0`, `docs/03-2`, `docs/09` and `src/storage/dependencies.ts` + `normalizeDependencies`.
- No Mermaid block in `docs/` has a dangling node ID or mismatched shape delimiter (checked mechanically — see *Verification* below).

## Recommended next actions, in order

1. **Fix `agent.md` first** (F1, F2, F4, F5, F7). It is the file agents read before code, and four of the five findings land on it. Cheap, high leverage.
2. **Rewrite `docs/01-2`** (F3, F4, F5 wording) from the generated views in this folder. It currently teaches a three-layer system with classes and functions that do not exist.
3. **Kill position-based citations** (F8) in `docs/05-0`, `docs/05-1`, `docs/05-2`, `docs/04-2`, `docs/06-x`, `docs/07-x`. Replace `file.ts#Lxx` with `file.ts → exportedSymbol`. This is one mechanical pass and it removes the whole P3 class permanently.
4. **Write the missing ADR** for the DFS → SCC/Johnson cycle-detection change (part of F1), and one line recording whether engine deep-imports are intended (F6). Both are decisions that were made in PRs and never written down where an agent will look.
5. **Add a machine check instead of trusting prose** — see below.

## A fitness function so this cannot silently rot again

Every finding class above is mechanically checkable except F1's semantics. Suggested `scripts/verify-architecture-docs.js`, wired into `ci.yml` the way `verify-tarball.js` already is, asserting:

| Check | Would have caught |
| --- | --- |
| every `` ```mermaid `` block in `docs/` parses (or at minimum: every node ID declared before use, balanced shape delimiters) | malformed diagrams |
| every `src/**` symbol named in a docs Mermaid node label or prose backtick exists in that file | F1 (old `pathStack`), F3 (`SM2.computeNextState`, `get_progress`), F7 |
| every `file.ts#Lxx-Lyy` citation resolves to a line whose file actually declares the symbol the sentence names | F8, F14 |
| grep-derived invariants: no `from 'fs'` outside `src/storage` (or the *narrow* phrasing), no `http`/`https`/`net`/`dns` import anywhere in `src`+`bin`, no `.test.ts` or `any` cast in `src` | F5, the Phase-1 no-network invariant |
| counts cross-checked against source: registered rules == barrel exports == `.length` cited in `agent.md`/`docs/02-3`; layer module counts == directory listing | F4, F7, F9's tier count |
| workflow pinning: parse every `uses:` from `.github/workflows/*` and diff against the `docs/07-1` table | F9's last two rows |

`node scripts/arch-import-graph.cjs` already emits the import graph, cycles and layer matrix this would consume, and `scripts/arch-render-dot.cjs` regenerates the two dependency views from it.

## Verification performed (and its limits)

Checked by this session: all 216 import edges and 0 cycles (generated scan); every source line cited in F1-F16 read directly; `.c8rc.json`, `release.yml`, `security.yml`, `ci.yml`, `deploy-docs.yml`, `pr-labeler.yml` read for F9; a mechanical Mermaid frame/delimiter lint over all **53 blocks in `docs/`** (fence closure, delimiter balance, `subgraph`/`alt` frame balance, dangling flowchart endpoints, undeclared sequence participants) — **0 findings**, meaning clean under those checks rather than verified by Mermaid; the linter is proven to fire by `node scripts/mermaid-lint.cjs --self-test` (8/8, fixture at `architecture/_fixtures/negative-mermaid.md`); `agent.md`, `README.md`, 8 ADRs and all 28 docs pages inventoried.

Since the first pass, the four DOT views have been rendered with Graphviz 16.1.0 and inspected as images (no renderer warnings), which is how the `boundary-exceptions.dot` rank-constraint syntax error and the cluster-fill/label-contrast defects were caught and fixed. The Structurizr DSL has still **not** been machine-parsed — `structurizr-cli` needs a JVM that isn't installed here — so treat its rendering as unverified until you open it in the Qoder viewer.

Not checked, and it would be wrong to imply otherwise: no test suite was executed for this audit, so "correct" claims about behaviour are code-reading plus the test names in `docs/06-1`, not observed green runs; the Windows-specific lock/retry paths cannot be exercised from this machine at all.
