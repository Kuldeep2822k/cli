# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Performance (perf)

- **Parallel test execution + categorized test scripts**: Removed the forced `--test-concurrency=1` (Node's test runner now parallelizes across CPU cores — file-level process isolation was already guaranteed since each test file runs in its own child process, and all suites use per-test `fs.mkdtempSync` temp dirs + per-process `PALEE_CONFIG_DIR`). Full suite: ~112s → ~38s locally (66% faster; acceptance target was 50%). Added `test:unit` (storage/engine/types/smoke, ~2.5s), `test:fast` (everything except the e2e tier suites and challenger1 stress, ~19s), `test:e2e` (tier suites), and `test:fuzz` (fuzz/stress) for fast inner loops. Verified deterministic across repeated runs, and `c8` coverage aggregation still reports correctly across parallel children ([#121](https://github.com/Kuldeep2822k/cli/issues/121)).

- **Windows-transient lock-directory removal handled in stale-lock recovery**: `createLock`'s stale-recovery path now treats `EPERM`/`EBUSY` from the lock-directory `rmdirSync` as retryable with a bounded 5-attempt budget (exponential backoff 50ms→300ms, ±25% jitter, Windows-only) instead of surfacing an unexpected exit-5 crash — on Windows, antivirus/indexer/other processes can briefly hold handles on `.palee/locks/*` directories under concurrent load. Recovery outcome is derived from the rmdirSync result, not the attempt count, so a successful final retry (or an ENOTEMPTY/ENOENT forward-progress signal) completes recovery instead of throwing the stale error; the original EPERM/EBUSY is rethrown only when the budget is spent unrecovered. Exposed by parallel test runs (challenger1 stress round); same Windows-transience policy as `atomicWrite`'s rename retries ([#121](https://github.com/Kuldeep2822k/cli/issues/121)).

### Refactor (refactor)

- **Injectable `loadTopics` cache**: `loadTopics(vaultPath, { cache })` now accepts a dedicated `FileCache<LoadedTopic>` via a backward-compatible `LoadTopicsOptions` overload, letting in-process tests and future consumers (Phase-2 AI read tools, validation framework) cache in isolation while the shared `getTopicCache()` seam remains the default. The legacy positional `loadTopics(vaultPath, files?)` form is unchanged ([#129](https://github.com/Kuldeep2822k/cli/issues/129)).

### Fixes (fix)

- **Engine boundary reads canonical `depends_on` only (type surface aligned)**: Removed the legacy `dependencies?: string[]` alias field from the `TopicNode` interface — engine functions (`getTopicDependencies` and everything downstream) read the canonical `depends_on` field only, so a TypeScript caller constructing a `TopicNode` with the legacy field no longer typechecks as a typed dependency list (it degrades to `unknown` via the index signature). Storage-layer parsing still tolerates the on-disk alias via `normalizeDependencies`; `roadmap --from` still strips the legacy key on import. Contract pinned by a runtime test (legacy alias yields `[]`) and a `@ts-expect-error` compile pin ([#140](https://github.com/Kuldeep2822k/cli/issues/140)).

- **Reject unsupported `palee_schema` values in hot.md reads**: `readHotMemory()` now classifies only `palee_schema: 1` as `ok`; absent, versioned (`2`), boolean (`true`), and stringified (`"1"`) values classify as `schema-invalid`, so `session start` rebuilds a foreign hot.md instead of trusting derived state it cannot interpret. Read-state contract recorded in [ADR-0007](docs/adr/0007-hot-memory-read-state-contract.md) ([#130](https://github.com/Kuldeep2822k/cli/issues/130)).
- Preserve explicit `0` values for SM-2 review state fields (`ease_factor`, `interval_days`, `repetition`, `lapses`) instead of treating them as missing and applying defaults ([#127](https://github.com/Kuldeep2822k/cli/issues/127)).
- **Normalize `depends_on` and `dependencies` aliases consistently**: Unified alias resolution in `src/storage/loader.ts` via `normalizeDependencies`, ensuring identical merge and deduplication semantics across `loadTopics`, `validateDependencyGraph`, and roadmap processing ([#126](https://github.com/Kuldeep2822k/cli/issues/126)).
- **Emit exit code 4 on OCC conflict in `palee migrate --fix`**: Per-note write conflicts are now classified as `Conflict` (exit 4) instead of falling through to the validation exit 3 / unexpected 5 paths; the remaining notes continue migrating, and conflict outranks validation when both occur ([#128](https://github.com/Kuldeep2822k/cli/issues/128)).

### Refactor (refactor)

- **Single shared derivation for roadmap import fields**: Extracted `resolveTopicUpdates()` in `src/cli/roadmap.ts` (return type `ResolvedTopicUpdates` in `src/types.ts`) — the validation pass and the `doImport` writeback pass now resolve every effective field value (difficulty, depends_on, and all frontmatter pass-throughs) from one pure helper instead of deriving `depends_on` once and re-deriving the other ~15 fields inline with duplicated fallback rules. Removes the validation-vs-writeback divergence pattern that produced the #137 cycle-on-import defect; any future roadmap field must be added to the helper, not to one pass. `depends_on` semantics unchanged (explicit `[]` clears, omitted preserves existing, populated replaces); difficulty fallback pinned by a new test. The helper is called with fresh per-pass data — writeback still re-reads the target note just before the atomic write (OCC freshness preserved) ([#139](https://github.com/Kuldeep2822k/cli/issues/139)).

- **Centralize `hot.md` reads in `readHotMemory()`**: Made `src/storage/memory.ts` the read-side owner of `.palee/hot.md` with a tolerant `readHotMemory()`/`resolveActiveTopic()` accessor (`HotMemoryRead` distinguishes `missing`, `no-frontmatter`, `corrupt`, `schema-invalid`, and `ok`); migrated all six parse sites in `session.ts` (topic resolution, start ×3, draft, end) with every flow's age/skew policy preserved ([#130](https://github.com/Kuldeep2822k/cli/issues/130)).
- **Extract `resolveTopicMastery` helper**: Consolidated three hand-written mastery fallback blocks into one engine helper with explicit `pillars-first` (review) and `existing-first` (adopt) precedence modes ([#127](https://github.com/Kuldeep2822k/cli/issues/127)).
- **Merge duplicate `WalkOptions` declarations**: Consolidated the two copies in `src/types.ts` into one interface retaining `followSymlinks` and `excludeDirs`; no API surface change ([#125](https://github.com/Kuldeep2822k/cli/issues/125)).
- **Centralize exit-code mapping in `src/cli/exit-codes.ts`**: Introduced the `ExitCode` enum and `exitCodeFor()` classifier; all command handlers now share one conflict-vs-unexpected mapping instead of copy-pasted `isConflictError(err) ? 4 : 5` ternaries, and raw `5` literals in catches were replaced with `ExitCode.Unexpected` ([#128](https://github.com/Kuldeep2822k/cli/issues/128)).

### Documentation & Maintenance (docs)

- **Storage Barrel Census & JSDoc Reservations**: Conducted a complete export census of `src/storage/index.ts`, annotated planned future-need exports (`getTopicCache`, `countWords`, `truncateWords`, `MAX_HOT_WORDS`, `UNSETTLED_HORIZON`, `extractTags`) with explicit `@remarks` reservation markers in owning modules, and added comprehensive public contract tests ([#131](https://github.com/Kuldeep2822k/cli/issues/131)).
- **CLI Flag Documentation Alignment**: Corrected `nextCommand` and `planCommand` JSDoc docstrings and `@example` blocks in `src/cli/next.ts` and `src/cli/plan.ts` to match registered CLI flags in `bin/palee.ts` exactly, removing phantom references to `--tag`, `--difficulty`, `--ready`, and `--limit` ([#131](https://github.com/Kuldeep2822k/cli/issues/131)).
- **Phase-2 type reservation**: Documented `Topic`/`Assessment`/`Review`/`Progress`/`Session`/`CompletedSession`/`DraftSession` as reserved for the Phase-2 AI module ([#125](https://github.com/Kuldeep2822k/cli/issues/125)).

### Removed (removed)

- **Internal lock parameters removed from the storage barrel**: `HEARTBEAT_INTERVAL` and `STALE_TIMEOUT` had zero runtime consumers and no reservations (#131 census verdict: remove) — pruned from `src/storage/index.ts` and the root re-export chain. They remain module exports in `src/storage/lock.ts` for internal and test use. As the package is 0.x, this lands in a minor release per semver 0.x conventions ([#131](https://github.com/Kuldeep2822k/cli/issues/131)).

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
