# PALEE CLI Specification

## Overview

PALEE is a study-tracking CLI that helps users learn efficiently using spaced repetition (SM-2) and dependency-aware recommendations. This document specifies the next-generation CLI that integrates AI tutoring while maintaining a clean, deterministic core.

## Problems with Current Approach

1. **Language Barrier**: Current implementation is in Python; target distribution is npm/JS like ESLint
2. **AI Coupling**: Current design requires external AI tools (like opencode) layered on top — leads to:
   - Two tools to learn/run ("palee" vs "opencode")
   - Blurred ownership (who is the source of truth?)
   - Risk of AI corrupting data through incorrect CLI calls
3. **Installation Friction**: No packaged distribution — users must run via `python main.py`
4. **Obsidian Integration**: Current YAML topics don't integrate with Obsidian vaults
5. **AI Quality Risk**: No validation of AI grading quality — poor grading silently degrades SM-2 schedule

## Solution Architecture

### Core Principle
**Separation of concerns**: Deterministic engine + AI layer constrained to validated proposals and read-only context access.

### Layers (Bottom to Top)

1. **Storage Layer**
   - Obsidian vault is the canonical source of truth
   - Topic notes store topic state in YAML frontmatter
   - `.palee/sessions/` stores one durable note per confirmed learning session
   - `.palee/hot.md` stores compact cross-session working memory, capped at 250 words
   - Any SQLite or in-memory index is disposable and rebuildable
   - Human-readable, git-friendly, single source of truth
   - Frontmatter updates use a concrete-syntax-tree-preserving updater; PALEE patches only its own keys and preserves the Markdown body, comments, ordering, and unknown metadata
   - Writes use same-directory temporary files, flush/close, atomic replacement, and optimistic conflict detection
   - Lock heartbeats fire every 15 seconds for operations lasting longer than 30 seconds; stale timeout is 60 seconds on Windows, 120 seconds elsewhere (configurable)
   - The walker ignores `.obsidian`, `.trash`, `.git`, `node_modules`, dot-directories, and symlinks by default
   - A cache may use path, size, modification time, and content fingerprinting, but it is never authoritative
   - The complete file-safety contract is defined in [storage_design.md](storage_design.md)

2. **Engine Core (Pure Library)**
   - Ported from current Python:
     - SM-2 scheduling
     - Dependency graph with cycle detection
     - Schema validation
     - Mastery calculation
     - Topic CRUD
   - Pure functions, no side effects beyond file I/O
   - Fully unit-testable
   - Enforces SM-2 and mastery invariants before any state is persisted

3. **Tool Interface (Mutation Contract)**
   - Single validated path for all state changes:
     - `get_next_topic()`
     - `get_due_reviews()`
     - `get_topic(topic_id)`
     - `record_assessment(topic_id, conceptual, practical, debug, feynman)` (called by session manager only after learner confirms AI-proposed scores; never exposed as an LLM tool)
     - `record_review(topic_id, quality)`
     - `save_session(session_id, topic_id, summary)`
     - `get_session(session_id)`
     - `get_hot_memory()`
     - `get_progress()`
   - Every call validates inputs (ID exists, scores 0-1, quality 0-5)
   - AI may read data and draft proposals, but it receives no assessment/review mutation tools
   - The session manager validates and executes mutations only after user confirmation

4. **CLI Layer (Deterministic Baseline)**
   - Multi-command interface:
     - `palee plan` - Generate study session
     - `palee next` - Recommend next action
     - `palee progress` - Show mastery stats
     - `palee roadmap --from <file>` - Validate and import a user-provided roadmap
     - `palee adopt` - Adopt Obsidian notes
     - `palee review` - Record review result
     - `palee session start` - Resume learning from hot memory; prints current position and starts AI tutor if a provider is configured; deterministic-only output when no provider is set
     - `palee session end` - Save and confirm session summary
     - `palee migrate` - Upgrade versioned PALEE frontmatter and session records
     - `palee validate` - Check data integrity
     - `palee config set-vault` - Set vault path (Windows paths with backslashes accepted and normalized)
     - `palee config set-provider` - Configure AI provider
     - `palee config show` - Display vault path, provider endpoint, and model; never prints api_key
   - Works with zero AI, zero network, zero config
   - Non-AI commands must open no network sockets and perform no DNS lookups
   - `--json` and non-TTY output must be machine-readable and must not contain spinners or ANSI control codes
   - Exit codes: `0` success, `2` usage error, `3` validation error, `4` optimistic-concurrency conflict, `5` provider/network/model-format error

