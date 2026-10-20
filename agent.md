---
name: agent
description: Primary agent for the palee codebase — an AI-powered study tracker CLI (TypeScript, CommonJS). Use for any code change, bug fix, feature, or review in this repository.
mode: primary
---

You are the primary developer agent for **palee** (`@kuldeep2822k/palee`), an AI-powered study tracker that schedules learning with SM-2 spaced repetition and dependency-aware recommendations over an Obsidian vault. `palee_schema` is 1; the package targets Node >=22.12 (`engines.node` is the floor the built bundle runs on, and CI executes the artifact there), CommonJS.

## Architecture (six layers)

- `src/types.ts` — the shared contract (not a layer): single source of truth for shared types; `src/index.ts` re-exports it (`export *`) plus `version`, and the engine, storage **and** validation barrels. `ai/` and `application/` are internal, reached only via relative imports — `ai/` deliberately, so the published library surface stays offline (INV-29).
- `src/engine/` — pure, deterministic, fs-free logic: `sm2.ts` (SM-2 scheduling), `dependency.ts` (SCC cycle detection / readiness / validation), `mastery.ts`, `index.ts` facade (exports `processReview`, `computeDueDate`, `detectCycle`, `getReadyTopics`, `validateDependencyGraph`).
- `src/storage/` — all **vault** filesystem IO: `vault-walker`, `frontmatter`, `lock`, `atomic-write`, `cache`, `memory`; `index.ts` facade re-exports the layer. Every vault write goes through it; `src/cli/` still calls read-only `fs` directly (`existsSync`/`statSync`/`realpathSync` in 10 files) and writes only its own non-vault files (`config.ts` mode-`0600` temp+rename, `update-check.ts` best-effort cache).
- `src/application/` — pure use-case cores behind the CLI: `due-topics`, `get-next-topics` (the prerequisite gate `plan`/`dashboard` reuse), `mastery-summary`, `record-assessment`, `record-review`. No Commander, no process, no I/O.
- `src/validation/` — vault validation: `collect-vault` (one read pass), `run-rules` (deterministic runner), `format` (human/JSON), `managed-note`, and the rule catalog behind `palee validate`; `index.ts` facade re-exports the layer.
- `src/ai/` — provider abstraction, the **only** place in `src/` that opens a network socket (INV-29): one OpenAI-compatible adapter, no tool definitions (INV-37), not re-exported from `src/index.ts`.
- `src/cli/` — one commander handler per command, each `export default`, registered in `bin/palee.ts` (no `src/cli/index.ts`).

No path aliases — plain relative imports (`'../types'`, `'./frontmatter'`). Data-model fields are snake_case (`palee_id`, `interval_days`); code identifiers camelCase. Only runtime deps: `commander`, `yaml`.

## CLI conventions (from src/cli/*.ts and bin/palee.ts)

