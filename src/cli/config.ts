/**
 * Config Command Handler
 * Manages PALEE configuration
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { PaleeConfig, NodeError } from '../types';

function getConfigPath(): string {
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

function loadConfig(): PaleeConfig {
  const configPath = getConfigPath();
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data) as PaleeConfig;
  } catch (e: unknown) {
    const err = e as NodeError;
    if (err.code === 'ENOENT') {
      return {}; // No config file yet
    }
    throw err;
  }
}

function saveConfig(config: PaleeConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

async function configCommand(action?: string, value?: string): Promise<void> {
  try {
    if (!action || action === 'show') {
      const config = loadConfig();
      console.log('PALEE Configuration:');
      console.log(`  Vault Path: ${config.vaultPath || '(not set)'}`);
      console.log(`  AI Provider: ${config.aiProvider || '(not set)'}`);
      console.log(`  Model: ${config.model || '(not set)'}`);
      process.exit(0);
    }

    if (action === 'set-vault') {
      if (!value) {
        console.error('Error: vault path required');
        process.exit(2);
      }

      const absolutePath = path.resolve(value);
      if (!fs.existsSync(absolutePath)) {
        console.error(`Error: vault path does not exist: ${absolutePath}`);
        process.exit(2);
      }

      const config = loadConfig();
      config.vaultPath = absolutePath;
      saveConfig(config);
      console.log(`Vault path set to: ${absolutePath}`);
      process.exit(0);
    }

    if (action === 'set-provider') {
      if (!value) {
        console.error('Error: provider name required');
        process.exit(2);
      }

      const config = loadConfig();
      config.aiProvider = value;
      saveConfig(config);
      console.log(`AI provider set to: ${value}`);
      process.exit(0);
    }

    if (action === 'set-model') {
      if (!value) {
        console.error('Error: model name required');
        process.exit(2);
      }

      const config = loadConfig();
      config.model = value;
      saveConfig(config);
      console.log(`Model set to: ${value}`);
      process.exit(0);
    }

    console.error(`Error: unknown action '${action}'`);
    console.error('Valid actions: show, set-vault, set-provider, set-model');
    process.exit(2);

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export { loadConfig, saveConfig };
export default configCommand;