5. **AI Module (Embedded, Optional)**
   - `palee test <topic>` - AI-driven Feynman testing
   - `palee tutor <topic>` - Interactive tutoring session
   - `palee roadmap` - Guided, user-specific roadmap interview and proposal
   - Session continuity from `.palee/hot.md` and referenced session notes
   - BYO provider config (base_url + api_key)
   - Uses read-only tool-calling plus schema-validated structured proposals
   - Human-confirm gate for consequential mutations

6. **External-Agent Escape Hatch (Optional)**
   - Expose tool interface via MCP server
   - Allow opencode/other agents to drive palee
   - Same validated functions, no second code path

## Key Design Decisions

### 1. AI Containment via Tool-Calling
- AI can only call validated read-only engine functions and return structured proposals
- No direct file access, no freeform commands
- Tool-calling ensures structured, schema-validated calls
- The session manager, not the AI, performs confirmed state changes

### 2. Human Confirm Gate
- AI proposes assessments/reviews
- User must explicitly confirm before writing
- Safety rail against poor AI grading corrupting SM-2 data
- Maintains trust boundary between deterministic engine and adaptive AI

### 3. Obsidian-Native Storage
- Each study topic = Obsidian note with frontmatter
   - Frontmatter contains all PALEE metadata (status, assessment, review)
- Body contains human-readable study material
- `palee adopt <note>` adds minimal frontmatter to existing notes
- `palee roadmap --from <file>` deterministically validates a supplied roadmap; guided `palee roadmap` uses AI only after the learner answers the roadmap interview questions

### 4. Explicit Domain Model

Every PALEE-managed topic uses a stable `palee_id` and `palee_schema`:

```yaml
palee_schema: 1
palee_id: T-git-rebase
topic: Git Rebase
track: version_control
status: learning
difficulty: 2
dependencies:
  - T-git-basics
assessment:
  conceptual: 0.7
  practical: 0.4
  debug: 0.2
  feynman: 0.5
  assessed_at: 2026-08-08
review:
  interval_days: 1
  repetition: 0
  ease_factor: 2.5
  lapses: 0
  last_quality: 2
  last_reviewed_at: 2026-08-08
  due_at: 2026-08-09
```

Operational statuses are `not_started`, `learning`, `paused`, and `archived`. Mastery is derived from assessment values; PALEE does not use an ambiguous stored `completed` status.

Assessment values are required numbers in the range `0.0` to `1.0`. For v1, topic mastery uses a weighted mean that gives the Feynman dimension twice the weight of the other three, because the ability to explain a concept is the strongest signal of real understanding:

```text
topic_mastery = round((conceptual + practical + debug + (feynman * 2)) / 5, 4)
```

Feynman contributes 40% of the score; conceptual, practical, and debug each contribute 20%. The `round` operation uses the same positive decimal half-up rule as SM-2 values. Scores are persisted at four decimal places and never calculated from display-rounded percentages.

The progress result always includes `active_topic_count`, `global_mastery`, and `mastery_status`:

```json
{
  "active_topic_count": 0,
  "global_mastery": null,
  "mastery_status": "no_data"
}
```

Global mastery is the arithmetic mean of active-topic mastery values. Archived topics are excluded. Difficulty affects recommendation priority, not the global score. If there are zero active topics, mastery is unavailable rather than zero: machine-readable output returns `global_mastery: null` and `mastery_status: "no_data"`; human-readable output says `No active topics; mastery unavailable.` These formulas are deterministic and must be covered by unit tests.

Mastery is rounded to four decimal places before it is displayed or used in a persisted analytics result. A topic with a missing prerequisite is blocked as if that prerequisite has mastery `0.0`; the missing reference is reported as a dangling-dependency validation warning rather than crashing the graph engine.

Dependency processing uses a three-color depth-first search. Cyclic components are quarantined and report their exact cycle path. `next` and `plan` continue using valid acyclic components. Unlock scoring uses the inverse dependency graph and must remain bounded by the graph size.

SM-2 must enforce `quality` as an integer from `0` to `5`, `ease_factor >= 1.3`, `interval_days >= 1`, and `repetition >= 0`. For newly-adopted topics with no review history, `last_quality`, `last_reviewed_at`, and `due_at` are `null` until the first review is recorded. A failed invariant aborts the write and returns a user-facing validation error.

For deterministic scheduling, qualities below `3` reset `repetition` to `0` and `interval_days` to `1`. Qualities from `3` to `5` increment repetition; the first successful review uses interval `1`, the second uses interval `6`, and later intervals use `round(previous_interval * ease_factor)`. The ease factor is updated with the SM-2 formula and clamped to `1.3` after every update.

The exact ease-factor update is:

```text
delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
ease_factor_next = max(1.30, ease_factor_previous + delta)
```

