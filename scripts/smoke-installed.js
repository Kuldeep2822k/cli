#!/usr/bin/env node
/**
 * Smoke-tests the *installed* palee binary — the one the workflow just put on
 * PATH from the packed tarball — by running one real command end to end.
 *
 * `--version` and `--help` prove the shim resolves, but they exit before the
 * command dispatcher loads config, reads a vault, or emits JSON through the
 * packaged dependency tree. `next --json` exercises all three: an empty,
 * isolated vault must yield the documented empty-state contract.
 *
 * Node built-ins only: the workflow step that runs this has no repository
 * dependencies installed, and this file must behave identically on Ubuntu,
 * Windows and macOS (`palee.cmd` needs a shell on Windows).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TIMEOUT_MS = 60_000;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-smoke-'));
let exitCode = 0;
try {
  const vaultDir = path.join(tempRoot, 'vault');
  const configDir = path.join(tempRoot, 'config');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ vaultPath: vaultDir }, null, 2) + '\n');

  const env = { ...process.env, PALEE_CONFIG_DIR: configDir, NODE_ENV: 'test' };
  // The installed binary must resolve its own packaged dependencies. Inherited
  // loader or resolution overrides (tsx preloads, path redirection) would make
  // this step test something other than the artifact.
  for (const key of Object.keys(env)) {
    if (/^NODE_(OPTIONS|PATH)$/i.test(key)) delete env[key];
  }

  // `palee` on PATH is `palee.cmd` on Windows, which CreateProcess cannot launch
  // directly; `cmd /c` runs exactly what a user typing `palee` would run. The
  // explicit form avoids `shell: true`, whose arg concatenation is deprecated
  // (DEP0190) on Node >= 24.
  const spawnOptions = {
    cwd: tempRoot,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: TIMEOUT_MS,
  };
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'palee next --json'], spawnOptions)
      : spawnSync('palee', ['next', '--json'], spawnOptions);

  if (result.error) {
    throw new Error(`could not run the installed palee binary: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `palee next --json exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`stdout was not JSON:\n${result.stdout}`);
  }

  const problems = [];
  if (parsed.total_topics !== 0) problems.push(`total_topics: expected 0, got ${JSON.stringify(parsed.total_topics)}`);
  if (parsed.due_count !== 0) problems.push(`due_count: expected 0, got ${JSON.stringify(parsed.due_count)}`);
  if (parsed.next !== null) problems.push(`next: expected null, got ${JSON.stringify(parsed.next)}`);
  if (problems.length > 0) {
    throw new Error(`empty-vault contract violated:\n  - ${problems.join('\n  - ')}\nfull output: ${result.stdout}`);
  }

  console.log(`smoke-installed: palee next --json on an empty vault → ${result.stdout.trim()}`);
} catch (err) {
  console.error(`smoke-installed: ${err.message}`);
  exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exitCode = exitCode;
