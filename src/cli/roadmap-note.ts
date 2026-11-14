/**
 * Roadmap Note IO — Canonical Paths and Descriptor-Bound Reads
 *
 * @remarks
 * The note-IO safety phase of `palee roadmap --from`, extracted from the
 * handler in `src/cli/roadmap.ts` by the P3-14 phase split (#565): the
 * canonicalizer that makes every roadmap-declared path comparable against the
 * vault boundary, and the descriptor-bound read that closes the
 * check-then-use window a planted symlink would otherwise exploit. Shared by
 * the validation pass, the dry-run plan, the pre-write graph check and the
 * import write loop; the field values those passes write live in
 * `./roadmap-resolve`.
 */

import fs from 'fs';
import path from 'path';
import { noteExceedsReadCap, oversizedNoteDiagnostic } from '../storage/source-cap';

/**
 * Canonical absolute form of a roadmap-declared topic path for boundary checks.
 *
 * @param resolvedVault - Canonical vault root (`fs.realpathSync`ed)
 * @param declared - The `path` as written in the roadmap (vault-relative or absolute)
 * @returns Absolute canonical path, so it compares equal to `resolvedVault`
 *
 * @remarks
 * `isWithinVault` requires both endpoints canonical, but an absolute declared
 * path was only lexically resolved. On a machine whose temp dir passes through
 * a symlink (macOS `/var` → `/private/var`) the lexical form never sits under
 * the resolved vault, so every absolute declaration read as an escape. An
 * existing file resolves directly; a note this import is about to create
 * resolves through its nearest existing ancestor. That stays fail-closed: a
 * symlinked ancestor pointing out of the vault still fails the check rather
 * than slipping through.
 */
export function canonicalDeclaredPath(resolvedVault: string, declared: string): string {
  const absolute = path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(resolvedVault, declared);
  // A symlinked final component is never followed here: a symlinked target
  // is never a note, and the importer's `lstat` guard owns that case ("not a
  // regular file", skipping one topic). Following it would re-report it as
  // an escape and fail validation for the whole batch instead. Only the
  // parent chain is canonicalized, which is also what a symlinked temp root
  // needs. Missing leaves resolve through the nearest existing ancestor, so
  // a note this import is about to create still compares against the vault.
  let leaf = absolute;
  const suffix: string[] = [];
  while (true) {
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(leaf);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isSymbolicLink() && suffix.length === 0) {
        try {
          return path.join(fs.realpathSync(path.dirname(leaf)), path.basename(leaf));
        } catch {
          return absolute;
        }
      }
      try {
        const canonicalBase = fs.realpathSync(leaf);
        return suffix.length > 0 ? path.join(canonicalBase, ...suffix) : canonicalBase;
      } catch {
        return absolute;
      }
    }
    const parent = path.dirname(leaf);
    if (parent === leaf) return absolute;
    suffix.unshift(path.basename(leaf));
    leaf = parent;
  }
}

/**
 * Reads a vault note through a descriptor bound to the file `lstat` validated.
 *
 * @param targetPath - The note path the caller checked
 * @param expected - The `lstat` result that established it as a regular file inside the vault
 * @returns The note's text
 * @throws Error when the path cannot be opened, or no longer holds the file that was validated
 *
 * @remarks
 * Every vault check above a read is check-then-use, so a symlink planted after
 * them is still followed and its outside content imported as the note's own
 * text. Opening first and comparing the descriptor's identity against the
 * earlier `lstat` closes that for the read: the bytes come from the object that
 * was validated, and a swap underneath shows up as a different inode before
 * anything is read.
 *
 * Identity comparison is the form that works everywhere this CLI ships. A
 * no-follow open does not: `fs.constants.O_NOFOLLOW` is undefined on win32, so
 * the open follows the link anyway. Nor does resolving a descriptor —
 * `fs.realpathSync` reads a number as a path relative to the working directory
 * on win32 rather than reporting the open file.
 *
 * A planted *hard* link stays invisible to this and to every path-based check:
 * it is not a reference to another file but a second name for the same one.
 */
export function readBoundNote(targetPath: string, expected: fs.Stats): string {
  const fd = fs.openSync(targetPath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== expected.ino || opened.dev !== expected.dev) {
      throw new Error(`${targetPath} changed between validation and read`);
    }
    // #565 P1-10: the cap is applied to the descriptor's own byte count. A second
    // `stat` on the path would reopen the check-then-use window this function exists to
    // close, and this writer is the one place the size is already in hand.
    if (noteExceedsReadCap(opened.size)) {
      throw new Error(oversizedNoteDiagnostic(opened.size));
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
