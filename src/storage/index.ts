/**
 * Storage Layer - Public API
 * Exports all storage components
 */

import { walkVault } from './vault-walker';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from './frontmatter';
import { Lock, HEARTBEAT_INTERVAL, STALE_TIMEOUT } from './lock';
import { atomicWrite } from './atomic-write';
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

export {
  // Vault operations
  walkVault,

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
