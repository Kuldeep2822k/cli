---
name: agent
description: Primary agent for the palee codebase — an AI-powered study tracker CLI (TypeScript, CommonJS). Use for any code change, bug fix, feature, or review in this repository.
mode: primary
---

You are the primary developer agent for **palee** (`@kuldeep2822k/palee`), an AI-powered study tracker that schedules learning with SM-2 spaced repetition and dependency-aware recommendations over an Obsidian vault. `palee_schema` is 1; the package targets Node >=22, CommonJS.

## Architecture (four layers)

- `src/types.ts` — single source of truth for shared types; `src/index.ts` re-exports it (`export *`) plus `version`. Engine and storage are internal, reached only via relative imports.
- `src/engine/` — pure, deterministic, fs-free logic: `sm2.ts` (SM-2 scheduling), `dependency.ts` (dependency-graph cycle detection / readiness / validation), `index.ts` facade (exports `processReview`, `computeDueDate`, `detectCycle`, `getReadyTopics`, `validateDependencyGraph`).
- `src/storage/` — all filesystem IO: `vault-walker`, `frontmatter`, `lock`, `atomic-write`, `cache`, `memory`; `index.ts` facade re-exports the layer. **No raw `fs` outside storage.**
- `src/cli/` — one commander handler per command, each `export default`, registered in `bin/palee.ts` (no `src/cli/index.ts`).

No path aliases — plain relative imports (`'../types'`, `'./frontmatter'`). Data-model fields are snake_case (`palee_id`, `interval_days`); code identifiers camelCase. Only runtime deps: `commander`, `yaml`.

## CLI conventions (from src/cli/*.ts and bin/palee.ts)

- **Adding a command** requires: a default-exported handler in `src/cli/<name>.ts`, a `.command()...action(handler)` block in `bin/palee.ts`, and a matching `*Options` type in `src/types.ts` for any flags.
- Every handler starts with `loadConfig()`; when `!config.vaultPath`, print exactly `Error: Vault path not configured. Run: palee config set-vault <path>` to stderr and `process.exit(2)`.
- Discover notes via `walkVault` + `parseFrontmatter`; filter on `frontmatter.palee_id`. WalkVault skips dot-dirs (`.obsidian`, `.palee`, `.git`), `node_modules`, symlinks — `.palee/` is never scanned as topics.
- Wrap every handler in try/catch → `console.error(\`Error: ${err.message}\`); process.exit(5)`.
- **Exit codes are load-bearing** (README and CI assert them): `0` success, `1` partial import failure, `2` usage/config, `3` validation failures, `4` OCC lock conflict, `5` unexpected exception. Every code path calls `process.exit(n)` explicitly.
- Output style: plain `console.log`/`console.error` — **no ANSI colors, no tables, no progress bars, no emoji**. Symbols: `✓` success, `⚠` warning, `•` bullets, `─` separators, `=== ... ===` headers (boxed `╔═╗` only on dashboard), 2-space sub-detail indents, `(not set)` / `(none)` empty states, `.toFixed(1)` percentages. Always guard division calculations with `total > 0` checks.

## Sacred invariants (never break; all are test-pinned)

SM-2 (`src/engine/sm2.ts`):
- Quality is integer 0-5; non-integer or out-of-range throws `Invalid quality`. Defaults: `ease_factor 2.5`, `interval_days 1`, `repetition 0`.
- `quality < 3` ⇒ `repetition = 0` AND `interval_days = 1`; `lapses += 1` **only if `repetition > 0`**.
- Success intervals: repetition 1 → 1, 2 → 6, 3+ → `Math.round(interval_days * ease_factor)` (clamped `Math.max(1, ...)`).
- EF delta frozen: `0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`; EF floor `1.3`; EF rounded half-up to ≤4 decimals (`roundHalfUp` uses `+1e-10` epsilon).
- `processReview` is pure: no timestamps, no side effects, deterministic — callers (`review.ts`) own `last_reviewed_at`/`due_at`.
- `computeDueDate` uses local-calendar `setDate` math (DST-safe) — never switch to UTC ms math.

Dependencies (`src/engine/dependency.ts`):
- Input is `Map<string, TopicNode>` keyed by `palee_id`; `TopicNode = { palee_id, depends_on, topic_mastery, [key]: unknown }`. `depends_on` = prerequisite IDs.
- `detectCycle` = 3-color DFS returning the exact repeated-start path or `null`. `validateDependencyGraph` emits `missing_dependency` errors then one `cycle` error with `path`; `valid = errors.length === 0`. Error `type` stays in `'duplicate_id'|'missing_dependency'|'cycle'`.
- Missing dep **blocks** (returns false / emits error), never throws, never crashes the scan.
- Readiness gate: `getReadyTopics(topics, threshold = 0.7)` keeps topics with `mastery < threshold` whose every dep has `mastery >= threshold`. The `0.7` constant is duplicated in `plan.ts` — keep aligned.

Storage (`src/storage/`):
- All vault writes go through `atomicWrite` (temp file + flush + `renameSync`); never bare fs writes to notes. Pass the prior content's `computeFingerprint` as `expectedFingerprint` — mismatch throws `OCC conflict` and leaves the target untouched.
- Writes are serialized by `Lock` (`.palee/locks/<sha256>.lockdir/`, 15s heartbeat, stale 60s Windows / 120s else, recovery quarantines via rename, never blind-delete).
- `updateFrontmatter` is CST-preserving (`yaml` parseDocument): body preserved byte-for-byte; unknown keys/comments/ordering survive; malformed frontmatter **throws**, never silently rewrites. PALEE-owned keys: `palee_schema, palee_id, topic, track, difficulty, status, dependencies, assessment, review` (plus the flat SRS/assessment fields `adopt.ts` writes).
- `.palee/sessions/*` and topic notes are **canonical**; `.palee/index.md` and `.palee/hot.md` are **derived, freely rebuildable** (`rebuildHotAndIndex`). Zero-byte session files are deleted during rebuild. `DRAFT-S-*` never counts as history; non-interactive mode never auto-discards drafts.
- Session ids `S-<UTC YYYYMMDDTHHMMSS>-<4 hex>`; drafts `DRAFT-S-<8 hex>`.

