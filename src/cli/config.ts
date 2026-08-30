/**
 * Config Command Handler
 * Manages PALEE configuration
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { PaleeConfig, NodeError } from '../types';

/**
 * Resolves the platform-specific path to the PALEE config JSON file.
 *
 * @returns The absolute file path to config.json.
 * @throws {Error} If LOCALAPPDATA environment variable is missing on Windows.
 */
function getConfigPath(): string {
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

/**
 * Loads and parses the stored PALEE configuration from disk.
 *
 * @returns The parsed PaleeConfig object, or an empty object if no config file exists or content is malformed.
 */
function loadConfig(): PaleeConfig {
  const configPath = getConfigPath();
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    if (!data.trim()) {
      return {};
    }
    return JSON.parse(data) as PaleeConfig;
  } catch (e: unknown) {
    const err = e as NodeError;
    if (err.code === 'ENOENT') {
      return {}; // No config file yet
    }
    if (e instanceof SyntaxError) {
      console.error(`Warning: Corrupted configuration at ${configPath}. Falling back to default configuration.`);
      return {};
    }
    throw err;
  }
}

/**
 * Persists the given PALEE configuration object to disk as JSON atomically.
 *
 * @param config - The updated configuration object to write.
 */
function saveConfig(config: PaleeConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(config, null, 2);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeSync(fd, payload, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  fs.renameSync(tempPath, configPath);
}

/**
 * CLI command handler for managing configuration (show, set-vault, set-provider, set-model).
 *
 * @param action - Optional configuration action (show, set-vault, set-provider, set-model).
 * @param value - Optional value to set for the given action.
 * @returns Promise resolving when the command finishes.
 * @remarks Sets process.exitCode = 2 on missing/invalid arguments or unknown actions,
 * and process.exitCode = 5 on unexpected exceptions.
 */
async function configCommand(action?: string, value?: string): Promise<void> {
  try {
    if (!action || action === 'show') {
      const config = loadConfig();
      console.log('PALEE Configuration:');
      console.log(`  Vault Path: ${config.vaultPath || '(not set)'}`);
      console.log(`  AI Provider: ${config.aiProvider || '(not set)'}`);
      console.log(`  Model: ${config.model || '(not set)'}`);
      return;
    }

    if (action === 'set-vault') {
      if (!value) {
        console.error('Error: vault path required');
        process.exitCode = 2;
        return;
      }

      const absolutePath = path.resolve(value);
      if (!fs.existsSync(absolutePath)) {
        console.error(`Error: vault path does not exist: ${absolutePath}`);
        process.exitCode = 2;
        return;
      }
      if (!fs.statSync(absolutePath).isDirectory()) {
        console.error(`Error: vault path is not a directory: ${absolutePath}`);
        process.exitCode = 2;
        return;
      }

      const config = loadConfig();
      config.vaultPath = absolutePath;
      saveConfig(config);
      console.log(`Vault path set to: ${absolutePath}`);
      return;
    }

    if (action === 'set-provider') {
      if (!value) {
        console.error('Error: provider name required');
        process.exitCode = 2;
        return;
      }

      const config = loadConfig();
      config.aiProvider = value;
      saveConfig(config);
      console.log(`AI provider set to: ${value}`);
      return;
    }

    if (action === 'set-model') {
      if (!value) {
        console.error('Error: model name required');
        process.exitCode = 2;
        return;
      }

      const config = loadConfig();
      config.model = value;
      saveConfig(config);
      console.log(`Model set to: ${value}`);
      return;
    }

    console.error(`Error: unknown action '${action}'`);
    console.error('Valid actions: show, set-vault, set-provider, set-model');
    process.exitCode = 2;
    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = 5;
    return;
  }
}

export { loadConfig, saveConfig };
export default configCommand;
