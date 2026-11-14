/**
 * `.palee` Tree Guards
 *
 * @remarks
 * The directory ensure-and-contain primitives of the PALEE memory
 * subsystem, extracted from `src/storage/memory.ts` by the P3-14 phase
 * split (#565) so the hot/index, sessions and drafts modules can share
 * them without reaching back through the `memory.ts` facade. Both guards
 * refuse a `.palee` (or `.palee/sessions`) that resolves outside the
 * vault *before* creating it, so a planted junction cannot make a
 * directory outside the vault on the way to a refused write (#264).
 */

import fs from 'fs';
import path from 'path';
import { assertContainedInVault } from './containment';

/**
 * Ensures and returns the `.palee` hidden directory inside the vault.
 *
 * @param vaultPath - Vault root path
 * @returns Path to `.palee` directory
 * @remarks Creates the directory recursively if it does not already exist.
 * @throws {NodeError} If `.palee` resolves outside the vault (`ECONTAINMENT`)
 * @example
 * ```typescript
 * const dir = getPaleeDir('/path/to/vault');
 * ```
 */
export function getPaleeDir(vaultPath: string): string {
  // `resolve`, not `join`. With a relative `vaultPath` a joined path is relative
  // too, and `assertContainedInVault` resolves a *relative* destination against
  // the vault root — the check then certified `<cwd>/vault/vault/.palee` while
  // the `mkdirSync` below created `<cwd>/vault/.palee`. Checked and created were
  // two different paths, so a planted link was never inspected and a real
  // directory still appeared outside the vault. One absolute path serves the
  // check, the creation and the returned value (#264 review).
  const dir = path.resolve(vaultPath, '.palee');
  // Containment before the `mkdirSync`, not merely before the note write (#264).
  // `existsSync` follows links, so with `.palee` itself planted as a junction this
  // call saw "already there", walked straight through it, and every `.palee` child
  // was then created *outside* the vault — a real directory made before
  // `atomicWrite` ever got a path it had to refuse. Asserting the tree here is what
  // makes the refusal create nothing.
  //
  // Same refusal surface as the write path, deliberately: `ECONTAINMENT`, the same
  // message and so the same exit 3 from `exitCodeFor`. Creating a directory outside
  // the vault through a planted link is the identical vault-integrity defect as
  // writing a note there and is no more retryable, so it gets one classifier and
  // one handler rather than a second error kind to forget about.
  assertContainedInVault(vaultPath, dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Ensures and returns the `.palee/sessions` directory inside the vault.
 *
 * @param vaultPath - Vault root path
 * @returns Path to `.palee/sessions` directory
 * @remarks Creates the directory recursively if it does not already exist.
 * @throws {NodeError} If `.palee/sessions` resolves outside the vault (`ECONTAINMENT`)
 * @example
 * ```typescript
 * const dir = getSessionsDir('/path/to/vault');
 * ```
 */
export function getSessionsDir(vaultPath: string): string {
  // Anchored like `getPaleeDir`: a relative `vaultPath` here would certify
  // `<vault>/<vault>/.palee/sessions` and then create `<vault>/.palee/sessions`.
  const dir = path.resolve(vaultPath, '.palee', 'sessions');
  // The sessions tree gets its own assertion rather than relying on `getPaleeDir`,
  // because it does not call it: canonicalising `.palee/sessions` resolves *through*
  // `.palee`, so this one check covers a junction at either level and any planted
  // intermediate component (#264). Runs before the `existsSync` gate, so a link is
  // refused instead of walked through into `mkdirSync` outside the vault; see
  // `getPaleeDir` for why the refusal is the same `ECONTAINMENT` surface as the
  // note write.
  assertContainedInVault(vaultPath, dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
