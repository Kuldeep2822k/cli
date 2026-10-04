/**
 * Vault Containment for Write Destinations (#264)
 *
 * @remarks
 * Thin canonicalisation layer over {@link isWithinVault}, the repo's
 * authoritative containment guard (see `src/engine/toc-chain.ts`): that predicate
 * already compares two *canonical* absolute paths, and every escape this module
 * refuses was invisible only because nobody had canonicalised the destination
 * before comparing it. Deliberately no second containment predicate — two
 * guards that disagree about what "inside the vault" means is worse than none.
 *
 * The canonicalisation is the part a write path needs and a read path never
 * did: the destination file usually does not exist yet, and the link that
 * redirects it sits in an ancestor directory. So the existing portion of the
 * path is resolved with `fs.realpathSync` and the missing tail re-attached,
 * exactly as `deleteSessionNote` (`src/storage/memory.ts`) and
 * `ensureVaultDirectory` (`src/storage/vault-walker.ts`) already do.
 *
 * Win32 handling, inherited from that precedent rather than reinvented:
 * - Both endpoints go through the same `fs.realpathSync`, so a caller spelling
 *   that differs only in case, or an 8.3 short name such as `KULDE~1`, expands
 *   identically on both sides instead of reading as an escape. `path.relative`
 *   on win32 compares case-insensitively; on a case-sensitive volume it does not,
 *   which is the correct answer there.
 * - `fs.realpathSync` (not `.native`) is used everywhere in this layer, because
 *   `native` may spell the root with a `\\?\` device prefix that no other path
 *   in the vault carries — `src/storage/wikilink.ts:149-152` records the same
 *   constraint for the read side.
 * - A different volume (`D:` against a `C:` vault) yields an absolute relative
 *   path, which {@link isWithinVault} rejects; the walk up the ancestor chain
 *   stops at the volume root, where `path.dirname` returns its argument.
 */

import fs from 'fs';
import path from 'path';
import { NodeError } from '../types';
import { isWithinVault } from './wikilink';

/** Error `code` carried by a containment refusal. */
const CONTAINMENT_ERROR_CODE = 'ECONTAINMENT';

/** Message prefix of a containment refusal; mirrors `deleteSessionNote`'s `Security error:` voice. */
const CONTAINMENT_MESSAGE_PREFIX = 'Security error: refusing to write outside the vault:';

/**
 * Checks whether an error is the containment refusal — a write destination that
 * resolves outside the vault.
 *
 * @param e - Error object or unknown caught value
 * @returns `true` if the error refuses an escaping destination, otherwise `false`
 *
 * @remarks
 * Deliberately the mirror image of {@link isConflictError}, and the two must stay
 * distinguishable: a conflict is retryable (`ExitCode.Conflict`), a containment
 * refusal is a vault integrity condition that no retry can fix.
 *
 * @example
 * ```typescript
 * try {
 *   await atomicWrite(vault, target, content);
 * } catch (err) {
 *   if (isContainmentError(err)) reportPlantedLink(vault);
 * }
 * ```
 */
function isContainmentError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: string; message?: string };
  if (err.code === CONTAINMENT_ERROR_CODE) return true;
  return typeof err.message === 'string' && err.message.startsWith(CONTAINMENT_MESSAGE_PREFIX);
}

/**
 * Canonicalises an absolute path by resolving its existing portion and re-attaching
 * the components that do not exist yet.
 *
 * @param absolute - Absolute path, lexical or already canonical
 * @returns Absolute path whose existing prefix is `fs.realpathSync`-resolved
 * @throws {NodeError} Rethrown when an existing component is unreadable for a
 * reason other than `ENOENT`/`ENOTDIR` — an ancestry this function cannot verify
 * is not an ancestry this module can vouch for, so it fails closed.
 *
 * @remarks
 * `fs.realpathSync` on a path with a missing leaf throws, and the destination of
 * a write is normally exactly that; resolving only the existing portion is what
 * makes a mid-path junction or symlinked directory visible here at all.
 */
