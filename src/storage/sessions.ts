/**
 * Session Note Loader (#41/#42/#44 read path)
 *
 * @remarks
 * Storage-side single-read loader for the PALEE memory subsystem:
 * canonical session notes (`.palee/sessions/S-*.md` and
 * `DRAFT-S-*.md`), the derived session index (`.palee/index.md`),
 * and a tolerant hot-memory read (`.palee/hot.md`, delegated to
 * `readHotMemory`). All filesystem IO for session validation lives
 * here so rules stay pure — the same layering as `loader.ts` for
 * topics.
 *
 * The loader never throws on malformed notes: per-file parse
 * outcomes are preserved on `LoadedSession` so `valid-session-schema`
 * can report the defect while the rest of the vault is still
 * validated (one bad note = one finding, never a dead scan).
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './frontmatter';
import { relativeVaultPath } from './vault-walker';
import { readHotMemory } from './memory';

/**
 * A single session note read from `.palee/sessions/`, with its raw
 * parse outcome.
 *
 * @remarks `sessionId`/`isDraft` are derived from the FILENAME (the
 * only always-reliable signal when frontmatter is malformed or the
 * filename/ID disagree — which `valid-session-schema` reports
 * separately); `frontmatter` carries the raw parsed values, or null
 * when the YAML failed to parse (`parseError` says why).
 */
export interface LoadedSession {
  /** Session ID derived from the filename (`S-…` / `DRAFT-S-…` stem) */
  sessionId: string;
  /** True when the filename marks the note as a draft checkpoint */
  isDraft: boolean;
  /** Relative POSIX path from the vault root (`.palee/sessions/…`) */
  path: string;
  /** Absolute filesystem path to the note */
  filePath: string;
  /** Raw parsed frontmatter; null when parsing failed */
  frontmatter: Record<string, unknown> | null;
  /** Frontmatter parse error message; undefined when parsing succeeded */
  parseError?: string;
}

/**
 * The parsed derived session index (`.palee/index.md`).
 *
 * @remarks `missing` and `corrupt` carry `null` fields — the index is
 * a rebuildable projection, so absence is a state, not an error
 * (VERDICT decision 4); `refs` holds every `[[S-…]]` wikilink in
 * body order, deduplicated, so `valid-session-index` can check each
 * against the confirmed-session set.
 */
export type SessionIndexRead =
  | { state: 'ok'; refs: string[] }
  | { state: 'missing'; refs: null }
  | { state: 'corrupt'; refs: null; parseError: string };

/** Directory (relative to vault root) holding canonical session notes. */
const SESSIONS_DIR_SEGMENTS = ['.palee', 'sessions'];

/** Wikilink reference shape produced by `regenerateIndex`. */
const INDEX_REF_PATTERN = /\[\[([^\]]+)\]\]/g;

/**
 * Loads every session note (confirmed + draft) from the vault's
 * `.palee/sessions/` directory in one deterministic read pass.
 *
 * @remarks Files are visited in ascending filename order so findings
 * are deterministic regardless of OS readdir order. Notes that fail
 * to parse are returned (not skipped) with `frontmatter: null` and
 * `parseError` set — the schema rule reports them; unreadable files
 * are excluded but surface through the caller's read-incomplete
 * signal. When the sessions directory does not exist, returns `[]`
 * (an empty memory subsystem is the fresh-vault state).
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @returns Session notes with parse outcomes, sorted by filename
 */
function loadSessions(vaultPath: string): LoadedSession[] {
  const sessionsDir = path.join(vaultPath, ...SESSIONS_DIR_SEGMENTS);
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return []; // no .palee/sessions yet — fresh vault, not an error
  }

  const sessions: LoadedSession[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue;
    const isDraft = file.startsWith('DRAFT-S-');
    const isConfirmed = file.startsWith('S-');
    // Stray non-session markdown in the sessions dir: read it too so
    // the schema rule can report it rather than silently ignoring
    // misplaced managed data. The stem is still the ID signal.
    if (!isDraft && !isConfirmed) continue;

    const filePath = path.join(sessionsDir, file);
    const sessionId = file.slice(0, -'.md'.length);
    const relPath = relativeVaultPath(vaultPath, filePath);

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      // Unreadable (locked mid-scan): excluded from the loaded set —
      // the memory snapshot is incomplete and the caller's
      // read-incomplete signal reports it (same policy as topics).
      continue;
    }

    const { frontmatter, error } = parseFrontmatter(content);
    const loaded: LoadedSession = {
      sessionId,
      isDraft,
      path: relPath,
      filePath,
      frontmatter: (frontmatter as Record<string, unknown> | null) ?? null,
      ...(error !== undefined ? { parseError: error } : {}),
    };
    sessions.push(loaded);
  }
  return sessions;
}

/**
 * Reads and classifies the derived session index
 * (`.palee/index.md`).
 *
 * @remarks Tolerant read: `missing` when the file does not exist
 * (fresh vault or not yet regenerated — a rebuildable projection's
 * absence is never an error), `corrupt` with the parser message when
 * its frontmatter cannot be parsed, `ok` with every deduplicated
 * `[[S-…]]` wikilink reference in first-seen order otherwise.
 * Non-session wikilinks (`[[T-…]]` topic links) are ignored — the
 * index format only guarantees session links.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @returns Classified index read with references when parseable
 */
function readSessionIndex(vaultPath: string): SessionIndexRead {
  const indexPath = path.join(vaultPath, '.palee', 'index.md');
  let content: string;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return { state: 'missing', refs: null };
  }

  const { body, error } = parseFrontmatter(content);
  if (error !== undefined) {
    return { state: 'corrupt', refs: null, parseError: error };
  }

  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(INDEX_REF_PATTERN)) {
    const ref = match[1].trim();
    if (ref.length === 0 || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return { state: 'ok', refs };
}

/**
 * Convenience read of `.palee/hot.md` for validation consumers.
 *
 * @remarks Thin delegation to `readHotMemory` so consumers have one
 * import for the whole memory subsystem; classification semantics
 * (`ok` / `missing` / `no-frontmatter` / `corrupt` / `schema-invalid`)
 * stay owned by `memory.ts` (#130 read-state contract).
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @returns Tolerant hot-memory read
 */
function readHotMemoryForValidation(vaultPath: string) {
  return readHotMemory(vaultPath);
}

export {
  loadSessions,
  readSessionIndex,
  readHotMemoryForValidation,
};
