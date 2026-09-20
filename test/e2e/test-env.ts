import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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
  runInteractive: (
    args: string[],
    steps: Array<{ waitFor: RegExp; write: string }>
  ) => Promise<CLIResult>;
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

  if (result.error) {
    throw new Error(`Process spawn error during '${args.join(' ')}': ${result.error.message}\n${result.error.stack}`);
  }

  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Re-export of runPalee under the runPaleeCli alias for compatibility.
 */
export const runPaleeCli = runPalee;

/**
 * Runs the PALEE CLI over a live stdin pipe, writing each queued input line
 * only after its `waitFor` marker shows up in the accumulated stdout.
 *
 * @param args - CLI arguments to pass to the binary
 * @param steps - Marker/input pairs, applied in order, each awaiting an answer
 *   that has not been consumed yet
 * @param timeoutMs - Bound the run so a missing marker fails instead of hanging
 * @returns Promise resolving to the same result shape `runPalee` returns
 * @remarks
 * `runPalee` pipes stdin through `spawnSync`, which delivers the whole blob at
 * once: Node's readline discards the lines after the first because no question
 * is pending when they arrive. Interleaving against a stdout marker lets one run
 * answer several sequential prompts, which interactive menus need.
 */
function runPaleeInteractive(
  args: string[],
  configDir: string,
  steps: Array<{ waitFor: RegExp; write: string }>,
  timeoutMs = 60000
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', PALEE_BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PALEE_CONFIG_DIR: configDir, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let consumed = 0;
    let step = 0;
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };

    const next = (): void => {
      const pending = steps[step];
      if (!pending) return;
      const match = stdout.slice(consumed).match(pending.waitFor);
      if (!match) return;
      consumed += (match.index ?? 0) + match[0].length;
      step++;
      child.stdin.write(pending.write);
      // Mirror spawnSync's `input` behaviour: an open stdin keeps the child's
      // event loop alive after the queue drains, so the run would never end.
      if (step === steps.length) child.stdin.end();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new Error(
            `Interactive CLI did not finish within ${timeoutMs}ms ` +
              `(consumed ${step}/${steps.length} input steps).\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        )
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      next();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) =>
      finish(() => reject(new Error(`Interactive spawn failed: ${err.stack}`)))
    );
    child.on('close', (code) => {
      const unconsumed = steps.length - step;
      finish(() => {
        if (unconsumed > 0) {
          reject(
            new Error(
              `${unconsumed} of ${steps.length} input line(s) never reached a prompt; ` +
                `the menu did not emit every waitFor marker.\nstdout:\n${stdout}`
            )
          );
          return;
        }
        resolve({ status: code ?? 1, stdout, stderr });
      });
    });
  });
}

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

  const runInteractive = (
    args: string[],
    steps: Array<{ waitFor: RegExp; write: string }>
  ): Promise<CLIResult> => runPaleeInteractive(args, configDir, steps);

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
    runInteractive,
    createTopic,
    updateTopic,
    readTopic,
    readHotMemory,
    readSessionIndex,
    listSessions,
    cleanup,
  };
}