function canonicalExistingPrefix(absolute: string): string {
  const missing: string[] = [];
  let leaf = absolute;
  while (true) {
    let canonical: string;
    try {
      canonical = fs.realpathSync(leaf);
    } catch (e: unknown) {
      const code = (e as NodeError).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = path.dirname(leaf);
      if (parent === leaf) {
        // Nothing on the chain exists (an uncreated vault, say). The lexical
        // path is the best available answer, and the caller's own root is
        // canonicalised the same way, so the comparison still holds.
        return absolute;
      }
      missing.push(path.basename(leaf));
      leaf = parent;
      continue;
    }
    return missing.length > 0 ? path.join(canonical, ...missing.reverse()) : canonical;
  }
}

/**
 * Resolves a write destination against the vault and refuses it if it lands outside.
 *
 * @param vaultPath - Vault root as the caller has it (absolute or relative, and
 * itself possibly reached through a link)
 * @param destinationPath - Path of the file or directory about to be written. A
 * relative path is resolved against the vault root, so a caller that goes on to
 * hand its own argument to `fs` must pass an absolute one — or use the returned
 * path, which is what `atomicWrite` does (#264)
 * @returns The canonical destination path, for callers that want to write or
 * report exactly the path that was certified
 * @throws {NodeError} With code `ECONTAINMENT` when the resolved destination
 * lies outside the canonical vault root
 *
 * @remarks
 * Guards directories as well as notes, and before they exist: besides the
 * `atomicWrite` destination it runs on the `.palee` tree at the sites that create
 * it — `getPaleeDir` and `getSessionsDir` (`src/storage/memory.ts`), `getLockDir`
 * (`src/storage/lock.ts`). Those sites gate on `fs.existsSync`, which follows
 * links, so a junctioned `.palee` let `mkdirSync(…, { recursive: true })` make a
 * real directory outside the vault *before* any write was refused. Asserting the
 * tree is the half of #264 that the write guard could not cover, and it is the
 * same refusal: a planted link that would put a directory outside the vault is the
 * identical vault-integrity defect as one that would put a note there, so it gets
 * the same code, the same message and the same exit 3 rather than a second error
 * kind for callers to forget.
 *
 * Both endpoints are canonicalised *before* the comparison, which is what closes
 * the two ways a lexical check can be wrong in opposite directions: a
 * `/vault/../vault/note.md` spelling that genuinely resolves inside (a prefix
 * check on the raw string would refuse it), and a `/vault/../../outside/note.md`
 * spelling whose string still starts with the vault root (a prefix check would
 * accept it).
 *
 * One state stays visible rather than refused, and is worth naming: a link whose
 * target does not exist yet cannot be resolved — `fs.realpathSync` fails with
 * `ENOENT`, the walk-up reads the linked component as merely missing, and the path
 * canonicalises to itself inside the vault. Nothing is created outside in that
 * state either: `mkdirSync` through a dangling link fails (`ENOENT` on a Windows
 * junction) rather than materialising the target, so the tree sites surface a
 * filesystem error, not a vault escape. This guard refuses a link that *resolves*
 * out of the vault.
 *
 * The vault root is resolved first and separately, so a root that is *itself* a
 * symlink — a user pointing `vaultPath` at a link, or a macOS temp dir behind
 * `/var` — compares against its own target and stays legal rather than making
 * every write look like an escape.
 *
 * Link *type* is not part of the decision: a Windows junction, a POSIX symlinked
 * directory, and a symlinked final component all resolve out of the vault and all
 * get refused, while a hardlink is not a link this layer can see (its canonical
 * path is itself, and the bytes stay in the vault's own directory tree — the
 * residual #218 left open deliberately).
 */
function assertContainedInVault(vaultPath: string, destinationPath: string): string {
  const resolvedVault = canonicalExistingPrefix(path.resolve(vaultPath));
  const absolute = path.isAbsolute(destinationPath)
    ? path.resolve(destinationPath)
    : path.resolve(resolvedVault, destinationPath);
  const canonical = canonicalExistingPrefix(absolute);

  if (!isWithinVault(resolvedVault, canonical)) {
    const refusal = new Error(
      `${CONTAINMENT_MESSAGE_PREFIX} ${destinationPath} resolves to ${canonical}`
    ) as NodeError;
    refusal.code = CONTAINMENT_ERROR_CODE;
    throw refusal;
  }

  return canonical;
}

export { assertContainedInVault, isContainmentError, CONTAINMENT_ERROR_CODE };
