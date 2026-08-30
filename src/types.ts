/**
 * PALEE Core Type Definitions
 *
 * @remarks
 * Contains all shared domain models, schema definitions, CLI configuration types,
 * storage structures, and validation interfaces across the PALEE ecosystem.
 */

// ─── Assessment & Review ──────────────────────────────────────────────

/**
 * Four-pillar pedagogical assessment breakdown for a topic.
 *
 * @remarks
 * Each pillar is evaluated on a scale of `0.0` (uninitiated) to `1.0` (fully mastered).
 */
export interface Assessment {
  /** Conceptual understanding score (20% weight, 0.0 - 1.0) */
  conceptual: number;
  /** Practical application score (20% weight, 0.0 - 1.0) */
  practical: number;
  /** Debugging / troubleshooting skill score (20% weight, 0.0 - 1.0) */
  debug: number;
  /** Feynman articulation score (40% weight, 0.0 - 1.0, double weighted) */
  feynman: number;
  /** ISO 8601 timestamp of when the assessment was last updated, or null if unassessed */
  assessed_at: string | null;
}

/**
 * SuperMemo SM-2 spaced repetition state for scheduling topic reviews.
 *
 * @remarks
 * Tracks repetition intervals, ease factors, lapses, and due dates.
 *
 * @see {@link https://www.supermemo.com/en/archives1990-2015/english/ol/sm2} SuperMemo-2 Algorithm
 */
export interface Review {
  /** Current review interval in days (>= 1) */
  interval_days: number;
  /** Number of consecutive successful review repetitions (>= 0) */
  repetition: number;
  /** Easiness factor determining interval scaling (minimum 1.3, initial 2.5) */
  ease_factor: number;
  /** Cumulative count of failed reviews after previously mastering the item */
  lapses: number;
  /** Quality rating submitted during the last review session (0 - 5), or null */
  last_quality: number | null;
  /** ISO 8601 timestamp of the last completed review, or null */
  last_reviewed_at: string | null;
  /** ISO 8601 or date-only string when the topic is next due for review, or null */
  due_at: string | null;
}

/**
 * Canonical topic difficulty levels.
 */
export type Difficulty = 'beginner' | 'intermediate' | 'advanced';

/**
 * Normalizes any raw difficulty input (string, number, or variant) into a canonical {@link Difficulty} value.
 *
 * @remarks
 * Normalization rules:
 * - String inputs: trimmed and lowercased (`'beginner'`, `'intermediate'`, `'advanced'`).
 * - Numeric inputs: `1` -> `'beginner'`, `2..3` -> `'intermediate'`, `4..5` -> `'advanced'`.
 * - Numeric strings: parsed to integers and mapped according to numeric rules.
 * - Fallback / invalid: defaults to `'intermediate'`.
 *
 * @example
 * ```typescript
 * normalizeDifficulty('BEGINNER'); // 'beginner'
 * normalizeDifficulty(1);          // 'beginner'
 * normalizeDifficulty('4');        // 'advanced'
 * normalizeDifficulty(undefined);  // 'intermediate'
 * ```
 *
 * @param raw - Raw difficulty value from YAML frontmatter or CLI arguments
 * @returns Canonical difficulty string: `'beginner'`, `'intermediate'`, or `'advanced'`
 */
export function normalizeDifficulty(raw: unknown): Difficulty {
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'beginner' || s === 'intermediate' || s === 'advanced') {
      return s;
    }
    const num = Number.parseInt(s, 10);
    if (!Number.isNaN(num)) {
      if (num <= 1) return 'beginner';
      if (num <= 3) return 'intermediate';
      return 'advanced';
    }
  } else if (typeof raw === 'number' && !Number.isNaN(raw)) {
    if (raw <= 1) return 'beginner';
    if (raw <= 3) return 'intermediate';
    return 'advanced';
  }
  return 'intermediate';
}

/**
 * Full schema representation of a PALEE topic note.
 */
