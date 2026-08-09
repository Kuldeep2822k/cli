# PALEE Phase 1 Implementation Checklist

This is the gate-controlled implementation roadmap for Phase 1. Every section must pass its acceptance criteria before moving to the next.

---

## ✓ Gate 0: Setup & Architecture (BEFORE any code)

**Objective:** Establish project structure, dependencies, and build system.

### Tasks
- [ ] Initialize Node.js project (`package.json`, Node 20+ LTS)
- [ ] Add dependencies: `yaml` (YAML CST parser), `js-yaml`, `commander` (CLI), `chalk` (terminal colors)
- [ ] Configure TypeScript or use plain JavaScript (document choice in README)
- [ ] Set up project structure: `src/`, `test/`, `bin/palee`
- [ ] Add `npm test`, `npm run lint` scripts to package.json
- [ ] Choose test framework (e.g., `node:test`, `vitest`, `jest`) and write one smoke test

### Acceptance Criteria
- `npm install` succeeds on Windows and Unix
- `npm test` runs and exits 0 (even with one trivial passing test)
- `bin/palee --version` prints a version number
- No native modules in dependency tree (run `npm ls` and verify)

### Verification
```bash
npm install
npm test
node bin/palee --version
npm ls | grep -i native  # should return nothing
```

**STOP HERE until all criteria pass.**

---

## ✓ Gate 1: Storage Layer (file I/O, locking, atomic writes)

**Objective:** Implement the complete storage contract from `storage_design.md` — no SM-2 logic yet, just read/write/lock.

### Tasks
- [ ] Implement vault walker (ignores `.obsidian`, `.trash`, `.git`, `node_modules`, dot-dirs, symlinks)
- [ ] Implement YAML frontmatter parser using CST (preserves comments, ordering, unknown keys)
- [ ] Implement YAML frontmatter updater (updates only PALEE-owned keys, preserves body byte-for-byte)
- [ ] Implement content fingerprinting (SHA-256 of file content)
- [ ] Implement atomic write protocol: temp file → fsync → rename
- [ ] Implement lock creation at `.palee/locks/<sha256-path>.lock` with exclusive-create semantics
- [ ] Implement lock heartbeat (15s interval, updates `heartbeat_at` field)
- [ ] Implement stale lock detection (60s Windows, 120s other platforms, configurable)
- [ ] Implement stale lock recovery (quarantine old lock, create new one)
- [ ] Implement Windows retry logic (5 attempts, exponential backoff, 50ms initial delay, 2x multiplier, ±25% jitter, 300ms cap)
- [ ] Implement OCC conflict detection (fingerprint mismatch → exit code 4)
- [ ] Implement cache with 2-second unsettled horizon (recompute fingerprint if `mtime` within 2s)

### Acceptance Criteria (from `invariants.md`)
- Updating a PALEE field preserves the Markdown body byte-for-byte
- Unknown frontmatter keys, comments, ordering, block scalars, aliases, and tags survive an update
- A changed fingerprint causes an OCC conflict and leaves the target untouched
- A second PALEE writer cannot acquire the target lock and receives exit code `4`
- Lock heartbeats occur every 15 seconds; locks become stale after 60s (Windows) or 120s (other) without a heartbeat
- Stale-lock recovery quarantines the old lock before creating a new one
- Lock release occurs after success, validation failure, conflict, and process interruption (Ctrl+C)
- A temporary-file or rename failure never truncates the target
- Five transient Windows lock failures are retried; a persistent lock returns exit code `4`
- The walker skips excluded directories and symlinks by default
- A malformed note produces a validation warning and does not abort a vault scan

### Verification
Write unit tests for every invariant above. Create a test vault with:
- A note with comments in frontmatter
- A note with unknown keys (`obsidian_plugin_data`, `cssclass`)
- A note with block scalar Markdown body containing YAML-like text
- A symlink to an external directory (should be skipped)
- A malformed YAML note (should warn, not crash)

Run two PALEE processes concurrently trying to lock the same file — second must exit with code 4.

Simulate Ctrl+C during a write — lock must be released.

On Windows: simulate EPERM by locking a file externally (e.g., open in Notepad with exclusive lock) — PALEE must retry 5 times then exit with code 4.

**STOP HERE until all tests pass.**

---

## ✓ Gate 2: Engine Core (SM-2, mastery, graph, validation)

**Objective:** Implement the deterministic engine with no AI, no CLI yet — pure library functions.

### Tasks
- [ ] Implement SM-2 scheduling (ease-factor delta formula, interval sequence, quality 0-5, ease_factor >= 1.3000)
- [ ] Implement mastery calculation: `round((c + p + d + feynman*2) / 5, 4)`
- [ ] Implement global mastery (excludes archived, includes paused, returns `null` with `no_data` status if zero active topics)
- [ ] Implement dependency graph (3-color DFS, cycle detection, quarantine cyclic components with exact cycle path)
- [ ] Implement unlock scoring (inverse dependency graph, bounded by graph size)
- [ ] Implement topic resolution (exact ID → exact title/filename → legacy alias → normalized slug → token-distance)
- [ ] Implement schema validation (reject invalid `quality`, `ease_factor`, `interval_days`, `repetition`, scores 0-1)
- [ ] Implement `null` handling for `last_quality`, `last_reviewed_at`, `due_at` on newly-adopted topics

