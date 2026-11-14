/**
 * The config-file path resolver.
 *
 * @remarks
 * A leaf module on purpose: `update-check` and `vault-echo` need only this
 * path, and importing it from `config.ts` dragged the whole config handler —
 * and, through it, the AI provider layer — into every run that never touches
 * that command (#565 P2-12). `config.ts` re-exports it, so existing importers
 * keep their specifier.
 */

import path from 'path';
import os from 'os';

/**
 * Resolves the platform-specific path to the PALEE config JSON file.
 *
 * @returns The absolute file path to config.json.
 * @throws {Error} If LOCALAPPDATA environment variable is missing on Windows.
 *
 * @remarks
 * Checks `PALEE_CONFIG_DIR`, defaulting to `%LOCALAPPDATA%/palee` on Windows or `~/.config/palee` on POSIX.
 *
 * @example
 * ```typescript
 * const configPath = getConfigPath();
 * ```
 */
export function getConfigPath(): string {
  if (process.env.PALEE_CONFIG_DIR) {
    return path.join(process.env.PALEE_CONFIG_DIR, 'config.json');
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA environment variable not set');
    }
    return path.join(localAppData, 'palee', 'config.json');
  } else {
    return path.join(os.homedir(), '.config', 'palee', 'config.json');
  }
}
