# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
