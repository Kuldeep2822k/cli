# Project: PALEE Documentation Humanization, Technical Contract Alignment, and Theme Accessibility Overhaul (Issue #113)

## Architecture
PALEE (Personalized Adaptive Learning Engine in Obsidian) CLI documentation suite built with VitePress (`docs/`), documenting:
- Presentation/Theme: `docs/.vitepress/theme/custom.css`, `docs/.vitepress/config.mts`
- Chapter 1: Overview & Architecture (`docs/01-*`)
- Chapter 2: CLI Commands & Ergonomics (`docs/02-*`)
- Chapter 3: Engine Core & Algorithms (`docs/03-*`)
- Chapter 4: Storage & Concurrency (`docs/04-*`)
- Chapter 5: Data Model & Domain Types (`docs/05-*`)
- Chapter 6: Testing Catalog & Suites (`docs/06-*`)
- Chapter 7: Tooling & CI/CD (`docs/07-*`)
- ADRs: Architectural Decision Records (`docs/adr/0001` through `0004`)

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Light/Dark Mermaid Scoping | Fix pitch-black card styling in light mode by scoping dark styles under `.dark` and using CSS variables | M1 | R1 |
| 2 | Top Nav Deduplication | Remove duplicate Architecture link in navbar and update version tag in `docs/.vitepress/config.mts` | M1 | R1 |
| 3 | 4-Pillar Mastery Engine Docs | Document `(c + p + d + 2f) / 5`, `0.70` threshold, clamping, and archive exclusion in `docs/03-0` & `03-1` | M2 | R2 |
| 4 | 3-Color DFS Cycle Detection | Formalize white/gray/black state graph traversal and fix inverted Mermaid diagrams in `docs/03-2` | M2 | R2 |
| 5 | Missing CLI Flags | Add `--difficulty`, `--depends-on`, `--all`, `--from`, `-y` option tables in `docs/02-1` | M3 | R3 |
| 6 | Exit Code Matrix (0-5) | Document comprehensive 0 to 5 exit code contract across all 11 CLI commands in Chapter 2 | M3 | R3 |
| 7 | Non-TTY Auto-JSON Detection | Document `process.stdout.isTTY === false` automatic JSON streaming in Chapter 2 | M3 | R3 |
| 8 | Daily Study/Review Workflows | Document 4 copy-pasteable real-world developer workflows in Chapter 2 | M3 | R3 |
| 9 | OCC Conflict Sequence Diagram | Correct OCC diagram in `docs/04-1` with `alt/else` branching and exit code 4 contract | M4 | R4 |
| 10 | Unsettled Mtime & SHA Fallback | Document 2-second unsettled mtime horizon and SHA-256 content fallback in `docs/04-3` | M4 | R4 |
| 11 | Discriminated Union Session Types | Document `Session = CompletedSession | DraftSession` with discriminant in `docs/05-0` | M4 | R4 |
| 12 | 19 Active Test Suites Catalog | Catalog all 19 test files (230 tests) in `docs/06-0` with copy-pasteable boilerplate | M5 | R5 |
| 13 | CI/CD 40-Char SHA Pinning | Document GitHub Actions commit SHA pinning and supply chain security in `docs/07-1` | M5 | R5 |
| 14 | ADR Alternatives Considered | Add complete "Alternatives Considered" sections to ADRs 0001–0004 and fix links in README | M5 | R5 |
| 15 | Verification & Quality Gates | Pass `npm test` (230 tests), `npm run check` (0 errors), `npm run docs:build` (clean build) | M6 | Acceptance Criteria |
| 16 | Dedicated Branch & PR Delivery | Branch `docs/issue-113-humanization-and-fixes`, push to origin, open PR targeting `main` | M7 | R6 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Theme & Navigation Accessibility | `docs/.vitepress/theme/custom.css`, `docs/.vitepress/config.mts` | None | DONE |
| M2 | Engine Core & Algorithmic Rigor | `docs/03-0-engine-core.md`, `docs/03-1-spaced-repetition-engine.md`, `docs/03-2-dependency-graph-engine.md` | None | DONE |
| M3 | CLI Ergonomics & JSON Output | `docs/02-0-cli-commands.md`, `docs/02-1-topic-management-commands.md`, `docs/02-2-review-and-scheduling-commands.md`, `docs/02-3-reporting-commands.md`, `docs/02-4-session-management-command.md` | None | DONE |
| M4 | Storage Layer, OCC & Domain Types | `docs/04-0-storage-layer.md`, `docs/04-1-frontmatter-parser-and-atomic-writes.md`, `docs/04-3-vault-walker-and-file-cache.md`, `docs/05-0-data-model-and-types.md` | None | DONE |
| M5 | Testing Catalog, CI/CD & ADRs | `docs/06-0-testing.md`, `docs/06-1-unit-tests.md`, `docs/06-2-integration-and-smoke-tests.md`, `docs/07-1-continuous-integration.md`, `docs/adr/0001-supermemo-sm2-algorithm.md`, `docs/adr/0002-atomic-file-locking-and-occ.md`, `docs/adr/0003-concrete-syntax-tree-yaml-frontmatter.md`, `docs/adr/0004-four-pillar-pedagogical-mastery.md`, `docs/adr/README.md` | None | DONE |
| M6 | Full Quality Gates Verification | Run test suite (230 tests), strict typecheck, and VitePress production build | M1, M2, M3, M4, M5 | DONE |
| M7 | Git Branching & PR Delivery | Commit to `docs/issue-113-humanization-and-fixes`, push to origin, open PR targeting `main` | M6 | IN_PROGRESS |

## Interface Contracts & Layout
### Code Layout & File Ownership
- M1 files: `docs/.vitepress/theme/custom.css`, `docs/.vitepress/config.mts`
- M2 files: `docs/03-0-engine-core.md`, `docs/03-1-spaced-repetition-engine.md`, `docs/03-2-dependency-graph-engine.md`
- M3 files: `docs/02-0-cli-overview.md`, `docs/02-1-topic-management-commands.md`, `docs/02-2-learning-session-commands.md`, `docs/02-3-analytics-and-insights.md`, `docs/02-4-configuration-and-maintenance.md`
- M4 files: `docs/04-0-storage-layer.md`, `docs/04-1-frontmatter-parser-and-atomic-writes.md`, `docs/04-3-vault-walker-and-file-cache.md`, `docs/05-0-data-model-and-types.md`
- M5 files: `docs/06-0-testing.md`, `docs/06-1-unit-tests.md`, `docs/06-2-integration-and-smoke-tests.md`, `docs/07-1-continuous-integration.md`, `docs/adr/0001-supermemo-sm2-algorithm.md`, `docs/adr/0002-atomic-file-locking-and-occ.md`, `docs/adr/0003-concrete-syntax-tree-yaml-frontmatter.md`, `docs/adr/0004-four-pillar-pedagogical-mastery.md`, `docs/adr/README.md`
- M6 & M7: Git & Test Runner commands
