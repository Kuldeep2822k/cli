/**
 * Update Check and the npm Child-Process Boundary
 *
 * The entire network-facing surface of `palee update` and the new-version notice
 * lives here, and it opens no socket. Every registry question is asked of the
 * user's own `npm` through a child process, so PALEE stays offline by
 * construction (INV-29): `test/ai-network-boundary.test.ts` deliberately keeps
 * `src/ai/provider.ts` as its only allowed network site, and the registry,
 * proxy, and credentials in the user's `.npmrc` are honoured without PALEE
 * ever reading them.
 *
 * Raw `fs` use here is confined to the config directory — machine-level state
 * of the same class as `config.json` (see `config.ts`), never vault files. The
 * derived `update-check.json` is freely rebuildable, so it skips the
 * tmp+fsync+rename ceremony `saveConfig` pays for a user-authored credential:
 * a torn cache is silently repaired by the next check.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'child_process';
import { getConfigPath } from './config';
import { programName } from './program-name';

/** The published package the update surface talks about. */
export const PACKAGE_NAME = '@kuldeep2822k/palee';

/** How long a cached check stays usable before a new one is paid for. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Budget for the automatic notice path: it must never dominate a normal run. */
export const AUTO_CHECK_TIMEOUT_MS = 5000;

/** Budget for `palee update`, where the user is waiting on the answer anyway. */
export const EXPLICIT_CHECK_TIMEOUT_MS = 30000;

/** A resolved `spawnSync` call shape, platform decision separated from execution. */
export interface NpmInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Runs one npm invocation, keeping the spawning process's stderr quiet.
 *
 * @param invocation - The platform decision from {@link npmInvocationFor}
 * @param options - `spawnSync` options; `shell` is taken from the invocation
 * @returns The raw `spawnSync` result
 *
 * @remarks
 * npm's Windows launcher is a `.cmd`, which Node (post CVE-2024-27980) only
 * allows through a shell — and `shell: true` with an args array prints
 * Node's DEP0190 on stderr, the stream the notice contract keeps quiet. The
 * warning tells developers to join argv strings themselves instead of trusting
 * Node's concatenation; here every arg is a compile-time constant in a fixed
 * order, so the concatenation it warns about is exactly the intended shape.
 * `process.noDeprecation` is consulted at emit time, so it is set around the
 * spawn only — and it affects this process alone: npm's own output is not
 * silenced.
 */
function spawnNpm(
  invocation: NpmInvocation,
  options: Omit<SpawnSyncOptions, 'shell'>
): SpawnSyncReturns<string | NonSharedBuffer> {
  const previous = process.noDeprecation;
  process.noDeprecation = true;
  try {
    return spawnSync(invocation.command, invocation.args, {
      ...options,
      shell: invocation.shell,
    });
  } finally {
    process.noDeprecation = previous;
  }
}

/**
 * Decides how to invoke npm on a platform.
 *
 * @param platform - The platform to decide for (a parameter so the win32 arm
 *   is unit-testable on every CI leg)
 * @param args - npm argv; every shipped caller passes compile-time constants
 * @returns The command, args, and shell flag to spawn with
 *
 * @remarks
 * Node's April 2024 security releases (CVE-2024-27980, in every CI leg: 22/24/26)
 * throw `EINVAL` when a `.bat`/`.cmd` is spawned without a shell, and npm's
 * Windows launcher is `npm.cmd` — so win32 goes through `cmd.exe`. That is safe
 * precisely because every arg here is a compile-time constant with no spaces:
 * nothing user-controlled ever reaches the shell string. On POSIX `npm` is a
 * real executable and no shell is added.
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

function comparePrereleaseIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const diff = Number(a) - Number(b);
    return diff > 0 ? 1 : diff < 0 ? -1 : 0;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two versions the way npm does, without the dependency.
 *
 * @param a - Left version string
 * @param b - Right version string
 * @returns `-1`, `0`, or `1`; `0` when either side does not parse, so a bad
 * string can never invent an "update available" or a false "up to date" panic
 *
 * @remarks
 * The numeric core compare is what `1.10.0 > 1.9.0` needs and a lexical
 * compare gets wrong; prerelease ordering follows semver (a prerelease sorts
 * below its release, identifiers compare numeric-then-alphanumeric).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const shared = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < shared; i++) {
    const cmp = comparePrereleaseIdentifiers(pa.pre[i], pb.pre[i]);
    if (cmp !== 0) return cmp;
  }
  return pa.pre.length === pb.pre.length ? 0 : pa.pre.length > pb.pre.length ? 1 : -1;
}

const VERSION_LINE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
    if (VERSION_LINE.test(trimmed)) return trimmed;
  }
  return null;
}

/** The cached check written beside `config.json`. */
export interface UpdateCheckRecord {
  checkedAt: number;
  currentVersion: string;
  latestVersion: string | null;
}

/** Path of the cache file, inside the (isolated) config directory. */
export function updateCheckPath(): string {
  return path.join(path.dirname(getConfigPath()), 'update-check.json');
}

/**
 * Reads the cache record.
 *
 * @returns The record, or `null` for missing, unparseable, or wrongly-shaped —
 * silently: a corrupt cache is derived state, not worth a line of noise
 */