export interface Topic {
  /** PALEE frontmatter schema version */
  palee_schema: number;
  /** Unique topic identifier within the vault */
  palee_id: string;
  /** Human-readable title or subject name */
  topic: string;
  /** Optional curriculum track or category grouping */
  track?: string;
  /** Learning status lifecycle state */
  status: 'not_started' | 'learning' | 'paused' | 'archived';
  /** Difficulty categorization */
  difficulty: Difficulty;
  /** Array of parent topic IDs required before this topic is ready */
  dependencies?: string[];
  /** Alias for `dependencies` matching topic graph terminology */
  depends_on?: string[];
  /** Four-pillar assessment breakdown */
  assessment: Assessment;
  /** Spaced repetition review metadata */
  review: Review;
}

/**
 * Aggregate progress statistics across all topics in a vault.
 */
export interface Progress {
  /** Count of non-archived active topics */
  active_topic_count: number;
  /** Count of archived topics */
  archived_topic_count?: number;
  /** Global weighted mastery percentage across all topics (0.0 - 1.0), or null */
  global_mastery: number | null;
  /** High-level mastery health status */
  mastery_status: 'no_data' | 'learning' | 'mastered';
}

/** Base fields shared across all session states */
export interface BaseSession {
  /** Schema version identifier */
  palee_schema: number;
  /** Unique session ID (`S-YYYYMMDDTHHMMSS-XXXX` or `DRAFT-S-*`) */
  session_id: string;
  /** ID of the topic studied in this session */
  topic_id: string;
  /** ISO 8601 start timestamp */
  started_at: string;
}

/** Completed learning session with a recorded end timestamp */
export interface CompletedSession extends BaseSession {
  /** Finalized session status */
  status: 'completed';
  /** ISO 8601 end timestamp when session was finished */
  ended_at: string;
}

/** In-progress draft session without an end timestamp */
export interface DraftSession extends BaseSession {
  /** Draft session status */
  status: 'draft';
  /** End timestamp is null for in-progress draft checkpoints */
  ended_at: null;
}

/**
 * Learning session state snapshot (discriminated union by status).
 */
export type Session = CompletedSession | DraftSession;

// ─── Memory & Sessions ───────────────────────────────────────────────

/**
 * Hot working memory state stored in `.palee/hot.md`.
 *
 * @remarks
 * Maintains quick-lookup context for the latest active topic and recent study notes.
 */
export interface HotMemoryData {
  /** Schema version */
  palee_schema: number;
  /** Fixed identifier (`H-active`) */
  memory_id: string;
  /** ID of the most recent confirmed session, or null */
  last_session: string | null;
  /** ID of the topic currently active in working memory, or null */
  active_topic: string | null;
  /** Date formatted as YYYY-MM-DD when hot memory was last regenerated */
  updated_at: string;
}

/** Base stored session file frontmatter record */
export interface BaseSessionRecord {
  /** PALEE session schema version */
  palee_schema: number;
  /** Unique session identifier */
  session_id: string;
  /** Topic ID studied */
  topic_id: string;
  /** ISO 8601 timestamp when session started */
  started_at: string;
}

/** Completed session file frontmatter record */
export interface CompletedSessionRecord extends BaseSessionRecord {
  /** Completion status */
  status: 'completed';
  /** ISO 8601 timestamp when session ended */
  ended_at: string;
}

/** In-progress draft session file frontmatter record */
export interface DraftSessionRecord extends BaseSessionRecord {
  /** Draft status */
  status: 'draft';
  /** End timestamp is null for in-progress drafts */
  ended_at: null;
}

/**
 * Stored session file frontmatter record (discriminated union by status).
 */
export type SessionRecord = CompletedSessionRecord | DraftSessionRecord;

/**
 * User action choices when recovering or processing an unfinished draft session.
 */
export type DraftRecoveryAction = 'resume' | 'save' | 'discard' | 'ignore';

// ─── Config ─────────────────────────────────────────────────────────

/**
 * Options for the `palee migrate` command
 */
export interface MigrateOptions {
  /** Automatically migrate and fix schema-less notes to schema v1 */
  fix?: boolean;
}

/**
 * Global configuration stored in `~/.palee/config.json`.
 */
