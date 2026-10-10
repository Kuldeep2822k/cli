/**
 * Config Command Handler
 * Manages PALEE configuration
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import { PaleeConfig, NodeError } from '../types';
import { exitCodeFor } from './exit-codes';
import { API_KEY_ENV, OpenAICompatibleProvider, describeForeignText, isSendable, normalizeProviderEndpoint, resolveProviderSettings } from '../ai';

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
 * The directories a Windows user's own files live under — the roots a
 * credential-bearing config may safely sit inside. Env-reading is kept here, at
 * the edge, so {@link isConfigDirStorableForKey} stays a pure function the tests
 * can drive with fixture roots.
 */
function profileRoots(): string[] {
  const roots = [process.env.USERPROFILE ?? os.homedir(), process.env.LOCALAPPDATA];
  return roots.filter((r): r is string => Boolean(r));
}

/**
 * Decides whether a key may be stored in `dir` on Windows, where `fs` modes are a
 * no-op and NTFS access is inherited from the directory's ACL. The accurate test
 * is a Win32 security API, which needs a native dependency; this is the
 * dependency-free, no-spawn stand-in: a directory inside the user's own profile
 * roots inherits an owner-only ACL, one outside (a share, a synced folder, a
 * clone on `D:`) may not. Location, not the ACL itself — hence the override.
 *
 * @param dir - The resolved config directory the key would be written into.
 * @param roots - The profile roots to accept, from {@link profileRoots}.
 * @returns `true` when `dir` is one of, or nested within, a root.
 *
 * @remarks
 * Uses `path.win32` so the decision is identical on any OS the test runs on, and
 * `path.win32.relative` so case folds and `C:\\Users\\bob` does not swallow
 * `C:\\Users\\bobby`. Empty roots means the location cannot be verified, so it
 * refuses rather than assuming safety.
 */
