/**
 * Vault Walker
 *
 * @remarks
 * Recursively discovers Markdown files across an Obsidian vault directory hierarchy.
 * Ignores hidden dot-directories (`.obsidian`, `.trash`, `.git`, `.palee`), `node_modules`,
 * and dotfiles, with built-in protection against circular symlinks and unreadable subdirectories.
 */

import fs from 'fs';
import path from 'path';
import { WalkOptions } from '../types';
import { assertContainedInVault } from './containment';

/** Specific top-level directory names permanently excluded from scanning */
const EXCLUDED_DIRS = new Set([
  'node_modules',
]);

/**
 * A note name without its Markdown extension, compared without regard to case.
 *
 * @param name - A basename, with or without the `.md` extension
 * @returns The stem, with the extension removed only when it is really there
 *
 * @remarks
 * `path.basename(p, '.md')` is case-sensitive, so it leaves `Setup.MD` carrying
 * its extension and the two spellings of one note never share a key.
 */
function stemOfNote(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Folds text for identity comparison: case and Unicode normalization, nothing else.
 *
 * @param text - A path, a note name, or a link destination as written
 * @returns Case-folded, NFC-normalized text
 *
 * @remarks
 * The fold {@link foldNoteKey} applies, split from the stem-stripping that only
 * makes sense on a filename. Any comparison whose two sides are paths — a link
 * destination against a walked key, an exclusion pattern against a note — folds
 * through this, because a fold only one side performs is no fold.
 */
function foldIdentity(text: string): string {
  return text.toLowerCase().normalize('NFC');
}

/**
 * Folds a note name or vault-relative path for identity comparison.
 *
 * @param name - A stem, a full note name, or a vault-relative POSIX path
 * @returns Case-folded, NFC-normalized text
 *
 * @remarks
 * Case is folded because {@link isResolvableNotePath} already folds it, and a
 * fold that only one side of a comparison performs is no fold. Unicode is
 * folded to NFC because APFS stores an accented name decomposed — `cafe\u0301.md`
 * — while a link typed for it arrives composed, and `toLowerCase()` alone leaves
 * those two unequal: the note resolves to nothing, and an accented subtree
 * chains to no predecessor at all.
 */
function foldNoteKey(name: string): string {
  return foldIdentity(stemOfNote(name));
}

/**
 * Whether a path names a note the CLI treats as visible — the exclusion rules `walkVault` applies
 * when it indexes the vault (dot-files, dot-directories such as `.obsidian`/`.trash`/`.git`/`.palee`,
 * and every `EXCLUDED_DIRS` entry is invisible there too), plus Markdown-only.
 *
 * @param relativePath - Vault-relative POSIX path (`MODULES/01-a.md`, `.trash/x.md`)
 * @returns `true` only when every `/`-separated segment is visible and the file ends in `.md`
 */
function isResolvableNotePath(relativePath: string): boolean {
  if (!relativePath.toLowerCase().endsWith('.md')) {
    return false;
  }
  return relativePath
    .split('/')
    .every((segment) => segment.length > 0 && !segment.startsWith('.') && !EXCLUDED_DIRS.has(segment));
}

/**
 * Traverses an Obsidian vault directory and returns absolute paths to all discovered Markdown (`.md`) notes.
 *
 * @remarks
 * Exclusion rules:
 * - Dot-directories (e.g. `.obsidian`, `.trash`, `.git`, `.palee`) matching directory entry names are skipped.
 * - Dot-files (e.g. `.hidden.md`, `.DS_Store`) are skipped.
 * - Non-markdown files are skipped. The extension is matched case-insensitively, because
 *   `isResolvableNotePath` folds case: a `Setup.MD` is invisible to no one else in the CLI,
 *   and a walker that hid it let `[[setup.md]]` resolve to a path `loadTopics` never listed.
 * - `node_modules` directory entries are skipped.
 * - Symbolic links are ignored by default unless `options.followSymlinks` is explicitly enabled.
 * - Symbolic link *files* (when followSymlinks is enabled) whose real target lies outside the vault are excluded.
 *
 * @param vaultPath - Path to the root Obsidian vault directory
 * @param options - Traversal options (e.g., `followSymlinks`)
 * @returns Array of absolute file paths to discovered `.md` files
 * @throws {Error} If the vault path does not exist, is not a directory, or lacks read permissions
 *
 * @example
 * ```typescript
 * const markdownFiles = walkVault('/Users/alex/Documents/ObsidianVault');
 * console.log(`Found ${markdownFiles.length} notes`);
 * ```
 */
function walkVault(vaultPath: string, options: WalkOptions = {}): string[] {
  const { followSymlinks = false, excludeDirs = [] } = options;
  const results: string[] = [];
  const visited = new Set<string>();
  const customExcluded = new Set([...EXCLUDED_DIRS, ...excludeDirs]);
  const absoluteVault = path.resolve(vaultPath);
  const resolvedVaultPath = fs.existsSync(absoluteVault) ? fs.realpathSync(absoluteVault) : absoluteVault;

  if (!fs.existsSync(resolvedVaultPath)) {
    throw new Error(`Vault path does not exist: ${resolvedVaultPath}`);
  }
  const rootStat = fs.statSync(resolvedVaultPath);
  if (!rootStat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${resolvedVaultPath}`);
  }
  try {
    fs.accessSync(resolvedVaultPath, fs.constants.R_OK);
  } catch {
    throw new Error(`Vault path is not readable (permission denied): ${resolvedVaultPath}`);
  }

  /**
   * Recursively traverses a subdirectory, filtering entries against exclusion rules.
   *
   * @param dir - Directory path to traverse
   * @returns Void
   *
   * @remarks
   * Evaluates directory entries with symlink escape protection, dot-directory exclusion, and custom filter rules.
   *
   * @example
   * ```typescript
   * walk('/vault/topics');
   * ```
   */
  function walk(dir: string): void {
    let realDir = dir;
    if (followSymlinks) {
      try { 
        realDir = fs.realpathSync(dir);
        const relativePath = path.relative(resolvedVaultPath, realDir);
        if (
          path.isAbsolute(relativePath) ||
          relativePath === '..' ||
          relativePath.startsWith('..' + path.sep) ||
          relativePath.startsWith('../') ||
          relativePath.split(path.sep).includes('..')
        ) return;
      } catch { return; }
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Directory read permission denied - skip silently
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      let isDir = entry.isDirectory();
      let isFil = entry.isFile();

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) {
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          isDir = stat.isDirectory();
          isFil = stat.isFile();
        } catch {
          // Dead link, skip
          continue;
        }
      }

      // Skip dot-files and dot-directories (.obsidian, .trash, .git, .hidden.md, etc.)
      if (entry.name.startsWith('.')) {
        continue;
      }

      // Skip excluded directories
      if (isDir && customExcluded.has(entry.name)) {
        continue;
      }

      if (isDir) {
        walk(fullPath);
      } else if (isFil && entry.name.toLowerCase().endsWith('.md')) {
        // For symlinked files, validate their real target is within the vault
        if (entry.isSymbolicLink() && followSymlinks) {
          try {
            const realFile = fs.realpathSync(fullPath);
            const fileRel = path.relative(resolvedVaultPath, realFile);
            if (
              path.isAbsolute(fileRel) ||
              fileRel === '..' ||
              fileRel.startsWith('..' + path.sep) ||
              fileRel.startsWith('../')
            ) {
              continue; // symlink target is outside vault — skip
            }
          } catch {
            continue; // dead or unresolvable symlink — skip
          }
        }
        results.push(fullPath);
      }
    }
  }

  walk(resolvedVaultPath);
  return results;
}

/**
 * Ensures a directory inside the vault exists, validating path boundaries and preventing symlink escapes.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param targetPath - Absolute or relative path to target directory or file within the vault
 * @returns Canonical path to the ensured directory
 * @throws {Error} With code `ECONTAINMENT` if targetPath resolves outside the vault through a
 * link — the same refusal surface as `atomicWrite` and the `.palee` tree (#335)
 * @throws {Error} If the lexical target path traverses out of the vault (`Path escapes vault boundary`)
 *
 * @remarks
 * Performs rigorous security and normalization checks:
 * 1. Resolves canonical vault root via `fs.realpathSync`.
 * 2. Normalizes relative target paths against `resolvedVault`.
 * 3. Validates boundary containment across relative traversal (`..`) and Windows drive roots.
 * 4. Asserts the *missing-leaf* path is contained via `assertContainedInVault` before creating it.
 * 5. Recursively creates the directory and re-asserts the canonical path it landed on.
 *
 * Step 4 replaced a bespoke pre-creation ancestor check (#335). The old shape was
 * create-then-verify: it canonicalised the first *existing* ancestor, ran
 * `mkdirSync(…, { recursive: true })`, and only then re-canonicalised the result and
 * refused. A link planted in the window between that ancestor read and the `mkdir`
 * therefore made the recursive create materialise directories outside the vault, and
 * the refusal — while it did fail closed — arrived after the damage. Certifying the
 * path that is about to be created, before creating it, is what `atomicWrite` and the
 * `.palee` tree sites already do with the one shared predicate (`isWithinVault`), so
 * this path now shares that refusal surface instead of a second prefix comparison
 * that could disagree with it.
 *
 * What this does NOT do, stated plainly: the window between the last `realpathSync`
 * of the certification and `mkdirSync` is a TOCTOU gap that is not closable from JS —
 * `src/storage/atomic-write.ts` records the same limit for the write path. Re-asserting
 * after the create (step 5) keeps that residual race failing closed, and a link that
 * is already resolvable out of the vault is now refused before anything is created;
 * neither makes a symlink race unexploitable.
 *
 * @example
 * ```typescript
 * const dir = ensureVaultDirectory('/path/to/vault', 'topics/math/algebra.md');
 * ```
 */
function ensureVaultDirectory(vaultPath: string, targetPath: string): string {
  const resolvedVault = fs.realpathSync(path.resolve(vaultPath));
  const absoluteTarget = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(resolvedVault, targetPath);
  const targetDir = path.extname(absoluteTarget) ? path.dirname(absoluteTarget) : absoluteTarget;

  // Boundary check: ensure targetDir does not escape vault across relative or cross-drive paths
  const relative = path.relative(resolvedVault, targetDir);
  if (
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    relative.startsWith('../') ||
    relative.split(path.sep).includes('..')
  ) {
    throw new Error(`Path escapes vault boundary: ${targetPath}`);
  }

  // Pre-creation containment assertion (#335): canonicalise the path that is about to
  // be made — existing prefix resolved, missing leaf re-attached — and refuse it here,
  // before any `mkdirSync` runs. Creating first and checking the result afterwards
  // left the out-of-vault directories on disk for a refusal that came too late.
  const certified = assertContainedInVault(resolvedVault, targetDir);

  if (!fs.existsSync(certified)) {
    fs.mkdirSync(certified, { recursive: true });
  }

  // Re-asserted on the created path, the way `atomicWrite` re-asserts before it
  // renames: the certification describes the vault as it was when it ran, and a link
  // installed between it and the `mkdir` above still resolves out. That gap is one
  // syscall wide and cannot be closed from JS; this only narrows it, and it keeps the
  // narrowed race failing closed instead of returning an escaping path.
  return assertContainedInVault(resolvedVault, certified);
}

/**
 * Computes a vault-relative POSIX-style path for an absolute file path.
 *
 * @param vaultPath - Vault root path as given by the caller (may itself
 * contain symlinked segments)
 * @param filePath - Absolute path to a file inside the vault (walked or
 * caller-supplied)
 * @returns POSIX-style relative path (`sub/note.md`); `..`-prefixed only
 * when the file genuinely lies outside the vault
 *
 * @remarks
 * `walkVault` resolves the vault root through `realpathSync` (#122), so
 * walked file paths can be prefixed differently from the caller's root —
 * the canonical macOS case is a temp vault under `/var/folders/…` where
 * walked paths come back under `/private/var/folders/…`. A lexical
 * `path.relative(vaultPath, filePath)` then produces garbage like
 * `../../private/var/…/note.md`. This helper detects exactly that
 * situation — the lexical relative path escaping the root while the file
 * is actually inside it — and re-derives the relative path from both
 * canonicalized endpoints. On filesystems without symlinked roots the
 * lexical result already stays inside the vault, so no `realpath` syscall
 * is paid and the fast path returns directly.
 */
function relativeVaultPath(vaultPath: string, filePath: string): string {
  const lexical = path.relative(path.resolve(vaultPath), path.resolve(filePath)).replace(/\\/g, '/');
  // A well-formed in-vault path never escapes the root lexically. An
  // escaping result means the two paths disagree about symlinked segments
  // (e.g. walked `/private/...` vs caller `/var/...`) — resolve both
  // endpoints canonically and try again. Files that truly live outside
  // the vault keep the escaping lexical path (truthful reporting).
  if (
    lexical === '' ||
    lexical === '..' ||
    lexical.startsWith('../') ||
    path.isAbsolute(lexical)
  ) {
    try {
      const canonicalRoot = fs.realpathSync(path.resolve(vaultPath));
      const canonicalFile = fs.realpathSync(path.resolve(filePath));
      const canonical = path.relative(canonicalRoot, canonicalFile).replace(/\\/g, '/');
      // Keep the canonical result only when the file is genuinely inside
      // the root; otherwise the file is truly outside — lexical is truth.
      // The containment check must be exact (`..` or `../` prefix), not the
      // broad startsWith('..'): a valid in-vault file named `..note.md`
      // would otherwise be misclassified as parent traversal and keep the
      // escaping lexical path (Greptile P2, #161).
      if (
        canonical !== '' &&
        canonical !== '..' &&
        !canonical.startsWith('../') &&
        !path.isAbsolute(canonical)
      ) {
        return canonical;
      }
    } catch {
      // realpath failed (deleted mid-scan, unreadable): the lexical path is
      // the best available answer; report it as-is.
    }
  }
  return lexical;
}

export { walkVault, ensureVaultDirectory, relativeVaultPath, isResolvableNotePath, stemOfNote, foldNoteKey, foldIdentity };
