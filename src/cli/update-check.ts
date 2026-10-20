/**
 * Update Check and the npm Child-Process Boundary
 *
 * The entire registry-facing surface of `palee update` and the new-version
 * notice. Every question is asked of the user's own `npm` through one
 * `spawnSync` child, so PALEE opens no socket (INV-29) and the registry, proxy
 * and credentials in the user's `.npmrc` are honoured without PALEE reading
 * them.
 *
 * Raw `fs` here is confined to the config directory — machine-level state of
 * the same class as `config.json` (see `config.ts`), never vault files. The
 * derived `update-check.json` is freely rebuildable: a torn cache is silently
 * repaired by the next check, so it skips the tmp+fsync+rename ceremony
 * `saveConfig` pays for a user-authored credential.
 *
 * ADR-0033 owns the spawn-bounding and cache decisions; this file keeps the
 * short version of each next to the code that enforces it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'child_process';
import { getConfigPath } from './config';
import { programName } from './program-name';

/** The published package the update surface talks about. */
const PACKAGE_NAME = '@kuldeep2822k/palee';

/** How long a cached check stays usable before a new one is paid for. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Budget for the automatic notice path: it must never dominate a normal run. */
const AUTO_CHECK_TIMEOUT_MS = 5000;

/** Budget for `palee update`, where the user is waiting on the answer anyway. */
export const EXPLICIT_CHECK_TIMEOUT_MS = 30000;

/** Longest npm stderr detail carried into a failure reason. */
const MAX_REASON_DETAIL = 200;

/** A resolved `spawnSync` call shape, platform decision separated from execution. */
export interface NpmInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Runs one npm invocation.
 *
 * @param invocation - The platform decision from {@link npmInvocationFor}
 * @param options - `spawnSync` options; `shell` and `cwd` are set here, not by the caller
 * @returns The raw `spawnSync` result
 *
 * @remarks
 * `cwd` is pinned to the home directory rather than inherited: on win32 npm is
 * reached through `cmd.exe`, which searches the current directory before
 * `PATH`, so an inherited directory would let a planted `npm.cmd` run as the
 * user (ADR-0033). Excluding `cwd` from the options type makes the pin
 * structural instead of a convention.
 *
 * On win32 npm's launcher is a `.cmd`, which Node (post CVE-2024-27980) only
 * allows through a shell; npm's argv is compile-time constants, so the shell
 * string has nothing user-controlled in it. `shell: true` with an args array
 * would print Node's DEP0190, and `process.noDeprecation` is consulted when
 * that warning is emitted, so it is set around the spawn only — npm's own
 * output is never silenced by it.
 */
function spawnNpm(
  invocation: NpmInvocation,
  options: Omit<SpawnSyncOptions, 'shell' | 'cwd'>
): SpawnSyncReturns<string | NonSharedBuffer> {
  const previous = process.noDeprecation;
  process.noDeprecation = true;
  try {
    return spawnSync(invocation.command, invocation.args, {
      ...options,
      shell: invocation.shell,
      cwd: os.homedir(),
    });
  } finally {
    if (previous === undefined) delete process.noDeprecation;
    else process.noDeprecation = previous;
  }
}

/**
 * Decides how to invoke npm on a platform.
 *
 * @param platform - The platform to decide for (a parameter so the win32 arm
 *   is unit-testable on every CI leg)
 * @param args - npm argv; every shipped caller passes compile-time constants
 * @returns The command, args, and shell flag to spawn with
 */
export function npmInvocationFor(platform: NodeJS.Platform, args: string[]): NpmInvocation {
  if (platform === 'win32') {
    return { command: 'npm.cmd', args, shell: true };
  }
  return { command: 'npm', args, shell: false };
}

/** npm argv asking the configured registry for the package's latest version. */
export function viewArgs(): string[] {
  return ['view', PACKAGE_NAME, 'version'];
}

/** npm argv that performs the global upgrade. */
export function installArgs(): string[] {
  return ['install', '-g', `${PACKAGE_NAME}@latest`];
}

interface ParsedVersion {
  core: [number, number, number];
  /** Prerelease dot-separated identifiers, or `null` for a release version. */
  pre: string[] | null;
}

const FULL_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): ParsedVersion | null {
  const match = FULL_VERSION.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined ? match[4].split('.') : null,
  };
}

/** Numeric prerelease identifiers, compared without leaving the string domain. */
function compareNumericIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aDigits = a.replace(/^0+/, '') || '0';
  const bDigits = b.replace(/^0+/, '') || '0';
  if (aDigits.length !== bDigits.length) return aDigits.length > bDigits.length ? 1 : -1;
  return aDigits < bDigits ? -1 : aDigits > bDigits ? 1 : 0;
}

function comparePrereleaseIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareNumericIdentifiers(a, b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two versions the way npm does, without the dependency.
 *
 * @param a - Left version string
 * @param b - Right version string
 * @returns `-1`, `0`, or `1`; `0` when either side does not parse, so a bad
 * string can never invent an update
 *
 * @remarks
 * The numeric core compare is what `1.10.0 > 1.9.0` needs and a lexical
 * compare gets wrong; prerelease ordering follows semver (a prerelease sorts
 * below its release, numeric identifiers compare by value without crossing
 * through `Number`, alphanumeric identifiers lexically).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return 0;
  const [aMajor, aMinor, aPatch] = pa.core;
  const [bMajor, bMinor, bPatch] = pb.core;
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const shared = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < shared; i++) {
    const aPart = pa.pre[i];
    const bPart = pb.pre[i];
    // Unreachable while i < shared, but indexed access is `string | undefined`
    // under noUncheckedIndexedAccess and the type has to stay honest.
    if (aPart === undefined || bPart === undefined) break;
    const cmp = comparePrereleaseIdentifiers(aPart, bPart);
    if (cmp !== 0) return cmp;
  }
  return pa.pre.length === pb.pre.length ? 0 : pa.pre.length > pb.pre.length ? 1 : -1;
}

/**
 * Extracts the printed version from `npm view <pkg> version` stdout.
 *
 * @param raw - Whole stdout text
 * @returns The first line that is nothing but a version, or `null`
 *
 * @remarks
 * A line must match whole because npm notices riding in stdout ("10.8.2 -> 10.9.0")
 * would otherwise be read as the package version.
 */
export function parseVersionLine(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '' && parseVersion(trimmed) !== null) return trimmed;
  }
  return null;
}

/**
 * One install's cached answer, keyed in the store by the version that asked.
 *
 * @remarks
 * Keying by version is what keeps parallel or renamed installs sharing one
 * config dir (#311) from invalidating each other's cache and re-probing npm on
 * every command: each install trusts only its own entry.
 */
export interface UpdateCheckEntry {
  checkedAt: number;
  latestVersion: string | null;
  /** The `latestVersion` a notice was already printed for, or `null`. */
  notifiedVersion: string | null;
}

/** Path of the cache file, beside the (config-dir) `config.json`. */
export function updateCheckPath(): string {
  return path.join(path.dirname(getConfigPath()), 'update-check.json');
}

/**
 * Reads the raw store, or `{}` for missing, unparseable, or wrongly-shaped
 * content — silently: a corrupt cache is derived state, not worth a line of noise.
 */
function readUpdateCheckStore(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(updateCheckPath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Reads the entry written by `currentVersion`.
 *
 * @param currentVersion - The version of the running build
 * @param now - Current epoch ms; entries from the future are refused
 * @returns The entry, or `null` when absent or not well-formed
 *
 * @remarks
 * `checkedAt` must be a finite number no later than `now` (a clock correction
 * or a poisoned `1e999` must not freeze the cache), and both version fields
 * must be version-shaped or null, so a foreign string can neither read as
 * "up to date" nor reach the notice printer.
 */
export function readUpdateCheckRecord(
  currentVersion: string,
  now: number = Date.now()
): UpdateCheckEntry | null {
  const entry = readUpdateCheckStore()[currentVersion];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  const checkedAt = record.checkedAt;
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt > now) return null;

  const latestVersion = record.latestVersion;
  if (latestVersion !== null) {
    if (typeof latestVersion !== 'string' || parseVersion(latestVersion) === null) return null;
  }

  const notifiedVersion = record.notifiedVersion ?? null;
  if (notifiedVersion !== null) {
    if (typeof notifiedVersion !== 'string' || parseVersion(notifiedVersion) === null) return null;
  }

  return { checkedAt, latestVersion, notifiedVersion };
}

/**
 * Whether a cached entry may be trusted.
 *
 * @param record - The cached entry
 * @param now - Current epoch ms
 * @param ttlMs - Freshness window
 * @returns `true` when within the window
 */
export function isCacheFresh(record: UpdateCheckEntry, now: number, ttlMs: number): boolean {
  return now - record.checkedAt < ttlMs;
}

/**
 * Writes `currentVersion`'s entry, preserving the other installs', best-effort.
 *
 * @param currentVersion - The version of the running build
 * @param record - The entry to persist
 *
 * @remarks
 * A write that cannot land costs one extra probe on the next run, never a
 * command: an unwritable config dir is not worth an error on a background
 * notice path.
 */
export function writeUpdateCheckRecord(currentVersion: string, record: UpdateCheckEntry): void {
  try {
    const store = readUpdateCheckStore();
    store[currentVersion] = record;
    const file = updateCheckPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // Best effort by contract; see the docstring.
  }
}

/** Outcome of asking npm for the latest version. */
type VersionProbe =
  | { kind: 'ok'; version: string }
  | { kind: 'failed'; reason: string };

/** The first non-empty stderr line, length-capped for a one-line reason. */
function firstStderrLine(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    return trimmed.length > MAX_REASON_DETAIL ? `${trimmed.slice(0, MAX_REASON_DETAIL)}…` : trimmed;
  }
  return null;
}

