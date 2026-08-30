# ADR-0006: Phase 1 Concurrency Resilience, Storage Layer Isolation & Session Duration Tracking

## Status
Accepted

## Context
As PALEE CLI evolves into a daily driver for intense study workflows, real-world usage patterns introduced several concurrency and data integrity challenges:

1. **Storage Leaks in CLI Handlers (#86, #90)**: Direct invocations of `fs.unlinkSync` and `fs.mkdirSync` inside command handlers (`src/cli/session.ts`, `src/cli/roadmap.ts`) bypassed storage boundary checks, creating path traversal risks and potential uncaught exceptions.
2. **Review TOCTOU Race Windows (#87)**: Spaced repetition reviews calculate new SM-2 intervals based on in-memory topic frontmatter read when the command starts. If an external editor or synchronization daemon modified the target topic file while the user was recalling the answer, writing back the result risked overwriting those changes without conflict detection.
3. **Session Timing Inaccuracies (#88)**: Learning sessions recorded placeholder or unverified elapsed times rather than tracking true study durations calculated between actual start timestamps and session completion.
4. **All-or-Nothing Roadmap Ingestion (#89)**: Ingesting multi-topic roadmaps failed entirely if a single topic note contained corrupt frontmatter or suffered an I/O glitch, preventing valid topics in the same batch from importing.
5. **Non-Deterministic Cache Leaks & UI Inconsistencies (#90, #91)**: The `FileCache` contained `NODE_ENV !== 'test'` bypasses that caused divergence between test runs and production behavior. Mastery outputs varied between floating-point decimals (`0.45`) and formatted percentages.

## Decision

We implemented a comprehensive Phase 1 concurrency resilience and storage isolation architecture:

### 1. Storage Boundary Isolation & Public Facade (`src/storage/index.ts`)
- Re-exported all persistence functions and types through `src/storage/index.ts`.
- Replaced all raw filesystem calls in CLI commands with dedicated storage boundary helpers:
  - `ensureVaultDirectory(vaultPath, targetPath)`: Validates vault path boundaries and prevents symlink escape attacks before creating directories.
  - `resetHotMemory(vaultPath)`: Safely resets `.palee/hot.md` during reinitialization.
  - `deleteTopicDrafts(vaultPath, topicId)` & `deleteSessionNote(vaultPath, targetPath)`: Encapsulates note unlinks with directory boundary validation preventing file deletions outside `.palee/sessions/`.
  - `getTopicDrafts(vaultPath, topicId)`: Discovers topic-associated active draft checkpoints.

### 2. Elimination of Review TOCTOU Race Windows (`src/cli/review.ts`)
- In `reviewCommand`, re-read the topic note from disk immediately prior to invoking `atomicWrite()`.
- Compute a fresh SHA-256 content fingerprint (`computeFingerprint(freshContent)`) and verify that `freshFingerprint === initialFingerprint`.
- If modified concurrently during the recall prompt, immediately trigger Optimistic Concurrency Control (OCC) conflict handling, cleanly setting `process.exitCode = 4`.

### 3. Resilient Multi-Topic Roadmap Batch Processing (`src/cli/roadmap.ts`)
- Enclosed per-topic note reading, parsing, and atomic writes inside a per-topic `try/catch` loop within `doImport()`.
- Corrupt notes or file errors increment `failed++` and emit clear diagnostic errors while allowing valid topics in the batch to continue importing.
- Established deterministic exit code semantics:
  - `0`: All topics imported successfully (`failed === 0`).
  - `1`: Partial batch failure (`failed > 0`).
  - `4`: OCC conflict during atomic write.
- Refactored helper function declaration order above call sites for linear control flow.

### 4. True Session Duration & 3-Tier Timestamp Recovery (`src/cli/session.ts`, `src/storage/memory.ts`)
- Persist `started_at` in `.palee/hot.md` frontmatter and draft checkpoint files (`.palee/sessions/DRAFT-S-*.md`).
- In `palee session end`, recover initial `started_at` via a 3-tier algorithm:
  1. **Tier 1**: Earliest `started_at` from matching draft checkpoints for the topic.
  2. **Tier 2**: `started_at` from `.palee/hot.md` if `active_topic` matches.
  3. **Tier 3**: Current instant `ended_at` as fallback.
- Calculate actual elapsed study time:
  $$\text{duration\_minutes} = \left\lfloor \frac{\max(0, t_{\text{ended\_at}} - t_{\text{started\_at}})}{60000} + 0.5 \right\rfloor$$
- Persist `started_at`, `ended_at`, and `duration_minutes` into final session notes.

### 5. Deterministic Cache Invalidation & UI Hygiene (`src/storage/cache.ts`, `src/cli/*.ts`)
- Removed `NODE_ENV !== 'test'` bypasses from `FileCache`, guaranteeing deterministic cache invalidation and 2,000 ms unsettled horizon checks across all environments.
- Standardized mastery display across all CLI commands (`next`, `plan`, `progress`, `dashboard`, `review`) to percentage format with 1 decimal place (`XX.X%`).
- Aligned dashboard ASCII boxes to 62-character width.

## Consequences

### Positive
- **Fault-Tolerant Batch Operations**: Vault curriculum imports do not fail completely due to an isolated corrupted note.
- **Zero Race Window on Active Recall**: External edits made during SM-2 reviews are protected from overwrite collisions with exit code `4`.
- **Accurate Study Analytics**: Session notes record real elapsed study duration rather than placeholder timestamps.
- **Strict Storage Layer Encapsulation**: CLI handlers are insulated from raw filesystem mutations and path traversal vulnerabilities.
- **Deterministic Testability**: Cache behavior in unit and integration test suites matches production runtime identically.

### Negative / Tradeoffs
- Re-reading topic notes immediately prior to review writes adds a minimal microsecond disk I/O step before atomic commit.

## Alternatives Considered

1. **Global Process Mutex for Reviews**:
   - *Why Rejected*: Serializes unrelated vault operations and fails to protect against edits made by external tools (Obsidian, sync daemons) that do not share the Node.js mutex.
2. **Direct CLI `fs.unlinkSync` Calls**:
   - *Why Rejected*: Bypasses path boundary validation and leaks raw filesystem error handling into user-facing CLI code.
