# ADR-0008: Validation Rule Framework — Architecture and Product Decisions

## Status

Accepted (2026-09-13). Decisions 1–4 were originally resolved in the Phase-1 planning document `planning/VALIDATION_FRAMEWORK_VERDICT.md` (2026-08-14) and delivered across PRs #158, #159, #162, #163, #165, #168, and #169 under umbrella issue #25; that planning document was removed as obsolete once delivery completed, and this ADR is the permanent record of what was decided.

## Context

`palee validate` began as three hardcoded checks (duplicate topic IDs, missing dependencies, dependency cycles) inside the CLI handler, with a narrow `ValidationError` union, no warning/error distinction, no machine-readable output, and a parser that could abort the whole scan on one malformed note. Issue #25 proposed an ESLint/Ruff-style rule framework plus a 20-rule backlog (issues #26–#45) and left four product decisions explicitly open:

1. Should missing dependencies be `warning` or `error`?
2. Should difficulty remain string-based or move to numeric `1..5` (older design docs showed both)?
3. Should warning-only validation exit `0`, or should any issue exit `3`? (Matters for CI.)
4. Should derived-view problems (`hot.md`, `index.md`) ever fail validation, or always warn because they are rebuildable?

## Decision

### Framework architecture

- **Pure visitor rules.** Every rule is a small, named, testable function implementing `ValidationRule` (`id`, `description`, `severity`, `fixable?`, `run(context)`) over a fully collected `ValidationContext`. Rules never read config, touch the filesystem, prompt, or call the network — collection and exit-code policy live in the CLI/collector layers.
- **Single-read snapshot.** `collectVault` reads each file exactly once; the same bytes feed parse outcomes, topic normalization, and the memory-subsystem snapshot (sessions, index, hot memory), so a concurrent edit cannot make different rules observe different vault versions. Read failures anywhere in the snapshot are retained and reported (`read-failure`) and mark the scan provisional (`readIncomplete`) — a partial snapshot can never silently validate clean.
- **Raw-frontmatter reads.** Rules read pre-normalization values, because the loader coerces and clamps during normalization — validation is where hand-authored corruption becomes visible instead of being silently blessed.
- **Deterministic output.** Rules run in registration order; findings sort deterministically; scans visit files in sorted order — output is stable across platforms.
- **One bad note = one finding.** Malformed frontmatter is a warning per file and never aborts the scan (the `planning/invariants.md` resilience rule).
- **Fixability modeled, `--fix` deferred.** Every rule declares `fixable: false | 'safe' | 'manual'`; the fix engine itself is intentionally deferred until read-only validation is stable (the ESLint serial non-overlapping fixer is the reference design).

### Decision 1: Missing dependencies are `warning` in vault scans (issue #34)

`no-missing-dependency` findings are `warning` by default; `roadmap --from` pre-validation keeps its own separate hard-error path; `--strict` escalates.

**Why:** `planning/invariants.md` states missing dependencies produce a warning; the engine treats missing prerequisites as `0.0` mastery and quarantines the dependent topic from `plan`/`next` without corrupting data. Failing an incrementally-written vault with exit 3 because a note is mid-flight punishes the users validation exists to protect. Delivered in #158 (ported), severity flipped in #165.

### Decision 2: Difficulty is the 3-tier string enum (issue #32)

Canonical storage is `'beginner' | 'intermediate' | 'advanced'`; `src/types.ts` standardizes on the `Difficulty` union with `normalizeDifficulty()` coercing legacy numeric input (`1` → `beginner`, `2–3` → `intermediate`, `4–5` → `advanced`).

**Why:** Every CLI handler and test suite already operated on strings; abstract integers are less intuitive in Obsidian Markdown frontmatter, and the `number`-typed `Topic.difficulty` field contradicted the running code. The dedicated `valid-difficulty` rule (#32) became unnecessary once the type-level mismatch it was meant to expose was fixed structurally (PR #56).

### Decision 3: Warnings exit 0; `--strict` escalates to 3 (issue #25)

A warnings-only vault exits `0` by default and `3` with `palee validate --strict`, in both human and JSON modes.

**Why:** Matches the ESLint/TypeScript/Ruff convention — non-fatal advisories (stale derived views, duplicate array entries, missing prerequisites) do not block local workflows, while CI pipelines requiring zero warnings opt in explicitly. Delivered in #162.

### Decision 4: Derived-view findings never gate (issues #43, #44)

Findings on rebuildable projections — `.palee/hot.md` (`valid-hot-memory`) and `.palee/index.md` (`valid-session-index`) — are ALWAYS `warning`, never `error`.

**Why:** Topic notes and canonical session records are the sole sources of truth (`planning/storage_design.md`, ADR-0007's read-state contract); the derived views are ephemeral projections that `session end`/`rebuildHotAndIndex` regenerate. Crashing validation on self-healing projections would violate storage resilience. A missing index/hot memory is additionally a legal fresh-vault state and never reports. Delivered in #168/#169.

## Consequences

### Positive

- Nineteen registered rules with focused unit tests (~190 rule-level tests), deterministic output, and a stable exit-code contract (`0`/`2`/`3`/`4`/`5`).
- The severity policy is consistent and legible: errors = canonical-data corruption that downstream paths silently mis-read; warnings = self-healing projections, provisional snapshots, and data-quality gaps a human decides about.
- JSON output is additive on the legacy shape, so existing scripts keep working while `--json` consumers get `rule_id`/`severity`/`warnings[]`.
- New rules are cheap: implement the contract, register in `src/cli/validate.ts`, export through the barrel, add tests — the census test keeps the catalog honest.

### Negative / Tradeoffs

- Rules must duplicate shape checks the loader also performs (raw reads) — accepted cost for exposing pre-normalization corruption.
- `--fix` remains a stub; the `fixable` metadata is forward-modeling only.
- Warning-vs-error boundaries occasionally need jurisdiction rules to avoid double-reporting (e.g. #42 skips sessions #41 already reported) — handled per-rule with shared helpers.

## Alternatives Considered

- **Missing deps as `error`:** rejected — breaks active vaults mid-write; the engine already quarantines.
- **Numeric difficulty:** rejected — contradicted every handler and test; strings are the documented Obsidian-facing format.
- **Warnings exit 3 always:** rejected — hostile to local interactive use; `--strict` covers CI.
- **Derived views as `error`:** rejected — they are rebuildable; failing validation on them contradicts ADR-0007's read-state contract and the self-healing invariants.
- **Impure rules (own fs access):** rejected — non-deterministic under concurrent writes, untestable in isolation; the single-read snapshot is the ESLint-inspired alternative.
