# Phase 1 — Non-AI Issues & Resolution Status

Discovered during code review on 2026-08-12 and resolved across Phase 1 PRs.

---

## 1. `--json` Flag Not Implemented
**Status:** ✅ **RESOLVED in PR #57 (2026-08-14)**

- Added `--json` option across `next`, `plan`, `progress`, `dashboard`, `validate`, and `session list`.
- Added automatic non-TTY stream detection (`isJsonOutput`) so piped/redirected outputs emit clean JSON.
- Standardized error serialization to JSON objects (`{"error": "..."}`) with exit code 2.

---

## 2. No Topic Resolution System
**Status:** ⏳ **SCHEDULED FOR PHASE 2 (Trigger 1 / T1-02)**

- Spec'd resolution precedence chain: exact ID → exact title/filename → legacy alias → normalized slug → token-distance.
- Currently uses substring matching. Will be implemented as a unified `resolveTopic()` engine helper.

---

## 3. `plan` / `dashboard` Show Ugly Empty State
**Status:** ✅ **RESOLVED in PR #54 (2026-08-14)**

- Implemented centralized `printEmptyVaultOnboarding()` helper in `src/cli/onboarding.ts`.
- Replaced empty dumps with actionable guidance (`palee adopt`, `palee roadmap --from`) across `plan`, `dashboard`, `progress`, and `next`.

---

## 4. `dashboard` Division by Zero Risk
**Status:** ✅ **RESOLVED in PR #53 (2026-08-14)**

- Added explicit `total > 0` ternary check in `src/cli/dashboard.ts` to prevent `NaN%` display on empty vaults.

---

## 5. `difficulty` Type Mismatch Between Spec and Code
**Status:** ✅ **RESOLVED in PR #56 (2026-08-14)**

- Defined `Difficulty = 'beginner' | 'intermediate' | 'advanced'` in `src/types.ts`.
- Added `normalizeDifficulty()` runtime helper supporting case/whitespace normalization and numeric coercion (1 -> beginner, 2..3 -> intermediate, 4..5 -> advanced).
- Standardized `adopt.ts`, `dashboard.ts`, `plan.ts`, `progress.ts`, and `roadmap.ts`.

---

## 6. `session` Defaults to Phantom Topic `T-general`
**Status:** ✅ **RESOLVED in PR #55 (2026-08-14)**

- Eliminated default phantom `T-general` topic creation.
- Implemented `resolveSessionTopic()` with active topic fallback from `.palee/hot.md` and sentinel `(none)` handling.
- Registered `--topic <id>` option on `palee session` in `bin/palee.ts`.

---

## 7. `adopt` Doesn't Set a `title` Field
**Status:** ⏳ **SCHEDULED FOR PHASE 2 (Trigger 2 / T2-03)**

- Will derive title from first `# heading` in Markdown body, clean filename fallback, or `--title` flag.

---

## 8. `validate --fix` Is a No-Op
**Status:** ⏳ **SCHEDULED FOR PHASE 2 (Validation Rule Framework)**

- Detailed in `VALIDATION_FRAMEWORK_VERDICT.md` across Rules 1–20 and Tier 6 Transactional Fix Engine.

---

## Summary Matrix

| # | Issue | Status | Resolution / PR |
|---|---|---|---|
| 1 | `--json` not implemented | ✅ RESOLVED | [PR #57](https://github.com/Kuldeep2822k/cli/pull/57) |
| 2 | No topic resolution system | ⏳ BACKLOG | Scheduled for Phase 2 |
| 3 | Empty state in `plan`/`dashboard` | ✅ RESOLVED | [PR #54](https://github.com/Kuldeep2822k/cli/pull/54) |
| 4 | Dashboard division by zero | ✅ RESOLVED | [PR #53](https://github.com/Kuldeep2822k/cli/pull/53) |
| 5 | `difficulty` type mismatch | ✅ RESOLVED | [PR #56](https://github.com/Kuldeep2822k/cli/pull/56) |
| 6 | `session` phantom `T-general` | ✅ RESOLVED | [PR #55](https://github.com/Kuldeep2822k/cli/pull/55) |
| 7 | `adopt` title derivation | ⏳ BACKLOG | Scheduled for Phase 2 |
| 8 | `validate --fix` no-op | ⏳ BACKLOG | Scheduled for Phase 2 (Rules 1–20) |
