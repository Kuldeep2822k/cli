import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseFrontmatter, updateFrontmatter } from '../../src/storage';

export interface CLIResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface TestVaultEnv {
  tempDir: string;
  configDir: string;
  vaultDir: string;
  run: (args: string[], options?: { input?: string; env?: Record<string, string> }) => CLIResult;
  createTopic: (filename: string, frontmatter: Record<string, unknown>, body?: string) => string;
  updateTopic: (filename: string, updates: Record<string, unknown>, body?: string) => string;
  readTopic: (filename: string) => { frontmatter: Record<string, unknown> | null; body: string; raw: string };
  readHotMemory: () => { frontmatter: Record<string, unknown> | null; body: string; raw: string } | null;
  readSessionIndex: () => { frontmatter: Record<string, unknown> | null; body: string; raw: string } | null;
  listSessions: () => { confirmed: string[]; drafts: string[] };
  cleanup: () => void;
}

const PALEE_BIN = path.resolve(__dirname, '../../bin/palee.ts');
const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Executes the PALEE CLI binary synchronously in an isolated child process.
 *
 * @param args - CLI arguments to pass to the binary
 * @param configDir - Isolated directory containing config.json
 * @param options - Additional options including piped input, custom env vars, and working directory
 * @returns CLI execution result containing status code, stdout, and stderr
 */
export function runPalee(
  args: string[],
  configDir: string,
  options?: { input?: string; env?: Record<string, string>; cwd?: string }
): CLIResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', PALEE_BIN, ...args], {
    cwd: options?.cwd || REPO_ROOT,
    env: {
      ...process.env,
      PALEE_CONFIG_DIR: configDir,
      NODE_ENV: 'test',
      ...(options?.env || {}),
    },
    input: options?.input,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

/**
 * Re-export of runPalee under the runPaleeCli alias for compatibility.
 */
export const runPaleeCli = runPalee;

/**
 * Creates an isolated temporary vault environment for E2E and stress tests.
 *
 * @param prefix - Prefix for the temporary directory name
 * @returns Configured TestVaultEnv helper suite
 */
export function createTestVault(prefix = 'palee-e2e-'): TestVaultEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(tempDir, 'config');
  const vaultDir = path.join(tempDir, 'vault');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });

  // Initialize config pointing to vaultDir
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ vaultPath: vaultDir }, null, 2),
    'utf8'
  );

  const run = (args: string[], options?: { input?: string; env?: Record<string, string> }): CLIResult => {
    return runPalee(args, configDir, options);
  };

  const createTopic = (filename: string, frontmatter: Record<string, unknown>, body = 'Topic notes content.'): string => {
    const fullPath = path.join(vaultDir, filename);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const defaultFm: Record<string, unknown> = {
      palee_schema: 1,
      difficulty: 'intermediate',
      depends_on: [],
      topic_mastery: 0.0,
      ...frontmatter,
    };

    const content = updateFrontmatter(`# ${frontmatter.title || frontmatter.palee_id || 'Untitled'}\n\n${body}`, defaultFm);
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
  };

  const updateTopic = (filename: string, updates: Record<string, unknown>, body?: string): string => {
    const fullPath = path.isAbsolute(filename) ? filename : path.join(vaultDir, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Topic file does not exist: ${fullPath}`);
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    const updated = updateFrontmatter(raw, updates);
    let finalContent = updated;
    if (body !== undefined) {
      const parsed = parseFrontmatter(updated);
      if (parsed.raw !== null) {
        finalContent = `---\n${parsed.raw}\n---\n${body}`;
      } else {
        finalContent = body;
      }
    }
    fs.writeFileSync(fullPath, finalContent, 'utf8');
    return fullPath;
  };

  const readTopic = (filename: string) => {
    const fullPath = path.isAbsolute(filename) ? filename : path.join(vaultDir, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Topic file does not exist: ${fullPath}`);
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = parseFrontmatter(raw);
    return {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      raw,
    };
  };

  const readHotMemory = () => {
    const hotPath = path.join(vaultDir, '.palee', 'hot.md');
    if (!fs.existsSync(hotPath)) return null;
    const raw = fs.readFileSync(hotPath, 'utf8');
    const parsed = parseFrontmatter(raw);
    return {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      raw,
    };
  };

  const readSessionIndex = () => {
    const indexPath = path.join(vaultDir, '.palee', 'index.md');
    if (!fs.existsSync(indexPath)) return null;
    const raw = fs.readFileSync(indexPath, 'utf8');
    const parsed = parseFrontmatter(raw);
    return {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      raw,
    };
  };

  const listSessions = () => {
    const sessionsDir = path.join(vaultDir, '.palee', 'sessions');
    if (!fs.existsSync(sessionsDir)) return { confirmed: [], drafts: [] };
    const files = fs.readdirSync(sessionsDir);
    return {
      confirmed: files.filter(f => f.startsWith('S-') && f.endsWith('.md')).sort().reverse(),
      drafts: files.filter(f => f.startsWith('DRAFT-S-') && f.endsWith('.md')).sort().reverse(),
    };
  };

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  };

  return {
    tempDir,
    configDir,
    vaultDir,
    run,
    createTopic,
    updateTopic,
    readTopic,
    readHotMemory,
    readSessionIndex,
    listSessions,
    cleanup,
  };
}
