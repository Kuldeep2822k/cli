/**
 * TOC Discovery — Reading the Repo's Own Enumeration (Issue PAL-205-C3)
 *
 * @remarks
 * Filesystem half of the TOC tier. `src/engine/toc-chain.ts` plans and
 * composes chains from plain path lists (the engine stays fs-free); this
 * module is the only place that opens TOC documents and decides which link
 * targets actually exist in the vault.
 *
 * A *TOC file* is a README-class document whose enumeration counts as lesson
 * order: `README.md`/`SUMMARY.md` (case-insensitive) at the vault root plus
 * the same names inside any visible, non-phase directory. Numbered modules
 * contribute most in OSS curricula, but an unnumbered repo's own README is
 * exactly the Tier-B signal the numbered tree cannot provide — numbered-tree
 * targets are then dropped later by composition (C2 numbering dominance), so
 * reading all README-class docs cannot let TOC override numbering.
 *
 * Resolution is fail-closed per link (PAL-205 §8c): a destination that folds
 * outside the vault, names no existing note, or collides case-insensitively
 * with several notes is *skipped and counted*, never guessed and never fatal
 * for the rest of the enumeration. There is deliberately no whole-vault
 * basename fallback — a relative link only ever resolves relative to its TOC
 * file, and a bare name may only match the exact path or its case-variant in
 * the same position.
 */

import fs from 'fs';
import path from 'path';
import { walkVault, isResolvableNotePath } from './vault-walker';
import { isWithinVault } from './wikilink';
import { classifyNoteForChain, isPhaseSubtree, stemOf } from '../engine/tier0-hygiene';
import { extractTocLinks, foldTocDestination } from '../engine/toc-chain';
import { parseNumericPrefix } from '../engine/auto-chain';

/** Names (case-insensitive) that enumerate lessons when found in a directory. */
const TOC_FILE_STEMS = ['readme', 'summary'];

/**
 * Largest document the enumeration will read, in bytes — 512 KiB, on the order
 * of 10 000 link lines. A hand-written lesson list does not reach it while a
 * pasted diff or a generated index does, and such a document is not a table of
 * contents: it is declined with an {@link TocSkippedLink} rather than parsed, so
 * one pathological README can never decide the cost of a whole-vault
 * `adopt --auto-chain` scan (issue #263). It also bounds the input handed to the
 * link scanner, whose label table is sized by the document.
 */
const TOC_MAX_SOURCE_BYTES = 512 * 1024;

/** One skipped link target with the reason it never became a chain edge. */
export interface TocSkippedLink {
  /** Vault-relative path of the TOC document containing the link */
  tocFile: string;
  /** Destination text as written; absent for a skip that names no link, such as `oversized` */
  raw?: string;
  /** Why the link was dropped; `oversized` declines the whole document without reading it */
  reason: 'escaped-vault' | 'missing' | 'ambiguous' | 'outside-scope' | 'oversized';
}

/** The full result of reading a vault's own enumerations. */
export interface TocEnumeration {
  /** TOC documents read, in chain-relevant order (root first) */
  tocFiles: string[];
  /** Resolved vault-relative note paths in document order (duplicates kept; the planner dedups) */
  documentOrder: string[];
  /** Every link that could not become an edge, counted */
  skipped: TocSkippedLink[];
}

/** Exact → case-folded note lookup; `ambiguous` when the fold matches several real paths. */
function lookupNote(index: NoteIndex, rel: string): { path: string | null; ambiguous: boolean } {
  if (index.exact.has(rel)) return { path: rel, ambiguous: false };
  const hits = index.folded.get(rel.toLowerCase()) ?? [];
  if (hits.length === 1) return { path: hits[0], ambiguous: false };
  if (hits.length > 1) return { path: null, ambiguous: true };
  return { path: null, ambiguous: false };
}
function toRelative(vaultPath: string, absolute: string): string {
  return path.relative(vaultPath, absolute).split(path.sep).join('/');
}

/**
 * Compares two vault-relative directory paths for TOC reading order:
 * numbered segments first (by number, then name), unnumbered after, parent
 * before children — the same shape `auto-chain`'s directory sort uses, kept
 * local so this module orders only *TOC documents*.
 */
function compareTocDirs(a: string, b: string): number {
  const sa = a.length === 0 ? [] : a.split('/');
  const sb = b.length === 0 ? [] : b.split('/');
  const len = Math.min(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const pa = parseNumericPrefix(sa[i]);
    const pb = parseNumericPrefix(sb[i]);
    if (pa !== null && pb !== null && pa.n !== pb.n) return pa.n - pb.n;
    if (pa !== null && pb === null) return -1;
    if (pa === null && pb !== null) return 1;
    const la = sa[i].toLowerCase();
    const lb = sb[i].toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
  }
  return sa.length - sb.length;
}

/**
 * Discovers the TOC documents of a vault in chain-relevant order.
 *
 * @param vaultPath - Absolute vault root
 * @returns Vault-relative POSIX paths: root README/SUMMARY first, then
 * module-level ones by directory order. Files in phase subtrees or excluded
 * by Tier-0 hygiene never enumerate.
 */
export function discoverTocFiles(vaultPath: string): string[] {
  return discoverTocFilesFromIndex(buildNoteIndex(vaultPath));
}

/**
 * {@link discoverTocFiles} against an index the caller already built.
 *
 * @param noteIndex - A built note index for the same vault root
 * @returns The same ordered TOC paths
 *
 * @remarks
 * Split out because deriving an enumeration needs the note index for itself:
 * walking the whole vault twice per adoption run to re-derive a list this
 * caller consumes immediately is a pure extra traversal on the slowest path in
 * the command (the derive stage measured ~240 us per note).
 */