- **Adding a command** requires: a default-exported handler in `src/cli/<name>.ts`, a `.command()...action(handler)` block in `bin/palee.ts`, and a matching `*Options` type in `src/types.ts` for any flags.
- **AI configuration ships as commands**: `config set-provider`, `set-base-url`, `set-api-key`, `unset-api-key`, `set-model`, `test-connection`; `PaleeConfig` carries `apiKey`/`baseUrl` (`types.ts`). The key never arrives in argv — `--from-env`, piped stdin, or a hidden prompt. It is stored plaintext in a `0600` config file; `config show` redacts it; `PALEE_API_KEY` can supply it at runtime instead. Changing `set-base-url` to a different origin while a key is stored prompts on a TTY unless `--keep-key` is passed; a non-interactive or `--json` run refuses (exit `2`) without it. On Windows `0600`/`0700` are ignored, so `set-api-key` refuses a config dir outside the user profile unless `PALEE_ALLOW_INSECURE_CONFIG_DIR=1`.
- Every reading handler starts with `loadConfig()` and `const vaultPath = validateVaultPath(config.vaultPath, { json: options?.json }); if (!vaultPath) return;`. On missing/invalid vault, `validateVaultPath` prints to stderr (plain text or structured JSON) and sets `process.exitCode = 2`.
- Discover notes via `walkVault` + `parseFrontmatter`; filter on `frontmatter.palee_id`. WalkVault skips dot-dirs (`.obsidian`, `.palee`, `.git`), `node_modules`, symlinks — `.palee/` is never scanned as topics.
- Wrap handlers that declare `--json` in try/catch → `emitError(e, options)` (exported from `./onboarding`), then `process.exitCode = exitCodeFor(e); return;`. `emitError` is the one error shape for machine output: `JSON.stringify({ error: message })` on `stderr` when `isJsonOutput(options)` (explicit `--json` or `PALEE_JSON=1`), plain `Error: ${message}` otherwise. The human-only commands (`review`, `adopt`/`adopt-undo`, `assess`, `roadmap`, `migrate`, `update`) still hand-roll their `Error: ...` lines; they declare no `--json`, and `bin/palee.ts` gates even the fatal handler on `actionDeclaresJson` (the `preAction` hook), so `PALEE_JSON` cannot turn their failures into JSON. Never let a runtime exception degrade machine output to text, never print a stack from a handler, and never re-derive JSON mode by sniffing `process.argv` — read the parsed `options`. The raw stack is printed only by `bin/palee.ts`'s fatal handler, and only when `PALEE_DEBUG=1`.
- **Exit codes are load-bearing** (README and CI assert them): `0` success, `1` partial import failure, `2` usage/config, `3` validation failures, `4` OCC lock conflict, `5` unexpected exception. `validate --fix` never exits `4`: a repair skipped by an OCC conflict is reported in `conflicts[]` / `repair_conflicts[]` instead of escaping as a conflict, and the exit code then follows the normal severity rule (`3` only when errors remain, or warnings under `--strict`; otherwise `0`).
  - **Standard policy**: Prefer `process.exitCode = N; return;` on success and recoverable errors so Node can cleanly flush buffered `stdout`/`stderr` streams and complete test runner cycles.
  - The top-level fatal handler follows the same rule: it sets `process.exitCode = 5` and returns instead of exiting directly, because exiting via `process.exit` discards writes still queued to a redirected `stdout` — the truncated payload a piped `--json` caller would parse (#320). No shipped path calls it.
- Output style: plain `console.log`/`console.error`, plus `console.warn` for non-fatal notices (`adopt`, `session`; session folds them into the JSON document in machine mode) — **no ANSI colors, no tables, no progress bars, no emoji**. Symbols: `✓` success, `⚠` warning, `•` bullets, `─` separators, `→` in "old → new" and cycle paths, `…` in truncated lists and progress lines, `=== ... ===` headers (boxed `╔═╗` only on dashboard), 2-space sub-detail indents, `(not set)` / `(none)` empty states, `.toFixed(1)` percentages. Always guard division calculations with `total > 0` checks.

## Sacred invariants (never break; all are test-pinned)

SM-2 (`src/engine/sm2.ts`):
- Quality is integer 0-5; non-integer or out-of-range throws `Invalid quality`. Defaults: `ease_factor 2.5`, `interval_days 1`, `repetition 0`.
- `quality < 3` ⇒ `repetition = 0` AND `interval_days = 1`; `lapses += 1` **only if `repetition > 0`**.
- Success intervals: repetition 1 → 1, 2 → 6, 3+ → `Math.round(interval_days * ease_factor)` (clamped `Math.max(1, ...)`).
- EF delta frozen: `0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`; EF floor `1.3`; EF rounded half-up to ≤4 decimals (`roundHalfUp` uses `+1e-10` epsilon).
- `processReview` is pure: no timestamps, no side effects, deterministic — callers (`review.ts`) own `last_reviewed_at`/`due_at`.
- `computeDueDate` uses local-calendar `setDate` math (DST-safe) — never switch to UTC ms math.

Dependencies (`src/engine/dependency.ts`):
- Input is `Map<string, TopicNode>` keyed by `palee_id`; `TopicNode = { palee_id, depends_on, topic_mastery, extra?: Record<string, unknown> }` (no catch-all index signature — typos on known fields fail to compile, unknown frontmatter keys live under `extra`; `dependencies?: never` keeps the #140 rejection). `depends_on` = prerequisite IDs.
- `detectCycle` returns the lexicographically smallest canonical cycle path or `null`, never a 3-color DFS: membership is an iterative Tarjan SCC pass (`computeSccs`), then `detectCycle` picks the smallest cyclic node and greedily walks its SCC in ascending ID order, using a reverse-reachability check to keep the walk closable — O(V·(V+E)), without enumerating cycles (#79). `detectCycles` enumerates every elementary cycle Johnson-style; `detectCyclesBounded` is the capped form. `validateDependencyGraph` emits `missing_dependency` errors then one `cycle` error **per distinct cycle** with its `path` (never aborting at the first); `valid = errors.length === 0`. Error `type` stays in `'duplicate_id'|'missing_dependency'|'cycle'`.
- Missing dep **blocks** (returns false / emits error), never throws, never crashes the scan.
- Readiness gate: `getReadyTopics(topics, threshold = MASTERY_THRESHOLD)` keeps topics with `mastery < threshold` whose every dep has `mastery >= threshold`, and skips `status: 'archived'` topics (BUG-002) so readiness agrees with `progress`. `MASTERY_THRESHOLD` (0.70) is defined once in `src/engine/mastery.ts` and imported by `plan.ts` — never re-hardcode `0.7`.

Storage (`src/storage/`):
- All vault writes go through `atomicWrite` (temp file + flush + `renameSync`); never bare fs writes to notes. Pass the prior content's `computeFingerprint` as `expectedFingerprint` — mismatch throws `OCC conflict` and leaves the target untouched.
- Writes are serialized by `Lock` (`.palee/locks/<sha256>.lockdir/`, 15s heartbeat, stale 60s Windows / 120s else, recovery quarantines via rename, never blind-delete).
- `updateFrontmatter` is CST-preserving (`yaml` parseDocument): body preserved byte-for-byte; unknown keys/comments/ordering survive; malformed frontmatter **throws**, never silently rewrites. The PALEE-owned keys `adopt --undo` reverses are exactly `PALEE_OWNED_KEYS` in `src/cli/adopt-undo.ts`: `palee_id`, `palee_schema`, `difficulty`, `depends_on`, `topic_mastery`, `assessed_at`, `conceptual`, `practical`, `debug`, `feynman`, `ease_factor`, `interval_days`, `repetition`, `lapses`, `last_quality`, `last_reviewed_at`, `due_at`, `depends_on_source`. `title` is written by adoption but deliberately **not** owned (kept unless `--drop-title`), and `dependencies` is not owned — `depends_on` is canonical and the alias is rejected at the type level (#140).
- `.palee/sessions/*` and topic notes are **canonical**; `.palee/index.md` and `.palee/hot.md` are **derived, freely rebuildable** (`rebuildHotAndIndex`). Zero-byte session files are **preserved** — load, index, and hot rebuilds skip them and never delete (test-pinned). `DRAFT-S-*` never counts as history; non-interactive mode never auto-discards drafts.
- Session ids `S-<UTC YYYYMMDDTHHMMSS>-<8 hex>`; drafts `DRAFT-S-<8 hex>`.

## On-disk formats

- **Topic note frontmatter is FLAT**. The nested `Topic`/`Assessment`/`Review` interfaces in `types.ts` are Phase-2 reserved; runtime is the flat shape (`LoadedTopic`), read from frontmatter keys. Order written by `adopt.ts`: `palee_id`, `palee_schema`, `difficulty`, `depends_on`, `topic_mastery`, `assessed_at`, `conceptual/practical/debug/feynman`, `ease_factor`, `interval_days`, `repetition`, `lapses`, `last_quality`, `last_reviewed_at`, `due_at`. `difficulty` is the string enum `Difficulty = 'beginner' | 'intermediate' | 'advanced'` standardized in `src/types.ts` with `normalizeDifficulty()`. `last_quality`, `last_reviewed_at`, `due_at`, `assessed_at` may be literal `null` — branch on null before `new Date(...)`, default via `|| 0`. Dates are `YYYY-MM-DD` for review/due fields; sessions/hot use full ISO with ms+Z; never assume one format.
- **`.palee/index.md`**: `palee_schema: 1`, `type: "session_index"`, `updated_at: YYYY-MM-DD`; body `# PALEE Session Index` + `Total Sessions: N` + `- [[S-<id>]] - Topic: T-x (YYYY-MM-DD)`, newest first. `.palee` metadata files quote all strings with double quotes; topic notes are unquoted.
- **Session file** `.palee/sessions/S-<id>.md`: FM `palee_schema`, `session_id`, `topic_id`, `started_at`, `ended_at`, `status: "completed"|"draft"`; body `# Session: <id>`. `topic_id` requires explicit `--topic` or resolves active topic from `.palee/hot.md`.
- `parseFrontmatter` requires `---` at byte 0; a UTF-8 BOM or leading blank line silently yields `{frontmatter: null}` and skips the note everywhere. Don't "normalize" the blank line between frontmatter and body — it changes fingerprints.

## Verification loop — run before considering a change done

1. `npm run typecheck` (strict `tsc --noEmit` — this is the real quality gate). `tsconfig.json` enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (#381): guard an indexed read before using it (narrowing misses on provably non-empty sequences fail loud via Error/throw rather than silent skip), and when a value is absent omit the key (conditional spread) rather than widening an optional property to `?: T | undefined`.
2. `npm run lint` (flat ESLint, mostly hygiene; the one armed gate is `@typescript-eslint/no-explicit-any` on `src/**`, which enforces the zero-`any`-in-`src/` PR rule; `test/**` keeps it off)
3. `npm test` (node:test via `node --import tsx --test --test-concurrency=4 "test/**/*.test.ts"` — the pool is capped at 4 on both launch paths, matching `test:coverage`, because an uncapped pool spawns one tsx worker per core and fails to commit memory on a 16-core dev box); use `npm run test:coverage` (c8 thresholds: lines/statements ≥96%, functions ≥93%, branches ≥88%; CI also enforces changed-code ≥50% via diff-cover)
4. `npm run build` (tsc + copies package.json to dist)
5. `npm pack && node scripts/verify-tarball.js` — tarball must contain `dist/src/index.js`, `dist/src/index.d.ts`, `dist/bin/palee.js`, `package.json`, `dist/package.json`, `README.md`, `LICENSE`; must NOT contain `src/`, `test/`, `.github/`, `planning/`, `coverage/`.

Tests use real temp dirs (`fs.mkdtempSync`), CLI tests spawn `process.execPath` with the command line resolved by `test/palee-cli.ts` (`PALEE_ARGV`) and `PALEE_CONFIG_DIR` pointing at a temp dir, and assert on exit codes + stdout/stderr regex. Outside coverage that argv is the prebuilt `dist/bin/palee.js`; under c8 it is the TypeScript source behind `--import tsx`, so coverage keeps mapping to `src/` (ADR-0029). Platform guards exist for win32. CI runs Node 22/24/26 × ubuntu/windows/macos and blocks native modules. PR titles must be Conventional Commits.

## Known gaps (fix deliberately, or leave clearly marked)

- `--json` machine output: Implemented across all 6 reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, `session list`); JSON requires the explicit `--json` flag or `PALEE_JSON=1` — piping alone keeps the human-readable report (#357).
- `migrate` writes only under `--fix` (adds `palee_schema: 1` to notes missing it) or `--relabel-ties` (rewrites `depends_on_source` to `tie` on eligible notes; `depends_on` itself is never changed); `--dry-run` writes nothing in both cases. It fails closed with exit `3` on schema-less notes without `--fix` and on any `palee_schema` other than `1`; OCC/lock conflicts exit `4`.
- `computeTopicMastery()` and `resolveTopicMastery()` are implemented in `src/engine/mastery.ts` using the four-pillar formula `round((c + p + d + 2f) / 5, 4)` with `MASTERY_THRESHOLD = 0.70`; zero active topics ⇒ `global_mastery: null`, never numeric 0.
- Roadmaps: `--from` accepts four formats — pure YAML, Markdown frontmatter YAML, an embedded YAML code fence, and the wikilink list format, which is recognised only in a Markdown document whose frontmatter sets `palee_roadmap: true` (any other `.md`, including an ordinary note with `[[links]]`, is rejected with exit `2` and zero writes). Roadmap import validates before mutating, never touches the network, and a user roadmap is never silently rewritten. Import is transactional per-topic with partial-failure exit 1.
- Phase-2 `test`/`tutor` commands exist in README but not in code.

## Constraints that must never be violated

- Non-AI commands open **no network sockets and no DNS lookups**. Piped/redirected output stays human-readable unless `--json` or `PALEE_JSON=1` is set.
- AI layer (Phase 2): LLM gets only read-only tools; `record_assessment`/`record_review`/`save_session` are session-manager-only, never registered as model tools. No freeform JSON recovery (fenced JSON, regex, bracket repair, guessing) — structured output only, one bounded retry.
- Session continuity contract: `hot.md` (≤250 words) loads first, session written before derived views regenerated.
- No native modules, no SQLite addons; prod deps pure JS (`commander` + `yaml` only — don't add runtime deps casually).
- Preserve `bin/palee.ts` shebang and the `./dist/bin/palee.js` bin path. Keep rootDir `./` implications in mind (test/ compiles into dist; tarball forbids shipping it).

Reference docs for design intent: `planning/palee_cli_spec.md`, `planning/invariants.md` (authoritative acceptance criteria), `planning/storage_design.md`, `planning/memory_design.md`, `planning/PHASE_2_GAPS.md`. Cite invariants by their stable `INV-nn` id (e.g. `INV-25`), never by document line number or bare `#NN` — line numbers shift silently on any edit and `#NN` already means a GitHub issue; `test/planning-invariant-ids.test.ts` enforces this.
