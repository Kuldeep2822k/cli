# PALEE Issue Board Action Plan

**Created:** 2026-09-09
**Scope:** All 30 open issues on the Phase-1 board, sequenced into waves so overlapping work discounts instead of doubling.
**Source of truth for rule design decisions:** `planning/VALIDATION_FRAMEWORK_VERDICT.md` (4 open product decisions already resolved there — do not relitigate).

## Board snapshot (2026-09-09)

- 30 open issues, 0 open PRs (#152–#156 all merged; #121/#129/#139/#140 closed).
- 4 AI-labeled issues stay parked for Phase 2: #24 (provider abstraction), #52 (dynamic difficulty), #70 (recommendation scoring), #82 (config base_url/api_key plumbing — natural last gate before AI work).
- 26 non-AI issues: 19 validation rules (#25 umbrella + #26–#45 minus closed #32), plus #65/#66/#67/#68/#73/#79.

## Adopted product decisions (from VALIDATION_FRAMEWORK_VERDICT.md)

1. **Missing dependencies:** `warning` in vault scans, `error` in roadmap pre-validation — lands with #34, NOT with the framework port (Wave 1 preserves today's `error` behavior and its pinned tests).
2. **Difficulty:** string enum `beginner | intermediate | advanced` is canonical (numeric docs are stale).
3. **Exit codes:** warnings-only validation exits `0`; errors exit `3`. `--strict` (warnings → exit 3) is deferred until severities are revisited in #34.
4. **Derived views (`hot.md`, `index.md`):** always `warning`, never `error` — they are rebuildable projections.

## Overlap map — where issues touch each other

| Overlap | Issues | Nature | Handling |
| :--- | :--- | :--- | :--- |
| Same check, two homes | #30/#34/#35 vs `src/engine/dependency.ts` | Engine already detects duplicate IDs, missing deps, cycles | Rules are thin ports over engine functions — single source of truth |
| Dependency turf war | #79 vs #34/#35/#73 | #79 rewrites the DFS (quarantine, deterministic ordering) | Hard order: #79 first, then ports, then #73 |
| Schema parent + children | #28 vs #36–#39 | Children reuse #28's walking machinery | #28 early; children copy its pattern |
| Session cluster | #41/#42/#44 | Same files (`.palee/sessions/*`), same loader | One PR, not three |
| Type split tax | #66 vs ~20 rule PRs | Every rule touches `types.ts` | #66 dead last — one consolidation pass |
| CLI layer reshuffle | #65 vs #67 | Each rewrites the other's ground | Done together, at the end |

**The two hard ordering rules:** never touch #34/#35 before #79 lands; never interleave #65/#66 with the rule backlog.

## Wave plan — 26 non-AI issues → ~11 PRs

| Wave | PR | Issues | Content | State |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 1 | #25 + #26 + #30 | Validation framework (`src/validation/`), `parse-frontmatter`, `no-duplicate-topic-id`, port missing-dep + cycle as rules | **In progress** |
| 2 | 2 | #79 | Dependency engine rework: 3-color DFS quarantine + deterministic ready ordering | Blocked by Wave 1 |
| 3 | 3 | #33 + #34 + #35 | `valid-dependency-list`, `no-missing-dependency` (severity flip per decision 1), `no-dependency-cycle` — ported onto final engine shape | Blocked by #79 |
| 4 | 4 | #28 + #29 + #31 | `valid-palee-schema`, `valid-topic-id-format`, `valid-topic-status` | After Wave 1 |
| | 5 | #36 + #37 + #40 | `valid-assessment-fields`, `valid-topic-mastery`, assessment/review independence tests | After Wave 1 |
| 5 | 6 | #38 + #39 | `valid-review-fields`, `valid-review-dates` — SM-2 adjacent, pin tests carefully | After Wave 1 |
| 6 | 7 | #41 + #42 + #44 | Session schema, orphan sessions, session index — one PR, shared session loader | After Wave 1 |
| | 8 | #43 + #45 | `valid-hot-memory` (word limit, `MAX_HOT_WORDS`), `safe-vault-paths` | After Wave 1 |
| 7 | 9 | #73 | Hierarchical auto-chaining + wikilink graph resolution, on top of #79's engine | After Waves 2–3 |
| 8 | 10 | #65 + #66 | Extract app logic from CLI handlers + split domain types — **last consolidation pass** | After all rule PRs |
| 9 | 11 | #82 | `config set-provider` base_url/api_key plumbing | Last before Phase 2 |

#67 and #68 are "evaluate whether…" issues: close each with a decision note (+ small PR only if the answer is yes), not a build.

## Definition of done — every PR

1. `npm run typecheck` + `npm run lint` clean, zero `any` in `src/`
2. Full `npm test` green (545+ tests), coverage gates met (lines ≥60%, functions ≥75%, branches ≥65%, diff ≥50%)
3. `npm run build` + `npm pack && node scripts/verify-tarball.js` clean
4. Conventional Commits title, branch `type/issue#-slug`, CHANGELOG entry linking issue + PR
5. Bot reviews (Skylos, Greptile, Kilo, labeler) addressed; **user merges**

## Wave 1 acceptance criteria (this PR)

- `src/validation/` framework: `ValidationContext` / `ValidationRule` / `ValidationIssue` types, `collect-vault`, `run-rules` (deterministic order), human + JSON formatters, rule metadata models fixability while `--fix` stays a stub.
- Rules: `parse-frontmatter` (warning, new capability), `no-duplicate-topic-id`, `no-missing-dependency`, `no-dependency-cycle` (behavior-preserving ports).
- Malformed frontmatter in any note becomes a warning and never aborts the scan (invariant `invariants.md:17`).
- Documented JSON contract (`valid`, `topic_count`, `file_count`, `error_count`, `errors[]` with legacy `type` keys) preserved; `warnings[]`/`warning_count` added additively.
- Warnings-only validation exits `0`; errors exit `3` (pinned tests stay green).
- Rules are pure: no fs, config, network, prompts, or console output inside `src/validation/rules/`.
- New fs needs live in `src/storage/` (no raw `fs` outside storage).
