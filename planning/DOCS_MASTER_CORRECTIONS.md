# PALEE Documentation & Specification Master Corrections Plan

This document serves as the single source of truth for all documentation corrections, specification alignments, and legacy planning hygiene across the PALEE project.

Consolidating these items into a single master document prevents unnecessary documentation churn during active feature development and ensures that all user-facing docs (`README.md`, `docs/`, `planning/`) are synchronized cleanly at major milestone releases.

---

## 1. User-Facing Documentation & README Synchronization (GitHub Issue #81)

**Target Files**: `README.md`, `docs/02-0-cli-commands.md`, `docs/02-2-review-and-scheduling-commands.md`

### 1.1 Future vs Shipped Command Delineation
- **`palee test <topic>`**: Mark explicitly under a `Phase 2 (Future AI Roadmap)` section in `README.md`. It represents the interactive Feynman assessment mode and is not part of the Phase 1 standalone CLI.
- **`palee tutor <topic>`**: Mark explicitly under `Phase 2 (Future AI Roadmap)` in `README.md`.
- **Guided `palee roadmap` (interactive interview)**: Clarify in `README.md` that Phase 1 supports file-based roadmaps (`palee roadmap --from <file>`), while interactive conversational roadmap generation is scheduled for Phase 2.

### 1.2 CLI Command Syntax & Invocation Alignment
- **`palee review` Syntax**: Fix the example in `README.md` from flag syntax (`palee review <topic> --quality N`) to canonical positional syntax (`palee review <topic-id> <quality-0-5>`), matching `bin/palee.ts` and `src/cli/review.ts`.
- **Provider Configuration**: Reconcile `README.md` examples with Phase 1 single-string provider setting (`palee config set-provider <name>`) and document the multi-key configuration (`base_url`, `api_key`, `model`) under the Phase 2 Provider Abstraction roadmap (Issue #24).

### 1.3 Exit Code Table Completeness
- Add **Exit Code 1** (Partial Import / Operational Warning, emitted by `src/cli/roadmap.ts`) to the exit code reference tables in `README.md` and `docs/02-0-cli-commands.md`.

---

## 2. CLI Stubs & Exit Code Contract Hardening (GitHub Issues #92 & #76)

**Target Files**: `src/cli/validate.ts`, `src/cli/migrate.ts`, `src/cli/adopt.ts`, `src/cli/review.ts`, `src/cli/roadmap.ts`, `docs/02-0-cli-commands.md`

### 2.1 Informational Exit Codes for Stubs (Issue #92)
- **`palee validate --fix`**: When invoked prior to the implementation of the automated fix engine (Issue #25), print an informative message explaining that automated AST/frontmatter repair is scheduled for Phase 2 and exit with code `0` (or dedicated code), rather than code `3` (which falsely indicates a vault validation failure).
- **`palee migrate`**: Document that Phase 1 `migrate` operates as a schema version inspector and reporting tool, with active automated migrations rolling out alongside future major schema revisions (`palee_schema: 2+`).

### 2.2 Error Mapping to Exit Code 4 for OCC / Lock Conflicts (Issue #76)
- The PALEE File-Safety Contract specifies **Exit Code 4** for concurrency / lock collisions.
- Update CLI catch handlers in write commands (`review.ts`, `adopt.ts`, `roadmap.ts`) to inspect error messages/types (e.g. `OCC conflict` or `ECONFLICT`) and set `process.exitCode = 4` rather than falling through to generic exit code `5`.

---

## 3. Canonical Schema Standardization across Planning Docs (GitHub Issue #69)

**Target Files**: `planning/*.md`, `planning/invariants.md`, `docs/05-1-topic-and-assessment-schema.md`

### 3.1 Topic Frontmatter Canonical Contract
Ensure all legacy markdown specifications in `planning/` reflect the canonical topic metadata shape:
```yaml
---
palee_id: T-YYYYMMDDTHHMMSS-xxxx
palee_schema: 1
title: Topic Title
difficulty: intermediate # 'beginner' | 'intermediate' | 'advanced'
depends_on: []           # Array of topic IDs (never 'dependencies')
topic_mastery: 0.0
conceptual: 0.0
practical: 0.0
debug: 0.0
feynman: 0.0
assessed_at: null
ease_factor: 2.5
interval_days: 1
repetition: 0
lapses: 0
last_quality: null
last_reviewed_at: null
due_at: null
---
```

### 3.2 Legacy Inconsistency Audit
- Replace outdated numeric difficulty representations (`1..5`) in older design drafts with the canonical 3-tier string enum (`beginner`, `intermediate`, `advanced`).
- Standardize all YAML dependency examples to `depends_on`.

---

## 4. Planning Document Hygiene & De-Bloating (GitHub Issue #93)

**Target Files**: `planning/PHASE_1_CHECKLIST.md`, `planning/cicd_dependency_management_proposal.md`, `planning/VALIDATION_FRAMEWORK_VERDICT.md`

### 4.1 Speculative vs Verifiable Content
- **Illustrative Models**: Clearly label speculative model names (e.g. `nemotron-3-ultra-free`, `deepseek-v4-flash-free`) as illustrative examples for Phase 2 AI provider integration.
- **Enterprise Proposals**: Tag advanced proposals (OIDC publishing, SBOMs, CodeQL) under a dedicated *Future Release Infrastructure Proposals* header.
- **Test Metric Grounding**: Keep `PHASE_1_CHECKLIST.md` aligned with real, verifiable CI test counts and suite numbers (currently 167 tests across 23 suites).

---

## 5. Consolidated GitHub Issue Mapping

| Issue | Title | Status in Master Plan |
| :--- | :--- | :--- |
| **#81** | `README documents non-existent commands, wrong review syntax, incomplete exit-code table` | Tracked in Section 1 |
| **#92** | `Documented stubs over-promise: validate --fix no-op exits 3; migrate never migrates` | Tracked in Section 2 |
| **#76** | `Exit code 4 (OCC/lock conflict) is documented but never emitted` | Tracked in Section 2 |
| **#69** | `Synchronize planning docs with the canonical topic schema` | Tracked in Section 3 |
| **#93** | `Trim planning docs to match shipped code (remove inflated/fictional claims)` | Tracked in Section 4 |

---

## 6. Execution Strategy

1. **Active Development Phase**: Keep focus on core functional modules (Issue #73 Auto-Chaining, Issue #25 Validation Rule Engine, Issue #24 AI Provider Abstraction Layer).
2. **Release Documentation Sweep**: Execute all corrections outlined in Sections 1–4 simultaneously in a dedicated documentation & release-hygiene pull request prior to tagging the next milestone release.
