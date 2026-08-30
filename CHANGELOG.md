# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Storage Layer Isolation & Unified Facade**: Encapsulated all vault filesystem mutations (`ensureVaultDirectory`, `resetHotMemory`, `deleteTopicDrafts`, `deleteSessionNote`, `writeSessionNote`) behind the centralized `src/storage/index.ts` facade, eliminating raw `fs.unlinkSync` and `fs.mkdirSync` calls from CLI command handlers ([#86](https://github.com/Kuldeep2822k/cli/issues/86), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **True Session Duration & Timestamp Persistence**: Persisted true start timestamps into `.palee/hot.md` and draft checkpoints, recovered start times upon completion, and recorded accurate study durations in permanent session notes ([#88](https://github.com/Kuldeep2822k/cli/issues/88), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Resilient Multi-Topic Roadmap Batch Ingestion**: Isolated per-topic parse and write exceptions in `palee roadmap --from` so single malformed notes log errors and allow remaining valid topics to continue importing ([#89](https://github.com/Kuldeep2822k/cli/issues/89), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Mermaid Interactive Pan-Zoom Controller**: Overhauled VitePress Mermaid rendering with GitHub-style inline controls, 60 FPS hardware-accelerated pan-zoom, drag threshold detection, and full-screen modal ([#115](https://github.com/Kuldeep2822k/cli/pull/115), [#116](https://github.com/Kuldeep2822k/cli/pull/116)).
- **Automatic Schema Migration (`palee migrate --fix`)**: Added `--fix` flag to automatically upgrade schema-less PALEE notes to `palee_schema: 1` atomically ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Custom Vault Traversal Exclusions**: Added `excludeDirs` option to `walkVault` and `WalkOptions` for custom directory filtering ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Session Draft Checkpoint Invariants**: Added exit code `2` and structured JSON format (`status: 'drafts_pending'`) when unconfirmed draft checkpoints block non-interactive `session start` ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Flexible Dependency Aliases**: Supported `dependencies` alias along with `depends_on` across `roadmap`, `validate`, and engine dependency validation ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).

### Fixed
- **Review OCC TOCTOU Elimination**: Re-read target topic notes immediately prior to atomic write in `palee review` to eliminate TOCTOU race conditions and emit clean exit code `4` on concurrent modifications ([#87](https://github.com/Kuldeep2822k/cli/issues/87), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Mastery Output & Dashboard Alignment**: Standardized percentage mastery formatting (`XX.X%`) across all CLI commands (`dashboard`, `next`, `plan`, `progress`, `review`) and aligned ASCII box borders to exactly 62 characters ([#91](https://github.com/Kuldeep2822k/cli/issues/91), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Deterministic FileCache Operation**: Removed environment bypasses from `FileCache`, guaranteeing deterministic cache invalidation and 2,000 ms unsettled horizon checks across all runtimes ([#90](https://github.com/Kuldeep2822k/cli/issues/90), [#120](https://github.com/Kuldeep2822k/cli/pull/120)).
- **Config Resilience & Atomic Saves**: Added `SyntaxError` and invalid format recovery in `loadConfig()` with graceful fallback to default configuration; implemented atomic `saveConfig()` with temporary file cleanup on failure ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Timezone-Safe Due Date Computation**: Fixed negative-UTC-offset date calculation in `computeDueDate()` for date-only strings and added `0000–0099` 2-digit year offset guard ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Atomic Write Concurrency**: Added cryptographic random entropy to temporary filenames in `atomicWrite()` to eliminate process-internal filename collisions ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **CST Document Frontmatter Formatting**: Unified frontmatter serialization using `Document` CST formatting for clean YAML block lists (`- item`) ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **Duplicate Topic ID Dependency Graph Retention**: Merged dependencies from duplicate topic notes during validation graph construction to preserve complete edge connectivity for cycle analysis ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).
- **CLI Fatal JSON Formatting**: Added structured JSON error output on unhandled command rejections when `--json` is supplied ([#117](https://github.com/Kuldeep2822k/cli/pull/117)).

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