export interface PaleeConfig {
  /** Absolute path to the active Obsidian vault */
  vaultPath?: string;
  /** AI backend provider (e.g., 'gemini', 'openai') */
  aiProvider?: string;
  /** Specific LLM model identifier */
  model?: string;
}

// ─── Lock ───────────────────────────────────────────────────────────

/**
 * Mutex lock file payload stored within `.palee/locks/<hash>.lockdir/<lock_id>.json`.
 *
 * @remarks
 * Used for cross-process synchronization and race-condition prevention across POSIX and Windows.
 */
export interface LockData {
  /** Unique lock acquisition identifier (`L-YYYYMMDDTHHMMSS-XXXX`) */
  lock_id: string;
  /** Absolute target file path being protected */
  target: string;
  /** OS Process ID holding the lock */
  pid: number;
  /** Host machine hostname */
  hostname: string;
  /** ISO 8601 acquisition timestamp */
  created_at: string;
}

// ─── Cache ──────────────────────────────────────────────────────────

/**
 * Internal cache entry for parsed file representations.
 *
 * @typeParam T - Type of cached payload data
 */
export interface CacheEntry<T = unknown> {
  /** Modification time (epoch ms) */
  mtime: number;
  /** File size in bytes */
  size: number;
  /** SHA-256 content digest */
  fingerprint: string;
  /** Cached parsed data payload */
  data: T;
  /** Timestamp (epoch ms) when cache validity was last verified */
  lastVerified: number;
}

// ─── Frontmatter ────────────────────────────────────────────────────

/**
 * Result of parsing YAML frontmatter from a Markdown document.
 */
export interface FrontmatterResult {
  /** Parsed YAML key-value dictionary, or null if no frontmatter / malformed */
  frontmatter: Record<string, unknown> | null;
  /** Markdown document body with frontmatter stripped */
  body: string;
  /** Raw YAML string content between `---` delimiters, or null */
  raw: string | null;
  /** Parsed YAML Concrete Syntax Tree document object (if available) */
  doc?: unknown;
  /** Error message if parsing failed */
  error?: string;
}

/** Options for traversing the vault filesystem */
export interface WalkOptions {
  /** Whether to traverse symbolic links (default: false) */
  followSymlinks?: boolean;
  /** Optional custom directory names to exclude from traversal */
  excludeDirs?: string[];
}

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Specific issue encountered during vault or dependency graph validation.
 */
export interface ValidationError {
  /** Error classification */
  type: 'duplicate_id' | 'missing_dependency' | 'cycle';
  /** Topic identifier where the issue was detected */
  topic?: string;
  /** Missing dependent topic ID (for `missing_dependency`) */
  missing?: string;
  /** Duplicate topic ID (for `duplicate_id`) */
  id?: string;
  /** File paths containing conflicting duplicate IDs */
  files?: string[];
  /** Cycle path sequence (for `cycle`) */
  path?: string[];
  /** Descriptive explanation of the validation failure */
  message?: string;
}

/**
 * Outcome of validating the complete topic graph.
 */
export interface ValidationResult {
  /** True if no validation errors were found */
  valid: boolean;
  /** List of detected validation errors */
  errors: ValidationError[];
}

// ─── Dependency Graph ───────────────────────────────────────────────

/**
 * In-memory topic node representation for dependency graph analysis and scheduling.
 */
export interface TopicNode {
  /** Unique PALEE topic identifier */
  palee_id: string;
  /** Alternative alias for `palee_id` */
  id?: string;
  /** Note title or subject name */
  title?: string;
  /** Relative path within the vault */
  path?: string;
  /** Difficulty categorization */
  difficulty?: Difficulty;
  /** List of prerequisite topic IDs */
  depends_on?: string[];
  /** Alias for `depends_on` matching serialized topic schema */
  dependencies?: string[];
  /** Computed overall mastery score (0.0 - 1.0) */
  topic_mastery: number;

