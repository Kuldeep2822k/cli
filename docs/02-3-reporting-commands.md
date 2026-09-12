# Reporting Commands

<details>
<summary><b>Relevant Source Files</b></summary>

- [src/cli/dashboard.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/dashboard.ts)
- [src/cli/progress.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/progress.ts)
- [src/cli/validate.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/validate.ts)
- [src/storage/loader.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/loader.ts)
- [src/engine/dependency.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/dependency.ts)
- [src/engine/mastery.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/mastery.ts)
- [test/cli-json-output.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/cli-json-output.test.ts)
- [test/cli-commands.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/cli-commands.test.ts)

</details>

Reporting commands provide deep visibility into the educational health of your Obsidian vault. They scan topic frontmatter to calculate global mastery metrics, report difficulty distributions, track spaced repetition statistics, and detect structural integrity violations across the prerequisite graph.

---

## 1. Dashboard Command (`palee dashboard`)

The `palee dashboard` command provides a high-level executive summary of your vault's learning state. It aggregates overall topic mastery percentages, tallies review queues, breaks down progress by difficulty tiers, and surfaces the single most urgent upcoming review.

### Syntax & Options

```bash
palee dashboard [flags]
```

| Flag | Type | Default | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `--json` | `boolean` | `false` | Output dashboard metrics as structured JSON (auto-activated in non-TTY environments). | `palee dashboard --json` |

---

### Data Aggregation & Metric Calculations