### Acceptance Criteria (from `invariants.md`)
- `quality` accepts only integers `0..5`; for unreviewed topics, `last_quality` is `null`
- Ease-factor delta is `0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`
- `ease_factor` is always at least `1.3000` (stored with 4 decimal places)
- Ease factor and intervals use positive decimal half-up rounding
- `quality < 3` resets repetition to `0` and interval to `1`
- Successful repetitions use intervals `1`, `6`, then `round(previous_interval * ease_factor)`
- Lapses increase only when a previously learned topic is forgotten (repetition was > 0 before the failure)
- No result produces an interval below `1`
- Due dates add calendar days in the configured vault timezone
- Topic mastery is `round((conceptual + practical + debug + (feynman * 2)) / 5, 4)` — feynman is double-weighted
- Global mastery excludes archived topics and includes paused topics
- With zero active topics, global mastery is `null` with status `no_data`, never numeric zero
- Missing dependencies block a topic and produce a warning
- Cycles are quarantined with an exact cycle path; acyclic topics remain usable
- Unlock scoring never returns a value larger than the number of reachable downstream topics

### Verification
Write unit tests for every formula and edge case above. Test data:
- A topic with `quality = 2` (below 3) — assert repetition resets to 0, interval to 1
- A topic with `quality = 5` — assert ease_factor increases, interval grows
- A topic with `ease_factor = 1.28` after update — assert clamped to `1.3000`
- Four topics with scores `[0.7, 0.4, 0.2, 0.5]` — assert mastery = `round((0.7+0.4+0.2+0.5*2)/5, 4)` = `0.4600`
- Zero active topics — assert `{mastery: null, status: "no_data"}`
- A dependency graph with a cycle `A → B → C → A` — assert cycle is quarantined and path is reported
- A dependency graph with 5 topics, 3 depending on topic X — assert unlock score for X is 3

**STOP HERE until all tests pass.**

---

## ✓ Gate 3: CLI Layer (deterministic commands only, no AI yet)

**Objective:** Build the CLI commands that use the engine but do not require AI.

### Tasks
- [ ] Implement `palee config set-vault <path>` — normalizes Windows backslashes, writes to config file
- [ ] Implement `palee config set-provider <url> <key> <model>` — writes to `%LOCALAPPDATA%\palee\ai_provider.json` (Windows) or `~/.config/palee/ai_provider.json` (Unix)
- [ ] Implement `palee config show` — prints vault path, provider endpoint, model; **never** prints `api_key`
- [ ] Implement `palee adopt <note-path>` — adds frontmatter with `palee_schema: 1`, stable `palee_id`, initial assessment scores 0.0, review fields with `null` for unreviewed state
- [ ] Implement `palee next` — reads vault, returns next not-started or learning topic (status-based priority)
- [ ] Implement `palee plan` — reads vault, returns ordered learning path respecting dependencies
- [ ] Implement `palee progress` — computes global mastery, prints stats
- [ ] Implement `palee review <topic> <quality>` — records SM-2 review result, updates `due_at`
- [ ] Implement `palee validate` — scans vault, reports cycles, missing deps, schema errors, dangling refs; exit code 0 if clean, 3 if errors found
- [ ] Implement `palee roadmap --from <file>` — validates roadmap JSON, checks for duplicate IDs, cycles, invalid difficulty, unsafe paths; asks for confirmation before writing
- [ ] Implement `palee migrate` — scans vault, counts notes with `palee_schema: 1`, reports any unrecognized versions; exit code 0 if all valid, 3 if any invalid; **writes nothing in Phase 1**
- [ ] Implement `palee session start` — prints hot memory position if it exists; prints message "No AI provider configured" if no provider set; deterministic-only output in Phase 1
- [ ] Implement `palee session end` — stub that prints "Session commands require Phase 2 (AI integration)"

### Acceptance Criteria (from `invariants.md` and `palee_cli_spec.md`)
- Resolution precedence is exact ID, exact title/filename, legacy alias, normalized slug, then token-distance match
- Ambiguous matches require interactive selection or return deterministic non-interactive error with exit code `2` and list all candidates
- Non-AI commands open no network sockets
- `--json` and non-TTY output contain no ANSI control sequences
- `roadmap --from` performs no network or AI calls
- A user-provided roadmap is validated before any vault mutation
- No roadmap proposal writes topic notes before explicit learner confirmation
- Roadmap proposals conform to the schema in `roadmap_design.md`
- `config show` never prints `api_key`
- Exit codes: `0` success, `2` usage error, `3` validation failure, `4` lock conflict, `5` provider/network error

### Verification
Create a test vault with 5 topics (2 with `status: not_started`, 1 `learning`, 2 `archived`).

