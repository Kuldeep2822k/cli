# ADR-0008: Validation Rule Framework — Architecture and Product Decisions

## Status

Accepted (2026-09-13). Decisions 1–4 were originally resolved in the Phase-1 planning document `planning/VALIDATION_FRAMEWORK_VERDICT.md` (2026-08-14) and delivered across PRs #158, #159, #162, #163, #165, #168, and #169 under umbrella issue #25; that planning document was removed as obsolete once delivery completed, and this ADR is the permanent record of what was decided. Decision 5 (backlog-to-catalog reconciliation) was added 2026-09-15.

## Context

`palee validate` began as three hardcoded checks (duplicate topic IDs, missing dependencies, dependency cycles) inside the CLI handler, with a narrow `ValidationError` union, no warning/error distinction, no machine-readable output, and a parser that could abort the whole scan on one malformed note. Issue #25 proposed an ESLint/Ruff-style rule framework plus a 20-item backlog (issues #26–#45) and left four product decisions explicitly open:

1. Should missing dependencies be `warning` or `error`?
2. Should difficulty remain string-based or move to numeric `1..5` (older design docs showed both)?
3. Should warning-only validation exit `0`, or should any issue exit `3`? (Matters for CI.)
4. Should derived-view problems (`hot.md`, `index.md`) ever fail validation, or always warn because they are rebuildable?

## Decision

### Framework architecture

- **Pure visitor rules.** Every rule is a small, named, testable function implementing `ValidationRule` (`id`, `description`, `severity`, `fixable?`, `run(context)`) over a fully collected `ValidationContext`. Rules never read config, touch the filesystem, prompt, or call the network — collection and exit-code policy live in the CLI/collector layers.
- **Single-read topic snapshot.** `collectVault` reads each file exactly once; the same captured bytes feed the per-file parse outcomes and topic normalization, so a concurrent edit cannot make different topic rules observe different versions of the same note. The memory subsystem (sessions, index, hot memory) is read in the same collection pass, but as its own reads — consistency there is handled by read ordering (the index is read before the sessions directory, closing the concurrent-`session end` interleaving window), not by byte sharing. Read failures anywhere in the snapshot are retained and reported (`read-failure`) and mark the scan provisional (`readIncomplete`) — a partial snapshot can never silently validate clean.
- **Raw-frontmatter reads.** Rules read pre-normalization values, because the loader coerces and clamps during normalization — validation is where hand-authored corruption becomes visible instead of being silently blessed.
- **Deterministic output.** Rules run in registration order; findings sort deterministically; scans visit files in sorted order — output is stable across platforms.
- **One bad topic note = one finding.** Malformed YAML frontmatter on a walked note is a warning per file (`parse-frontmatter`) and never aborts the scan (the `planning/invariants.md` resilience rule). Session notes carry a stricter contract by design: a malformed session note is an `error` from `valid-session-schema` (the rebuild paths key on its shape), and a parseable session with several defects can produce several findings.
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

### Decision 4: Derived-view findings never become errors (issues #43, #44)

Findings on rebuildable projections — `.palee/hot.md` (`valid-hot-memory`) and `.palee/index.md` (`valid-session-index`) — are ALWAYS `warning`, never `error`. They never gate the exit code by default: a vault whose only findings are derived-view warnings exits `0`. `--strict` escalates ALL warnings — these included — to exit `3`, per decision 3's opt-in contract; the guarantee is the severity classification (never an error, never a hard validation failure), not immunity from `--strict`.

**Why:** Topic notes and canonical session records are the sole sources of truth (`planning/storage_design.md`, ADR-0007's read-state contract); the derived views are ephemeral projections that `session end`/`rebuildHotAndIndex` regenerate. Crashing validation on self-healing projections would violate storage resilience. A missing index/hot memory is additionally a legal fresh-vault state and never reports. Delivered in #168/#169.

### Decision 5: Backlog-to-catalog reconciliation — two items have no registered rule (issues #32, #40)

The 20-item #25 backlog (#26–#45) reconciles to **nineteen registered rules** through three distinct dispositions:

- **#32 `valid-difficulty` — dissolved; no rule and no external enforcement path.** Decision 2 replaced the `number`-typed `Topic.difficulty` with the 3-tier string enum at the type level (PR #56), fixing the specific mismatch the item targeted. This closed the issue; it did **not** add a runtime guard for persisted frontmatter, and no separate path enforces it. Consequence: a hand-authored or corrupted `difficulty` value on disk is still coerced by the loader (numeric values normalized, others defaulted to `intermediate`) and receives no validation finding — a known, documented gap rather than a guarantee. Reopening `valid-difficulty` is the natural follow-up if raw stored difficulty needs surfacing. The type-level fix governs the in-memory `Topic` shape, not raw persisted bytes.
- **#40 `assessment-review-independence` — enforced by command-level mutation tests, not a static vault rule.** This is the **only** backlog item enforced outside the rule set. Independence is a property of what commands write, not of what the vault looks like: no static snapshot of a note can distinguish "assessment state survived a review mutation" from "assessment state was never touched." The contract is pinned in both directions by `test/e2e/assessment-review-independence.test.ts` — `palee review` updates only SM-2 fields and preserves assessment data (including non-zero `topic_mastery`) byte-for-byte, and the `palee roadmap` import path preserves all seven SM-2 fields on reviewed topics. A rule cannot express this; the regression test is the enforcement mechanism.
- **#26 `parse-frontmatter` — one item, two rules.** The item's scope covers both malformed-YAML reporting (`parse-frontmatter`) and unreadable-file reporting (`read-failure`), both exported from `src/validation/rules/parse-frontmatter.ts`.

No rule is silently missing: every other backlog item (#27–#31, #33–#39, #41–#45) maps one-to-one to a registered rule, and the count is pinned by `test/validation-barrel-census.test.ts`.

**Why:** Registering a rule for #40 would duplicate an enforcement path that already exists at a lower layer, so the regression test is the correct mechanism. #32 is deliberately absent because it was closed by the type-level fix, but the two dispositions are different — one enforced elsewhere, one dropped with a documented residual gap — and the ADR records both so the catalog stays honest and the gap is visible rather than implied away.

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
