# Reporting Commands

Relevant source files:

- [src/cli/dashboard.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/dashboard.ts)
- [src/cli/progress.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/progress.ts)
- [src/cli/validate.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/validate.ts)
- [src/storage/loader.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/loader.ts)
- [src/engine/dependency.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/dependency.ts)
- [src/engine/mastery.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/mastery.ts)
- [test/cli-json-output.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/cli-json-output.test.ts)
- [test/cli-commands.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/cli-commands.test.ts)

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
  $$\text{Global Mastery} = \frac{1}{N_{\text{active}}} \sum_{i=1}^{N_{\text{active}}} \text{mastery}_i$$
- **Mastery Status**: Classifies vault overall state as `'no_data'` ($N = 0$), `'learning'` ($< 0.70$), or `'mastered'` ($\ge 0.70$).
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

---

### Vault Structural Integrity Rules

`validateCommand` constructs an in-memory graph of all topics and checks for three critical integrity errors [src/cli/validate.ts#35-109](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/validate.ts#L35-L109):

1. **Duplicate Topic IDs (`duplicate_id`)**: Multiple Markdown notes sharing the same `palee_id` in their frontmatter.
2. **Missing Dependencies (`missing_dependency`)**: A topic referencing a prerequisite ID in `depends_on` that does not exist anywhere in the vault.
3. **Dependency Cycles (`cycle`)**: Circular dependency chains (e.g. $A \to B \to C \to A$) detected using 3-color DFS graph traversal in the dependency engine [src/engine/dependency.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/dependency.ts).

```mermaid
flowchart LR
    subgraph Storage ["Vault Storage (.md Files)"]
        FM1["Note 1 Frontmatter"]
        FM2["Note 2 Frontmatter"]
    end
    
    subgraph Analyzer ["Validation Engine (validateCommand)"]
        DupCheck{"Duplicate palee_id ?"}
        MapBuild["Build TopicNode Map"]
        GraphCheck{"validateDependencyGraph()"}
    end
    
    subgraph Errors ["Diagnostic Errors (Exit 3)"]
        ErrDup["duplicate_id: [fileA, fileB]"]
        ErrMiss["missing_dependency: topic -> target"]
        ErrCyc["cycle: [A -> B -> C -> A]"]
    end
    
    Storage --> DupCheck
    DupCheck -->|"Duplicate Found"| ErrDup
    DupCheck -->|"Unique IDs"| MapBuild
    MapBuild --> GraphCheck
    GraphCheck -->|"Missing Prerequisite"| ErrMiss
    GraphCheck -->|"Cycle Detected"| ErrCyc
    GraphCheck -->|"All Passed"| Success["✓ 0 Errors Found (Exit 0)"]
```

### Example Human-Readable Output (Failures Detected)

```bash
$ palee validate
Validating vault: /Users/dev/ObsidianVault

Found 18 PALEE topics in 24 files

✗ Found 2 validation error(s):

  • Missing dependency: T-cloud-native depends on T-docker-missing

  • Dependency cycle: T-topic-a → T-topic-b → T-topic-a
```

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
| `palee validate` | Vault validation passed with 0 structural errors. | N/A | Vault path not configured or invalid directory. | Validation errors found (duplicate `palee_id`, missing dependency, or cycle). | N/A | Unexpected runtime exception or directory walk failure. |