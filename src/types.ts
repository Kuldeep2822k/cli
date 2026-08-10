// ─── Assessment & Review (existing) ─────────────────────────────────

export interface Assessment {
  conceptual: number;
  practical: number;
  debug: number;
  feynman: number;
  assessed_at: string | null;
}

export interface Review {
  interval_days: number;
  repetition: number;
  ease_factor: number;
  lapses: number;
  last_quality: number | null;
  last_reviewed_at: string | null;
  due_at: string | null;
}

export interface Topic {
  palee_schema: number;
  palee_id: string;
  topic: string;
  track?: string;
  status: 'not_started' | 'learning' | 'paused' | 'archived';
  difficulty: number;
  dependencies: string[];
  assessment: Assessment;
  review: Review;
}

export interface Progress {
  active_topic_count: number;
  global_mastery: number | null;
  mastery_status: 'no_data' | 'active';
}

export interface Session {
  palee_schema: number;
  session_id: string;
  topic_id: string;
  started_at: string;
  ended_at: string;
  status: 'completed' | 'draft';
}

// ─── Memory & Sessions ───────────────────────────────────────────────

export interface HotMemoryData {
  palee_schema: number;
  memory_id: string;
  last_session: string | null;
  active_topic: string | null;
  updated_at: string;
}

export interface SessionRecord {
  palee_schema: number;
  session_id: string;
  topic_id: string;
  started_at: string;
  ended_at: string;
  status: 'completed' | 'draft';
}

export type DraftRecoveryAction = 'resume' | 'save' | 'discard' | 'ignore';

export interface SessionOptions {
  interactive?: boolean;
  topic?: string;
}

// ─── Config ─────────────────────────────────────────────────────────

export interface PaleeConfig {
  vaultPath?: string;
  aiProvider?: string;
  model?: string;
}

// ─── Lock ───────────────────────────────────────────────────────────

export interface LockData {
  lock_id: string;
  target: string;
  pid: number;
  hostname: string;
  created_at: string;
}

// ─── Cache ──────────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  mtime: number;
  size: number;
  fingerprint: string;
  data: T;
  lastVerified: number;
}

// ─── Frontmatter ────────────────────────────────────────────────────

export interface FrontmatterResult {
  frontmatter: Record<string, unknown> | null;
  body: string;
  raw: string | null;
  doc?: unknown;
  error?: string;
}

// ─── Validation ─────────────────────────────────────────────────────

export interface ValidationError {
  type: 'duplicate_id' | 'missing_dependency' | 'cycle';
  topic?: string;
  missing?: string;
  id?: string;
  files?: string[];
  path?: string[];
  message?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ─── Dependency Graph ───────────────────────────────────────────────

export interface TopicNode {
  palee_id: string;
  depends_on: string[];
  topic_mastery: number;
  [key: string]: unknown;
}

// ─── CLI Options ────────────────────────────────────────────────────

export interface AdoptOptions {
  difficulty?: string;
  dependsOn?: string;
}

export interface NextOptions {
  all?: boolean;
}

export interface ProgressOptions {
  topic?: string;
}

export interface ValidateOptions {
  fix?: boolean;
}

export interface RoadmapOptions {
  from?: string;
  yes?: boolean;
}

// ─── Roadmap YAML ───────────────────────────────────────────────────

export interface RoadmapTopic {
  id: string;
  title: string;
  path: string;
  difficulty?: string;
  depends_on?: string[];
  order?: number;
}

export interface RoadmapFile {
  topics: RoadmapTopic[];
}

// ─── Vault Walker ───────────────────────────────────────────────────

export interface WalkOptions {
  followSymlinks?: boolean;
}

// ─── Node Error (for catch blocks) ──────────────────────────────────

export interface NodeError extends Error {
  code?: string;
}
