# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Features (feat)

- **Review-state, review-dates, and dependency-list validation rules (#33, #38, #39) + missing-dependency severity flip (#34)**: `palee validate` now runs three raw-frontmatter rules — `valid-review-fields` (SM-2 state as stored must match the engine contract: `ease_factor >= 1.3`, `interval_days >= 1`, counters `>= 0`, `last_quality` null or integer 0–5), `valid-review-dates` (`last_reviewed_at`/`due_at` must be null or strict real `YYYY-MM-DD` calendar dates, with inverted pairs reported), and `valid-dependency-list` (`depends_on` must be an array of non-empty string IDs; shape errors and self-references are errors, duplicates are warnings). Per VERDICT decision 1, `no-missing-dependency` findings are now warnings in vault scans — the engine quarantines the dependent topic, `roadmap --from` keeps its separate hard-error path, and `--strict` escalates. ([#33](https://github.com/Kuldeep2822k/cli/issues/33), [#34](https://github.com/Kuldeep2822k/cli/issues/34), [#38](https://github.com/Kuldeep2822k/cli/issues/38), [#39](https://github.com/Kuldeep2822k/cli/issues/39), [#165](https://github.com/Kuldeep2822k/cli/pull/165))

- **Assessment and mastery validation rules (#36, #37) + assessment-review independence coverage (#40)**: `palee validate` now runs `valid-assessment-fields` (the four pillar scores must be finite `[0.0, 1.0]` numbers as stored on disk, `assessed_at` null or a real calendar date; missing fields follow the adopt-default policy) and `valid-topic-mastery` (a warning when stored `topic_mastery` drifts from the engine formula or is malformed — `--strict` gates it). #40 is enforced as command-level regression tests instead of a static rule: `palee review` updates only SM-2 fields while assessment data survives byte-for-byte. ([#36](https://github.com/Kuldeep2822k/cli/issues/36), [#37](https://github.com/Kuldeep2822k/cli/issues/37), [#40](https://github.com/Kuldeep2822k/cli/issues/40), [#163](https://github.com/Kuldeep2822k/cli/pull/163))

- **Validation barrel + `--strict` warning escalation (#25)**: `src/validation/` ships a public barrel exporting the framework surface (`collectVault`, `runRules`, formatters, all registered rules, contract types), pinned by a census test. `palee validate --strict` exits 3 on warnings-only vaults; default behavior and the JSON payload are unchanged. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#162](https://github.com/Kuldeep2822k/cli/pull/162))

- **Schema, topic-id-format, and status validation rules (#28, #29, #31)**: three new `palee validate` rules — every PALEE-managed note must declare `palee_schema: 1` (unknown future versions error), topic IDs must match the centralized `T-` lowercase kebab-case policy (legacy formats stay valid), and `status` must be one of the four documented states. `adopt` now generates policy-compliant IDs. ([#28](https://github.com/Kuldeep2822k/cli/issues/28), [#29](https://github.com/Kuldeep2822k/cli/issues/29), [#31](https://github.com/Kuldeep2822k/cli/issues/31), [#159](https://github.com/Kuldeep2822k/cli/pull/159))

- **Validation rule framework with first rule catalog**: `palee validate` runs on a rule framework (single-read vault collector, deterministic runner, human/JSON formatters) with the duplicate-ID, missing-dependency, and cycle checks ported as pure rules. Malformed frontmatter and unreadable files become warnings that never abort the scan, and `--json` adds `warning_count`/`warnings[]`; findings, exit codes, and the rest of the JSON contract are unchanged. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#26](https://github.com/Kuldeep2822k/cli/issues/26), [#30](https://github.com/Kuldeep2822k/cli/issues/30), [#158](https://github.com/Kuldeep2822k/cli/pull/158))

- **Multi-cycle enumeration + quarantine in the dependency engine**: `detectCycles` (iterative Tarjan SCC decomposition + Johnson-style enumeration, recursion-free) reports every distinct cycle in canonical rotation, and `quarantineCyclicTopics` removes cyclic topics and their transitive dependents in a single O(V+E) pass so `plan` continues on valid acyclic components — quarantined cycles surface in human output and as a `quarantined_cycles` JSON array, with a bounded display sample (1000 cycles, `truncated` flag) so dense SCCs can never stall output. `validateDependencyGraph` reports one error per distinct cycle, `getReadyTopics` is deterministically ordered, and `detectCycle` keeps its signature as a compatibility wrapper. ([#79](https://github.com/Kuldeep2822k/cli/issues/79), [#157](https://github.com/Kuldeep2822k/cli/pull/157))

### Performance (perf)

- **Parallel test execution + categorized test scripts**: removed the forced `--test-concurrency=1` — the full suite runs ~112s → ~38s — and added `test:unit`, `test:fast`, `test:e2e`, and `test:fuzz` scripts for fast inner loops; determinism and `c8` coverage aggregation verified across parallel children. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))

- **Windows-transient lock-directory removal handled in stale-lock recovery**: `createLock`'s stale-recovery path treats `EPERM`/`EBUSY` from the lock-directory removal as retryable with a bounded 5-attempt backoff budget (Windows-only) instead of surfacing an unexpected exit-5 crash. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))

### Fixes (fix)

- **Vault-relative paths stay clean through symlinked vault roots**: `walkVault` resolves the root via `realpathSync`, and the new `relativeVaultPath()` helper keeps walked paths clean when the vault root is reached through a symlink (the macOS temp-dir default); pinned by symlinked-root regression tests through scanner, loader, and `collectVault`. ([#160](https://github.com/Kuldeep2822k/cli/issues/160))

- **Engine boundary reads canonical `depends_on` only**: removed the legacy `dependencies` alias from the `TopicNode` interface, so typed callers can no longer pass it as a dependency list; storage parsing still tolerates the on-disk alias and roadmap imports strip it. ([#140](https://github.com/Kuldeep2822k/cli/issues/140))

- **Reject unsupported `palee_schema` values in hot.md reads**: `readHotMemory()` classifies only `palee_schema: 1` as `ok`, so `session start` rebuilds a foreign hot.md instead of trusting derived state it cannot interpret (read-state contract recorded in [ADR-0007](docs/adr/0007-hot-memory-read-state-contract.md)) ([#130](https://github.com/Kuldeep2822k/cli/issues/130)).

- **Preserve explicit `0` values for SM-2 review state fields** (`ease_factor`, `interval_days`, `repetition`, `lapses`) instead of treating them as missing and applying defaults ([#127](https://github.com/Kuldeep2822k/cli/issues/127)).

- **Normalize `depends_on` and `dependencies` aliases consistently**: unified alias resolution in `normalizeDependencies`, with identical merge and dedup semantics across `loadTopics`, `validateDependencyGraph`, and roadmap processing ([#126](https://github.com/Kuldeep2822k/cli/issues/126)).

- **Emit exit code 4 on OCC conflict in `palee migrate --fix`**: per-note write conflicts are classified as `Conflict` (exit 4), the remaining notes continue migrating, and conflict outranks validation when both occur ([#128](https://github.com/Kuldeep2822k/cli/issues/128)).

### Refactor (refactor)

- **Single shared derivation for roadmap import fields**: `resolveTopicUpdates()` is now the single source of truth for both the roadmap validation pass and the writeback pass, removing the validation-vs-writeback divergence pattern behind the #137 cycle-on-import defect; OCC freshness is preserved. ([#139](https://github.com/Kuldeep2822k/cli/issues/139))

- **Centralize `hot.md` reads in `readHotMemory()`**: `src/storage/memory.ts` is the read-side owner of hot memory with a tolerant `HotMemoryRead` accessor; all six parse sites in `session.ts` were migrated with every flow's age/skew policy preserved. ([#130](https://github.com/Kuldeep2822k/cli/issues/130))

- **Injectable `loadTopics` cache**: `loadTopics` accepts a dedicated `FileCache<LoadedTopic>` via a backward-compatible options overload for isolated caching, while the shared cache seam remains the default; the legacy positional form is unchanged. ([#129](https://github.com/Kuldeep2822k/cli/issues/129))

- **Extract `resolveTopicMastery` helper**: consolidated three hand-written mastery fallback blocks into one engine helper with explicit `pillars-first` (review) and `existing-first` (adopt) precedence modes ([#127](https://github.com/Kuldeep2822k/cli/issues/127)).

- **Merge duplicate `WalkOptions` declarations** into one interface retaining `followSymlinks` and `excludeDirs`; no API surface change ([#125](https://github.com/Kuldeep2822k/cli/issues/125)).

- **Centralize exit-code mapping in `src/cli/exit-codes.ts`**: the `ExitCode` enum and `exitCodeFor()` classifier replace copy-pasted conflict-vs-unexpected ternaries across command handlers ([#128](https://github.com/Kuldeep2822k/cli/issues/128)).

### Documentation & Maintenance (docs)

- **Storage Barrel Census & JSDoc Reservations**: complete export census of `src/storage/index.ts` with explicit `@remarks` reservation markers for planned future exports and public contract tests ([#131](https://github.com/Kuldeep2822k/cli/issues/131)).

- **CLI Flag Documentation Alignment**: `next`/`plan` JSDoc docstrings and `@example` blocks now match the registered CLI flags exactly, removing phantom `--tag`/`--difficulty`/`--ready`/`--limit` references ([#131](https://github.com/Kuldeep2822k/cli/issues/131)).

- **Phase-2 type reservation**: documented `Topic`/`Assessment`/`Review`/`Progress`/`Session`/`CompletedSession`/`DraftSession` as reserved for the Phase-2 AI module ([#125](https://github.com/Kuldeep2822k/cli/issues/125)).

### Removed (removed)

- **Internal lock parameters removed from the storage barrel**: `HEARTBEAT_INTERVAL` and `STALE_TIMEOUT` had zero runtime consumers (census verdict: remove) and were pruned from the public barrel — they remain module exports in `src/storage/lock.ts` for internal and test use ([#131](https://github.com/Kuldeep2822k/cli/issues/131)).

---

## [0.4.0] - 2026-08-31

### Features (feat)
- **Storage Layer Isolation & Unified Facade**: Encapsulated all vault filesystem mutations (`ensureVaultDirectory`, `resetHotMemory`, `deleteTopicDrafts`, `deleteSessionNote`, `writeSessionNote`) behind the centralized `src/storage/index.ts` facade, eliminating raw `fs.unlinkSync` and `fs.mkdirSync` calls from CLI command handlers ([#86](https://github.com/Kuldeep2822k/cli/issues/86), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **True Session Duration & Timestamp Persistence**: Persisted true start timestamps into `.palee/hot.md` and draft checkpoints, recovered start times upon completion, and recorded accurate study durations in permanent session notes ([#88](https://github.com/Kuldeep2822k/cli/issues/88), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Resilient Multi-Topic Roadmap Batch Ingestion**: Isolated per-topic parse and write exceptions in `palee roadmap --from` so single malformed notes log errors and allow remaining valid topics to continue importing ([#89](https://github.com/Kuldeep2822k/cli/issues/89), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Mermaid Interactive Pan-Zoom Controller**: Overhauled VitePress Mermaid rendering with GitHub-style inline controls, 60 FPS hardware-accelerated pan-zoom, drag threshold detection, and full-screen modal ([#115](https://github.com/Kuldeep2822k/cli/pull/115), [#116](https://github.com/Kuldeep2822k/cli/pull/116)).
- **Automatic Schema Migration (`palee migrate --fix`)**: Added `--fix` flag to automatically upgrade schema-less PALEE notes to `palee_schema: 1` atomically ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Custom Vault Traversal Exclusions**: Added `excludeDirs` option to `walkVault` and `WalkOptions` for custom directory filtering ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Session Draft Checkpoint Invariants**: Added exit code `2` and structured JSON format (`status: 'drafts_pending'`) when unconfirmed draft checkpoints block non-interactive `session start` ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Flexible Dependency Aliases**: Supported `dependencies` alias along with `depends_on` across `roadmap`, `validate`, and engine dependency validation ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).

### Fixes (fix)
- **Review OCC TOCTOU Elimination**: Re-read target topic notes immediately prior to atomic write in `palee review` to eliminate TOCTOU race conditions and emit clean exit code `4` on concurrent modifications ([#87](https://github.com/Kuldeep2822k/cli/issues/87), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Mastery Output & Dashboard Alignment**: Standardized percentage mastery formatting (`XX.X%`) across all CLI commands (`dashboard`, `next`, `plan`, `progress`, `review`) and aligned ASCII box borders to exactly 62 characters ([#91](https://github.com/Kuldeep2822k/cli/issues/91), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Deterministic FileCache Operation**: Removed environment bypasses from `FileCache`, guaranteeing deterministic cache invalidation and 2,000 ms unsettled horizon checks across all runtimes ([#90](https://github.com/Kuldeep2822k/cli/issues/90), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **macOS Canonical Path Resolution**: Resolved `vaultPath` and `targetPath` via `realpathSync` in `walkVault` and `deleteSessionNote` to prevent false-positive boundary security errors on macOS symlinked `/var/folders` directories ([#122](https://github.com/Kuldeep2822k/cli/pull/122)).
- **macOS Draft Delete Test Stub**: Updated `deleteTopicDrafts` test stub in `test/storage-memory.test.ts` to match draft ID substring, ensuring deterministic error propagation testing across macOS realpath targets ([#123](https://github.com/Kuldeep2822k/cli/pull/123)).
- **Config Resilience & Atomic Saves**: Added `SyntaxError` and invalid format recovery in `loadConfig()` with graceful fallback to default configuration; implemented atomic `saveConfig()` with temporary file cleanup on failure ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Timezone-Safe Due Date Computation**: Fixed negative-UTC-offset date calculation in `computeDueDate()` for date-only strings and added `0000–0099` 2-digit year offset guard ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Atomic Write Concurrency**: Added cryptographic random entropy to temporary filenames in `atomicWrite()` to eliminate process-internal filename collisions ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **CST Document Frontmatter Formatting**: Unified frontmatter serialization using `Document` CST formatting for clean YAML block lists (`- item`) ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Duplicate Topic ID Dependency Graph Retention**: Merged dependencies from duplicate topic notes during validation graph construction to preserve complete edge connectivity for cycle analysis ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **CLI Fatal JSON Formatting**: Added structured JSON error output on unhandled command rejections when `--json` is supplied ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).

### Maintenance & CI (chore)
- **npm OIDC Trusted Publishing & Provenance**: Configured `.github/workflows/release.yml` for tokenless npm OpenID Connect (OIDC) publishing with build provenance attestations ([#124](https://github.com/Kuldeep2822k/cli/pull/124)).
- **CodeRabbit Code Review Hardening**: Addressed CodeRabbit review findings across signal handling, CI budget tolerance, and JSDoc documentation ([#120](https://github.com/Kuldeep2822k/cli/pull/120)).

---

## [0.3.1] - 2026-08-23

### Fixed
- **NPM Readme Asset Resolution**: Fixed README logo URL pointing to raw GitHub asset for npm registry rendering.

### Changed
- **CI / CD Action Version Upgrades**: Bumped GitHub Actions dependencies ([#99](https://github.com/Kuldeep2822k/cli/pull/99), [#100](https://github.com/Kuldeep2822k/cli/pull/100), [#101](https://github.com/Kuldeep2822k/cli/pull/101), [#102](https://github.com/Kuldeep2822k/cli/pull/102)).

---

## [0.3.0] - 2026-08-20

### Added
- **Batch Note Adoption (`palee adopt`)**: Added recursive directory adoption and whole-vault adoption with `--dry-run`, `--yes`, `--tag`, `--include`, and `--exclude` glob filters ([#50](https://github.com/Kuldeep2822k/cli/pull/50), [#74](https://github.com/Kuldeep2822k/cli/pull/74)).
- **Multi-Format Roadmap Parser**: Supported pure YAML, frontmatter YAML, and embedded code fence YAML roadmaps ([#112](https://github.com/Kuldeep2822k/cli/pull/112)).
- **Technical Documentation Suite**: Published 35-chapter VitePress documentation suite with 53 interactive architecture diagrams, JSDoc specifications, and Architecture Decision Records (ADRs) ([#108](https://github.com/Kuldeep2822k/cli/pull/108), [#112](https://github.com/Kuldeep2822k/cli/pull/112), [#114](https://github.com/Kuldeep2822k/cli/pull/114)).
- **OCC & Lock Conflict Exit Codes**: Emitted distinct exit code `4` on Optimistic Concurrency Control (OCC) and file lock conflicts (`isConflictError`) ([#76](https://github.com/Kuldeep2822k/cli/pull/76), [#107](https://github.com/Kuldeep2822k/cli/pull/107)).

### Changed
- **CLI Exit Code Standardization**: Replaced `process.exit()` with `process.exitCode` across all CLI command handlers to ensure clean stream flushing ([#77](https://github.com/Kuldeep2822k/cli/pull/77), [#110](https://github.com/Kuldeep2822k/cli/pull/110)).
- **Centralized Vault Validation**: Routed all CLI command handlers through `validateVaultPath` for uniform permission checks and onboarding messages ([#78](https://github.com/Kuldeep2822k/cli/pull/78), [#111](https://github.com/Kuldeep2822k/cli/pull/111)).
- **Storage Layer Boundary Unification**: Unified vault scanning into centralized `loadTopics` boundary with in-memory caching and single-pass file discovery ([#98](https://github.com/Kuldeep2822k/cli/pull/98)).
- **Shared Mastery Engine Refactoring**: Extracted shared `MASTERY_THRESHOLD` constant and unified topic mastery calculation during note adoption and review updates ([#85](https://github.com/Kuldeep2822k/cli/pull/85), [#94](https://github.com/Kuldeep2822k/cli/pull/94), [#95](https://github.com/Kuldeep2822k/cli/pull/95), [#106](https://github.com/Kuldeep2822k/cli/pull/106)).

### Fixed
- **Archived Topic Exclusion**: Excluded archived topics from global mastery calculation ([#97](https://github.com/Kuldeep2822k/cli/pull/97)).
- **Invalid Date Guard in Progress**: Guarded progress date parsing against invalid dates ([#96](https://github.com/Kuldeep2822k/cli/pull/96)).

---

## [0.2.0] - 2026-08-14

### Added
- **Machine-Readable `--json` Output (Invariant #45)**: Added `--json` option across all reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, and `session list`). Piped or redirected output automatically defaults to JSON mode when stdout is non-TTY.
- **Structured JSON Setup Errors**: Vault validation and configuration errors emit structured `{"error": "..."}` JSON with exit code 2 when run in JSON or non-TTY mode.
- **Standardized `Difficulty` Enum & Runtime Helper**: Defined `Difficulty = 'beginner' | 'intermediate' | 'advanced'` in `src/types.ts` and added `normalizeDifficulty()` runtime helper supporting string folding, whitespace trimming, and numeric mappings (1 -> beginner, 2..3 -> intermediate, 4..5 -> advanced).
- **Empty Vault Onboarding Guidance**: Added centralized `printEmptyVaultOnboarding()` helper to provide actionable commands (`palee adopt`, `palee roadmap --from`) across empty vault states.
- **Session Topic Option**: Added `--topic <id>` option to `palee session` and implemented `resolveSessionTopic()` with active topic fallback.

### Fixed
- **Dashboard Division-by-Zero Guard**: Added explicit `total > 0` ternary check in `src/cli/dashboard.ts` to prevent `NaN%` display on empty vaults.
- **Vault Validation & Permissions**: Replaced abrupt `process.exit(0)` with clean `return` on empty states and added directory/read-permission (`R_OK`) checks at vault root.
- **Phantom Topic Elimination**: Eliminated default creation of phantom `T-general` topic notes during session operations.

---

## [0.1.0] - 2026-08-12

### Added
- Setup & Architecture with `commander`, `yaml`, and Node.js testing.
- Conflict-Aware Atomic Storage Layer with file fingerprinting, OCC, and robust file locking.
- Deterministic Engine Core (SM-2, mastery calculation, dependency graph resolution, cycle detection).
- Comprehensive CLI Layer with deterministic commands (`plan`, `next`, `progress`, `review`, `validate`, `roadmap --from`, `adopt`).
- Phase 1 Session Memory System (`hot.md`, `index.md`, durable session logs, draft recovery).
- Full Windows path and lock-recovery support.
- Interactive draft checkpoint recovery.

### Fixed
- Fixed strict TypeScript enforcement and removed all dead code.
- Purged all narrative comments to conform to strict code standards.