export function readUpdateCheckRecord(): UpdateCheckRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(updateCheckPath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Partial<UpdateCheckRecord>;
    if (typeof record.checkedAt !== 'number') return null;
    if (typeof record.currentVersion !== 'string') return null;
    if (typeof record.latestVersion !== 'string' && record.latestVersion !== null) return null;
    return {
      checkedAt: record.checkedAt,
      currentVersion: record.currentVersion,
      latestVersion: record.latestVersion,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a cached record may be trusted.
 *
 * @param record - The cached record
 * @param now - Current epoch ms
 * @param runningVersion - The version of the running build
 * @param ttlMs - Freshness window
 * @returns `true` when fresh and written by this same version — a record from
 * a 1.0.0 install must never tell a 1.2.0 install it is stale, because
 * parallel or renamed installs share the machine-global config dir (#311)
 */
export function isCacheFresh(
  record: UpdateCheckRecord,
  now: number,
  runningVersion: string,
  ttlMs: number
): boolean {
  return record.currentVersion === runningVersion && now - record.checkedAt < ttlMs;
}

/**
 * Writes the cache record, best-effort.
 *
 * @param record - The record to persist
 * @returns Whether the write landed
 */
export function writeUpdateCheckRecord(record: UpdateCheckRecord): boolean {
  try {
    const file = updateCheckPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Outcome of asking npm for the latest version. */
export type VersionProbe =
  | { kind: 'ok'; version: string }
  | { kind: 'failed'; reason: string };

/**
 * Asks the user's npm for the latest published version.
 *
 * @param timeoutMs - Hard budget for the child process
 * @returns The version, or a failure reason; never throws
 */
export function probeLatestVersion(timeoutMs: number): VersionProbe {
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
  | { currentVersion: string; state: 'unknown'; source: 'none' | 'cache'; reason: string }
  | { currentVersion: string; state: 'up-to-date' | 'update-available'; latestVersion: string; source: 'cache' | 'npm' };

/**
 * Decides the update state, consulting the cache first unless forced.
 *
 * @param currentVersion - The running build's version
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
    const record = readUpdateCheckRecord();
    if (record !== null && isCacheFresh(record, now, currentVersion, UPDATE_CHECK_TTL_MS)) {
      if (record.latestVersion === null) {
        return { currentVersion, state: 'unknown', source: 'cache', reason: 'a previous update check failed' };
      }
      return {
        currentVersion,
        state: compareVersions(record.latestVersion, currentVersion) === 1 ? 'update-available' : 'up-to-date',
        latestVersion: record.latestVersion,
        source: 'cache',
      };
    }
  }

  const probe = probeLatestVersion(options.timeoutMs);
  if (probe.kind === 'failed') {
    writeUpdateCheckRecord({ checkedAt: now, currentVersion, latestVersion: null });
    return { currentVersion, state: 'unknown', source: 'none', reason: probe.reason };
  }
  writeUpdateCheckRecord({ checkedAt: now, currentVersion, latestVersion: probe.version });
  return {
    currentVersion,
    state: compareVersions(probe.version, currentVersion) === 1 ? 'update-available' : 'up-to-date',
    latestVersion: probe.version,
    source: 'npm',
  };
}

/**
 * Decides whether the automatic notice must stay silent.
 *
 * @param env - Process environment to read
 * @param stdoutIsTTY - Whether stdout is a terminal
 * @param actionName - The command that just ran
 * @param jsonRequested - Whether the command asked for machine output
 * @returns `true` when no notice may be printed
 *
 * @remarks
 * One pure predicate holds every gate: only human terminals get a notice (the
 * machine-output contract — piped and `--json` callers see nothing extra),
 * `PALEE_NO_UPDATE_CHECK` opts out the way `PALEE_DEBUG` opts in, and `update`
 * itself never gets the notice it just answered.
 */
export function notificationSuppressed(
  env: NodeJS.ProcessEnv,
  stdoutIsTTY: boolean | undefined,
  actionName: string,
  jsonRequested: boolean
): boolean {
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
export function formatNotice(currentVersion: string, latestVersion: string, binName: string): string {
  return `⚠ A new version of palee is available: ${latestVersion} (you have ${currentVersion}). Run ${binName} update`;
}

/**
 * Prints the notice if — and only if — one is owed. Totals every failure path:
 * a version notice can never fail a command that already succeeded, and it
 * never touches `process.exitCode`.
 *
 * @param currentVersion - The running build's version
 * @param actionName - The command that just ran
 * @param jsonRequested - Whether the command asked for machine output
 */
export function maybeNotifyUpdate(currentVersion: string, actionName: string, jsonRequested: boolean): void {
  try {
    if (notificationSuppressed(process.env, process.stdout.isTTY, actionName, jsonRequested)) return;
    const report = evaluateUpdate(currentVersion, { force: false, timeoutMs: AUTO_CHECK_TIMEOUT_MS });
    if (report.state === 'update-available') {
      console.error(formatNotice(currentVersion, report.latestVersion, programName()));
    }
  } catch {
    // Deliberately empty: nothing a learner did wrong can be caused by the notice.
  }
}

/** Outcome of running the global install. */
export interface InstallOutcome {
  ok: boolean;
  exitCode: number | null;
  reason: string | null;
}

/**
 * Runs `npm install -g @kuldeep2822k/palee@latest` with npm owning the
 * terminal: stdio inherit, no timeout — npm's own progress and error text is
 * what the user needs to see, including the cause of an EACCES from an
 * unwritable global prefix.
 *
 * @returns Whether npm exited zero, with its code and a reason on failure
 */
export function runGlobalInstall(): InstallOutcome {
  const result = spawnNpm(npmInvocationFor(process.platform, installArgs()), {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, exitCode: null, reason: `npm could not be run (${code})` };
  }
  if (result.status !== 0) {
    return { ok: false, exitCode: result.status, reason: `npm install -g exited with code ${result.status}` };
  }
  return { ok: true, exitCode: 0, reason: null };
}
