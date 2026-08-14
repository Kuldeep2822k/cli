# PALEE Phase 1 Implementation Checklist

This is the gate-controlled implementation roadmap for Phase 1. Every section has passed its acceptance criteria.

---

## ✓ Gate 0: Setup & Architecture (BEFORE any code)

**Objective:** Establish project structure, dependencies, and build system.

### Tasks
- [x] Initialize Node.js project (`package.json`, Node 20+ LTS)
- [x] Add dependencies: `yaml` (YAML CST parser), `commander` (CLI)
- [x] Configure TypeScript (`tsconfig.json`, strict type checking)
- [x] Set up project structure: `src/`, `test/`, `bin/palee`
- [x] Add `npm test`, `npm run lint`, `npm run check`, `npm run build` scripts to package.json
- [x] Choose test framework (`node:test` with `tsx`) and implement unit test suites

### Acceptance Criteria
- `npm install` succeeds on Windows and Unix
- `npm test` runs and exits 0
- `bin/palee --version` prints a version number
- No native modules in dependency tree

---

## ✓ Gate 1: Storage Layer (file I/O, locking, atomic writes)

**Objective:** Implement the complete storage contract from `storage_design.md` — no SM-2 logic yet, just read/write/lock.

### Tasks
- [x] Implement vault walker (ignores `.obsidian`, `.trash`, `.git`, `node_modules`, dot-dirs, symlinks)
- [x] Implement YAML frontmatter parser using CST (preserves comments, ordering, unknown keys)
- [x] Implement YAML frontmatter updater (updates only PALEE-owned keys, preserves body byte-for-byte)
- [x] Implement content fingerprinting (SHA-256 of file content)
- [x] Implement atomic write protocol: temp file → fsync → rename
- [x] Implement lock creation at `.palee/locks/<sha256-path>.lockdir/` with exclusive-create semantics
- [x] Implement lock heartbeat (15s interval)
- [x] Implement stale lock detection (60s Windows, 120s other platforms)
- [x] Implement stale lock recovery (quarantine old lock, create new one)
- [x] Implement OCC conflict detection (fingerprint mismatch → exit code 4)
- [x] Implement cache with 2-second unsettled horizon (recompute fingerprint if `mtime` within 2s)

---

## ✓ Gate 2: Engine Core (SM-2, mastery, graph, validation)

**Objective:** Implement the deterministic engine with no AI, no CLI yet — pure library functions.

### Tasks
- [x] Implement SM-2 scheduling (ease-factor delta formula, interval sequence, quality 0-5, ease_factor >= 1.3000)
- [x] Implement dependency graph (3-color DFS, cycle detection, quarantine cyclic components with exact cycle path)
- [x] Implement dependency validation (missing dependencies, cycle detection)
- [x] Implement readiness gating (`getReadyTopics` threshold = 0.7)
- [x] Implement difficulty normalization (`normalizeDifficulty()` string enum and numeric 1-5 coercion)
- [x] Implement `null` handling for `last_quality`, `last_reviewed_at`, `due_at` on newly-adopted topics

---

## ✓ Gate 3: CLI Layer (deterministic commands only, no AI yet)

**Objective:** Build the CLI commands that use the engine but do not require AI.

### Tasks
- [x] Implement `palee config set-vault <path>` — normalizes Windows backslashes, writes to config file
- [x] Implement `palee config set-provider <url> <key> <model>`
- [x] Implement `palee config show` — prints vault path, provider endpoint, model; **never** prints `api_key`
- [x] Implement `palee adopt <note-path>` — adds frontmatter with `palee_schema: 1`, stable `palee_id`, initial fields
- [x] Implement `palee next` — reads vault, returns next topic due for review; supports `--json`
- [x] Implement `palee plan` — reads vault, returns ordered learning plan respecting dependencies; supports `--json`
- [x] Implement `palee progress` — computes progress and difficulty stats; supports `--topic` and `--json`
- [x] Implement `palee review <topic> <quality>` — records SM-2 review result, updates `due_at`
- [x] Implement `palee validate` — scans vault, reports cycles, missing deps, duplicate IDs; supports `--json`
- [x] Implement `palee roadmap --from <file>` — validates roadmap JSON/YAML, checks for duplicate IDs, cycles, difficulty
- [x] Implement `palee migrate` — scans vault, counts notes with `palee_schema: 1`
- [x] Implement `palee session start` — prints hot memory position, warns if no AI provider configured
- [x] Implement `palee session end` — updates session note and regenerates hot.md / index.md
- [x] Implement `palee session list` — lists confirmed sessions and active drafts; supports `--json`
- [x] Implement `--json` and non-TTY stream detection across reading commands

---

## ✓ Gate 4: Memory System (sessions, hot.md, index.md, draft recovery)

**Objective:** Implement session memory, hot memory, draft checkpoints, and recovery.

### Tasks
- [x] Create `.palee/sessions/` directory on first session
- [x] Implement session note write (ISO-8601 timestamp ID, full frontmatter, Markdown body)
- [x] Implement `hot.md` generation (250-word cap on body only, frontmatter excluded from count, `updated_at` as `YYYY-MM-DD`)
- [x] Implement `index.md` generation (lists sessions, rebuildable from session records)
- [x] Implement draft checkpoint write to `.palee/sessions/DRAFT-S-<unique-id>.md`
- [x] Implement draft recovery: scan for `DRAFT-S-*` files, prompt `[R]esume [S]ave as session [D]iscard [I]gnore`
- [x] Non-interactive mode: report draft path and exit with message, never auto-discard
- [x] Implement "confirmed session → regenerate hot.md → regenerate index.md" pipeline
- [x] Rebuild `hot.md` and `index.md` from sessions if missing or corrupt

---

## ✓ Gate 5: Documentation & Packaging

**Objective:** Finalize user-facing docs and prepare for Phase 2.

### Tasks
- [x] Write `README.md` with installation, setup, and basic workflow
- [x] Write `CHANGELOG.md` with Phase 1 & `0.2.0` release notes
- [x] Add `bin/palee` to `package.json` `bin` field
- [x] Verify `palee --help` and exit codes
- [x] Document exit codes and Windows-specific notes in README
- [x] Maintain sacred invariants across all 18 test suites

---

## Phase 1 Complete — Ready for Phase 2

All Phase 1 gates are verified and passing.

✅ All storage invariants pass (frontmatter preservation, locks, OCC, Windows retries)  
✅ All engine invariants pass (SM-2, mastery, graph, validation)  
✅ All CLI commands work deterministically with `--json` support  
✅ Memory system works (sessions, hot.md, draft recovery)  
✅ Documentation is synchronized and accurate  
