# PALEE Execution & Trigger Tracker

This tracker converts analysis/review findings into a **deterministic execution queue**.  
**The Core Rule:** You never pick tasks by mood. You always pick from the highest active trigger level (Trigger 1 → 2 → 3 → 4 → 5).

---

## ⚡ Execution Rules

1. **Max 2 in "Active Work"**: Never have more than 2 tasks marked `[IN PROGRESS]` simultaneously.
2. **Top-Down Priority**: Always clear higher triggers before moving down:
   - **🚨 Trigger 1 (Invariants & Breaking)**: Spec violations, crash risks, broken core contracts.
   - **🔓 Trigger 2 (Multipliers & Blockers)**: Shared engines/utils that unblock or clean multiple commands.
   - **⚡ Trigger 3 (Quick Wins < 45m)**: Clear, self-contained fixes. Start here on Day 1 for momentum.
   - **🔨 Trigger 4 (Spec'd Feature Work)**: Fully designed features and phase milestones.
   - **🧪 Trigger 5 (Spikes / Unknowns)**: 45-minute timeboxed research items.

---

## 🎯 Active Slot (Max 2 items)

- [ ] `EMPTY` — *Pull the next item from Trigger 1 or Trigger 4 below*
- [ ] `EMPTY`

---

## 🚨 Trigger 1: Invariant Violations & Breaking Bugs (P0 — Do First)

*Condition: Violates an explicit invariant in `invariants.md`, causes unhandled crashes, or breaks core spec.*

| ID | Issue / Task | Source | Blocked By | Status |
|---|---|---|---|---|
| **T1-02** | **Topic Resolution Precedence Chain**<br>Invariant #42: Precedence must be exact ID → exact title/filename → legacy alias → normalized slug → token-distance.<br>*Currently substring match only in review/progress.* | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#2-no-topic-resolution-system) | None | `[READY]` |

---

## 🔓 Trigger 2: Multipliers & Foundational Utilities (P1 — Unblocks Others)

*Condition: Shared modules, type alignments, or engines that multiple commands rely on.*

| ID | Issue / Task | Source | Impact / Benefit | Status |
|---|---|---|---|---|
| **T2-01** | **Create shared `resolveTopic()` utility in `src/engine/`**<br>Centralize topic matching logic across all CLI commands (`review`, `progress`, `next`, `plan`, `dashboard`). | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#2-no-topic-resolution-system) | Unblocks T1-02 & unifies all CLI topic resolution | `[READY]` |
| **T2-03** | **Derive `title` field on `palee adopt`**<br>Derive title from first `# heading` in Markdown body, clean filename fallback, or `--title` flag. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#7-adopt-doesnt-set-a-title-field) | Ensures consistent note titles in vault | `[READY]` |

---

## 🔨 Trigger 4: Planned Phase 2 Features (Deep Execution)

*Condition: Multi-step feature implementations with written specs.*

| ID | Issue / Task | Source | Gate / Milestone | Status |
|---|---|---|---|---|
| **T4-01** | **Support `.md` Roadmap Files (`--from roadmap.md`)**<br>Allow frontmatter-driven markdown roadmaps in vault instead of `.yaml` only. | [`PHASE_2_GAPS.md`](./PHASE_2_GAPS.md#1-roadmap-support-md-instead-of-yaml-only) | Phase 2 | `[BACKLOG]` |
| **T4-02** | **Implement Validation Rule Framework (Issues #25–#45 / Rules 1–20)**<br>AST-preserving visitor validation engine with pure diagnostic rules across 6 tiers. | [`VALIDATION_FRAMEWORK_VERDICT.md`](./VALIDATION_FRAMEWORK_VERDICT.md) | Phase 2 | `[BACKLOG]` |
| **T4-03** | **Implement `validate --fix` Auto-Repair**<br>Auto-fix broken dependency links, duplicate IDs, and missing frontmatter fields. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#8-validate---fix-is-a-no-op) | Phase 2 | `[BACKLOG]` |

---

## 🧪 Trigger 5: Spikes & Research (Timeboxed 45 mins)

*Condition: Unknowns or open architecture decisions. Do NOT code feature until spike is done.*

- [ ] **SPIKE-01: Token-distance match algorithm for `resolveTopic()`**
  - *Goal:* Decide between Levenshtein distance vs Damerau-Levenshtein vs simple Jaro-Winkler for CLI typo tolerance without adding heavy dependencies.
  - *Timebox:* 30 mins
  - *Outcome:* Write small pure-JS token distance helper in `src/engine/match.ts`.

---

## ✅ Completed in Phase 1 (Merged & Verified)

- [x] **T1-01: Implement `--json` flag and non-TTY stream detection on CLI commands** (PR #57, 2026-08-14)
- [x] **T2-02: Standardize `Difficulty` enum & `normalizeDifficulty()` runtime helper** (PR #56, 2026-08-14)
- [x] **T3-01: Fix Division by Zero in `dashboard.ts`** (PR #53, 2026-08-14)
- [x] **T3-02: Empty State Guidance for Zero-Topic Vaults** (PR #54, 2026-08-14)
- [x] **T3-03: Eliminate `session` Phantom Topic `T-general` & add `--topic` option** (PR #55, 2026-08-14)
- [x] **T4-03 (Gate 1 Storage): Atomic Write, OCC Fingerprinting & Lock Heartbeat Engine** (2026-08-12)
