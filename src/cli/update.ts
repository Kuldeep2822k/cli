/**
 * Update Command Handler
 * Reports the current and latest published palee versions and upgrades the
 * global install by delegating to the user's own npm.
 *
 * Deliberate deviations from the vault-command spine: no `loadConfig` /
 * `validateVaultPath` — an update is machine-level, like `config`, and a fresh
 * install with no vault configured is exactly the user who needs to update —
 * and no `--json` surface: during a real install npm owns stdout, so promising
 * one machine document there could not be kept (ADR-0033). The error shape
 * follows `config test-connection`, the only other network-touching command.
 */

import packageJson from '../../package.json';
import { UpdateOptions } from '../types';
import { exitCodeFor, ExitCode } from './exit-codes';
import { programName } from './program-name';
import {
  EXPLICIT_CHECK_TIMEOUT_MS,
  evaluateUpdate,
  installArgs,
  runGlobalInstall,
  writeUpdateCheckRecord,
} from './update-check';

/**
 * CLI command handler for updating the global palee install.
 *
 * @param options - Update command options; `dryRun` reports and installs nothing.
 * @returns Promise resolving when output is complete.
 * @remarks Sets process.exitCode = 5 when npm could not be run, the version
 * query failed or timed out, or the install exited non-zero. Usage errors exit
 * 2 through Commander's exitOverride tail in bin/palee.ts.
 */
async function updateCommand(options: UpdateOptions = {}): Promise<void> {
  try {
    const currentVersion = packageJson.version;
    const report = evaluateUpdate(currentVersion, { force: true, timeoutMs: EXPLICIT_CHECK_TIMEOUT_MS });

    if (report.state === 'unknown') {
      console.error(`Error: could not determine the latest published version (${report.reason})`);
      process.exitCode = ExitCode.Unexpected;
      return;
    }

    if (report.state === 'up-to-date') {
      console.log(`✓ palee is up to date (${currentVersion})`);
      return;
    }

    const latestVersion = report.latestVersion;
    if (options.dryRun) {
      console.log(`⚠ palee ${latestVersion} is available (you have ${currentVersion}).`);
      console.log(`• Would run: npm ${installArgs().join(' ')}`);
      return;
    }

    console.log(`• Running: npm ${installArgs().join(' ')}`);
    const install = runGlobalInstall();
    if (!install.ok) {
      console.error(`Error: ${install.reason}`);
      process.exitCode = ExitCode.Unexpected;
      return;
    }

    // The running process still reports the old version until the shell starts
    // a new one, and the next command in the same second could read a cache
    // naming the version that was just installed. Rewriting it as up-to-date
    // stops the old build from emitting a stale notice.
    writeUpdateCheckRecord({ checkedAt: Date.now(), currentVersion, latestVersion: currentVersion });
    console.log(`✓ Updated palee to ${latestVersion}.`);
    console.log(`• Verify: ${programName()} --version`);
    return;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export { updateCommand };
export default updateCommand;
