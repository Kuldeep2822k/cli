# Unit Tests
<details>
<summary><b>Relevant Source Files</b></summary>

- [src/cli/adopt.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/cli/adopt.ts)
- [src/engine/dependency.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/dependency.ts)
- [src/engine/index.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/index.ts)
- [src/engine/mastery.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/mastery.ts)
- [src/engine/sm2.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/engine/sm2.ts)
- [src/storage/atomic-write.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/atomic-write.ts)
- [src/storage/cache.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/cache.ts)
- [src/storage/frontmatter.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/frontmatter.ts)
- [src/storage/loader.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/loader.ts)
- [src/storage/lock.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/lock.ts)
- [src/storage/memory.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/memory.ts)
- [src/storage/pattern-matcher.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/pattern-matcher.ts)
- [src/storage/roadmap-parser.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/roadmap-parser.ts)
- [src/storage/walker.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/storage/walker.ts)
- [src/types.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/types.ts)
- [test/engine-dependency.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/engine-dependency.test.ts)
- [test/engine-mastery.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/engine-mastery.test.ts)
- [test/engine-sm2.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/engine-sm2.test.ts)
- [test/storage-atomic-write.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-atomic-write.test.ts)
- [test/storage-cache.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-cache.test.ts)
- [test/storage-frontmatter.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-frontmatter.test.ts)
- [test/storage-loader.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-loader.test.ts)
- [test/storage-lock.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-lock.test.ts)
- [test/storage-memory.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-memory.test.ts)
- [test/storage-pattern-matcher.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-pattern-matcher.test.ts)
- [test/storage-roadmap-parser.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-roadmap-parser.test.ts)
- [test/storage-walker.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/storage-walker.test.ts)
- [test/types-difficulty.test.ts](https://github.com/Kuldeep2822k/cli/blob/main/test/types-difficulty.test.ts)

</details>

The PALEE unit test suite ensures the mathematical correctness of core algorithms, defensive file-safety protocols in the storage layer, and strict domain model typing. Unit tests are executed directly from TypeScript source using `tsx` and the native Node.js test runner (`node:test`), ensuring high speed and complete test isolation.

---

## 1. Engine Core Tests

Engine tests verify spaced repetition scheduling, graph algorithms, and pedagogical mastery computation on pure in-memory data structures decoupled from the filesystem.

### SuperMemo SM-2 Spaced Repetition (`test/engine-sm2.test.ts`)

Tests in `test/engine-sm2.test.ts` (15 tests) verify the `processReview` function and scheduling arithmetic:

- **State Transitions**: Validates that quality ratings $q < 3$ trigger a lapse, resetting `repetition` to 0, `interval_days` to 1, and incrementing `lapses`.
- **Interval Progression**: Verifies the expanding interval progression (Repetition 1 $\rightarrow$ 1 day, Repetition 2 $\rightarrow$ 6 days, Repetition $n > 2 \rightarrow \text{round}(I_{n-1} \times EF)$).
- **Ease Factor Clamping**: Confirms that `ease_factor` is adjusted via $\Delta EF = 0.1 - (5 - q) \times (0.08 + (5 - q) \times 0.02)$, is strictly clamped to $\ge 1.30$, and is rounded to 4 decimal places.
- **Calendar Due Dates**: Validates `computeDueDate` calculation in the local timezone across month and year boundaries.

### Dependency Graph & Cycle Detection (`test/engine-dependency.test.ts`)

Tests in `test/engine-dependency.test.ts` (8 tests) exercise graph validation and traversal:

- **3-Color DFS Cycle Detection**: Verifies that `detectCycle` correctly flags simple circular dependencies ($A \rightarrow B \rightarrow A$) as well as complex multi-node cycles ($A \rightarrow B \rightarrow C \rightarrow A$).
- **Frontier Readiness Filtering**: Validates `getReadyTopics`, confirming that topics are only marked ready when all declared prerequisites reach or exceed `MASTERY_THRESHOLD` (0.70).
- **Missing Dependency Diagnostics**: Ensures `validateDependencyGraph` emits structured error descriptors containing missing topic IDs when unadopted notes are referenced in `depends_on`.
- **Alias Support**: Verifies seamless normalization between `depends_on` and `dependencies` frontmatter keys.

### Four-Pillar Pedagogical Mastery (`test/engine-mastery.test.ts`)

Tests in `test/engine-mastery.test.ts` (11 tests) verify the multi-dimensional mastery engine:

- **Formula Invariant**: Confirms `mastery = round((c + p + d + 2f) / 5, 4)` with 40% Feynman weighting.
- **Mastery Threshold**: Asserts that `MASTERY_THRESHOLD = 0.70` serves as the authoritative threshold for dependency satisfaction.
- **Score Normalization & Clamping**: Verifies that out-of-range scores (`< 0.0` or `> 1.0`), `NaN`, `null`, or undefined inputs are safely clamped within `[0.0, 1.0]`.
- **Archive Topic Exclusion**: Ensures archived topics (`archived: true`) are excluded from active readiness calculations.

---

## 2. Storage Layer & Safety Tests

Storage tests enforce PALEE's "File-Safety Contract," guaranteeing non-destructive updates, concurrency control, and crash tolerance across local vaults.

### File Locking & Mutex (`test/storage-lock.test.ts`)

Tests in `test/storage-lock.test.ts` (11 tests) verify the cross-process lock directory mutex:

- **Atomic Acquisition**: Confirms `mkdirSync` on `.palee/locks/<hash>.lockdir` provides mutual exclusion, throwing `ECONFLICT` on concurrent collision.
- **Descriptor & Heartbeat**: Validates that lock descriptors record PID, hostname, and timestamp, refreshed every 15 seconds via `utimesSync`.
- **Stale Lock Quarantine Takeover**: Simulates abandoned locks by artificially aging `mtime`, verifying automatic takeover after 60s on Windows or 120s on POSIX systems.
- **Symlink Canonicalization**: Ensures symbolic links resolve to their canonical physical paths prior to lock hash computation.

### Atomic Writes & OCC (`test/storage-atomic-write.test.ts`)

Tests in `test/storage-atomic-write.test.ts` (10 tests) verify safe filesystem writes:

- **Optimistic Concurrency Control (OCC)**: Verifies that passing a stale SHA-256 fingerprint triggers an `ECONFLICT` error, preventing lost updates from external editors.
- **Atomic Swap & Temp Cleanup**: Confirms writes flush to unique `.tmp.*` files and execute atomic `renameSync`. If write failure occurs, temporary files are cleanly unlinked.

### Frontmatter Preservation via CST (`test/storage-frontmatter.test.ts`)

Tests in `test/storage-frontmatter.test.ts` (11 tests) exercise the YAML Document API:

- **Comment & Custom Key Preservation**: Verifies that updating PALEE keys (`palee_id`, `topic_mastery`, `due_at`) preserves user-authored YAML comments, custom tags, and Obsidian properties.
- **Byte-for-Byte Body Integrity**: Asserts that the Markdown document body remains identical byte-for-byte after frontmatter modifications.
- **Fingerprinting**: Verifies SHA-256 content hashing for OCC synchronization.

### Vault Topic Loader (`test/storage-loader.test.ts`)

Tests in `test/storage-loader.test.ts` (5 tests) verify batch vault loading:

- **Extraction & Normalization**: Parses frontmatter blocks, converts numeric strings, and clamps invalid values.
- **Fallback Title Hierarchy**: Verifies title resolution order in `loadTopics`: frontmatter `title` &rarr; base filename.
- **Pre-Scanned Performance**: Confirms that providing a pre-scanned file list bypasses redundant filesystem scans.

### Working Memory & Session Recovery (`test/storage-memory.test.ts`)

Tests in `test/storage-memory.test.ts` (10 tests) verify the active study context system:

- **Session Identification**: Verifies session ID generation format `S-YYYYMMDDTHHMMSS-xxxx` and draft checkpoints `DRAFT-S-xxxxxxxx`.
- **Hot Context Truncation**: Validates that `.palee/hot.md` truncates note text to `MAX_HOT_WORDS = 250` words to preserve context efficiency.
- **Catalog Regeneration**: Ensures `.palee/index.md` accurately regenerates topic lists, recent sessions, and draft links.

### Pattern & Glob Matching (`test/storage-pattern-matcher.test.ts`)

Tests in `test/storage-pattern-matcher.test.ts` (14 tests) verify pattern matching utilities:

- **Glob Support**: Validates single `*`, recursive `**/*.md`, character class `[...]`, and wildcard `?` matching.
- **Cross-Platform Path Normalization**: Automatically normalizes Windows `\` backslashes to canonical `/` slashes.
- **Obsidian Tag Matching**: Extracts and matches exact `#tag` and nested `#category/subcategory` tag hierarchies.

### Multi-Format Roadmap Parser (`test/storage-roadmap-parser.test.ts`)

Tests in `test/storage-roadmap-parser.test.ts` (8 tests) exercise curriculum ingestion:

- **Format Flexibility**: Parses roadmaps from pure `.yaml`/`.yml` files, Markdown frontmatter headers, and embedded ```` ```yaml ```` codeblocks.
- **Syntax & Schema Diagnostics**: Validates topic node requirements and provides clear error diagnostics on missing required fields.

### Vault Traversal (`test/storage-walker.test.ts`)

Tests in `test/storage-walker.test.ts` (11 tests) verify recursive file discovery:

- **Markdown Discovery**: Recursively traverses nested vault folders to locate `.md` files.
- **Exclusion Filters**: Automatically ignores `.obsidian`, `.trash`, `.git`, `node_modules`, and hidden dot-directories.
- **Symlink Safety**: Skips circular symlinks to prevent infinite directory recursion.

### In-Memory File Cache (`test/storage-cache.test.ts`)

Tests in `test/storage-cache.test.ts` (9 tests) verify caching and invalidation logic:

- **Unsettled Horizon (2000ms)**: Mitigates filesystem buffer lag by using SHA-256 content hashes within the 2-second edit window, falling back to fast `mtime` checks outside the window.
- **Cache Invalidation**: Invalidates cache entries on size mismatch or explicit deletion.

---

## 3. Data Model & Domain Type Tests

### Difficulty Coercion & Types (`test/types-difficulty.test.ts`)

Tests in `test/types-difficulty.test.ts` (9 tests) enforce type contracts:

- **Difficulty Coercion**: Verifies `normalizeDifficulty` coerces case-insensitive strings ("BEGINNER", "  Advanced  ") and numeric thresholds (values &le; 1 &rarr; `beginner`, values &le; 3 &rarr; `intermediate`, and values &gt; 3 &rarr; `advanced`, including numbers like 0 or 6), safely defaulting unrecognized strings to `intermediate`.
- **Discriminated Union Session Types**: Verifies type discrimination between `CompletedSession` and `DraftSession` based on session state and properties.

---

## Code Entity Association Matrix

| System Component | Primary Functions / Classes | Test File | Test Count |
|---|---|---|:---:|
| Spaced Repetition | `processReview`, `computeDueDate` | `test/engine-sm2.test.ts` | 15 |
| Dependency Graph | `detectCycle`, `getReadyTopics`, `validateDependencyGraph` | `test/engine-dependency.test.ts` | 8 |
| Pedagogical Mastery | `computeTopicMastery`, `MASTERY_THRESHOLD` | `test/engine-mastery.test.ts` | 11 |
| File Locking | `Lock` class, `acquireLock`, `releaseLock` | `test/storage-lock.test.ts` | 11 |
| Atomic Writes | `atomicWrite`, `isConflictError` | `test/storage-atomic-write.test.ts` | 10 |
| Frontmatter CST | `parseFrontmatter`, `updateFrontmatter`, `computeFingerprint` | `test/storage-frontmatter.test.ts` | 11 |
| Vault Loader | `loadTopics` | `test/storage-loader.test.ts` | 5 |
| Working Memory | `startSession`, `saveDraft`, `endSession` | `test/storage-memory.test.ts` | 10 |
| Pattern Matcher | `matchesGlob`, `matchesTag` | `test/storage-pattern-matcher.test.ts` | 14 |
| Roadmap Parser | `parseRoadmap` | `test/storage-roadmap-parser.test.ts` | 8 |
| Vault Walker | `walkVault` | `test/storage-walker.test.ts` | 11 |
| File Cache | `FileCache`, `UNSETTLED_HORIZON` | `test/storage-cache.test.ts` | 9 |
| Domain Types | `normalizeDifficulty`, `Difficulty`, `Session` | `test/types-difficulty.test.ts` | 9 |