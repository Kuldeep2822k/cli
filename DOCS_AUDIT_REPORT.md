# PALEE CLI — Complete Documentation Audit & Architectural Review

**Audit Date**: September 19, 2026  
**Target Codebase Version**: `v0.5.2`  
**Repository**: `Kuldeep2822k/cli`  
**Review Status**: **APPROVED BY MAINTAINER [✓]** (Awaiting explicit instruction to proceed with execution)

---

## 1. Executive Summary

This document provides a comprehensive forensic audit and architectural analysis of all documentation across the PALEE CLI repository. The audit evaluates both **hosted documentation** (the 39 VitePress markdown chapters under `docs/` published to [https://kuldeep2822k.github.io/cli/](https://kuldeep2822k.github.io/cli/)) and **non-hosted documentation** (root markdown files, `planning/` specifications, and agent guidance files).

### Key Metrics & Findings

| Category | Total Scanned | Issues Identified | High-Severity Items | Audit Review Status |
| :--- | :---: | :---: | :--- | :---: |
| **Hosted Docs (`docs/`)** | 39 files | 14 files with drift/issues | 2 orphaned ADRs, phantom commands (`verify`, `doctor`, `assess`) | **APPROVED [✓]** |
| **Non-Hosted Docs (Root & `planning/`)** | 15 files | 7 files with drift/stale | 4 candidates for deletion; drift in `README.md` & `agent.md` | **APPROVED [✓]** |
| **Mermaid Architecture Diagrams** | 53 diagrams | 25 diagrams with layout/text issues | 1 extreme 419-char node (`Rules`), multiple >40-char clipped labels | **APPROVED [✓]** |
| **Emoji Occurrences** | 54 instances | 20 lines in `docs/`, 34 in root/planning | 6 diagrams containing emojis (`⛔`, `🚨`, `✓`, `⚠`); table headers with `✅` | **APPROVED [✓]** |
| **Internal Code / File Links** | 350+ links | 10 broken/drifted references | `src/storage/walker.ts` (should be `vault-walker.ts`), `.eslint.config.mjs` | **APPROVED [✓]** |

---

## 2. Complete Inventory of All Documentation

### 2.1 Hosted VitePress Documentation (`docs/`)

The VitePress documentation site consists of 39 Markdown files organized into 9 numbered sections, an ADR directory, and root landing pages:

| Path | Title / Section | VitePress Nav Status | Status / Health |
| :--- | :--- | :---: | :--- |
| `docs/index.md` | PALEE CLI Landing Page | Root `/` | Healthy (version now dynamically synced to v0.5.2) |
| `docs/01-0-overview.md` | 1. Overview | Sidebar: Overview | Healthy |
| `docs/01-1-getting-started.md` | 1.1 Getting Started | Sidebar: Overview | Minor drift (exit code list incomplete; `set-provider` syntax) |
| `docs/01-2-architecture-overview.md` | 1.2 Architecture Overview | Sidebar: Overview | Healthy |
| `docs/02-0-cli-commands.md` | 2. CLI Commands | Sidebar: CLI Commands | Healthy (Diagram 7 has long labels) |
| `docs/02-1-topic-management-commands.md` | 2.1 Topic Management Commands | Sidebar: CLI Commands | Diagram 9 has emojis (`✓`, `⚠`) & long nodes |
| `docs/02-2-review-and-scheduling-commands.md` | 2.2 Review and Scheduling Commands | Sidebar: CLI Commands | Diagram 10 has emoji (`✓`) |
| `docs/02-3-reporting-commands.md` | 2.3 Reporting Commands | Sidebar: CLI Commands | **Severe**: Diagram 12 has 419-character un-wrapped `Rules` node; emoji (`✓`) |
| `docs/02-4-session-management-command.md` | 2.4 Session Management Command | Sidebar: CLI Commands | Diagram 13 has emoji (`⛔ Exit`) & long node |
| `docs/03-0-engine-core.md` | 3. Engine Core | Sidebar: Engine Core | Diagram 14 includes phantom command `palee assess`; long nodes |
| `docs/03-1-sm2-spaced-repetition-algorithm.md` | 3.1 SM-2 Spaced Repetition Algorithm | Sidebar: Engine Core | HTML entities (`&Delta;`, `&times;`, `&isin;`) in diagram nodes |
| `docs/03-2-dependency-graph-engine.md` | 3.2 Dependency Graph Engine | Sidebar: Engine Core | Diagram 19 has emoji (`🚨 Cycle Detected`); unquoted `O(1)` |
| `docs/04-0-storage-layer.md` | 4. Storage Layer | Sidebar: Storage Layer | Diagram 21 lists only 6 of 13 storage modules |
| `docs/04-1-frontmatter-parser-and-atomic-writes.md` | 4.1 Frontmatter Parser and Atomic Writes | Sidebar: Storage Layer | Sequence diagram unquoted bracket syntax |
| `docs/04-2-file-locking.md` | 4.2 File Locking | Sidebar: Storage Layer | Healthy |
| `docs/04-3-vault-walker-and-file-cache.md` | 4.3 Vault Walker and File Cache | Sidebar: Storage Layer | Healthy |
| `docs/04-4-session-memory-storage.md` | 4.4 Session Memory Storage | Sidebar: Storage Layer | Healthy |
| `docs/05-0-data-model-and-types.md` | 5. Data Model and Types | Sidebar: Data Model | Healthy |
| `docs/05-1-topic-and-assessment-schema.md` | 5.1 Topic and Assessment Schema | Sidebar: Data Model | URL-encoded `%20` links to `examples/` |
| `docs/05-2-configuration-and-cli-option-types.md` | 5.2 Configuration and CLI Option Types | Sidebar: Data Model | Long nodes in diagram 34 & 35 |
| `docs/06-0-testing.md` | 6. Testing | Sidebar: Testing | Broken link to `src/storage/walker.ts`; outdated count (230 tests vs 477); 84-char node |
| `docs/06-1-unit-tests.md` | 6.1 Unit Tests | Sidebar: Testing | Broken link to `src/storage/walker.ts` |
| `docs/06-2-integration-and-smoke-tests.md` | 6.2 Integration and Smoke Tests | Sidebar: Testing | **Severe**: Phantom commands `palee verify` & `palee doctor`; 11 table emojis (`✅`) |
| `docs/07-0-cicd-and-release-pipeline.md` | 7. CI/CD and Release Pipeline | Sidebar: CI/CD | Healthy |
| `docs/07-1-continuous-integration.md` | 7.1 Continuous Integration | Sidebar: CI/CD | Broken link to `.eslint.config.mjs` (actual: `eslint.config.mjs`) |
| `docs/07-2-release-workflow-and-npm-publishing.md` | 7.2 Release Workflow and NPM Publishing | Sidebar: CI/CD | Healthy |
| `docs/08-0-planning-and-design-documents.md` | 8. Planning and Design Documents | Sidebar: Planning | Healthy |
| `docs/08-1-phase-1-specification-and-invariants.md` | 8.1 Phase 1 Specification and Invariants | Sidebar: Planning | Healthy |
| `docs/08-2-future-ai-module-and-phase-2-design.md` | 8.2 Future: AI Module and Phase 2 Design | Sidebar: Planning | Healthy |
| `docs/09-glossary.md` | 9. Glossary | Sidebar: Glossary | Class diagram note text width |
| `docs/adr/README.md` | ADR Index | Sidebar: ADRs | Lists ADR-0001 through ADR-0008 |
| `docs/adr/0001-supermemo-sm2-algorithm.md` | ADR-0001: SM-2 | Sidebar: ADRs | Healthy |
| `docs/adr/0002-atomic-file-locking-and-occ.md` | ADR-0002: Atomic Locking & OCC | Sidebar: ADRs | Healthy |
| `docs/adr/0003-concrete-syntax-tree-yaml-frontmatter.md` | ADR-0003: CST YAML | Sidebar: ADRs | Healthy |
| `docs/adr/0004-four-pillar-pedagogical-mastery.md` | ADR-0004: Four-Pillar Model | Sidebar: ADRs | Healthy |
| `docs/adr/0005-concurrency-storage-and-schema-migration.md` | ADR-0005: Concurrency Storage | Sidebar: ADRs | Healthy |
| `docs/adr/0006-phase-1-concurrency-resilience-and-storage-isolation.md` | ADR-0006: Resilience & Isolation | Sidebar: ADRs | Healthy |
| `docs/adr/0007-hot-memory-read-state-contract.md` | ADR-0007: Hot Memory Contract | **MISSING from Sidebar** | **Orphaned**: Present in directory and `adr/README.md`, omitted from `config.mts` |
| `docs/adr/0008-validation-framework-decisions.md` | ADR-0008: Validation Decisions | **MISSING from Sidebar** | **Orphaned**: Present in directory and `adr/README.md`, omitted from `config.mts` |

---

### 2.2 Non-Hosted Documentation (Root & Planning)

| File | Purpose | Size | Freshness / Status |
| :--- | :--- | :---: | :--- |
| `README.md` | Public repository entry point | 8,710 B | Drift: advertises `palee test`/`tutor` (unimplemented); incorrect `set-provider` syntax; omits Exit Code 1 |
| `CHANGELOG.md` | Release history (Keep a Changelog) | 23,513 B | Up to date (v0.5.2 added) |
| `PROJECT.md` | Phase 1 milestone tracking | 8,324 B | **Stale**: Tracking M1-M5, all marked "DONE". Stored in `.gitignore`/`.npmignore`. Candidate for deletion. |
| `TEST_INFRA.md` | Phase 1 test harness notes | 2,027 B | **Stale**: 32-line scratch notes superseded by `docs/06-*`. Stored in `.gitignore`/`.npmignore`. Candidate for deletion. |
| `PRE_AI_ISSUE_EXECUTION_PLAN.md` | Phase 1 pre-AI execution plan (Aug 17) | 11,456 B | **Stale**: Historical issue backlog (#70-#91) all resolved. Stored in `.gitignore`/`.npmignore`. Candidate for deletion. |
| `agent.md` | Primary developer agent context | 11,054 B | Drift: Line 73 states `computeTopicMastery()` does not exist (implemented in `src/engine/mastery.ts`) |
| `planning/palee_cli_spec.md` | Authoritative CLI functional spec | 20,555 B | Active reference (cited by `docs/08-*` and `agent.md`) |
| `planning/invariants.md` | Authoritative acceptance criteria | 4,511 B | Active reference (cited by `docs/08-*` and `agent.md`) |
| `planning/storage_design.md` | Storage layer design spec | 6,955 B | Active reference (cited by `docs/08-*` and `agent.md`) |
| `planning/memory_design.md` | Working memory design spec | 5,726 B | Active reference (cited by `docs/08-*` and `agent.md`) |
| `planning/roadmap_design.md` | Roadmap import & DAG spec | 4,233 B | Active reference (cited by `docs/08-*` and `agent.md`) |
| `planning/ai_module_design.md` | Phase 2 AI architecture spec | 13,560 B | Active reference for future Phase 2 |
| `planning/example_workflows.md` | Workflow examples | 7,383 B | Active reference |
| `planning/cicd_dependency_management_proposal.md` | Early CI/CD proposal (Aug 10) | 26,371 B | **Stale / Superseded**: 526-line proposal superseded by `.github/workflows/` and `docs/07-*`. Candidate for deletion or archiving. |
| `planning/PHASE_2_GAPS.md` | Design review gap analysis (Aug 11) | 9,629 B | **Partially Stale**: Items 1 (roadmap .md), 2 (batch adopt), 8 (mastery formula) are already implemented. |

---

## 3. Stale & Obsolete Files (Candidates for Deletion)

The following 4 files in the repository are completely stale, redundant, or superseded by the formal documentation suite under `docs/`. They are already excluded from npm packaging via `.npmignore` and git-ignored in `.gitignore`, but remain in the working tree as dead artifacts:

### 1. `PRE_AI_ISSUE_EXECUTION_PLAN.md` (Repo Root, 11,456 bytes)
- **What it is**: An issue execution plan dated **2026-08-17** outlining Phases 0 through 4 (Issues #70 through #91).
- **Why it is stale**: All Phase 0 issues (#75, #83, #85, #80, #84), Phase 1 issues (#76, #77, #78, #86, #87, #89, #88, #90, #91), and Phase 3 validation rules were implemented and merged in releases v0.3.0, v0.4.0, and v0.5.0.
- **Risk of deletion**: **Zero**. Not referenced by any code, test, or documentation file.
- **Recommendation**: **Delete** to eliminate root-level clutter.

### 2. `PROJECT.md` (Repo Root, 8,324 bytes)
- **What it is**: A sprint task tracker titled "PALEE CLI Phase 1 Final Hardening and Verification" detailing Milestones M1 through M5.
- **Why it is stale**: Every feature (F1 through F17) and every milestone (M1 through M5) is marked `DONE`. The actual architectural contracts are permanently documented in `docs/04-0-storage-layer.md` and `docs/adr/0006-...`.
- **Risk of deletion**: **Zero**. Not referenced by any build, test, or documentation file.
- **Recommendation**: **Delete**.

### 3. `TEST_INFRA.md` (Repo Root, 2,027 bytes)
- **What it is**: A 32-line summary of test tiers written during Phase 1 hardening.
- **Why it is stale**: It contains a high-level table that has been completely superseded by the comprehensive testing chapters: `docs/06-0-testing.md`, `docs/06-1-unit-tests.md`, and `docs/06-2-integration-and-smoke-tests.md`.
- **Risk of deletion**: **Zero**.
- **Recommendation**: **Delete**.

### 4. `planning/cicd_dependency_management_proposal.md` (26,371 bytes)
- **What it is**: A 526-line pre-implementation proposal written on **2026-08-10** for GitHub Actions CI/CD workflows and dependency policies.
- **Why it is stale**: The actual production workflows were implemented in `.github/workflows/` (`ci.yml`, `release.yml`, `security.yml`, `deploy-docs.yml`) and fully documented in `docs/07-0-cicd-and-release-pipeline.md`, `docs/07-1-continuous-integration.md`, and `docs/07-2-release-workflow-and-npm-publishing.md`. The proposal contains obsolete hypothetical designs (e.g. CodeQL SAST, artifact attestations) that do not match the current setup.
- **Risk of deletion**: **Low**. Referenced in `docs/08-0-planning-and-design-documents.md` line 8 as an index entry; if deleted, that link line should be removed from `docs/08-0`.
- **Recommendation**: **Delete** or move to an `archive/` folder.

---

## 4. Deployed VitePress Pages Review: Accuracy, Inconsistencies & Drift

### 4.1 Phantom / Non-Existent Commands vs. Planned Future Features

It is critical to distinguish between **accidental phantom commands** (hallucinations/errors) and **intentional planned future capabilities**:

#### A. Accidental Phantom Commands (Defects to Clean Up)
1. **`palee verify` and `palee doctor` in `docs/06-2-integration-and-smoke-tests.md` (lines 153-154)**:
   ```markdown
   | `palee verify`  | ✅ | ✅ (Codes 0, 2, 3) | ✅ (`verify --json`) |
   | `palee doctor`  | ✅ | ✅ (Codes 0, 2) | ✅ (`doctor --json`) |
   ```
   - **Discrepancy**: Neither `palee verify` nor `palee doctor` exists in `bin/palee.ts` or `src/cli/`. The actual integrity validation command is `palee validate`. These rows were likely copied from a template or other CLI project and are erroneous.
   - **Recommendation**: Remove these two rows from the smoke-test matrix.

2. **`palee assess` in `docs/03-0-engine-core.md` (line 66)**:
   ```mermaid
   CmdAssess["palee assess / progress"]
   ```
   - **Discrepancy**: No CLI command named `palee assess` exists in `bin/palee.ts`. The command is `palee progress` (and `palee review` for recording quality scores).
   - **Recommendation**: Change `CmdAssess["palee assess / progress"]` to `CmdAssess["palee progress"]`.

#### B. Planned Future Phase 2 Features (INTENTIONAL — DO NOT REMOVE)
The following are **legitimate future features** designed for Phase 2 (AI Module) and must **NOT** be removed:
- **`palee test <topic>` and `palee tutor <topic>`**: Documented in `README.md`, `planning/ai_module_design.md`, and `docs/08-2-future-ai-module-and-phase-2-design.md`. These represent the planned Feynman-style testing and Socratic tutoring AI workflows.
- **`palee roadmap` without `--from`**: The planned interactive AI interview mode for personalized curriculum generation.
- **`palee config set-provider` with `base_url`, `api_key`, `model`**: Represents the target Phase 2 credential and endpoint specification for OpenAI-compatible AI backends.
- **`planning/ai_module_design.md` and `planning/PHASE_2_GAPS.md`**: Foundational design assets preserving the future architectural roadmap. Keep intact.

---

### 4.2 Other Accuracy Items

1. **Exit Code Matrix in `README.md` (lines 211-215)**:
   - **Discrepancy**: Omits **Exit Code 1** (Partial failure, used by batch roadmap import when some topics fail). Lists 0, 2, 3, 4, 5 only.
   - **Recommendation**: Add Exit Code 1 to the README table.

### 4.3 Outdated Metrics & Agent Guidance

1. **Test Suite Count in `docs/06-0-testing.md` (line 127)**:
   - **Documented as**: `Test Execution Tiers (19 Files / 230 Tests)`.
   - **Actual Status in v0.5.2**: **477 tests across 73 test suites** in the fast suite alone.

2. **Mastery Function Status in `agent.md` (line 73)**:
   - **Documented as**: "`computeTopicMastery()` does not exist — mastery stays at the value adopt seeds (0.0)".
   - **Actual Status**: `computeTopicMastery()` and `resolveTopicMastery()` exist in `src/engine/mastery.ts` and are actively used.

### 4.4 Storage Architecture Diagram Omissions (`docs/04-0-storage-layer.md` line 41)

Diagram 21 depicts the `src/storage/` layer as containing only 6 modules:
- `vault-walker.ts`, `frontmatter.ts`, `atomic-write.ts`, `lock.ts`, `cache.ts`, `memory.ts`.
- **Missing from diagram**:
  - `loader.ts` (centralized note loader with caching)
  - `scanner.ts` (vault-wide frontmatter scanner)
  - `pattern-matcher.ts` (glob & frontmatter tag matcher)
  - `roadmap-parser.ts` (multi-format roadmap parser)
  - `dependencies.ts` (dependency normalization utilities)
  - `sessions.ts` (session note management)

### 4.5 Orphaned ADRs in VitePress Navigation (`docs/.vitepress/config.mts`)

The VitePress sidebar configuration in `docs/.vitepress/config.mts` (lines 133-142) only registers ADR-0001 through ADR-0006:
```ts
sidebar: [
  ...
  {
    text: 'Architectural Decision Records',
    link: '/adr/README',
    items: [
      { text: 'ADR-0001: SM-2 Spaced Repetition', link: '/adr/0001-supermemo-sm2-algorithm' },
      { text: 'ADR-0002: Atomic File Locking & OCC', link: '/adr/0002-atomic-file-locking-and-occ' },
      { text: 'ADR-0003: Frontmatter via YAML Document API', link: '/adr/0003-concrete-syntax-tree-yaml-frontmatter' },
      { text: 'ADR-0004: Four-Pillar Pedagogical Model', link: '/adr/0004-four-pillar-pedagogical-mastery' },
      { text: 'ADR-0005: Concurrency Storage & Schema Migration', link: '/adr/0005-concurrency-storage-and-schema-migration' },
      { text: 'ADR-0006: Concurrency Resilience & Storage Isolation', link: '/adr/0006-phase-1-concurrency-resilience-and-storage-isolation' }
      // Missing: ADR-0007 and ADR-0008!
    ]
  }
]
```
Both `docs/adr/0007-hot-memory-read-state-contract.md` and `docs/adr/0008-validation-framework-decisions.md` exist on disk and in `docs/adr/README.md`, but users navigating the website cannot discover them from the sidebar.

---

## 5. Mermaid Diagram Deep Audit (Spacing, Truncation & Layout)

Across all 53 diagrams in the documentation, **25 diagrams have formatting, layout, or text truncation issues**. Below is the detailed analysis of every affected diagram:

### 5.1 Critical Layout Issue: 419-Character Single Node in `docs/02-3-reporting-commands.md`

- **Location**: `docs/02-3-reporting-commands.md`, lines 214–277 (Diagram 12)
- **Node**: `Rules` (line 224)
- **Current Content**:
  ```mermaid
  Rules["parse-frontmatter → read-failure → valid-managed-note-kind → valid-palee-schema → valid-topic-id-format → valid-topic-status → no-duplicate-topic-id → valid-dependency-list → no-missing-dependency → no-dependency-cycle → valid-assessment-fields → valid-topic-mastery → valid-review-fields → valid-review-dates → valid-session-schema → no-session-unknown-topic → valid-session-index → valid-hot-memory → safe-vault-paths"]
  ```
- **Problem**: This single node contains **419 characters** without a single `<br/>` tag in a `flowchart LR` diagram! In VitePress, this causes the SVG to stretch hundreds of pixels beyond the right margin, breaking responsive page layouts on desktops and rendering completely illegible on laptops and tablets.
- **Recommended Fix**:
  Split the 19 rules into a formatted multi-line block with `<br/>` tags (e.g. 4-5 rules per line), or represent the rule categories as a subgraph containing separate, readable nodes:
  ```mermaid
  Rules["19 Validation Rules (in Registration Order):<br/>1. parse-frontmatter • 2. read-failure • 3. valid-managed-note-kind<br/>4. valid-palee-schema • 5. valid-topic-id-format • 6. valid-topic-status<br/>7. no-duplicate-topic-id • 8. valid-dependency-list • 9. no-missing-dependency<br/>10. no-dependency-cycle • 11. valid-assessment-fields • 12. valid-topic-mastery<br/>13. valid-review-fields • 14. valid-review-dates • 15. valid-session-schema<br/>16. no-session-unknown-topic • 17. valid-session-index • 18. valid-hot-memory<br/>19. safe-vault-paths"]
  ```

---

### 5.2 Diagrams with Cramped Space & Long Nodes (>35 Characters)

When nodes exceed 35–40 characters in a single line, Mermaid generates excessively wide SVG bounding boxes that cause node overlap, edge label collisions, or horizontal scrollbar clipping:

| # | File & Lines | Diagram Type | Node ID & Line | Current Text (Single-Line) | Character Length | Recommended Multi-Line Refactor |
| :-: | :--- | :---: | :---: | :--- | :-: | :--- |
| **1** | `docs/02-0-cli-commands.md`<br>lines 40–57 | `flowchart TD` | `User` (line 42) | `Terminal Invocation: palee &lt;command&gt; [args] [flags]` | 48 | `Terminal Invocation:<br/>palee &lt;command&gt; [args] [flags]` |
| | | | `SrsEng` (line 50) | `SRS Review & Plan Engine (review, next, plan)` | 44 | `SRS Review & Plan Engine<br/>(review, next, plan)` |
| | | | `RepEng` (line 51) | `Analytics Engine (dashboard, progress, validate)` | 47 | `Analytics Engine<br/>(dashboard, progress, validate)` |
| | | | `SessEng` (line 52) | `Session Working Memory (session start/draft/end/list)` | 52 | `Session Working Memory<br/>(session start/draft/end/list)` |
| **2** | `docs/02-1-topic-management-commands.md`<br>lines 97–125 | `flowchart TD` | `ErrTTY` (line 117) | `Error: Non-interactive environment (Exit 2)` | 42 | `Error: Non-interactive<br/>environment (Exit 2)` |
| | | | `Rollback` (line 122) | `Rollback Journal: Restore Modified Notes (Exit 4/5)` | 50 | `Rollback Journal:<br/>Restore Modified Notes (Exit 4/5)` |
| **3** | `docs/02-1-topic-management-commands.md`<br>lines 231–265 | `flowchart TD` | `ImportLoop` (line 247) | `Iterate Roadmap Topics (Per-Topic try/catch)` | 43 | `Iterate Roadmap Topics<br/>(Per-Topic try/catch)` |
| | | | `CatchErr` (line 255) | `Catch Error -> Log & failed++ -> Continue Next Topic` | 52 | `Catch Error:<br/>Log & failed++<br/>Continue Next Topic` |
| | | | `CatchOCC` (line 256) | `Log Conflict & failed++ & conflicts++ -> Continue Next Topic` | 60 | `Log Conflict:<br/>failed++ & conflicts++<br/>Continue Next Topic` |
| **4** | `docs/02-2-review-and-scheduling-commands.md`<br>lines 83–103 | `flowchart TD` | `ReviewInput` (line 85) | `palee review &lt;topic&gt; &lt;0..5&gt;` | 39 | `palee review<br/>&lt;topic&gt; &lt;0..5&gt;` |
| | | | `PreWriteRead` (line 96) | `TOCTOU Check: Re-read Note from Disk` | 36 | `TOCTOU Check:<br/>Re-read Note from Disk` |
| **5** | `docs/02-3-reporting-commands.md`<br>lines 47–61 | `flowchart TD` | `Learning` (line 53) | `Learning: 0.0 &lt; topic_mastery &lt; 0.70` | 42 | `Learning:<br/>0.0 &lt; topic_mastery &lt; 0.70` |
| | | | `DiffBreak` (line 56) | `Difficulty Breakdown: Beginner / Inter / Adv` | 44 | `Difficulty Breakdown:<br/>Beginner / Inter / Adv` |
| **6** | `docs/02-3-reporting-commands.md`<br>lines 214–277 | `flowchart LR` | `WarnDepLegacy` (line 245) | `legacy dependencies alias — migrate to depends_on` | 49 | `legacy dependencies alias<br/>(migrate to depends_on)` |
| | | | `WarnDepDup` (line 246) | `duplicate depends_on / dependencies entry` | 41 | `duplicate depends_on /<br/>dependencies entry` |
| **7** | `docs/02-4-session-management-command.md`<br>lines 55–72 | `flowchart TD` | `SyncHot` (line 60) | `Verify & Sync Working Memory (.palee/hot.md)` | 43 | `Verify & Sync Working Memory<br/>(.palee/hot.md)` |
| | | | `WarnDraft` (line 63) | `Print Draft Warning & Exit Code 2 / JSON drafts_pending` | 55 | `Print Draft Warning<br/>Exit Code 2 / drafts_pending` |
| | | | `PrintHot` (line 71) | `Display Active Topic & Working Memory Excerpt` | 45 | `Display Active Topic &<br/>Working Memory Excerpt` |
| **8** | `docs/03-0-engine-core.md`<br>lines 31–95 | `flowchart TD` | `ExpMastery` (line 39) | `computeTopicMastery / normalizeScore / MASTERY_THRESHOLD` | 56 | `computeTopicMastery / normalizeScore<br/>MASTERY_THRESHOLD` |
| | | | `ExpDep` (line 40) | `getReadyTopics / areDependenciesSatisfied / detectCycle / validateDependencyGraph` | 81 | `getReadyTopics / areDependenciesSatisfied<br/>detectCycle / validateDependencyGraph` |
| **9** | `docs/03-1-sm2-spaced-repetition-algorithm.md`<br>lines 92–116 | `flowchart TD` | `Start` (line 94) | `Review Input: (Topic Review State, Quality: 0-5)` | 49 | `Review Input:<br/>Topic Review State, Quality: 0-5` |
| | | | `Schedule` (line 114) | `Compute due_at = computeDueDate(Today, Interval)` | 47 | `Compute due_at =<br/>computeDueDate(Today, Interval)` |
| **10** | `docs/03-2-dependency-graph-engine.md`<br>lines 69–98 | `flowchart TD` | `Engine` (line 75) | `Dependency Engine (src/engine/dependency.ts)` | 43 | `Dependency Engine<br/>(src/engine/dependency.ts)` |
| | | | `DepCheck` (line 79) | `areDependenciesSatisfied(topic, topics, threshold)` | 49 | `areDependenciesSatisfied<br/>(topic, topics, threshold)` |
| **11** | `docs/03-2-dependency-graph-engine.md`<br>lines 191–216 | `flowchart TD` | `VResult` (line 206) | `ValidationResult: { valid: boolean, errors: ValidationError[] }` | 60 | `ValidationResult:<br/>{ valid: boolean, errors: ValidationError[] }` |
| **12** | `docs/06-0-testing.md`<br>lines 119–152 | `flowchart TD` | `IT` (line 130) | `(test/cli-commands.test.ts, test/cli-adopt-batch.test.ts)` | 56 | `test/cli-commands.test.ts<br/>test/cli-adopt-batch.test.ts` |
| | | | `INP` (line 131) | `(test/cli-exit-codes.test.ts, test/cli-json-output.test.ts, test/session-cli.test.ts)` | 84 | `test/cli-exit-codes.test.ts<br/>test/cli-json-output.test.ts<br/>test/session-cli.test.ts` |
| | | | `Storage` (line 137) | `Storage Layer (AtomicWrite, Locks, Frontmatter, Cache)` | 53 | `Storage Layer<br/>(AtomicWrite, Locks, Frontmatter, Cache)` |
| **13** | `docs/08-0-planning-and-design-documents.md`<br>lines 64–138 | `flowchart TD` | `C_Atom` (line 92) | `Atomic Write (src/storage/atomic-write.ts)` | 41 | `Atomic Write<br/>(src/storage/atomic-write.ts)` |
| | | | `C_DAG` (line 95) | `Dependency Graph (src/engine/dependency.ts)` | 42 | `Dependency Graph<br/>(src/engine/dependency.ts)` |

---

### 5.3 Special Character & Unquoted Syntax Risks in Diagrams

Mermaid parsers in various VitePress builds can crash or misparse when node labels contain parentheses `()`, brackets `[]`, colons `:`, or mathematical comparison operators without being explicitly wrapped in double quotes `""`:

1. **`docs/03-1-sm2-spaced-repetition-algorithm.md` (lines 97, 102)**:
   - `q &lt; 3: Failure` and `q &ge; 3: Success` — unquoted labels with colons and HTML entities on decision branch edges.
2. **`docs/03-2-dependency-graph-engine.md` (line 118)**:
   - `Done(["Subtree Pruned in O(1)"])` — nested parentheses `O(1)` inside stadium shape `(["..."])` without escaping.
3. **`docs/04-1-frontmatter-parser-and-atomic-writes.md` (lines 89, 97, 106)**:
   - Sequence diagram note messages containing unquoted brackets: `) [mkdirSync`, `) [rmdirSync`.
4. **`docs/08-0-planning-and-design-documents.md` (lines 155, 159)**:
   - Sequence diagram note messages containing unquoted brackets: `) [src/storage/memory.ts`.

---

## 6. Emoji Audit & Remediation Guide

Technical documentation standards for PALEE require a clean, distraction-free typographic style. All emojis across prose, table headers, and Mermaid diagrams should be eliminated or replaced with standard alphanumeric indicators or clean ASCII/Unicode symbols (`[OK]`, `[WARN]`, `[ERROR]`, `(Exit 0)`, etc.).

### 6.1 Emojis in Mermaid Diagrams (6 instances)

| File | Line | Current Line with Emoji | Recommended Clean Replacement |
| :--- | :---: | :--- | :--- |
| `docs/02-1-topic-management-commands.md` | 262 | `Success["✓ Roadmap imported successfully (Exit 0)"]` | `Success["Roadmap imported successfully (Exit 0)"]` |
| `docs/02-1-topic-management-commands.md` | 263 | `PartialFail["⚠ Failed to import X topics (Exit 1)"]` | `PartialFail["Failed to import X topics (Exit 1)"]` |
| `docs/02-2-review-and-scheduling-commands.md` | 102 | `SuccessReview["✓ Review recorded (Exit 0)"]` | `SuccessReview["Review recorded (Exit 0)"]` |
| `docs/02-3-reporting-commands.md` | 276 | `Success["✓ 0 Errors Found (Exit 0)"]` | `Success["0 Errors Found (Exit 0)"]` |
| `docs/02-4-session-management-command.md` | 68 | `WarnDraft --> Stop(("⛔ Exit"))` | `WarnDraft --> Stop(("Exit"))` |
| `docs/03-2-dependency-graph-engine.md` | 114 | `Cycle["🚨 Cycle Detected<br/>Extract pathStack loop slice"]` | `Cycle["Cycle Detected<br/>Extract pathStack loop slice"]` |

### 6.2 Emojis in Prose & Tables (14 instances in `docs/`)

| File | Line | Context | Recommended Replacement |
| :--- | :---: | :--- | :--- |
| `docs/02-1-topic-management-commands.md` | 287 | `✓ All notes are schema v1 - no migration needed` | `[OK] All notes are schema v1 - no migration needed` |
| `docs/02-3-reporting-commands.md` | 287 | `✗ Found 1 validation error(s):` | `ERROR: Found 1 validation error(s):` |
| `docs/02-3-reporting-commands.md` | 292 | `⚠ Found 1 validation warning(s):` | `WARN: Found 1 validation warning(s):` |
| `docs/06-2-integration-and-smoke-tests.md` | 144 | `| palee config | ✅ | ✅ (Codes 0, 2) | ✅ (config --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 145 | `| palee adopt | ✅ | ✅ (Codes 0, 2, 4) | ✅ (adopt --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 146 | `| palee roadmap | ✅ | ✅ (Codes 0, 2, 3, 4) | ✅ (roadmap --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 147 | `| palee review | ✅ | ✅ (Codes 0, 2, 4) | ✅ (review --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 148 | `| palee next | ✅ | ✅ (Codes 0, 2) | ✅ (next --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 149 | `| palee plan | ✅ | ✅ (Codes 0, 2) | ✅ (plan --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 150 | `| palee progress| ✅ | ✅ (Codes 0, 2) | ✅ (progress --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 151 | `| palee dashboard| ✅ | ✅ (Codes 0, 2) | ✅ (dashboard --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 152 | `| palee session | ✅ | ✅ (Codes 0, 2) | ✅ (session --json) |` | Replace `✅` with `Yes` or `Passed` |
| `docs/06-2-integration-and-smoke-tests.md` | 153 | `| palee verify | ✅ | ✅ (Codes 0, 2, 3) | ✅ (verify --json) |` | **Remove row** (phantom command) |
| `docs/06-2-integration-and-smoke-tests.md` | 154 | `| palee doctor | ✅ | ✅ (Codes 0, 2) | ✅ (doctor --json) |` | **Remove row** (phantom command) |

### 6.3 Emojis in Non-Hosted / Root Files (34 instances)

- `README.md`: Contains `→` arrows in workflow sections (acceptable Unicode symbols, not pictorial emojis).
- `agent.md`: Contains `✓` and `⚠` in output specification section (acceptable as terminal symbol specifications).
- `PRE_AI_ISSUE_EXECUTION_PLAN.md` & `TEST_INFRA.md`: Contain `✓` checkmarks; will be resolved when files are deleted.
- `planning/PHASE_2_GAPS.md`: Contains `✅ Yes` and `❌ No` in status tables.

---

## 7. Broken Links & Code References Audit

10 code references and file links point to non-existent files or incorrectly formatted paths:

| File | Line | Broken Target / Path | Correct Target / Path | Severity |
| :--- | :---: | :--- | :--- | :---: |
| `docs/06-0-testing.md` | 20 | `src/storage/walker.ts` | `src/storage/vault-walker.ts` | Medium |
| `docs/06-1-unit-tests.md` | 18 | `src/storage/walker.ts` | `src/storage/vault-walker.ts` | Medium |
| `docs/07-1-continuous-integration.md` | 161 | `.eslint.config.mjs#4-30` | `eslint.config.mjs#L4-L30` (no leading dot) | Medium |
| `docs/07-1-continuous-integration.md` | 163 | `.eslint.config.mjs#12-19` | `eslint.config.mjs#L12-L19` (no leading dot) | Medium |
| `docs/07-1-continuous-integration.md` | 164 | `.eslint.config.mjs#21-28` | `eslint.config.mjs#L21-L28` (no leading dot) | Medium |
| `docs/05-1-topic-and-assessment-schema.md` | 5 | `examples/Docker%20Fundamentals.md` | `examples/Docker Fundamentals.md` (unescaped space) | Low |
| `docs/05-1-topic-and-assessment-schema.md` | 6 | `examples/Docker%20Networking.md` | `examples/Docker Networking.md` (unescaped space) | Low |
| `docs/05-1-topic-and-assessment-schema.md` | 7 | `examples/Docker%20Volumes.md` | `examples/Docker Volumes.md` (unescaped space) | Low |
| `docs/05-1-topic-and-assessment-schema.md` | 76 | `examples/Docker%20Fundamentals.md` | `examples/Docker Fundamentals.md` (unescaped space) | Low |
| `docs/05-1-topic-and-assessment-schema.md` | 164 | `examples/Docker%20Fundamentals.md` | `examples/Docker Fundamentals.md` (unescaped space) | Low |

---

## 8. Prioritized Recommendations & Action Plan

To bring the documentation to 100% production fidelity without risking regression, the following sequential phases are recommended for future implementation:

### Phase 1: Repository Hygiene & Stale File Cleanup
1. **Delete 3 stale root files**: `PRE_AI_ISSUE_EXECUTION_PLAN.md`, `PROJECT.md`, `TEST_INFRA.md`.
2. **Remove or archive**: `planning/cicd_dependency_management_proposal.md`.
3. **Clean up `.gitignore` and `.npmignore`**: Remove references to deleted files.

### Phase 2: Navigation & Discoverability
1. **Update `docs/.vitepress/config.mts`**:
   Add ADR-0007 and ADR-0008 to the sidebar:
   ```ts
   { text: 'ADR-0007: Hot-Memory Read-State Contract', link: '/adr/0007-hot-memory-read-state-contract' },
   { text: 'ADR-0008: Validation Framework Decisions', link: '/adr/0008-validation-framework-decisions' }
   ```

### Phase 3: Mermaid Diagram Resizing & Layout Optimization
1. **Refactor Diagram 12 (`docs/02-3-reporting-commands.md`)**:
   Break the 419-character `Rules` node into formatted multi-line text with `<br/>` tags.
2. **Refactor the 24 cramped nodes**:
   Insert `<br/>` line breaks into single-line nodes exceeding 35 characters across Diagrams 1, 2, 3, 7, 8, 9, 10, 11, 13, 14, 15, 20, 36, and 45.
3. **Quote special characters**:
   Ensure all nodes with colons, parentheses, or comparison operators are enclosed in explicit double quotes `""`.
4. **Update Diagram 21 (`docs/04-0-storage-layer.md`)**:
   Add the 7 missing storage modules (`loader.ts`, `scanner.ts`, `pattern-matcher.ts`, `roadmap-parser.ts`, `dependencies.ts`, `sessions.ts`).

### Phase 4: Emoji Elimination & Typography Standardization
1. **Strip emojis from Mermaid diagrams**:
   Remove `⛔`, `🚨`, `✓`, `⚠` from node labels in `docs/02-1`, `docs/02-2`, `docs/02-3`, `docs/02-4`, and `docs/03-2`.
2. **Clean table and prose emojis**:
   Replace `✅` with `Yes`/`Passed` in `docs/06-2`. Replace `✓`/`✗`/`⚠` in CLI output code examples in `docs/02-1` and `docs/02-3` with standard text tags (`[OK]`, `[ERROR]`, `[WARN]`).

### Phase 5: Codebase Parity & Accuracy Reconciliation
1. **Remove accidental phantom commands**:
   Delete rows for `palee verify` and `palee doctor` from `docs/06-2-integration-and-smoke-tests.md`. Replace `palee assess` with `palee progress` in `docs/03-0-engine-core.md`.
2. **Preserve planned future Phase 2 feature specifications**:
   - **Do NOT remove** `palee test`, `palee tutor`, `palee roadmap` (guided AI interview mode), or AI provider specifications from `README.md`, `planning/ai_module_design.md`, or `docs/08-2-future-ai-module-and-phase-2-design.md`. These are intentional design assets for Phase 2.
   - Add Exit Code 1 (Partial failure) to the `README.md` exit codes table.
3. **Fix broken links**:
   - Replace `src/storage/walker.ts` with `src/storage/vault-walker.ts` in `docs/06-0` and `docs/06-1`.
   - Replace `.eslint.config.mjs` with `eslint.config.mjs` in `docs/07-1`.
4. **Update test metrics**:
   Update `docs/06-0-testing.md` from `19 Files / 230 Tests` to `477 Tests`.
5. **Update `agent.md`**:
   Correct the note regarding `computeTopicMastery()`.
