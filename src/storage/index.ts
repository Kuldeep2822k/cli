/**
 * Storage Layer - Public API
 * Exports all storage components
 */

import { walkVault } from './vault-walker';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT } from './lock';
import { atomicWrite, isConflictError } from './atomic-write';
import { FileCache, UNSETTLED_HORIZON } from './cache';
import {
  generateSessionId,
  generateDraftId,
  truncateWords,
  countWords,
  formatDateOnly,
  writeSessionNote,
  updateHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  recoverDraft,
  MAX_HOT_WORDS,
} from './memory';
import { parseRoadmapContent, type ParsedRoadmapResult } from './roadmap-parser';
import { matchesPattern, matchesTags, extractTags, validatePattern } from './pattern-matcher';
import { loadTopics, type LoadedTopic } from './loader';

export {
  // Vault operations
  walkVault,
  loadTopics,

  // Pattern and Tag Matching
  matchesPattern,
  matchesTags,
  extractTags,
  validatePattern,

  // Roadmap operations
  parseRoadmapContent,

  // Frontmatter operations
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,

  // Locking
  Lock,
  HEARTBEAT_INTERVAL,
  STALE_TIMEOUT,

  // Atomic writes
  atomicWrite,
  isConflictError,

  // Caching
  FileCache,
  UNSETTLED_HORIZON,

  // Memory & Session Storage
  generateSessionId,
  generateDraftId,
  truncateWords,
  countWords,
  formatDateOnly,
  writeSessionNote,
  updateHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  recoverDraft,
  MAX_HOT_WORDS,
};

export type { ParsedRoadmapResult, LoadedTopic };