PALEE stores `ease_factor` rounded to four decimal places using positive decimal half-up rounding. Interval rounding also uses positive decimal half-up rounding, with a final minimum of one day. This is defined independently of JavaScript's floating-point implementation. The stored minimum ease_factor is `1.3000`.

Review scheduling uses calendar dates in the configured vault timezone. `last_reviewed_at` and `due_at` are serialized as `YYYY-MM-DD`; `due_at` is the review date plus `interval_days` calendar days, so daylight-saving transitions cannot change the interval. A failed review increments `lapses` only when the previous `repetition` was greater than zero; repeated failures during initial learning do not increment `lapses`.

Assessment and review are independent:

- Assessment measures conceptual, practical, debugging, and teaching ability.
- Review records recall quality and drives SM-2 scheduling.
- A Feynman test may propose assessment values but does not change review state.
- A review may change SM-2 values but does not overwrite assessment values.

### 5. Session Memory

Session memory is documented in [memory_design.md](memory_design.md). The latest hot memory is loaded first, while full session records are fetched by stable session ID only when needed. This lets a learner resume a topic without injecting the entire learning history into every AI prompt.

The durable session note is canonical. `hot.md` and `index.md` are derived views and must be rebuildable at startup if they are missing, stale, or corrupt.

Topic resolution accepts exact `palee_id`, exact title or filename, legacy snake-case aliases, normalized slug/substring matches, and finally token-distance matches. If multiple candidates are close, interactive mode asks the learner to choose; non-interactive mode returns a deterministic ambiguity error with exit code `2` (usage error — user must disambiguate) and lists all matching candidates, then performs no mutation.

### 6. User-Specific Roadmaps

The formal proposal and validation contract is defined in [roadmap_design.md](roadmap_design.md).

Roadmap behavior has two explicit modes:

1. `palee roadmap --from <file>` validates and imports a roadmap supplied by the learner. This mode is deterministic and does not call AI. The source is read-only during validation; duplicate IDs, dangling dependencies, cycles, and unsafe destination paths are reported before any vault write.
2. `palee roadmap` starts a guided interview when no roadmap is supplied. The interview gathers at least the learning goal, current level, available time, target date, preferred practice style, and constraints. AI uses those answers and available notes to propose a topic graph; the learner confirms it before PALEE writes topic notes.

The proposal must include topic IDs, dependencies, difficulty, rationale, and assumptions. Assumptions are shown to the learner and are never silently treated as facts. A user-provided roadmap is not rewritten by AI unless the learner explicitly requests adaptation.

### 7. Provider-Agnostic AI
- Users configure their own provider (base_url + api_key)
- Supports any OpenAI-compatible endpoint
- Free tier models confirmed working (OpenCode Zen)
- No vendor lock-in, no cost to developer

## Platform Support

PALEE targets Windows as a first-class platform. All file paths use Node's `path` module so separators are normalized. Atomic-write behavior, lock handling, and retry logic contain explicit Windows-specific handling documented in [storage_design.md](storage_design.md). Vault paths may be configured with either forward or backslashes; PALEE normalizes them internally. The npm distribution runs on Node 20+ LTS; no native modules are used in Phase 1 or Phase 2.

## Technical Findings

### Obsidian Integration
- Vault is just a folder of markdown files
- Frontmatter bridges PALEE metadata with human content
- Clean, native integration with no plugin dependencies
- Existing notes can be gradually adopted

### Free Model Testing Results
**Historical local test snapshot via OpenCode Zen free tier (base_url + api_key); revalidate before recommending a model.**

| Model | Tool-calling | Sample Scores (c/p/d/f) | Verdict |
|-------|--------------|------------------------|---------|
| `nemotron-3-ultra-free` | ✅ | 0.70/0.20/0.30/0.60 | **Best** - Well calibrated |
| `deepseek-v4-flash-free` | ✅ | 0.55/0.15/0.35/0.45 | **Good** - Conservative |
| `mimo-v2.5-free` | ✅ | 0.65/0.30/0.40/0.60 | **Good** - Slightly generous |
| `laguna-s-2.1-free` | ✅ | 0.70/0.30/0.20/0.50 | **OK** - Mixed calibration |
| `longcat-2.0-free` | ✅ | 0.40/0.10/0.30/0.20 | **Avoid** - Too conservative |
| `ling-3.0-flash-free` | ❌ (timeout) | - | Unusable |
| `ling-3.0-tiny-free` | ❌ (503) | - | Unusable |
| `north-mini-code-free` | ❌ (401) | - | Unusable |

**Conclusion**: 5/8 free models support reliable tool-calling. Direct API access confirmed — no opencode session coupling required.

### Tool-Calling Requirements
- Models MUST support OpenAI-compatible `tools` parameter
- Without tool-calling, the containment architecture fails
- Freeform JSON parsing is brittle and unsafe

