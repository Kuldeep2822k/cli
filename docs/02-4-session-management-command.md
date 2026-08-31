# Session Management Command

<details>
<summary><b>Relevant Source Files</b></summary>

- [src/cli/session.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/session.ts)
- [src/storage/memory.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/memory.ts)
- [src/storage/frontmatter.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/frontmatter.ts)
- [src/storage/vault-walker.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/vault-walker.ts)
- [src/types.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/types.ts)
- [test/session-cli.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/session-cli.test.ts)
- [test/cli-commands.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/cli-commands.test.ts)
- [test/cli-json-output.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/cli-json-output.test.ts)

</details>

The `palee session` command suite manages the real-time learning lifecycle, active focus tracking, and persistence of study session records. It maintains a short-term "working memory" file (`.palee/hot.md`), a chronological session index (`.palee/index.md`), and durable session notes in `.palee/sessions/`.

---

## 1. Session Lifecycle & Architecture

A session represents an active period of study focused on a single PALEE topic. The lifecycle encompasses topic resolution, working memory synchronization, interim draft checkpoints, and final session confirmation.

### Topic Resolution Hierarchy

When running commands that require an active study target (`draft`, `end`), PALEE resolves the target topic using a strict three-tier hierarchy via `resolveSessionTopic()` [src/cli/session.ts#24-54](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/session.ts#L24-L54):

1. **CLI Flag Override**: Explicitly specified via `--topic <id>` (e.g. `--topic "T-rust-ownership"`).
2. **Working Memory Inspection**: Extracted from the `active_topic` frontmatter property of `.palee/hot.md`.
3. **Missing Topic Error**: If neither is present or the value is `(none)`, the command terminates with exit code `2`.

---

### Working Memory (`hot.md`), Index (`index.md`) & True Duration Tracking

- **`.palee/hot.md` (Working Memory)**: Automatically generated and refreshed by `rebuildHotAndIndex()` [src/storage/memory.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/memory.ts). Contains metadata on the current active topic (`active_topic`), session start timestamp (`started_at`), timestamp of last update (`updated_at`), and a truncated 250-word working memory excerpt of the note body for quick context recovery.
- **`.palee/index.md` (Session Index)**: Chronological index of completed learning sessions, cross-referenced with topic IDs and formatted as Obsidian-style links.
- **True Session Duration Persistence**: When a session starts or checkpoints, its precise ISO-8601 start timestamp (`started_at`) is written to `.palee/hot.md` and interim draft checkpoints. Upon session completion, PALEE computes the exact elapsed study time in minutes and persists `started_at`, `ended_at`, and `duration_minutes` to the permanent session note.

---

### Draft Recovery Protocol

If an unexpected interruption occurs (such as terminal closure or system reboot), PALEE leaves an unconfirmed draft note (`DRAFT-S-<hex>.md`) in `.palee/sessions/` preserving the original `started_at` timestamp.

When `palee session start` is executed:
- **Non-Interactive Mode**: Alerts the user that unconfirmed drafts exist and suggests running `palee session start --interactive` (exiting with code `2` or emitting `status: 'drafts_pending'` in JSON mode).
- **Interactive Mode (`-i, --interactive`)**: Prompts the user with four recovery options for each orphaned draft [src/cli/session.ts#96-112](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/session.ts#L96-L112):
  - `[R]esume`: Continues the previous session, retaining the draft.
  - `[S]ave`: Immediately finalizes and converts the draft into a confirmed session note (`S-*.md`), calculating true elapsed duration from its `started_at` timestamp, and unlinks the draft.
  - `[D]iscard`: Safely unlinks the orphaned draft checkpoint via `deleteSessionNote()`.
  - `[I]gnore`: Leaves the draft file untouched on disk.

```mermaid
flowchart TD
    StartCmd["palee session start [-i]"] --> ScanDrafts["Scan .palee/sessions/ for DRAFT-S-*.md"]
    
    ScanDrafts --> HasDrafts{"Unconfirmed Drafts Found?"}
    HasDrafts -->|"No"| SyncHot["Verify & Sync Working Memory (.palee/hot.md)"]
    
    HasDrafts -->|"Yes"| InterCheck{"Interactive Mode (-i)?"}
    InterCheck -->|"No"| WarnDraft["Print Draft Warning & Exit Code 2 / JSON drafts_pending"]
    InterCheck -->|"Yes"| PromptRecovery["Prompt User: [R]esume / [S]ave / [D]iscard / [I]gnore"]
    
    PromptRecovery --> ExecuteAction["recoverDraft() (Storage Isolation)"]
    ExecuteAction --> SyncHot
    WarnDraft --> Stop(("⛔ Exit"))
    
    SyncHot --> SetStart["Record started_at in hot.md"]
    SetStart --> PrintHot["Display Active Topic & Working Memory Excerpt"]
```

---

## 2. Command Subactions

The `palee session` command accepts four distinct action arguments:

### 1. `palee session start`
Initializes the study environment:
- Scans `.palee/sessions/` for unconfirmed draft checkpoints.
- Rebuilds `hot.md` if missing or corrupted using `resetHotMemory()` and `rebuildHotAndIndex()`.
- Records the current timestamp as `started_at` in `.palee/hot.md` for the resolved topic.
- Prints the active topic ID, last session timestamp, and the working memory body excerpt from `hot.md`.

```bash
# Start study session in interactive recovery mode
palee session start --interactive

# Query session start status as structured JSON (emits drafts_pending on unconfirmed checkpoints)
palee session start --json
```

### 2. `palee session draft`
Captures an interim checkpoint during an ongoing study session without closing the session:
- Resolves the study topic (`--topic` or active topic from `hot.md`).
- Inherits the `started_at` timestamp from active hot memory if available, or records current timestamp.
- Generates a unique draft identifier (`DRAFT-S-<random_hex>`).
- Persists a draft markdown file in `.palee/sessions/` containing `topic_id`, `started_at`, and `status: 'draft'`.

```bash
# Capture a checkpoint for the active topic
palee session draft

# Capture a checkpoint for an explicit topic
palee session draft --topic "T-20260814T120000-abcd"
```

### 3. `palee session end`
Concludes the study period, calculates actual elapsed time, and formalizes the session:
- Resolves the target topic ID (via `--topic` or `hot.md`).
- **3-Tier Start Timestamp Recovery Algorithm**:
  - **Tier 1 (Topic Draft Checkpoints)**: Queries `getTopicDrafts(vaultPath, topicId)` for active drafts matching the topic, sorting chronologically to recover the earliest `started_at`.
  - **Tier 2 (Active Working Memory)**: Reads `started_at` from `.palee/hot.md` if `active_topic` matches the session topic.
  - **Tier 3 (Current Instant Fallback)**: Falls back to the current instant `ended_at` if no prior timestamp exists.
- **Duration Calculation**:
  ```typescript
  const endedAt = new Date().toISOString();
  const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
  const durationMinutes = Math.round(durationMs / 60000);
  ```
- Generates a confirmed session ID (`S-YYYYMMDDTHHMMSS-<hex>.md`) and writes the permanent session note via `writeSessionNote()` containing `started_at`, `ended_at`, `duration_minutes`, and `status: 'completed'`.
- Deletes matching draft checkpoints via storage helper `deleteTopicDrafts(vaultPath, topicId)`.
- Executes `rebuildHotAndIndex()` to refresh `hot.md` and `index.md`.

```bash
# Finalize the current study session
palee session end --topic "T-20260814T120000-abcd"
```

### 4. `palee session list`
Displays session history and pending drafts:
- Lists the most recent 10 confirmed sessions in chronological order.
- Lists all active draft checkpoints awaiting resolution.
- Supports `--json` for machine-readable integrations.

```bash
# List sessions in terminal
palee session list

# Output structured session JSON
palee session list --json
```

---

## 3. Options Reference for `palee session`

The following table lists all supported arguments and options for `palee session` [src/types.ts#464-474](https://github.com/Kuldeep2822k/cli/blob/main/src/types.ts#L464-L474):

| Parameter / Flag | Type | Default | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `<action>` | `string` | **Required** | Session action to perform: `start`, `draft`, `end`, or `list`. | `palee session start` |
| `-i, --interactive` | `boolean` | `false` | Enable interactive prompt mode for draft recovery during `palee session start`. | `palee session start -i` |
| `--topic <id>` | `string` | `undefined` | Target topic ID. Overrides the `active_topic` defined in `.palee/hot.md`. | `palee session end --topic "T-01"` |
| `--json` | `boolean` | `false` | Output results as structured JSON (supported for `palee session start` and `palee session list`). | `palee session start --json` |

---

## 4. Physical Storage Layout & Boundary Isolation

All session metadata is isolated within the `.palee/` directory at the vault root. CLI command handlers interact with this storage strictly via dedicated storage helpers (`src/storage/index.ts`), with **zero direct `fs.unlinkSync` or `fs.mkdirSync` calls** in CLI handlers:

```text
<vaultPath>/
├── .palee/
│   ├── hot.md                     # Active working memory, topic context & started_at
│   ├── index.md                   # Chronological session index
│   └── sessions/
│       ├── S-20260814T120000-abcd.md       # Confirmed session record (with duration_minutes)
│       ├── S-20260814T153000-efgh.md       # Confirmed session record (with duration_minutes)
│       └── DRAFT-S-98765432.md             # Unconfirmed draft checkpoint (with started_at)
└── Topics/
    └── Topic-Note.md
```

### File Naming & Schema Specifications

| File Type | Path Pattern | Frontmatter Key Fields |
| :--- | :--- | :--- |
| **Working Memory** | `.palee/hot.md` | `palee_schema: 1`, `memory_id: "H-active"`, `active_topic: string \| null`, `started_at: string \| null`, `last_session: string \| null`, `updated_at: string` |
| **Confirmed Session** | `.palee/sessions/S-<TIMESTAMP>-<HEX>.md` | `palee_schema: 1`, `session_id: string`, `topic_id: string`, `started_at: string`, `ended_at: string`, `duration_minutes: number`, `status: "completed"` |
| **Draft Checkpoint** | `.palee/sessions/DRAFT-S-<HEX>.md` | `palee_schema: 1`, `session_id: string`, `topic_id: string`, `started_at: string`, `ended_at: null`, `status: "draft"` |

---

## 5. Exit Codes for Session Management

| Command | Exit Code 0 | Exit Code 1 | Exit Code 2 | Exit Code 3 | Exit Code 4 | Exit Code 5 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `palee session` | Session action (`start`, `draft`, `end`, `list`) completed successfully. | N/A | Vault path not configured, missing `--topic` for `draft`/`end` when no active topic exists, unconfirmed drafts blocking non-interactive `session start`, or unknown action specified. | N/A | OCC conflict during session note write or `hot.md` update (`isConflictError`). | Unexpected runtime exception or storage boundary violation error. |