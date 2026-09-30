# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`palee validate --fix` now repairs invalid SM-2 fields**: `--fix` previously reported "not implemented"; it now repairs invalid SM-2 review fields and reports each repair in the output. ([#210](https://github.com/Kuldeep2822k/cli/pull/210))

### Fixed

- **Draft recovery exits 2 when input runs out**: the interactive recovery menu previously exited 0 silently when stdin ended mid-prompt, leaving the checkpoint unresolved; it now terminates with exit code 2. ([#202](https://github.com/Kuldeep2822k/cli/pull/202))
- **Commander usage errors follow the ExitCode contract**: unknown commands/options and missing arguments previously bypassed the exit-code mapping (Commander defaulted to 1); help, `--version`, and bare invocation now exit 0, all other usage errors exit 2. ([#197](https://github.com/Kuldeep2822k/cli/pull/197))
- **Roadmap import no longer mints zero-valued pillar scores**: absent assessment pillars resolved to `0.0` and were written onto notes, causing false mastery-drift warnings under `validate --strict`. ([#196](https://github.com/Kuldeep2822k/cli/pull/196))
- **Hot-memory rebuild keeps sessions with unparseable timestamps**: unparseable `started_at` values previously wiped the derived hot memory to "No learning history recorded yet." while the session files stayed intact. ([#211](https://github.com/Kuldeep2822k/cli/pull/211))
- **Stale draft timestamps clamped to 24h**: draft recovery and session-end draft selection now clamp `started_at` older than 24 hours, matching the draft-write freshness check. ([#208](https://github.com/Kuldeep2822k/cli/pull/208))
- **Roadmap import no longer reads through a symlinked note path**: existence is tested with `lstat`, the target must resolve inside the vault, and the read is bound to the descriptor of the validated file — so a link planted after the check cannot bring outside content into a note. ([#217](https://github.com/Kuldeep2822k/cli/issues/217), [#218](https://github.com/Kuldeep2822k/cli/pull/218))

### Changed

- **Documentation site refresh**: resolved audit drift, navigation gaps, and Mermaid diagram clipping/layout issues; the navbar now displays the current package version. ([#189](https://github.com/Kuldeep2822k/cli/pull/189))
- **Dependency updates**: `duriantaco/skylos` 4.36.1 → 4.38.0, `yaml` 2.9.0 → 2.9.1. ([#203](https://github.com/Kuldeep2822k/cli/pull/203), [#174](https://github.com/Kuldeep2822k/cli/pull/174))

---

## [0.5.2] - 2026-09-19

### Fixed

- **Frontmatter parser robustness**: detects body text swallowed into frontmatter by unclosed fences; supports quoted keys with colons and unquoted keys with spaces, slashes, or non-ASCII characters; preserves `raw`/`body` for whitespace-only fenced blocks. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation rule runner is exception-safe**: rule crashes now surface as structured findings instead of exit-5 crashes. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation barrel export order aligned** with rule registration order. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **`valid-dependency-list` covers the legacy `dependencies` alias** with an advisory warning to migrate to `depends_on`. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#181](https://github.com/Kuldeep2822k/cli/issues/181), [#187](https://github.com/Kuldeep2822k/cli/pull/187))

### Changed

- **Documented the legacy `dependencies` alias advisory** in rule metadata, docs, and Mermaid diagrams. ([#187](https://github.com/Kuldeep2822k/cli/pull/187))

---

## [0.5.1] - 2026-09-18

### Fixed

- **`no-dependency-cycle` reports every cycle**, not just the first (bounded at 1000, with a truncation finding). ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#184](https://github.com/Kuldeep2822k/cli/pull/184))
- **Derived-view rebuilds never delete canonical sessions**; draft sessions are excluded from the hot-memory rebuild. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#185](https://github.com/Kuldeep2822k/cli/pull/185))
- **Numeric `assessed_at` values normalize to ISO 8601** through the adopt/loader round-trip. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#186](https://github.com/Kuldeep2822k/cli/pull/186))
- **Leading BOM stripped** so frontmatter parses for files saved by Windows editors. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#183](https://github.com/Kuldeep2822k/cli/pull/183))

### Changed

- **ADR-0008 review clarifications**; v0.5.0 entries moved out of `[Unreleased]`. ([#182](https://github.com/Kuldeep2822k/cli/pull/182))
- **Dependency updates**: `duriantaco/skylos` 4.35.0 → 4.36.1. ([#175](https://github.com/Kuldeep2822k/cli/pull/175))

---

## [0.5.0] - 2026-09-15

### Added

- **Validation rule framework**: single-read vault collector, deterministic runner, human/JSON formatters; duplicate-ID, missing-dependency, and cycle checks ported as pure rules. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#26](https://github.com/Kuldeep2822k/cli/issues/26), [#30](https://github.com/Kuldeep2822k/cli/issues/30), [#158](https://github.com/Kuldeep2822k/cli/pull/158))
- **Validation rules for schema, topic IDs, and status**: `palee_schema: 1` enforcement, `T-` kebab-case topic ID policy, four-state `status` validation; `adopt` generates compliant IDs. ([#28](https://github.com/Kuldeep2822k/cli/issues/28), [#29](https://github.com/Kuldeep2822k/cli/issues/29), [#31](https://github.com/Kuldeep2822k/cli/issues/31), [#159](https://github.com/Kuldeep2822k/cli/pull/159))
- **`validate --strict` warning escalation** and a `src/validation/` public barrel with census test. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#162](https://github.com/Kuldeep2822k/cli/pull/162))
- **Assessment and mastery validation rules** (`valid-assessment-fields`, `valid-topic-mastery`); #40 enforced as command-level regression tests. ([#36](https://github.com/Kuldeep2822k/cli/issues/36), [#37](https://github.com/Kuldeep2822k/cli/issues/37), [#40](https://github.com/Kuldeep2822k/cli/issues/40), [#163](https://github.com/Kuldeep2822k/cli/pull/163))
- **Review-state, review-dates, and dependency-list validation rules**; `no-missing-dependency` downgraded to warning per ADR-0008. ([#33](https://github.com/Kuldeep2822k/cli/issues/33), [#34](https://github.com/Kuldeep2822k/cli/issues/34), [#38](https://github.com/Kuldeep2822k/cli/issues/38), [#39](https://github.com/Kuldeep2822k/cli/issues/39), [#165](https://github.com/Kuldeep2822k/cli/pull/165))
- **Memory-subsystem validation rules** (`valid-managed-note-kind`, `valid-session-schema`, `no-session-unknown-topic`, `valid-session-index`). ([#27](https://github.com/Kuldeep2822k/cli/issues/27), [#41](https://github.com/Kuldeep2822k/cli/issues/41), [#42](https://github.com/Kuldeep2822k/cli/issues/42), [#44](https://github.com/Kuldeep2822k/cli/issues/44), [#168](https://github.com/Kuldeep2822k/cli/pull/168))
- **Hot-memory and safe-vault-paths validation rules**; shared `displayValue` helper fixes `NaN`/`Infinity` rendering in diagnostics. ([#43](https://github.com/Kuldeep2822k/cli/issues/43), [#45](https://github.com/Kuldeep2822k/cli/issues/45), [#166](https://github.com/Kuldeep2822k/cli/issues/166), [#169](https://github.com/Kuldeep2822k/cli/pull/169))
- **Multi-cycle enumeration and quarantine** in the dependency engine (bounded display with `truncated` flag). ([#79](https://github.com/Kuldeep2822k/cli/issues/79), [#157](https://github.com/Kuldeep2822k/cli/pull/157))

### Changed

- **Parallel test execution**: full suite ~112s → ~38s; added `test:unit`, `test:fast`, `test:e2e`, `test:fuzz` scripts. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Windows lock-directory stale recovery** with bounded 5-attempt backoff instead of exit-5 crashes. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Internal refactors**: single shared derivation for roadmap imports, centralized `hot.md` reads and exit-code mapping, injectable `loadTopics` cache. ([#139](https://github.com/Kuldeep2822k/cli/issues/139), [#130](https://github.com/Kuldeep2822k/cli/issues/130), [#129](https://github.com/Kuldeep2822k/cli/issues/129), [#128](https://github.com/Kuldeep2822k/cli/issues/128), [#154](https://github.com/Kuldeep2822k/cli/pull/154), [#145](https://github.com/Kuldeep2822k/cli/pull/145), [#151](https://github.com/Kuldeep2822k/cli/pull/151), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **ADR-0008: validation-framework decisions** recorded; dangling planning-doc references fixed. ([#170](https://github.com/Kuldeep2822k/cli/issues/170), [#172](https://github.com/Kuldeep2822k/cli/pull/172))
- **Dependency and workflow updates**: workflow security hardening, GitHub Actions bumps, dead-code detection via Skylos. ([#143](https://github.com/Kuldeep2822k/cli/pull/143), [#148](https://github.com/Kuldeep2822k/cli/pull/148), [#141](https://github.com/Kuldeep2822k/cli/pull/141))

### Fixed

- **Vault-relative paths through symlinked roots** via `realpathSync`. ([#160](https://github.com/Kuldeep2822k/cli/issues/160), [#161](https://github.com/Kuldeep2822k/cli/pull/161))
- **Exit code 4 on OCC conflict** in `palee migrate --fix`. ([#128](https://github.com/Kuldeep2822k/cli/issues/128), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **Explicit `0` preserved in SM-2 fields** (`ease_factor`, `interval_days`, `repetition`, `lapses`). ([#127](https://github.com/Kuldeep2822k/cli/issues/127))
- **`depends_on`/`dependencies` aliases normalized consistently** across loader, validator, and roadmap. ([#126](https://github.com/Kuldeep2822k/cli/issues/126))
- **Unsupported `palee_schema` in hot.md triggers rebuild** (ADR-0007). ([#130](https://github.com/Kuldeep2822k/cli/issues/130))
- **npm audit fixes applied**; published package files optimized via `.npmignore`. ([#156](https://github.com/Kuldeep2822k/cli/pull/156), [#173](https://github.com/Kuldeep2822k/cli/pull/173))

### Removed

- **Lock internals pruned from the storage barrel** (`HEARTBEAT_INTERVAL`, `STALE_TIMEOUT`; still in `src/storage/lock.ts`). ([#131](https://github.com/Kuldeep2822k/cli/issues/131))

---

## [0.4.0] - 2026-08-31

### Added

- **Storage layer isolation**: all vault filesystem mutations behind the `src/storage/index.ts` facade. ([#86](https://github.com/Kuldeep2822k/cli/issues/86), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **True session durations** persisted to `.palee/hot.md` and draft checkpoints. ([#88](https://github.com/Kuldeep2822k/cli/issues/88), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Resilient roadmap batch ingestion**: per-topic failures no longer block remaining imports. ([#89](https://github.com/Kuldeep2822k/cli/issues/89), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Interactive Mermaid pan-zoom controls** in the docs site. ([#115](https://github.com/Kuldeep2822k/cli/pull/115), [#116](https://github.com/Kuldeep2822k/cli/pull/116))
- **`palee migrate --fix`**: atomically upgrades schema-less notes to `palee_schema: 1`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Custom vault traversal exclusions** (`excludeDirs`). ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Session draft checkpoint invariants**: exit code 2 and `drafts_pending` JSON when drafts block `session start`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Flexible dependency aliases**: `dependencies` supported alongside `depends_on`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Fixed

- **Review OCC race eliminated**: target note re-read before atomic write; exit 4 on concurrent modification. ([#87](https://github.com/Kuldeep2822k/cli/issues/87), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Mastery output and dashboard alignment** standardized. ([#91](https://github.com/Kuldeep2822k/cli/issues/91), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Deterministic file-cache operation** (2,000 ms unsettled horizon). ([#90](https://github.com/Kuldeep2822k/cli/issues/90), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **macOS canonical path resolution** for symlinked `/var/folders` paths. ([#122](https://github.com/Kuldeep2822k/cli/pull/122))
- **Config resilience**: `SyntaxError` recovery in `loadConfig()` with atomic saves. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Timezone-safe due-date computation** with 2-digit year guard. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Atomic write concurrency** via cryptographic entropy in temp filenames. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Duplicate topic IDs**: dependencies merged for complete graph connectivity. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Structured JSON errors** on unhandled rejections with `--json`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **CST frontmatter formatting**: unified `Document` serialization for clean YAML block lists. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Changed

- **npm OIDC trusted publishing** with build provenance attestations. ([#124](https://github.com/Kuldeep2822k/cli/pull/124))

---

## [0.3.1] - 2026-08-23

### Fixed

- **README logo URL** fixed for npm registry rendering.

### Changed

- **GitHub Actions dependencies bumped**. ([#99](https://github.com/Kuldeep2822k/cli/pull/99), [#100](https://github.com/Kuldeep2822k/cli/pull/100), [#101](https://github.com/Kuldeep2822k/cli/pull/101), [#102](https://github.com/Kuldeep2822k/cli/pull/102))

---

## [0.3.0] - 2026-08-20

### Added

- **Batch note adoption (`palee adopt`)** with `--dry-run`, `--yes`, `--tag`, `--include`, `--exclude` filters. ([#50](https://github.com/Kuldeep2822k/cli/pull/50), [#74](https://github.com/Kuldeep2822k/cli/pull/74))
- **Multi-format roadmap parser** (pure YAML, frontmatter YAML, embedded code-fence YAML). ([#112](https://github.com/Kuldeep2822k/cli/pull/112))
- **Technical documentation suite**: 35-chapter VitePress docs with interactive architecture diagrams. ([#108](https://github.com/Kuldeep2822k/cli/pull/108), [#112](https://github.com/Kuldeep2822k/cli/pull/112), [#114](https://github.com/Kuldeep2822k/cli/pull/114))
- **Distinct exit code 4** on OCC and file-lock conflicts. ([#76](https://github.com/Kuldeep2822k/cli/pull/76), [#107](https://github.com/Kuldeep2822k/cli/pull/107))

### Changed

- **Exit-code standardization**: `process.exitCode` replaces `process.exit()` for clean stream flushing. ([#77](https://github.com/Kuldeep2822k/cli/issues/77), [#110](https://github.com/Kuldeep2822k/cli/pull/110))
- **Centralized vault validation** through `validateVaultPath`. ([#78](https://github.com/Kuldeep2822k/cli/issues/78), [#111](https://github.com/Kuldeep2822k/cli/pull/111))
- **Unified storage layer boundary** with in-memory caching and single-pass discovery. ([#98](https://github.com/Kuldeep2822k/cli/pull/98))
- **Shared mastery engine** with extracted `MASTERY_THRESHOLD`. ([#85](https://github.com/Kuldeep2822k/cli/issues/85), [#94](https://github.com/Kuldeep2822k/cli/pull/94), [#95](https://github.com/Kuldeep2822k/cli/pull/95), [#106](https://github.com/Kuldeep2822k/cli/pull/106))

### Fixed

- **Archived topics excluded** from global mastery calculation. ([#97](https://github.com/Kuldeep2822k/cli/pull/97))
- **Invalid-date guard** in progress date parsing. ([#96](https://github.com/Kuldeep2822k/cli/pull/96))

---

## [0.2.0] - 2026-08-14

### Added

- **Machine-readable `--json` output** across reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, `session list`); non-TTY output defaults to JSON.
- **Structured JSON setup errors** with exit code 2 in JSON/non-TTY mode.
- **Standardized `Difficulty` enum** (`beginner` | `intermediate` | `advanced`) with `normalizeDifficulty()` runtime helper.
- **Empty-vault onboarding guidance** pointing at `palee adopt` and `palee roadmap --from`.
- **`--topic <id>` option** for `palee session` with active-topic fallback.

### Fixed

- **Dashboard division-by-zero guard** against `NaN%` on empty vaults.
- **Vault validation and permissions**: clean returns on empty states plus directory/read-permission checks at the vault root.
- **Phantom topic elimination**: no more default `T-general` topic notes during session operations.

---

## [0.1.0] - 2026-08-12

### Added

- Project setup with `commander`, `yaml`, and Node.js testing.
- Conflict-aware atomic storage layer with file fingerprinting, OCC, and robust file locking.
- Deterministic engine core (SM-2, mastery calculation, dependency graph resolution, cycle detection).
- CLI layer with deterministic commands (`plan`, `next`, `progress`, `review`, `validate`, `roadmap --from`, `adopt`).
- Phase 1 session memory system (`hot.md`, `index.md`, durable session logs, draft recovery).
- Full Windows path and lock-recovery support.
- Interactive draft checkpoint recovery.

### Fixed

- Strict TypeScript enforcement with dead code removed.
- Narrative comments purged to conform to strict code standards.
