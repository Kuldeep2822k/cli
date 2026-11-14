/**
 * PALEE Session Memory Storage Manager
 *
 * @remarks
 * Facade for the memory subsystem's phases, extracted by the P3-14 phase
 * split (#565). Manages study session persistence, hot working memory
 * derivation, index cataloging, and draft crash recovery within the vault's
 * `.palee/` directory. This module owns no logic: it re-exports the focused
 * modules so every importer — the storage barrel, the validation layer, and
 * the deep-importing tests — sees exactly the names it always did.
 *
 * Subsystems and their homes:
 * - **Hot / Index / Active-Session Marker** (`./hot-index`): the working
 *   state at the top of `.palee/` — `.palee/hot.md` (capped at 250 words of
 *   recent active context), `.palee/index.md` listing chronological study
 *   sessions, and `.palee/active-session.md`, the canonical in-progress
 *   marker the rebuild reconciles.
 * - **Canonical Sessions** (`./sessions`): the notes under
 *   `.palee/sessions/S-*.md` — id minting, the OCC-guarded save, the locked
 *   delete, the completed-session probe, and the read-side loader.
 * - **Draft Recovery** (`./drafts`): the checkpoint files
 *   (`.palee/sessions/DRAFT-S-*.md`) and the recovery pass that resolves
 *   them.
 * - **Tree Containment** (`./palee-dirs`): `getPaleeDir`/`getSessionsDir`
 *   refuse a `.palee` that resolves outside the vault before creating it, so
 *   a planted junction cannot make a directory outside the vault on the way
 *   to a refused write (#264).
 */

// Hot/index/active-session — the `.palee/` top-level working state.
export type { HotMemoryRead, HotMemoryReadState } from './hot-index';
export {
  MAX_HOT_WORDS,
  readHotMemory,
  resolveActiveTopic,
  truncateWords,
  countWords,
  formatDateOnly,
  updateHotMemory,
  resetHotMemory,
  regenerateIndex,
  rebuildHotAndIndex,
  readActiveSession,
  writeActiveSession,
  clearActiveSession,
} from './hot-index';

// Canonical session notes — the `.palee/sessions/S-*.md` lifecycle.
export {
  generateSessionId,
  writeSessionNote,
  hasCompletedSession,
  deleteSessionNote,
} from './sessions';

// Draft checkpoints and crash recovery — the `.palee/sessions/DRAFT-S-*.md` lifecycle.
export {
  generateDraftId,
  writeDraftCheckpoint,
  getDrafts,
  getTopicDrafts,
  getConsumedDraftPaths,
  deleteTopicDrafts,
  recoverDraft,
} from './drafts';