function isConfigDirStorableForKey(dir: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  const resolvedDir = realpathIfExists(dir);
  for (const root of roots) {
    const resolvedRoot = realpathIfExists(root);
    const rel = path.win32.relative(resolvedRoot, resolvedDir);
    if (rel === '') return true;
    if (!rel.startsWith('..') && !path.win32.isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * Canonicalizes a path for the containment check: collapses 8.3 short names
 * (`RUNNER~1` → `runneradmin`) and symlinks. Only `fs.realpathSync.native`
 * (GetFinalPathNameByHandle) does this — the JS `fs.realpathSync` preserves the
 * input's short-name spelling, which would make the dir and the profile root fail
 * to match even when one genuinely contains the other.
 *
 * The config dir usually does not exist yet (`saveConfig` creates it on first
 * write), so we canonicalize the nearest existing ancestor and rejoin the
 * not-yet-created tail; a path with no existing ancestor falls back to a lexical
 * resolve so the check still has an absolute path to compare.
 */
function realpathIfExists(p: string): string {
  const resolved = path.win32.resolve(p);
  let existing = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return tail.length ? path.win32.join(real, ...tail) : real;
    } catch {
      const parent = path.win32.dirname(existing);
      if (parent === existing) return resolved;
      tail.unshift(path.win32.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Loads and parses the stored PALEE configuration from disk.
 *
 * @returns The parsed PaleeConfig object, or an empty object if no config file exists or content is malformed.
 *
 * @remarks
 * Returns empty defaults on `ENOENT` or invalid JSON syntax without throwing unhandled exceptions.
 *
 * @example
 * ```typescript
 * const config = loadConfig();
 * console.log(config.vaultPath);
 * ```
 */
function loadConfig(): PaleeConfig {
  const configPath = getConfigPath();
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    if (!data.trim()) {
      return {};
    }
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`Warning: Invalid configuration format at ${configPath}. Falling back to default configuration.`);
      return {};
    }
    const validConfig: PaleeConfig = {};
    if (typeof (parsed as PaleeConfig).vaultPath === 'string') validConfig.vaultPath = (parsed as PaleeConfig).vaultPath;
    if (typeof (parsed as PaleeConfig).aiProvider === 'string') validConfig.aiProvider = (parsed as PaleeConfig).aiProvider;
    if (typeof (parsed as PaleeConfig).model === 'string') validConfig.model = (parsed as PaleeConfig).model;
    if (typeof (parsed as PaleeConfig).baseUrl === 'string') validConfig.baseUrl = (parsed as PaleeConfig).baseUrl;
    if (typeof (parsed as PaleeConfig).apiKey === 'string') validConfig.apiKey = (parsed as PaleeConfig).apiKey;
    return validConfig;
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
 * @returns Void
 *
 * @remarks
 * Writes configuration to a unique temporary file, fsyncs data, and atomically renames.
 * The file holds a provider credential, so it is created `0600` inside a `0700`
 * directory: the mode is set when the temp file is opened, before a byte of the
 * payload exists, and `renameSync` carries it onto the config path. Windows
 * ignores the mode argument and resolves access through the directory's ACL.
 *
 * @example
 * ```typescript
 * saveConfig({ vaultPath: '/vault', aiProvider: 'gemini' });
 * ```
 */
function saveConfig(config: PaleeConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // `pid + Date.now()` is not a unique name: two processes that fork from the
  // same parent inside the same millisecond share both, and the second `open(w)`
  // truncates the first one's temp file mid-write. `atomicWrite` already pays for
  // entropy here, so the config writer has no reason to be weaker than the note
  // writer.
  const tempPath = `${configPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const payload = JSON.stringify(config, null, 2);

  let fd: number | null = null;
  let success = false;
  try {
    // `wx` fails if `tempPath` already exists, so a pre-placed file or symlink at
    // the temp name cannot be followed and written through — the random suffix
    // makes a genuine collision near-impossible, and a collision that does happen
    // is a signal, not something to overwrite.
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeSync(fd, payload, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, configPath);
    success = true;
    // Durability of the rename itself: without fsyncing the directory the entry
    // can be lost on power loss even though the data fd was synced. Best-effort —
    // a platform that refuses a directory fsync (some Windows configurations) is
    // no worse off than before.
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (!success) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * Reads the API key a `set-api-key` should store.
 *
 * @param fromEnv - Optional environment variable name to read it from.
 * @returns The trimmed key, or `null` when nothing usable was obtained.
 *
 * @remarks
 * The key never arrives as a command-line argument: `argv` is readable by every
 * process on the machine (`ps`, `/proc/<pid>/cmdline`) and lands in shell history.
 * Precedence is `--from-env`, then a piped stdin, then an interactive prompt that
 * does not echo the key and keeps it out of line history. Each failure says why on
 * `stderr`.
 */
async function readApiKey(fromEnv?: string): Promise<string | null> {
  if (fromEnv) {
    const stored = process.env[fromEnv];
    if (!stored || !stored.trim()) {
      console.error(`Error: environment variable ${fromEnv} is not set`);
      return null;
    }
    return stored.trim();
  }

  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let piped = '';
    for await (const chunk of process.stdin) piped += chunk;
    piped = piped.trim();
    if (!piped) {
      console.error('Error: no API key read from stdin');
      return null;
    }
    return piped;
  }

  const typed = await promptHidden('API key: ');
  if (!typed.trim()) {
    console.error('Error: no API key entered');
    return null;
  }
  return typed.trim();
}

/**
 * Prompts on a TTY for a secret without echoing it. The prompt text is written,
 * then every keystroke is swallowed, so the key never reaches terminal scrollback
 * or a session recording; `historySize: 0` keeps it out of line-editing history.
 */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 0,
    });
    let muted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!muted) process.stdout.write(s);
    };
    rl.question(query, (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/**
 * CLI command handler for managing configuration.
 *
 * @param action - Optional action: show, set-vault, set-provider, set-base-url, set-api-key,
 * unset-api-key, test-connection, set-model.
 * @param value - Value for the actions that take one. `set-api-key` deliberately takes none.
 * @param options - Command options; `fromEnv` names the variable `set-api-key` reads,
 * `json` makes `show` emit machine-readable output.
 * @returns Promise resolving when the command finishes.
 * @remarks Sets process.exitCode = 2 on missing/invalid arguments or unknown actions,
 * and process.exitCode = 5 on unexpected exceptions. `show --json` reports whether a key
 * is stored (`api_key_set`) and never the key itself.
 *
 * @example
 * ```typescript
 * await configCommand('set-vault', '/Users/alex/Vault');
 * ```
 */
async function configCommand(
  action?: string,
  value?: string,
  options?: { fromEnv?: string; json?: boolean }
): Promise<void> {
  try {
    if (!action || action === 'show') {
      const config = loadConfig();
      if (options?.json) {
        console.log(JSON.stringify({
          vault_path: config.vaultPath ?? null,
          ai_provider: config.aiProvider ?? null,
          base_url: config.baseUrl ?? null,
          model: config.model ?? null,
          api_key_set: Boolean(config.apiKey),
        }));
        return;
      }
      console.log('PALEE Configuration:');
      console.log(`  Vault Path: ${config.vaultPath || '(not set)'}`);
      console.log(`  AI Provider: ${config.aiProvider || '(not set)'}`);
      console.log(`  Base URL: ${config.baseUrl || '(not set)'}`);
      console.log(`  API Key: ${config.apiKey ? '••••••••' : '(not set)'}`);
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

    if (action === 'set-base-url') {
      if (!value) {
        console.error('Error: base URL required');
        process.exitCode = 2;
        return;
      }

      // The same rule the provider applies when it calls out. Validating here with a
      // different rule set would let a user store an endpoint that every later command
      // refuses with a different message — and a `?token=` in the value would be stored
      // and then folded into the middle of the request path.
      let endpoint: URL;
      try {
        endpoint = normalizeProviderEndpoint(value);
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = exitCodeFor(err);
        return;
      }
      // A key can also ride in the query or fragment (…/v1?api_key=sk-…); that is
      // stored and printed by `config show` just the same, so refuse it too — and
      // without echoing the value. A provider endpoint has no use for either.
      if (endpoint.search || endpoint.hash) {
        console.error('Error: base URL must not carry a query or fragment; set the credential with set-api-key');
        process.exitCode = 2;
        return;
      }

      const config = loadConfig();
      config.baseUrl = endpoint.origin + endpoint.pathname.replace(/\/+$/, '');
      saveConfig(config);
      console.log(`AI base URL set to: ${config.baseUrl}`);
      return;
    }

    if (action === 'set-api-key') {
      if (value) {
        console.error('Error: the API key cannot be an argument — argv is readable by other processes and lands in shell history');
        console.error('Run with --from-env VAR, pipe the key on stdin, or run with no input to be prompted');
        process.exitCode = 2;
        return;
      }

      const key = await readApiKey(options?.fromEnv);
      if (key === null) {
        process.exitCode = 2;
        return;
      }

      // The provider refuses a key with a non-printable character at call time, because it
      // cannot go into an Authorization header. Catch it here instead so a key that can
      // never work is rejected on the way in rather than stored and failing on first use.
      // The key is never echoed, so the message names the fault, not the value.
      if (!isSendable(key)) {
        console.error('Error: the API key contains a non-printable character and cannot be sent in an HTTP header; check for a stray control character or newline');
        process.exitCode = 2;
        return;
      }

      // On Windows the 0600/0700 modes saveConfig sets are ignored, so a config
      // directory outside the user's profile can inherit a readable ACL. Refuse
      // to write the key there rather than store it where another principal can
      // read it (#316). The override is for a directory the user has secured by
      // other means, which this location heuristic cannot see.
      if (process.platform === 'win32' && !process.env.PALEE_ALLOW_INSECURE_CONFIG_DIR) {
        const dir = path.dirname(getConfigPath());
        const roots = profileRoots();
        if (!isConfigDirStorableForKey(dir, roots)) {
          console.error(`Error: refusing to store the API key in ${dir}: it is outside your user profile (${roots.join(', ')}), where its file permissions cannot be guaranteed on Windows.`);
          console.error('Use PALEE_API_KEY at runtime instead, point PALEE_CONFIG_DIR under %LOCALAPPDATA% or %USERPROFILE%, or set PALEE_ALLOW_INSECURE_CONFIG_DIR=1 to override.');
          process.exitCode = 2;
          return;
        }
      }

      const config = loadConfig();
      config.apiKey = key;
      saveConfig(config);
      console.log('API key stored. `palee config show` does not print it.');
      return;
    }

    if (action === 'unset-api-key') {
      const config = loadConfig();
      if (config.apiKey === undefined) {
        console.log('No API key is stored.');
        return;
      }

      delete config.apiKey;
      saveConfig(config);
      console.log('API key removed.');
      return;
    }

    if (action === 'test-connection') {
      if (value) {
        console.error('Error: test-connection takes no argument');
        process.exitCode = 2;
        return;
      }
      // The one place a stored credential can prove itself. It sends the shortest
      // possible prompt and reports reachability, the URL actually called, which key
      // source won, and what came back — because a Phase-2 feature spending real tokens
      // to discover a bad base URL is the expensive way to learn the same thing.
      //
      // The default timeout is kept rather than shortened: a local server cold-loading a
      // model can take tens of seconds, and failing that early would report a working
      // provider as broken.
      try {
        const settings = resolveProviderSettings(loadConfig());
        const provider = new OpenAICompatibleProvider(settings);
        const started = process.hrtime.bigint();
        const reply = await provider.complete({
          messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }],
          temperature: 0,
        });
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        const keyLabel =
          settings.keySource === 'env' ? `from $${API_KEY_ENV}`
            : settings.keySource === 'config' ? 'from the config file'
              : 'none configured';
        console.log('✓ Provider reachable');
        console.log(`  Endpoint: ${provider.url}`);
        console.log(`  Model:    ${provider.model}`);
        console.log(`  Key:      ${keyLabel}`);
        console.log(`  Reply:    ${describeForeignText(settings.apiKey, reply.text)} (${elapsed.toFixed(0)} ms)`);
        if (reply.usage) {
          console.log(`  Tokens:   ${reply.usage.promptTokens} in / ${reply.usage.completionTokens} out`);
        }
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exitCode = exitCodeFor(err);
        return;
      }
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
    console.error('Valid actions: show, set-vault, set-provider, set-base-url, set-api-key, unset-api-key, test-connection, set-model');
    process.exitCode = 2;
    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export { loadConfig, saveConfig, isConfigDirStorableForKey };
export default configCommand;
