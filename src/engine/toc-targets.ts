/**
 * TOC Target Normalization (Issue PAL-205-C, INV-46/47)
 *
 * @remarks
 * Phase 2 of the TOC tier, extracted from `src/engine/toc-chain.ts` by the
 * P3-14 phase split (#565): turn a link destination into a vault-relative
 * POSIX candidate (folder links → `<dir>/README.md`, anchors stripped,
 * trailing slashes tolerated and deduped downstream, per-TOC-file base dir,
 * lexical `.`/`..` fold). Backslashes are *literal characters*, never
 * separators — the same rule `src/storage/wikilink.ts` enforces, because a
 * Windows `path.resolve` would silently reinterpret them.
 */

/** Result of folding one destination against the TOC file's directory. */
export interface TocTargetCandidate {
  /** Vault-relative POSIX path (`01-x/README.md`); `''` when the fold names no
   * path at all — an escape, or a destination that folds away entirely */
  relativePath: string;
  /** True when the fold walked above the vault root — storage must reject it */
  escapedRoot: boolean;
}

/**
 * Folds one link destination into a vault-relative candidate path.
 *
 * @param destination - Post-decode, anchor-stripped destination from {@link extractTocLinks}
 * @param tocDir - Vault-relative POSIX directory of the TOC file itself (`''` for root)
 * @returns The lexical candidate plus the escape flag; extension/folder rules
 * applied (trailing `/` → `<dir>/README.md`, extension-less → append `.md`)
 *
 * @remarks
 * Backslashes are never treated as separators (they stay literal characters
 * of one segment). A leading `/` anchors at the vault root; anything else is
 * relative to {@link tocDir}. The `..` fold is lexical — the authoritative
 * containment guard remains `isWithinVault` in the storage layer, run on
 * canonical paths; {@link TocTargetCandidate#escapedRoot} is the early signal.
 */
export function foldTocDestination(destination: string, tocDir: string): TocTargetCandidate {
  const segments: string[] = [];
  const absolute = destination.startsWith('/');
  const source = absolute ? destination.slice(1) : `${tocDir}/${destination}`;
  for (const segment of source.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
      else {
        return { relativePath: '', escapedRoot: true };
      }
      continue;
    }
    segments.push(segment);
  }
  const last = segments[segments.length - 1] ?? '';
  if (destination.endsWith('/')) {
    // Folder link → its README. Trailing slash dedupes with an explicit
    // README.md link naturally via first-appearance dedup downstream. A
    // destination that folds to no segment at all is the vault root, and
    // `segments[-1]` there is a non-index property `join('/')` silently drops —
    // so `[Home](/)` came back `''` and the caller reported it as
    // `escaped-vault` instead of chaining on the root `README.md`.
    if (segments.length === 0) segments.push('README.md');
    else segments[segments.length - 1] = `${last}/README.md`;
  } else if (last.length > 0 && !last.toLowerCase().endsWith('.md')) {
    // No extension at all → a note path (Obsidian/GitHub both allow it).
    // An extension that merely isn't `.md` (`.pdf`, `.png`) is left alone so
    // the storage visibility check rejects it rather than inventing `x.pdf.md`.
    if (!last.includes('.')) {
      segments[segments.length - 1] = `${last}.md`;
    }
  }
  return { relativePath: segments.join('/'), escapedRoot: false };
}