`dashboardCommand` scans all topic files in the vault and classifies notes using the 4-pillar mastery threshold ($M = 0.70$) [src/cli/dashboard.ts#88-114](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/dashboard.ts#L88-L114):

- **Mastered**: Topics with `topic_mastery >= 0.70`.
- **Learning**: Topics actively in progress (`0.0 < topic_mastery < 0.70`).
- **New**: Unreviewed topics with `topic_mastery === 0.0`.
- **Reviews Due**: Topics where `due_at` is in the past or equal to the current system time.
- **Difficulty Tiers**: Aggregated counts and mastered subtotals across `beginner`, `intermediate`, and `advanced` tiers.

```mermaid
flowchart TD
    ScanVault["Scan Vault Notes (loadTopics)"] --> FilterTopics["Extract Topics with palee_id"]
    FilterTopics --> MetricCalc["Calculate Aggregate Metrics"]
    
    MetricCalc --> Mastered["Mastered: topic_mastery &gt;= 0.70"]
    MetricCalc --> Learning["Learning: 0.0 &lt; topic_mastery &lt; 0.70"]
    MetricCalc --> New["New: topic_mastery == 0.0"]
    MetricCalc --> Due["Reviews Due: due_at &lt;= now"]
    MetricCalc --> DiffBreak["Difficulty Breakdown: Beginner / Inter / Adv"]
    
    Mastered & Learning & New & Due & DiffBreak --> FormatCheck{"isJsonOutput() ?"}
    FormatCheck -->|"TTY (Console)"| RenderTable["Render Styled ASCII Boxed Dashboard"]
    FormatCheck -->|"Non-TTY / --json"| RenderJSON["Emit Structured JSON to stdout"]
```

### Example Human-Readable Output

```bash
$ palee dashboard
╔════════════════════════════════════════════════════════════╗
║              PALEE Learning Dashboard                     ║
╚════════════════════════════════════════════════════════════╝

Total Topics:      15
Mastered (≥70%):   6 (40.0%)
Learning:          7 (46.7%)
New:               2 (13.3%)
Due for Review:    3

By Difficulty:
  beginner       : 5 topics (4 mastered)
  intermediate   : 7 topics (2 mastered)
  advanced       : 3 topics (0 mastered)

Next Review:
  Memory Ownership (T-20260814T120100-efgh)
  Mastery: 45.0% | Reps: 2

─────────────────────────────────────────────────────────────
Run "palee next" to start reviewing
Run "palee plan" to see today's learning plan
```

---

## 2. Progress Command (`palee progress`)

The `palee progress` command offers granular analytics into learning retention, historical repetitions, lapse counts, and topic-specific mastery scores.

### Syntax & Options

```bash
palee progress [flags]
```

| Flag | Type | Default | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `--topic <id>` | `string` | `undefined` | Inspect a specific topic by ID (e.g. `T-20260814T120000-abcd`) or unique title substring. | `palee progress --topic "Recursion"` |
| `--json` | `boolean` | `false` | Output progress metrics as structured JSON (auto-activated in non-TTY environments). | `palee progress --json` |

---

### Vault-Wide vs Topic-Specific Modes

#### 1. Vault-Wide Mode (Default)
Aggregates all active topics across the vault [src/cli/progress.ts#140-233](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/progress.ts#L140-L233):
- **Archived Topic Exclusion**: Notes with `status: archived` in frontmatter are tracked separately and excluded from `global_mastery` and `active_topic_count`.
- **Global Average Mastery**: Calculates the true mathematical mean of mastery across all active topics:

  ```text
  global_mastery = sum(active_topics.mastery) / active_topic_count
  ```

- **Mastery Status**: Classifies vault overall state as `'no_data'` (`active_count === 0`), `'learning'` (`< 0.70`), or `'mastered'` (`>= 0.70`).
- **Total Repetitions & Lapses**: Aggregates lifetime review repetitions and memory lapses across all active topics.

#### 2. Topic-Specific Mode (`--topic <id>`)
Surfaces comprehensive SRS metadata for an individual topic note:
- `topic_mastery` percentage
- `difficulty` tier
- `repetition` count and `lapses` count
- `assessed_at` and `last_reviewed_at` timestamps

### Example Outputs

#### Vault-Wide Human-Readable Summary
```bash
$ palee progress
=== Learning Progress ===

Active Topics: 14 (1 archived)
  Mastered (≥70%): 6 (42.9%)
  Learning: 6 (42.9%)
  New: 2 (14.3%)

Average Mastery: 54.3% (learning)
Total Reviews: 28
Total Lapses: 3

By Difficulty:
  beginner: 5 topics, avg mastery 78.0%
  intermediate: 6 topics, avg mastery 48.3%
  advanced: 3 topics, avg mastery 26.7%
```

#### Topic Lookup
```bash
$ palee progress --topic "Recursion"
Progress for: Recursion and Backtracking
ID: T-20260814T120000-abcd
Path: DSA/Recursion.md

Mastery: 80.0%
Difficulty: advanced
Repetitions: 5
Lapses: 0
Last Assessed: 2026-08-25
Last Reviewed: 2026-08-25
```

---

## 3. Validate Command (`palee validate`)

The `palee validate` command performs static analysis on the entire Obsidian vault to verify data model integrity and prerequisite graph acyclicity.

### Syntax & Options

```bash
palee validate [flags]
```

| Flag | Type | Default | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `--fix` | `boolean` | `false` | Attempt automated repairs for detected validation errors (Phase 1 diagnostic flag). | `palee validate --fix` |
| `--json` | `boolean` | `false` | Output validation diagnostics as structured JSON (auto-activated in non-TTY environments). | `palee validate --json` |
| `--strict` | `boolean` | `false` | Escalate warnings to a non-zero exit code: a warnings-only vault exits `3` like an errors vault (default: warnings never gate the exit code). | `palee validate --strict` |

---

### Vault Structural Integrity Rules

`palee validate` runs a thirteen-rule validation framework (rules live under [src/validation/rules/](https://github.com/Kuldeep2822k/cli/blob/main/src/validation/rules/), registered in `src/cli/validate.ts`, exported through the [src/validation/](https://github.com/Kuldeep2822k/cli/blob/main/src/validation/index.ts) barrel): nine error-default rules (the graph integrity ports minus missing-dependency, the schema/identity rules, and the assessment and review-state rules) and four warning-default rules — the two snapshot rules that explain gaps in the collected topic set, the mastery-drift rule that keeps stored derived data honest, and missing-dependency findings (the engine quarantines the dependent topic instead of failing the scan; `roadmap --from` pre-validation keeps its own separate error path). `valid-dependency-list` is error-default but emits its duplicate-entry findings as warnings. Errors exit 3; warnings exit 0 unless `--strict` escalates them to 3.

1. **Malformed Frontmatter (`parse-frontmatter`, warning)**: A note whose YAML frontmatter cannot be parsed (including unclosed `---` fences whose body reads like YAML). The scan always continues — one bad note is a finding, never a dead validation.
2. **Read Failures (`read-failure`, warning)**: A file that could not be read at all (locked or deleted mid-scan). Validation ran on an incomplete snapshot; the warning appears alongside any graph findings so transient conditions are visible without downgrading them.
3. **Schema Version (`valid-palee-schema`, error)**: Every PALEE-managed note must declare `palee_schema: 1`; missing, non-integer, and unsupported versions are errors so mutations can refuse to guess at unknown data. Non-managed user notes are never reported.
4. **Topic ID Format (`valid-topic-id-format`, error)**: Topic IDs must match the centralized policy in `src/engine/topic-id.ts` — `T-` plus lowercase kebab-case segments; the exact legacy adopt-generated format stays valid.
5. **Topic Status (`valid-topic-status`, error)**: Status must be one of `not_started` | `learning` | `paused` | `archived`; missing status is tolerated as the adopt default.
6. **Duplicate Topic IDs (`no-duplicate-topic-id`, error)**: Multiple Markdown notes sharing the same `palee_id` in their frontmatter.
7. **Dependency List Shape (`valid-dependency-list`, error)**: `depends_on` must be an array of non-empty topic-ID strings — a bare string, a non-string item (numbers, booleans, nulls), or an empty-string slot is a shape error, and a self-reference (`T-a` depending on `T-a`) is a structural error. Duplicate entries are a separate warning: the loader dedupes them, so scheduling is unaffected. Missing or null `depends_on` is the documented empty-list default and never reports. The rule runs before the graph rules and reads raw frontmatter (pre-normalization) so defects the loader's coercion would hide are exposed.
8. **Missing Dependencies (`no-missing-dependency`, warning)**: A topic referencing a prerequisite ID in `depends_on` that does not exist anywhere in the vault. A warning in vault scans (the engine quarantines the dependent topic from `plan`/`next` instead of failing the scan — incrementally-written vaults are the norm, and a note mid-flight must not fail a whole validation run); `roadmap --from` pre-validation keeps its own separate hard-error path, so an import-time dangling reference still blocks the import. Findings never depend on unrelated vault state; if a dependency target was itself unreadable, the `read-failure` warning appears alongside explaining the transient condition, and re-running settles it. `--strict` escalates the warning for CI use.
9. **Dependency Cycles (`no-dependency-cycle`, error)**: Circular dependency chains (e.g. $A \to B \to C \to A$) detected by the dependency engine [src/engine/dependency.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/dependency.ts) (iterative Tarjan SCC analysis with a lexicographic-first cycle search; the rule reports the exact path).
10. **Assessment Fields (`valid-assessment-fields`, error)**: Assessment scores (`conceptual`, `practical`, `debug`, `feynman`) must be finite numbers within `[0.0, 1.0]` as stored on disk, and `assessed_at` must be `null` or a real calendar date — date-only strings (`YYYY-MM-DD`) and ISO timestamps (`2026-02-30T12:00:00Z`) alike are rejected when their written calendar rolls over (`2026-02-30` is not normalized into March). The rule reads raw frontmatter values — the loader clamps and coerces during normalization, so this rule exposes real vault corruption instead of silently blessing it. Missing assessment fields follow the documented default policy (they are the newly-adopted state) and pass.
11. **Topic Mastery Drift (`valid-topic-mastery`, warning)**: When a topic's assessment fields are shape-valid, stored `topic_mastery` must equal the engine formula `round((conceptual + practical + debug + 2*feynman) / 5, 4)` — recomputed with `computeTopicMastery` from [src/engine/mastery.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/mastery.ts). Drift reports a warning with `details.actual` (stored) and `details.expected` (computed); a present-but-malformed stored value (non-numeric, non-finite) is itself a mismatch — the loader would coerce it to 0 at runtime, so the rule reads the raw value to expose that. Topics whose assessment fields fail rule 10 are skipped (no double-reporting), topics with all four pillars absent are the newly-adopted default state and never report, missing assessment data never crashes the rule, and archived topics are still checked — internal consistency matters for any stored topic. A warning only, so `--strict` gates it.
12. **Review Fields (`valid-review-fields`, error)**: SM-2 review state must match the engine contract as stored on disk: `ease_factor` a finite number `>= 1.3` (the SM-2 floor), `interval_days` an integer `>= 1`, `repetition`/`lapses` integers `>= 0`, and `last_quality` `null` or an integer `0-5`. The rule reads raw frontmatter (the loader's `parseNumber`/`parseInteger` coercion would silently accept stringified or fractional values), so values no PALEE writer could produce — stringified numbers, `null` numeric state, fractional counters — are exposed as errors. Missing keys are the adopt-default state and pass.
13. **Review Dates (`valid-review-dates`, error)**: `last_reviewed_at` and `due_at` must be `null` (newly adopted) or strict zero-padded date-only `YYYY-MM-DD` strings naming real calendar dates — the exact shape `formatLocalDateOnly` persists. Full ISO timestamps fail (date-only is the product contract: review scheduling compares local calendar days), impossible calendars fail (`2026-02-31` is not normalized into March), and when both fields are valid, `due_at` earlier than `last_reviewed_at` reports the inversion. Validation is pure component analysis shared with the `assessed_at` policy — no timezone-dependent parsing.

```mermaid
flowchart LR
    subgraph Storage ["Vault Storage (.md Files)"]
        FM1["Note 1 Frontmatter"]
        FM2["Note 2 Frontmatter"]
    end
    
    subgraph Analyzer ["Validation Framework (src/validation/)"]
        Scan["collectVault() — single-read snapshot"]
        Runner["runRules() — every rule runs, in registration order"]
        Rules["parse-frontmatter → read-failure → valid-palee-schema → valid-topic-id-format → valid-topic-status → no-duplicate-topic-id → valid-dependency-list → no-missing-dependency → no-dependency-cycle → valid-assessment-fields → valid-topic-mastery → valid-review-fields → valid-review-dates"]
    end
    
    subgraph Errors ["Errors (Exit 3)"]
        ErrDup["duplicate_id"]
        ErrDepShape["depends_on shape invalid / self-reference"]
        ErrCyc["cycle"]
        ErrSchema["invalid palee_schema"]
        ErrId["bad topic ID format"]
        ErrStatus["bad status"]
        ErrAssess["bad assessment fields / assessed_at"]
        ErrReview["SM-2 review state or dates invalid"]
    end

    subgraph Warnings ["Warnings (Exit 0 by default; Exit 3 with --strict)"]
        WarnParse["malformed frontmatter"]
        WarnRead["unreadable file (snapshot incomplete)"]
        WarnMastery["topic_mastery drift"]
        WarnMiss["missing dependency (quarantined, not fatal)"]
        WarnDepDup["duplicate depends_on entry"]
    end
    
    Storage --> Scan
    Scan --> Runner
    Runner --> Rules
    Rules -->|"duplicate IDs"| ErrDup
    Rules -->|"dangling prerequisite"| WarnMiss
    Rules -->|"depends_on shape invalid / self-reference"| ErrDepShape
    Rules -->|"cycle detected"| ErrCyc
    Rules -->|"unknown schema version"| ErrSchema
    Rules -->|"malformed topic ID"| ErrId
    Rules -->|"unknown status"| ErrStatus
    Rules -->|"score/date shape invalid"| ErrAssess
    Rules -->|"SM-2 bounds / date contract violated"| ErrReview
    Rules -->|"duplicate dependency entry"| WarnDepDup
    Rules -->|"malformed YAML"| WarnParse
    Rules -->|"read failed"| WarnRead
    Rules -->|"stale derived data"| WarnMastery
    Rules -->|"no errors"| Success["✓ 0 Errors Found (Exit 0)"]
```

### Example Human-Readable Output (Failures Detected)

```bash
$ palee validate
Validating vault: /Users/dev/ObsidianVault

Found 18 PALEE topics in 24 files

✗ Found 1 validation error(s):

  • Dependency cycle detected: T-topic-a -> T-topic-b -> T-topic-a
    Rule: no-dependency-cycle

⚠ Found 1 validation warning(s):

  • Topic T-cloud-native depends on missing topic T-docker-missing
    Rule: no-missing-dependency
```

---

### Assessment-Review Independence (enforced by regression tests, #40)

Assessment fields (`conceptual`, `practical`, `debug`, `feynman`, `assessed_at`, `topic_mastery`) and SM-2 review fields (`last_quality`, `last_reviewed_at`, `due_at`, `ease_factor`, `interval_days`, `repetition`, `lapses`) are independent state. Per the #40 design, independence is **not** a static vault rule — command-level mutation tests are the enforcement mechanism, because independence is about what commands write, not what the vault looks like. `test/e2e/assessment-review-independence.test.ts` pins the contract in both directions: `palee review` updates only SM-2 fields and preserves assessment data (including non-zero `topic_mastery`) byte-for-byte; `palee roadmap` import — the curriculum write path — preserves all seven SM-2 review fields byte-for-byte on reviewed topics, so an assessment-path mutation never clobbers review state unless an explicit confirmed review mutation is added.

---

## 4. Machine-Readable Output & Non-TTY Detection

All reporting commands support the PALEE automated JSON streaming contract (`isJsonOutput()`):

```bash
# Direct JSON piping to jq for CI/CD checks
$ palee validate | jq .valid
true

# Extract total reviews due from dashboard
$ palee dashboard | jq .reviews_due
3
```

### Structured Error Handling

When an error occurs (such as an unconfigured vault or a missing topic query in `--topic`), PALEE emits a structured error JSON object on `stderr` and exits with code `2`:

```json
{"error": "Topic not found: NonExistentTopic"}
```

---

## 5. Exit Codes for Reporting Commands

| Command | Exit Code 0 | Exit Code 1 | Exit Code 2 | Exit Code 3 | Exit Code 4 | Exit Code 5 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `palee dashboard` | Successfully displayed dashboard metrics or empty vault onboarding. | N/A | Vault path not configured or directory does not exist. | N/A | N/A | Unexpected runtime exception or calculation failure. |
| `palee progress` | Successfully displayed vault progress summary, topic detail (`--topic`), or empty vault state. | N/A | Vault path unconfigured, or topic query not found for `--topic`. | N/A | N/A | Unexpected runtime exception or file read failure. |
| `palee validate` | Vault validation passed with 0 structural errors. | N/A | Vault path not configured or invalid directory. | Any validation error (malformed schema, topic ID, status, duplicate `palee_id`, missing dependency, cycle, or assessment-field shape); warnings also exit 3 under `--strict`. | N/A | Unexpected runtime exception or directory walk failure. |