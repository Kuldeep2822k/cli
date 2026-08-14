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

> *Move items here when starting work. Move to "Done" when merged and verified.*

- [ ] `EMPTY` — *Pull the next item from Trigger 1 or Trigger 3 below*
- [ ] `EMPTY`

---

## 🚨 Trigger 1: Invariant Violations & Breaking Bugs (P0 — Do First)

*Condition: Violates an explicit invariant in `invariants.md`, causes unhandled crashes, or breaks core spec.*

| ID | Issue / Task | Source | Blocked By | Status |
|---|---|---|---|---|
| **T1-01** | **Implement `--json` flag on CLI commands**<br>Invariant #45: `--json` and non-TTY contain no ANSI control sequences.<br>*Target commands: `next`, `plan`, `progress`, `dashboard`, `validate`, `session list`* | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#1---json-flag-not-implemented) | None | `[READY]` |
| **T1-02** | **Topic Resolution Precedence Chain**<br>Invariant #42: Precedence must be exact ID → exact title/filename → legacy alias → normalized slug → token-distance.<br>*Currently substring match only in review/progress.* | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#2-no-topic-resolution-system) | None | `[READY]` |

---

## 🔓 Trigger 2: Multipliers & Foundational Utilities (P1 — Unblocks Others)

*Condition: Shared modules, type alignments, or engines that multiple commands rely on.*

| ID | Issue / Task | Source | Impact / Benefit | Status |
|---|---|---|---|---|
| **T2-01** | **Create shared `resolveTopic()` utility in `src/engine/`**<br>Centralize topic matching logic across all CLI commands (`review`, `progress`, `next`, `plan`, `dashboard`). | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#2-no-topic-resolution-system) | Unblocks T1-02 & unifies all CLI topic resolution | `[READY]` |
| **T2-02** | **Standardize `difficulty` type across spec and code**<br>Align `src/types.ts` (`difficulty: 'beginner' \| 'intermediate' \| 'advanced'`) with CLI commands. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#5-difficulty-type-mismatch-between-spec-and-code) | Prevents type mismatch bugs in Phase 2 | `[READY]` |
| **T2-03** | **Derive `title` field on `palee adopt`**<br>Derive title from first `# heading` in Markdown body, clean filename fallback, or `--title` flag. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#7-adopt-doesnt-set-a-title-field) | Ensures consistent note titles in vault | `[READY]` |

---

## ⚡ Trigger 3: Quick Wins (< 45 Mins — Momentum Builders)

*Condition: Zero ambiguity, completely spec'd, fast to complete and verify. Great for Day 1 morning.*

| ID | Issue / Task | Source | Est. Time | Status |
|---|---|---|---|---|
| **T3-01** | **Fix Division by Zero in `dashboard.ts`**<br>Add explicit `total > 0` check when computing mastered percentage (`src/cli/dashboard.ts:72`). | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#4-dashboard-division-by-zero-risk) | 10 mins | `[READY]` |
| **T3-02** | **Empty State Handling for Zero-Topic Vaults**<br>Replace blank output with onboarding guide (`palee adopt`, `palee roadmap`) in `plan`, `dashboard`, `progress`, `next`. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#3-plan--dashboard-show-ugly-empty-state) | 25 mins | `[READY]` |
| **T3-03** | **Fix `session end` Phantom Topic `T-general`**<br>Require `--topic`, prompt for active topic, or read last active topic from `hot.md`. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#6-session-end-defaults-to-phantom-topic-t-general) | 25 mins | `[READY]` |

---

## 🔨 Trigger 4: Planned Phase 2 Features (Deep Execution)

*Condition: Multi-step feature implementations with written specs.*

| ID | Issue / Task | Source | Gate / Milestone | Status |
|---|---|---|---|---|
| **T4-01** | **Support `.md` Roadmap Files (`--from roadmap.md`)**<br>Allow frontmatter-driven markdown roadmaps in vault instead of `.yaml` only. | [`PHASE_2_GAPS.md`](./PHASE_2_GAPS.md#1-roadmap-support-md-instead-of-yaml-only) | Phase 2 | `[BACKLOG]` |
| **T4-02** | **Implement `validate --fix` Auto-Repair**<br>Auto-fix broken dependency links, duplicate IDs, and missing frontmatter fields. | [`PHASE_1_ISSUES.md`](./PHASE_1_ISSUES.md#8-validate---fix-is-a-no-op) | Phase 2 | `[BACKLOG]` |
| **T4-03** | **Storage Layer OCC Conflict & Heartbeat Gate**<br>Complete lock heartbeat (15s) and stale lock recovery (60s Windows). | [`PHASE_1_CHECKLIST.md`](./PHASE_1_CHECKLIST.md#-gate-1-storage-layer-file-io-locking-atomic-writes) | Gate 1 | `[BACKLOG]` |

---

## 🧪 Trigger 5: Spikes & Research (Timeboxed 45 mins)

*Condition: Unknowns or open architecture decisions. Do NOT code feature until spike is done.*

- [ ] **SPIKE-01: Token-distance match algorithm for `resolveTopic()`**
  - *Goal:* Decide between Levenshtein distance vs Damerau-Levenshtein vs simple Jaro-Winkler for CLI typo tolerance without adding heavy dependencies.
  - *Timebox:* 30 mins
  - *Outcome:* Write small pure-JS token distance helper in `src/engine/match.ts`.

---

## ✅ Completed This Cycle

- [ ] *(Completed items move here with date)*

---

## 🔄 Weekly Review-to-Execution Ritual (End of Analysis Week)

When your 1-week review/analysis is ending:
1. **Gather new findings** into `PHASE_X_ISSUES.md`.
2. **Sort each item into this tracker**:
   - Is it breaking / violating an invariant? ➔ **Trigger 1**
   - Does it unblock other tasks? ➔ **Trigger 2**
   - Is it a clean fix under 45 mins? ➔ **Trigger 3**
   - Is it a larger feature? ➔ **Trigger 4**
   - Are there unknowns? ➔ **Trigger 5**
3. **Execution Day 1 Morning**:
   - Pick **one Quick Win (Trigger 3)** first. Ship it in 30 mins to break hesitation.
   - Then tackle **Trigger 1** and **Trigger 2**.
