/**
 * Vault Target Resolution and Echo
 * Names the config file and the vault a command resolved for this run
 *
 * @remarks
 * `PALEE_CONFIG_DIR` is the only per-run config override, and when it is unset
 * every command silently falls back to the machine-global config — so a scripted
 * run that forgets the export reads and writes whatever vault that file happens
 * to point at (#311). Mutating commands used to finish at exit 0 without ever
 * printing the vault they touched. This module resolves the vault once, at the
 * point of validation, and echoes it there, so the guard lives in one place
 * instead of being re-typed in every command file.
 */

import { PaleeConfig } from '../types';
import { getConfigPath } from './config';
import { validateVaultPath } from './onboarding';

/**
 * What a command resolved for this run: the vault it reads or writes, and the
 * config file that named it.
 *
 * @remarks
 * Both are paths, never credential material — the API key stays out of this
 * struct and out of every line and field this module emits.
 */
export interface VaultTarget {
  /** Resolved absolute path of the vault the command acts on. */
  vaultPath: string;
  /** Absolute path of the `config.json` that supplied it. */
  configPath: string;
}

/**
 * Options for {@link resolveVaultTarget}.
 */
export interface ResolveVaultTargetOptions {
  /**
   * The handler emits a machine-readable JSON payload for this invocation, so
   * the target goes into that payload via {@link vaultTargetFields} instead of
   * being printed as a line. A bare `console.log` above a JSON object would
   * break the callers that parse `stdout`.
   */
  json?: boolean;
  /**
   * Set to `false` on a read-only code path, where naming the vault is not what
   * this module exists for. Mutating paths leave it unset and get the line.
   */
  echo?: boolean;
}

/**
 * Resolves and validates the vault a command will act on, echoing what it
 * resolved to before the first write happens.
 *
 * @param config - The loaded configuration, whose `vaultPath` is validated.
 * @param options - `json` suppresses the line echo because the caller puts the
 * fields in its payload; `echo: false` suppresses it for read-only paths.
 * @returns The resolved {@link VaultTarget}, or `null` when the vault is missing
 * or unusable — in which case `validateVaultPath` has already reported it and set
 * the exit code, so the caller only has to return.
 *
 * @remarks
 * Every handler that calls this already started with `loadConfig()` +
 * `validateVaultPath(config.vaultPath, …)`, so swapping those two lines for this
 * one costs no downstream churn: the returned `vaultPath` is the same string.
 * The echo is plain `console.log` lines in the house style — `•` bullets, no
 * ANSI, no emoji — written before the handler resolves a single note.
 *
 * @example
 * ```typescript
 * const target = resolveVaultTarget(config);
 * if (!target) return;
 * const vaultPath = target.vaultPath;
 * ```
 */
export function resolveVaultTarget(
  config: PaleeConfig,
  options: ResolveVaultTargetOptions = {}
): VaultTarget | null {
  const vaultPath = validateVaultPath(config.vaultPath, { json: options.json });
  if (!vaultPath) return null;

  const target: VaultTarget = { vaultPath, configPath: getConfigPath() };
  if (!options.json && options.echo !== false) echoVaultTarget(target);
  return target;
}

/**
 * Prints the resolved vault and config path.
 *
 * @param target - The target returned by {@link resolveVaultTarget}.
 * @returns Void
 *
 * @remarks
 * Two lines, vault first, because the vault is the one that can be somebody
 * else's. Nothing here refuses the write: a single-vault user's global config is
 * not a mistake, it is the normal case, and the defect was that the run never
 * said which vault it acted on — not that the fallback exists.
 *
 * @example
 * ```typescript
 * echoVaultTarget({ vaultPath: 'D:/vault', configPath: 'C:/…/palee/config.json' });
 * ```
 */
export function echoVaultTarget(target: VaultTarget): void {
  console.log(`• Vault:  ${target.vaultPath}`);
  console.log(`• Config: ${target.configPath}`);
}

/**
 * The JSON-payload form of {@link echoVaultTarget}.
 *
 * @param target - The target returned by {@link resolveVaultTarget}.
 * @returns The two snake_case fields to spread into the command's payload.
 *
 * @remarks
 * Same two facts, machine-readable, and the same rule: paths only, never a
 * credential.
 *
 * @example
 * ```typescript
 * console.log(JSON.stringify({ status: 'drafts_pending', ...vaultTargetFields(target) }));
 * ```
 */
export function vaultTargetFields(target: VaultTarget): { vault_path: string; config_path: string } {
  return { vault_path: target.vaultPath, config_path: target.configPath };
}