  /** Learning status */
  status?: string;
  /** Conceptual assessment score */
  conceptual?: number;
  /** Practical assessment score */
  practical?: number;
  /** Debugging assessment score */
  debug?: number;
  /** Feynman assessment score */
  feynman?: number;
  /** SM-2 ease factor */
  ease_factor?: number;
  /** SM-2 interval in days */
  interval_days?: number;
  /** SM-2 repetition count */
  repetition?: number;
  /** SM-2 lapse counter */
  lapses?: number;
  /** Quality rating from previous review */
  last_quality?: number | null;
  /** Last assessment timestamp */
  assessed_at?: string | null;
  /** Last review timestamp */
  last_reviewed_at?: string | null;
  /** Due date for next review */
  due_at?: string | Date | null;
  /** Dynamic properties from frontmatter */
  [key: string]: unknown;
}

// ─── CLI Options ────────────────────────────────────────────────────

/**
 * Command-line options for `palee adopt`.
 */
export interface AdoptOptions {
  /** Override default difficulty */
  difficulty?: Difficulty;
  /** Comma-separated list of prerequisite topic IDs */
  dependsOn?: string;
  /** Adopt all discovered unmanaged Markdown notes */
  all?: boolean;
  /** Glob pattern(s) or file paths to include */
  include?: string;
  /** Glob pattern(s) to exclude from adoption */
  exclude?: string;
  /** Tag filter to match in note frontmatter */
  tag?: string;
  /** Preview adoption changes without modifying files */
  dryRun?: boolean;
  /** Show verbose diagnostic details */
  verbose?: boolean;
  /** Skip interactive confirmation prompts */
  yes?: boolean;
}

/**
 * Command-line options for `palee next`.
 */
export interface NextOptions {
  /** List all ready topics instead of just the single highest priority topic */
  all?: boolean;
  /** Output results as JSON */
  json?: boolean;
}

/**
 * Command-line options for `palee plan`.
 */
export interface PlanOptions {
  /** Output topological study plan as JSON */
  json?: boolean;
}

/**
 * Command-line options for `palee dashboard`.
 */
export interface DashboardOptions {
  /** Output dashboard metrics as JSON */
  json?: boolean;
}

/**
 * Command-line options for `palee progress`.
 */
export interface ProgressOptions {
  /** Specific topic query to inspect */
  topic?: string;
  /** Output progress metrics as JSON */
  json?: boolean;
}

/**
 * Command-line options for `palee validate`.
 */
export interface ValidateOptions {
  /** Attempt automatic repairs where possible */
  fix?: boolean;
  /** Output validation report as JSON */
  json?: boolean;
}

/**
 * Command-line options for `palee session`.
 */
export interface SessionOptions {
  /** Enable interactive prompt mode */
  interactive?: boolean;
  /** Target topic ID for the session */
  topic?: string;
  /** Output session details as JSON */
  json?: boolean;
}

/**
 * Command-line options for `palee roadmap`.
 */
export interface RoadmapOptions {
  /** Path to external roadmap YAML or Markdown definition */
  from?: string;
  /** Automatically approve adoption without confirmation */
  yes?: boolean;
}

// ─── Roadmap YAML ───────────────────────────────────────────────────

/**
 * Single topic entry parsed from a curriculum roadmap file.
 */
export interface RoadmapTopic {
  /** Target topic ID */
  id: string;
  /** Descriptive title */
  title: string;
  /** Target file path relative to vault */
  path: string;
  /** Assigned difficulty */
  difficulty?: Difficulty;
  /** List of prerequisite topic IDs */
  depends_on?: string[];
  /** Optional sequence ordering */
  order?: number;
}

/**
 * Structured roadmap file content.
 */
export interface RoadmapFile {
  /** List of topics defined in the roadmap */
  topics: RoadmapTopic[];
}

// ─── Vault Walker ───────────────────────────────────────────────────

/**
 * Options for traversing vault directory trees.
 */
export interface WalkOptions {
  /** Whether to traverse symbolic links (default: false) */
  followSymlinks?: boolean;
}

// ─── Node Error (for catch blocks) ──────────────────────────────────

/**
 * Extension of standard Error containing optional Node.js error code (e.g. `'ENOENT'`, `'ECONFLICT'`).
 */
export interface NodeError extends Error {
  /** System error code */
  code?: string;
}
