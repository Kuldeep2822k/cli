/**
 * Storage Subsystem - Public API
 *
 * @remarks
 * Bundles the core persistence capabilities of PALEE:
 * - **Vault Traversal & Loading**: `walkVault`, `loadTopics`
 * - **YAML CST & Markdown Frontmatter**: `parseFrontmatter`, `updateFrontmatter`, `computeFingerprint`
 * - **Cross-Process File Locking**: `Lock`
 * - **Atomic OCC Writes**: `atomicWrite`, `isConflictError`
 * - **Unsettled Horizon Cache**: `FileCache`, `UNSETTLED_HORIZON`
 * - **Session & Memory Persistence**: `writeSessionNote`, `updateHotMemory`, `regenerateIndex`, `rebuildHotAndIndex`, `recoverDraft`, etc.
 * - **Pattern & Roadmap Parsers**: `matchesPattern`, `matchesTags`, `parseRoadmapContent`
 */

import { walkVault, ensureVaultDirectory, relativeVaultPath } from './vault-walker';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { scanNotes } from './scanner';
import type { ScanNotesOptions } from './scanner';
import { Lock } from './lock';
import { atomicWrite, isConflictError } from './atomic-write';
import { FileCache, UNSETTLED_HORIZON } from './cache';
import {
  generateSessionId,
  generateDraftId,
  truncateWords,
  countWords,
  formatDateOnly,
  readHotMemory,
  resolveActiveTopic,
  writeSessionNote,
  updateHotMemory,
  resetHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  getTopicDrafts,
  deleteTopicDrafts,
  deleteSessionNote,
  recoverDraft,
  MAX_HOT_WORDS,
} from './memory';
import { parseRoadmapContent, type ParsedRoadmapResult } from './roadmap-parser';
import { matchesPattern, matchesTags, extractTags, validatePattern } from './pattern-matcher';
import { loadTopics, getTopicCache, type LoadedTopic, type LoadTopicsOptions } from './loader';
import {
  loadSessions,
  readSessionIndex,
  type LoadedSession,
  type SessionIndexRead,
} from './sessions';
import type { HotMemoryRead, HotMemoryReadState } from './memory';

export {
  // Vault operations
  walkVault,
  ensureVaultDirectory,
  relativeVaultPath,
  loadTopics,
  getTopicCache,
  scanNotes,

  // Memory subsystem reads (session notes, index, hot memory)
  loadSessions,
  readSessionIndex,

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
  readHotMemory,
  resolveActiveTopic,
  writeSessionNote,
  updateHotMemory,
  resetHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  writeDraftCheckpoint,
  getDrafts,
  getTopicDrafts,
  deleteTopicDrafts,
  deleteSessionNote,
  recoverDraft,
  MAX_HOT_WORDS,
};

export type { ParsedRoadmapResult, LoadedTopic, LoadTopicsOptions, HotMemoryRead, HotMemoryReadState, ScanNotesOptions, LoadedSession, SessionIndexRead };