function discoverTocFilesFromIndex(noteIndex: NoteIndex): string[] {
  const candidates = [...noteIndex.exact.keys()].filter((rel) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!TOC_FILE_STEMS.includes(stemOf(base))) return false;
    if (isPhaseSubtree(rel)) return false;
    return classifyNoteForChain(rel).cls !== 'excluded';
  });
  const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  return candidates.sort((a, b) => {
    const d = compareTocDirs(dirOf(a), dirOf(b));
    if (d !== 0) return d;
    // README before SUMMARY within one dir; stable case fold otherwise.
    const rankA = stemOf(a) === 'readme' ? 0 : 1;
    const rankB = stemOf(b) === 'readme' ? 0 : 1;
    return rankA - rankB || (a < b ? -1 : 1);
  });
}

interface NoteIndex {
  /** exact-case vault-relative POSIX path → true */
  exact: Map<string, true>;
  /** lowercased path → the real paths matching case-insensitively */
  folded: Map<string, string[]>;
}

function buildNoteIndex(vaultPath: string): NoteIndex {
  const exact = new Map<string, true>();
  const folded = new Map<string, string[]>();
  for (const absolute of walkVault(vaultPath)) {
    const rel = toRelative(vaultPath, absolute);
    exact.set(rel, true);
    const key = rel.toLowerCase();
    const list = folded.get(key);
    if (list) list.push(rel);
    else folded.set(key, [rel]);
  }
  return { exact, folded };
}

/**
 * Reads every TOC document and resolves its markdown links to real notes.
 *
 * @param vaultPath - Absolute vault root
 * @param scopePaths - Optional set of vault-relative paths (POSIX) to keep;
 * targets outside the scanned adoption scope are counted as `outside-scope`
 * @returns Ordered resolved note paths plus per-file skipped-link records
 *
 * @remarks
 * Per-link rules, all adversarially profiled in PAL-205 §8c and shared with
 * the engine folding rules ({@link foldTocDestination}):
 * folder → `README.md`; `%20` decoded with no raw fallback; anchors stripped;
 * backslashes literal (a `\` can never make a segment cross directories);
 * `..` that leaves the root rejected via the same {@link isWithinVault} guard
 * wikilinks use; case-insensitive fallback resolves `02-core/readme.md` to
 * the actual `02-core/README.md`, and a fallback that matches several real
 * paths is ambiguous → skipped. A document over {@link TOC_MAX_SOURCE_BYTES}
 * is never read at all: it is counted as `oversized`, because a file that large
 * is not somebody's table of contents (issue #263).
 */
export function deriveTocEnumeration(vaultPath: string, scopePaths?: Set<string>): TocEnumeration {
  const resolvedVault = fs.realpathSync(vaultPath);
  const index = buildNoteIndex(resolvedVault);
  const tocFiles = discoverTocFilesFromIndex(index);
  const documentOrder: string[] = [];
  const skipped: TocSkippedLink[] = [];

  for (const tocFile of tocFiles) {
    const tocDir = tocFile.includes('/') ? tocFile.slice(0, tocFile.lastIndexOf('/')) : '';
    const absolute = path.join(resolvedVault, tocFile);
    let text: string;
    try {
      // Stat first: a document over the guard is declined without being read at
      // all, so the size bound covers the IO and the parse, not only the parse.
      if (fs.statSync(absolute).size > TOC_MAX_SOURCE_BYTES) {
        skipped.push({ tocFile, reason: 'oversized' });
        continue;
      }
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue; // unreadable TOC contributes nothing; other TOCs still run
    }
    for (const link of extractTocLinks(text)) {
      if (link.destination === null) continue; // self-skip inside the parser (external, malformed, …)
      const folded = foldTocDestination(link.destination, tocDir);
      const rel = folded.relativePath;
      if (
        folded.escapedRoot ||
        rel.length === 0 ||
        !isWithinVault(resolvedVault, path.resolve(resolvedVault, rel))
      ) {
        skipped.push({ tocFile, raw: link.raw, reason: 'escaped-vault' });
        continue;
      }
      if (!isResolvableNotePath(rel)) {
        // Invisible namespace (dot-dirs, node_modules) or non-Markdown file:
        // a name the rest of the CLI cannot see never joins a chain.
        skipped.push({ tocFile, raw: link.raw, reason: 'missing' });
        continue;
      }
      let found = lookupNote(index, rel);
      if (
        found.path === null &&
        !found.ambiguous &&
        !link.destination.endsWith('/') &&
        !link.destination.toLowerCase().endsWith('.md')
      ) {
        // GitHub-style folder link without a trailing slash: `[a](01-a)` was
        // folded to `01-a.md`; when only the *directory* `01-a/` exists, its
        // README is the target. A real `01-a.md` file always wins (tried
        // first), so file-vs-folder is never a coin flip.
        found = lookupNote(index, `${rel.slice(0, -3)}/README.md`);
      }
      if (found.ambiguous) {
        skipped.push({ tocFile, raw: link.raw, reason: 'ambiguous' });
        continue;
      }
      const resolved = found.path;
      if (resolved === null) {
        skipped.push({ tocFile, raw: link.raw, reason: 'missing' });
        continue;
      }
      if (scopePaths && !scopePaths.has(resolved)) {
        skipped.push({ tocFile, raw: link.raw, reason: 'outside-scope' });
        continue;
      }
      documentOrder.push(resolved);
    }
  }
  return { tocFiles, documentOrder, skipped };
}