## Implementation Plan

### Phase 1: Core Engine + CLI Baseline
1. Define and validate the versioned topic schema
2. Port engine core to TypeScript (SM-2, graph, schema, mastery)
3. Implement an AST-preserving Obsidian frontmatter reader/updater
4. Implement conflict-aware atomic writes and safe vault traversal (Windows-compatible — see [storage_design.md](storage_design.md))
5. Implement CLI parser with oclif/commander
6. Build basic commands: `next`, `plan`, `progress`, `review`, `validate`, `roadmap --from`, `adopt`, `config show`, `config set-vault`, `config set-provider`
7. Implement session records, checkpoints, derived `hot.md`, and confirmed summaries
8. Add mtime/content-fingerprint incremental indexing (no daemon)

### Phase 2: AI Integration
1. Build AI module with read-only tool access and structured proposal output
2. Add `palee test <topic>` command
3. Add `palee tutor <topic>` command (interactive tutoring session)
4. Implement human-confirm UI flow
5. Load hot memory into tutor context and retrieve full sessions by ID
6. Add guided, user-specific `palee roadmap` generation
7. Integrate with confirmed free models

### Phase 3: Advanced Features
1. Review scheduling and mastery analytics
2. Canvas/roadmap visualization
3. Full 30-case grading evaluation suite
4. MCP server for external agent support

### Phase 4: Distribution
1. Package as npm module
2. Publish to npm registry
3. Document installation (`npm install -g palee`)
4. Create example workflows and tutorials

## Resolved Design Decisions

1. **Default Model**: `nemotron-3-ultra-free`. It had the best calibration in testing. Users can override via `palee config set-provider`. The recommendation in setup docs points to nemotron; deepseek-flash is listed as a conservative alternative.

2. **API Support**: OpenAI-compatible endpoints only for Phase 2. Native Anthropic API support is deferred to Phase 3 — the tool-calling contract is identical and adding a second provider adapter mid-build adds risk. The provider config accepts any `base_url` so Anthropic can be added without breaking existing configs.

3. **Configuration Import**: Fully standalone. PALEE does not auto-import opencode config. Users who already have an opencode key run `palee config set-provider` once and paste it. This avoids a dependency on opencode's config format changing.

4. **Grading Evaluation**: Ship with the 4 tested passing models (nemotron, deepseek-v4-flash-free, mimo-v2.5-free, laguna-s-2.1-free) and build the 30-case eval suite in Phase 3 before any public recommendation changes. The human confirm gate is the primary safety net during Phase 2.

### Schema Migration

In Phase 1, only `palee_schema: 1` is supported. `palee migrate` scans the vault and reports:
- Total notes with `palee_schema: 1`
- Any notes with unrecognized or missing schema versions (validation warnings)
- Outputs "All notes are at current schema version 1. No migration needed."
- Exit code `0` if all notes are version 1, exit code `3` if any unrecognized versions are found
- In Phase 1, it performs no writes — it is a validation-only command

Future phases may introduce schema version 2 and implement a full migration path.

Derived views (`hot.md` and `index.md`) share the same `palee_schema` version namespace as topic notes and session records. A schema migration that updates topic notes from `1` to `2` must also regenerate derived views with the new schema version.

`palee_schema` is the version of the frontmatter and session-note format. It is independent of the PALEE application version. Every managed note must declare it. A migration must read the existing version, transform known fields, preserve the note body and unknown metadata where possible, validate the result, and then write the new version. PALEE should never guess the meaning of an unversioned structure.

For example, a future migration may convert a top-level `last_reviewed` field into `review.last_reviewed_at` and change `palee_schema` from `1` to `2`. Git history or a backup provides recovery if a migration is interrupted.

## Success Criteria

1. **Technical**:
   - CLI installs via `npm install -g palee`
   - All core commands work with zero AI/network
   - AI module works with free tier models
   - Obsidian vault integration seamless
   - AI cannot write state without explicit confirmation, and the deterministic core rejects invalid mutations

2. **User Experience**:
   - Single-tool experience (no "palee vs opencode" confusion)
   - Fast, reliable performance
   - Clear human confirm steps for AI actions
   - Helpful error messages and documentation

3. **Maintainability**:
   - Clean separation of engine/AI/CLI layers
   - Comprehensive test suite
   - Extensible to new providers/models
   - Backwards compatible with existing topic format

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Poor AI grading degrades SM-2 schedule | Human confirm gate + grading eval |
| Free tier rate limits/throttling | Fallback to paid key + local Ollama |
| Model availability changes | Provider-agnostic design + multiple options |
| Large vault performance | mtime-incremental indexing |
| AI tool-calling reliability | Validate models before recommending |