## On-disk formats

- **Topic note frontmatter is FLAT** (not the nested `assessment`/`review` shape in `types.ts` — the type is out of sync; code reads flat keys). Order written by `adopt.ts`: `palee_id`, `palee_schema`, `difficulty`, `depends_on`, `topic_mastery`, `assessed_at`, `conceptual/practical/debug/feynman`, `ease_factor`, `interval_days`, `repetition`, `lapses`, `last_quality`, `last_reviewed_at`, `due_at`. `difficulty` is the string enum `Difficulty = 'beginner' | 'intermediate' | 'advanced'` standardized in `src/types.ts` with `normalizeDifficulty()`. `last_quality`, `last_reviewed_at`, `due_at`, `assessed_at` may be literal `null` — branch on null before `new Date(...)`, default via `|| 0`. Dates are `YYYY-MM-DD` for review/due fields; sessions/hot use full ISO with ms+Z; never assume one format.
- **`.palee/index.md`**: `palee_schema: 1`, `type: "session_index"`, `updated_at: YYYY-MM-DD`; body `# PALEE Session Index` + `Total Sessions: N` + `- [[S-<id>]] - Topic: T-x (YYYY-MM-DD)`, newest first. `.palee` metadata files quote all strings with double quotes; topic notes are unquoted.
- **Session file** `.palee/sessions/S-<id>.md`: FM `palee_schema`, `session_id`, `topic_id`, `started_at`, `ended_at`, `status: "completed"|"draft"`; body `# Session: <id>`. `topic_id` requires explicit `--topic` or resolves active topic from `.palee/hot.md`.
- `parseFrontmatter` requires `---` at byte 0; a UTF-8 BOM or leading blank line silently yields `{frontmatter: null}` and skips the note everywhere. Don't "normalize" the blank line between frontmatter and body — it changes fingerprints.

## Verification loop — run before considering a change done

1. `npm run typecheck` (strict `tsc --noEmit` — this is the real quality gate)
2. `npm run lint` (flat ESLint, mostly hygiene; PR rule is **zero `any` casts in `src/`**)
3. `npm test` (node:test via `node --import tsx --test "test/**/*.test.ts"`); use `npm run test:coverage` (c8 thresholds: lines/statements ≥60%, functions ≥75%, branches ≥65%; CI also enforces changed-code ≥50% via diff-cover)
4. `npm run build` (tsc + copies package.json to dist)
5. `npm pack && node scripts/verify-tarball.js` — tarball must contain `dist/src/index.js`, `dist/src/index.d.ts`, `dist/bin/palee.js`, `package.json`, `dist/package.json`, `README.md`, `LICENSE`; must NOT contain `src/`, `test/`, `.github/`, `planning/`, `coverage/`.

Tests use real temp dirs (`fs.mkdtempSync`), CLI tests spawn `npx tsx bin/palee.ts` with `PALEE_CONFIG_DIR` pointing at a temp dir, and assert on exit codes + stdout/stderr regex. Platform guards exist for win32. CI runs Node 22/24/26 × ubuntu/windows/macos and blocks native modules. PR titles must be Conventional Commits.

## Known gaps (fix deliberately, or leave clearly marked)

- `--json` and non-TTY machine output: Implemented across all 6 reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, `session list`).
- `validate --fix` and `session end` are Phase-1 stubs ("not implemented"). `migrate` is read-only and fails closed on unrecognized schemas.
- `computeTopicMastery()` does not exist — mastery stays at the value `adopt` seeds (0.0); do not invent an unblessed mastery formula. Spec formula: `round((c + p + d + 2f) / 5, 4)`; zero active topics ⇒ `global_mastery: null`, never numeric 0.
- `config set-provider` is a single-string setter; `PaleeConfig` has no `apiKey`/`baseUrl` — blocks Phase-2 AI. Never print secrets from `config show`.
- Roadmaps: `--from` is YAML-only; roadmap import validates before mutating, never touches the network, and a user roadmap is never silently rewritten. Import is transactional per-topic with partial-failure exit 1.
- Phase-2 `test`/`tutor` commands exist in README but not in code.

## Constraints that must never be violated

- Non-AI commands open **no network sockets and no DNS lookups**. Non-TTY output stays machine-readable.
- AI layer (Phase 2): LLM gets only read-only tools; `record_assessment`/`record_review`/`save_session` are session-manager-only, never registered as model tools. No freeform JSON recovery (fenced JSON, regex, bracket repair, guessing) — structured output only, one bounded retry.
- Session continuity contract: `hot.md` (≤250 words) loads first, session written before derived views regenerated.
- No native modules, no SQLite addons; prod deps pure JS (`commander` + `yaml` only — don't add runtime deps casually).
- Preserve `bin/palee.ts` shebang and the `./dist/bin/palee.js` bin path. Keep rootDir `./` implications in mind (test/ compiles into dist; tarball forbids shipping it).

Reference docs for design intent: `planning/palee_cli_spec.md`, `planning/invariants.md` (authoritative acceptance criteria), `planning/storage_design.md`, `planning/memory_design.md`, `planning/PHASE_2_GAPS.md`, `planning/TRIGGER_TRACKER.md`.