const NPM_NOT_FOUND = /not recognized|not found|command not found/i;

/**
 * Asks the user's npm for the latest published version.
 *
 * @param timeoutMs - Hard budget for the child process
 * @returns The version, or a failure reason; never throws
 *
 * @remarks
 * Module-private: the only caller is {@link evaluateUpdate}, and the cwd pin in
 * {@link spawnNpm} is what keeps this safe to reach from an automated path.
 */
function probeLatestVersion(timeoutMs: number): VersionProbe {
  try {
    const result = spawnNpm(npmInvocationFor(process.platform, viewArgs()), {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code ?? 'unknown error';
      if (code === 'ETIMEDOUT') {
        return { kind: 'failed', reason: `npm view timed out after ${timeoutMs} ms` };
      }
      return { kind: 'failed', reason: `npm could not be run (${code})` };
    }
    if (result.status !== 0) {
      const detail = firstStderrLine(typeof result.stderr === 'string' ? result.stderr : '');
      // On win32 a missing npm exits 1 through cmd.exe with "not recognized"
      // on stderr, while POSIX gets ENOENT; both are "npm is not usable here".
      if (detail !== null && NPM_NOT_FOUND.test(detail)) {
        return { kind: 'failed', reason: 'npm could not be found on PATH' };
      }
      if (detail !== null) {
        return { kind: 'failed', reason: `npm view exited with code ${result.status}: ${detail}` };
      }
      return { kind: 'failed', reason: `npm view exited with code ${result.status}` };
    }
    const version = parseVersionLine(typeof result.stdout === 'string' ? result.stdout : '');
    if (version === null) {
      return { kind: 'failed', reason: 'npm view did not print a version' };
    }
    return { kind: 'ok', version };
  } catch (e: unknown) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The whole answer to "is there a newer palee?". */
export type UpdateReport =
  | { state: 'unknown'; reason: string }
  | { state: 'up-to-date' | 'update-available'; latestVersion: string };

/**
 * Decides the update state, consulting the cache first unless forced.
 *
 * @param currentVersion - The running build's version, and the cache key
 * @param options - `force` re-probes even when the cache is fresh; `timeoutMs`
 *   budgets the probe
 * @returns The report; a failed probe is cached as `latestVersion: null` so an
 * offline user does not pay a spawn+timeout on every run
 */
export function evaluateUpdate(
  currentVersion: string,
  options: { force: boolean; timeoutMs: number }
): UpdateReport {
  const now = Date.now();
  if (!options.force) {
    const record = readUpdateCheckRecord(currentVersion, now);
    if (record !== null && isCacheFresh(record, now, UPDATE_CHECK_TTL_MS)) {
      if (record.latestVersion === null) {
        return { state: 'unknown', reason: 'a previous update check failed' };
      }
      return {
        state: compareVersions(record.latestVersion, currentVersion) === 1 ? 'update-available' : 'up-to-date',
        latestVersion: record.latestVersion,
      };
    }
  }

  const probe = probeLatestVersion(options.timeoutMs);
  const checkedAt = Date.now();
  // A re-probe must not re-arm a delivered notice: `notifiedVersion` outlives
  // the TTL (the docs promise one notice per published version, not per day),
  // and it survives a failed probe too, so an offline day cannot re-announce
  // the release the user already saw.
  const previous = readUpdateCheckRecord(currentVersion, checkedAt);
  if (probe.kind === 'failed') {
    writeUpdateCheckRecord(currentVersion, {
      checkedAt,
      latestVersion: null,
      notifiedVersion: previous?.notifiedVersion ?? null,
    });
    return { state: 'unknown', reason: probe.reason };
  }
  writeUpdateCheckRecord(currentVersion, {
    checkedAt,
    latestVersion: probe.version,
    notifiedVersion: previous?.notifiedVersion === probe.version ? probe.version : null,
  });
  return {
    state: compareVersions(probe.version, currentVersion) === 1 ? 'update-available' : 'up-to-date',
    latestVersion: probe.version,
  };
}

/**
 * Decides whether the automatic notice must stay silent.
 *
 * @param env - Process environment to read
 * @param stdoutIsTTY - Whether stdout is a terminal
 * @param actionName - The command that just ran
 * @param jsonRequested - Whether the command asked for machine output
 * @param exitCode - The command's exit code, when it set one
 * @returns `true` when no notice may be printed
 *
 * @remarks
 * One pure predicate holds every gate: only human terminals and successful
 * commands get a notice (a failed run already has its own error to report, and
 * the machine-output contract — piped and `--json` callers — sees nothing
 * extra), `PALEE_NO_UPDATE_CHECK` opts out the way `PALEE_DEBUG` opts in, and
 * `update` itself never gets the notice it just answered.
 */
export function notificationSuppressed(
  env: NodeJS.ProcessEnv,
  stdoutIsTTY: boolean | undefined,
  actionName: string,
  jsonRequested: boolean,
  exitCode: number | string | null | undefined
): boolean {
  if (exitCode !== undefined && exitCode !== 0) return true;
  if (stdoutIsTTY !== true) return true;
  if (jsonRequested) return true;
  if (actionName === 'update') return true;
  const optOut = env.PALEE_NO_UPDATE_CHECK;
  if (optOut !== undefined && optOut !== '' && optOut !== '0') return true;
  return false;
}

/**
 * Formats the one-line stderr notice.
 *
 * @param currentVersion - The running build's version
 * @param latestVersion - The newer published version
 * @param binName - The invoked bin name, so a renamed install is told to run its own command (#314)
 * @returns The notice line
 */
function formatNotice(currentVersion: string, latestVersion: string, binName: string): string {
  return `⚠ A new version of palee is available: ${latestVersion} (you have ${currentVersion}). Run ${binName} update`;
}

/**
 * Prints the notice when {@link notificationSuppressed} allows it, at most once
 * per published version. The 24 h TTL bounds probing, not the delivered mark:
 * an expired entry re-probes but stays silent for the release it already
 * announced. Swallows every failure: a version notice can never fail a command
 * that already succeeded, and it never touches `process.exitCode`.
 *
 * @param currentVersion - The running build's version
 * @param actionName - The command that just ran
 * @param jsonRequested - Whether the command asked for machine output
 */
export function maybeNotifyUpdate(currentVersion: string, actionName: string, jsonRequested: boolean): void {
  try {
    if (notificationSuppressed(process.env, process.stdout.isTTY, actionName, jsonRequested, process.exitCode)) return;

    // Fast path: a fresh entry whose notice was already delivered needs no
    // probe and no print.
    const now = Date.now();
    const cached = readUpdateCheckRecord(currentVersion, now);
    if (
      cached !== null &&
      isCacheFresh(cached, now, UPDATE_CHECK_TTL_MS) &&
      cached.latestVersion !== null &&
      cached.latestVersion === cached.notifiedVersion
    ) {
      return;
    }

    const report = evaluateUpdate(currentVersion, { force: false, timeoutMs: AUTO_CHECK_TIMEOUT_MS });
    if (report.state !== 'update-available') return;
    // evaluateUpdate carries a delivered mark across the TTL; read the fresh
    // record it just wrote, or an expired entry would announce its release again.
    const delivered = readUpdateCheckRecord(currentVersion, Date.now());
    if (delivered !== null && delivered.notifiedVersion === report.latestVersion) return;
    console.error(formatNotice(currentVersion, report.latestVersion, programName()));

    // Mark the notice delivered so runs inside the TTL stay quiet. If the
    // write cannot land, the worst case is a repeated notice, never a failure.
    const after = readUpdateCheckRecord(currentVersion, Date.now());
    if (after !== null && after.latestVersion === report.latestVersion) {
      writeUpdateCheckRecord(currentVersion, {
        checkedAt: after.checkedAt,
        latestVersion: after.latestVersion,
        notifiedVersion: report.latestVersion,
      });
    }
  } catch {
    // Deliberately empty: nothing a learner did wrong can be caused by the notice.
  }
}

/** Outcome of running the global install. */
export type InstallOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Runs `npm install -g @kuldeep2822k/palee@latest` with npm owning the
 * terminal: stdio inherit, no timeout — npm's own progress and error text is
 * what the user needs to see, including the cause of an EACCES from an
 * unwritable global prefix.
 *
 * @returns Whether npm exited zero, with a reason on failure; never throws
 */
export function runGlobalInstall(): InstallOutcome {
  const result = spawnNpm(npmInvocationFor(process.platform, installArgs()), {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, reason: `npm could not be run (${code})` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `npm install -g exited with code ${result.status}` };
  }
  return { ok: true };
}
