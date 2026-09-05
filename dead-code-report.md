# PALEE Code Cleanup Audit

Repo root: `cli/` · Version: 0.4.0 · Date of audit: 2026-09-03

This report separates three things that "look unused" but should be treated differently:
1. **Dead** — can be removed now.
2. **Reserved for Phase 2** — looks dead at runtime but is intentionally kept (do not delete).
3. **Planned but not yet implemented** — documented in planning docs; not in code at all.

---

## 1. Confirmed dead (safe to remove)

| Item | Location | Evidence |
|------|----------|----------|
| `matchPathGlob` | `src/storage/pattern-matcher.ts` | `export function`, called only internally by `matchesPattern`. Not re-exported, not in any test. Safe to make private. |
| `roundHalfUp` | `src/engine/sm2.ts` | `export function`, called only internally by `processReview`. Not re-exported through engine barrel, not in any test. Safe to make private. |
---

## 2. Reserved for Phase 2 (intentionally kept — do NOT delete)

These are marked "Reserved for Phase-2 ... do not delete" in `src/types.ts` and are pinned by `test/types-difficulty.test.ts`:

- `Assessment`, `Review`, `Topic`, `Progress`
- `Session`, `BaseSession`, `CompletedSession`, `DraftSession`

They are the documented Phase-2 AI-module contract (see `docs/08-2-future-ai-module-and-phase-2-design.md`). Runtime code uses flat frontmatter + `TopicNode`/`LoadedTopic` instead, so these look "unused" to a linter — that's by design.

Additional Phase-2 reserved surfaces:
- `AssessmentPillars`, `CacheEntry`, `FrontmatterResult`, `HotMemoryData`, `LockData`, `RoadmapFile`, `RoadmapTopic`, `ValidationError`, `ValidationResult` — all used by storage/engine/CLI internally. Not dead.

---

## 3. Public API with no internal consumer (confirm intent first)

| Item | Location | Notes |
|------|----------|-------|
| `getTopicCache` | `src/storage/loader.ts` → `storage/index.ts` → `src/index.ts` | No CLI or test calls it. Likely a deliberate library accessor for external consumers/tests. Removing changes the published API surface. |

---

## 4. Barrel inconsistency (tidy-up, not dead)

`src/engine/index.ts` re-exports only 2 of `sm2.ts`'s 5 exports:

- Exported: `processReview`, `computeDueDate`
- Missing: `calculateEaseFactorDelta`, `formatLocalDateOnly`, `roundHalfUp`

Consequence: `src/cli/review.ts`, `test/engine-sm2.test.ts`, `test/timezone-matrix.test.ts`, `test/property-fuzz.test.ts` deep-import `'../engine/sm2'` directly instead of using the `'../engine'` barrel.

Recommendation:
- `roundHalfUp` → make private (it's dead, see §1).
- `calculateEaseFactorDelta`, `formatLocalDateOnly` → add to the barrel for consistency.

---

## 5. Dead doc comments (stale JSDoc, not code)

| File | JSDoc claims these options | Actually defined in bin/palee.ts |
|------|---------------------------|----------------------------------|
| `src/cli/next.ts` line 25 | `--tag`, `--difficulty` | only `--all`, `--json` |
| `src/cli/plan.ts` line 30 | `--ready`, `--all`, `--limit`, `--tag`, `--difficulty` | only `--json` |
| `src/cli/progress.ts` line 30 | `--tag`, `--difficulty` | only `--topic`, `--json` |

---

## 6. Planned / future-work references (found in planning docs, not yet in code)

From `planning/PHASE_2_GAPS.md` and related design docs:

| Future feature | Status | Note |
|----------------|--------|------|
| `palee test <topic>` | Not implemented | Phase-2 AI Feynman testing. Stub from README has no `test.ts`. |
| `palee tutor <topic>` | Not implemented | Phase-2 AI tutoring. |
| Guided roadmap (`palee roadmap` w/o `--from`) | Not implemented | AI interview mode; currently errors with "Phase 1 only supports --from". |
| `config set-provider` interactive prompt (base_url/api_key/model) | Broken / partial | Implementation only takes single `aiProvider` string; no `apiKey`/`baseUrl` fields. |
| `api_key` redaction in `config show` | Vacuous | Passes only because `apiKey` field doesn't exist. |
| `palee adopt --dir` | GAP | Batch adopt via `--all` exists; `--dir` variant not implemented. |
| `--fix` for `validate` | Stub | `validate.ts` prints "not implemented in Phase 1". |

See `planning/PHASE_2_GAPS.md` for the full list and priority ordering.

---

## 7. Stale version reference (drift, not dead code)

- `docs/.vitepress/config.mts` line 50 hardcodes `'v0.3.1'` in the nav.
- `package.json` version is `0.4.0`.

---

## Summary of recommendations

**Remove now (low risk, verifiable):**
1. `export` keyword on `matchPathGlob`
2. `export` keyword on `roundHalfUp` (make private)

**Keep — reclassified after deeper verification:**
3. `markdown-it-mathjax3` — REQUIRED. VitePress lists it as an optional peer dependency and does NOT bundle it; the docs use 82+ math expressions with `markdown.math: true`. Removing it breaks math rendering.
4. `scripts/sync-svg.js` — real utility (base64-embeds `palee-logo.png` into the two `palee-logo.svg` copies for pixel parity). Orphaned from automation, but not dead. Recommended: wire it as a `package.json` script rather than delete.

**Fix consistency:**
5. Add `calculateEaseFactorDelta` + `formatLocalDateOnly` to `src/engine/index.ts`; keep `roundHalfUp` private
6. Correct stale JSDoc option lists in `next.ts`, `plan.ts`, `progress.ts`
7. Bump hardcoded `v0.3.1` → `0.4.0` in VitePress config

**Confirm before touching:**
8. `getTopicCache` (public API surface)

**Do NOT delete (reserved):**
9. Phase-2 `Assessment`/`Review`/`Topic`/`Session` type families