Run:
```bash
palee adopt "Docker.md"
palee validate
palee next
palee plan
palee progress
palee review T-docker-basics 4
palee roadmap --from test-roadmap.json  # valid roadmap
palee roadmap --from invalid-roadmap.json  # contains cycle, expect exit 3
palee migrate
palee config show  # must not print api_key
```

Verify:
- `adopt` adds frontmatter with `assessed_at: null`, `last_quality: null`
- `validate` reports a missing dependency if one exists
- `next` returns the first `not_started` topic
- `review` updates `due_at`, `ease_factor`, `repetition`
- `roadmap --from` rejects a cyclic roadmap with exit code 3
- `migrate` prints "All notes are at current schema version 1"
- `config show` prints vault and provider but redacts api_key

**STOP HERE until all tests pass.**

---

## ✓ Gate 4: Memory System (sessions, hot.md, index.md, draft recovery)

**Objective:** Implement session memory, hot memory, draft checkpoints, and recovery — still deterministic, no AI prompts yet.

### Tasks
- [ ] Create `.palee/sessions/` directory on first session
- [ ] Implement session note write (ISO-8601 timestamp ID, full frontmatter, Markdown body)
- [ ] Implement `hot.md` generation (250-word cap on body only, frontmatter excluded from count, `updated_at` as `YYYY-MM-DD`)
- [ ] Implement `index.md` generation (lists sessions, rebuildable from session records)
- [ ] Implement draft checkpoint write to `.palee/sessions/DRAFT-S-<unique-id>.md` after each meaningful turn
- [ ] Implement draft recovery on startup: scan for `DRAFT-S-*` files, prompt `[R]esume [S]ave as session [D]iscard [I]gnore`
- [ ] Non-interactive mode: report draft path and exit with message, never auto-discard
- [ ] Implement "confirmed session → regenerate hot.md → regenerate index.md" pipeline
- [ ] Rebuild `hot.md` and `index.md` from sessions if missing or corrupt

### Acceptance Criteria (from `invariants.md` and `memory_design.md`)
- A draft checkpoint survives interruption; on next startup, interactive mode offers Resume, Save as session, Discard, and Ignore — all four paths must behave correctly and non-interactive mode must never auto-discard
- A confirmed session is written before derived views are regenerated
- Corrupt or missing `hot.md` is rebuilt from canonical sessions
- `hot.md` contains no more than 250 words in body (frontmatter excluded)
- `updated_at` in `hot.md` uses `YYYY-MM-DD` (date only)
- Session note filenames use `S-<ISO8601-timestamp>-<collision-suffix>.md` format

### Verification
Create a session, write a draft checkpoint, kill the process with Ctrl+C, restart — draft must be offered for recovery.

Write a session, delete `hot.md`, run any command — `hot.md` must be regenerated from the last session.

Write a session with a 300-word summary, generate `hot.md` — body must be truncated to 250 words (frontmatter not counted).

**STOP HERE until all tests pass.**

---

## ✓ Gate 5: Documentation & Packaging

**Objective:** Finalize user-facing docs and prepare for Phase 2.

### Tasks
- [ ] Write `README.md` with installation, setup, and basic workflow
- [ ] Write `CHANGELOG.md` with Phase 1 release notes
- [ ] Add `bin/palee` to `package.json` `bin` field
- [ ] Test `npm install -g .` and verify `palee --help` works globally
- [ ] Write example vault in `examples/` directory
- [ ] Document exit codes in README
- [ ] Add Windows-specific notes (path normalization, lock timeout, `%LOCALAPPDATA%`)

### Acceptance Criteria
- `npm install -g .` succeeds and `palee --version` works from any directory
- README explains setup in 5 steps or fewer
- Example vault has 3 topics with dependencies, can run through `adopt → next → plan → progress → review` workflow
- All Phase 1 commands are documented with examples

### Verification
Install globally, create a new vault, run the Quick Start from README — every command must work.

---

## Phase 1 Complete — Gate to Phase 2

**Before starting Phase 2 (AI integration), verify:**

✅ All storage invariants pass (frontmatter preservation, locks, OCC, Windows retries)  
✅ All engine invariants pass (SM-2, mastery, graph, validation)  
✅ All CLI commands work without AI (deterministic-only)  
✅ Memory system works (sessions, hot.md, draft recovery)  
✅ Documentation is complete and accurate  
✅ Example vault demonstrates every Phase 1 command  
✅ No Phase 2 features are partially implemented (no dead code)

**If any gate criterion fails, stop and fix before proceeding.**

---

## What Phase 2 Adds (DO NOT implement in Phase 1)

Phase 2 introduces:
- AI module (`ai_module_design.md`)
- `palee test <topic>` (Feynman testing)
- `palee tutor <topic>` (interactive tutoring)
- `palee roadmap` (guided roadmap generation — no `--from` flag)
- Human-confirm gates for AI proposals
- Hot memory injection into AI context
- Anomaly detection for assessment scores
- Provider config usage

Phase 1 is deterministic-only. Do not start Phase 2 until all Phase 1 gates pass.
