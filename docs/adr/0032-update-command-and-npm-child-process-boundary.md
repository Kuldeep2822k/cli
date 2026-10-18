# ADR-0032: The Update Command and Its npm Child Process

## Status

Accepted

## Context

Issue #253 asked for two things: a `palee update` command, so upgrading does not require typing
`npm install -g @kuldeep2822k/palee@latest` by hand, and a notice when a new version has been
released, because today nothing ever tells a learner one exists.

Both require asking the npm registry a question, and PALEE's founding rule says otherwise:
INV-29 — non-AI commands open no network sockets — is enforced by `test/ai-network-boundary.test.ts`,
which statically forbids `fetch`, `http(s)`, `net`, `tls`, and `dns` in every `src/**` file except
`src/ai/provider.ts`. The test's own failure message states why: a second socket site would need
its own timeout, redaction, cancel, and exit-code handling, and would silently widen the attack
surface the provider adapter exists to concentrate.

The tension is real but resolvable: the rule constrains what the PALEE **process** opens. And
palee lives in an npm-shaped ecosystem by design — it is installed with npm and published with npm
(`docs/07-2-release-workflow-and-npm-publishing.md`), so every user already has a
registry-authenticated, proxy-aware, mirror-configured `npm` on PATH.

## Decision

### Registry questions are asked of the user's own npm, through one child process

`src/cli/update-check.ts` is the entire update surface. It calls `spawnSync` with two fixed argv
shapes — `npm view @kuldeep2822k/palee version` and `npm install -g @kuldeep2822k/palee@latest`.
Every element is a compile-time constant; nothing user-controlled reaches an argv or a shell string.
PALEE opens no socket and performs no name resolution, so the boundary test keeps
`src/ai/provider.ts` as its sole allowed network site, unchanged, and the user's `.npmrc` —
registry mirror, proxy, auth token — is honoured by npm itself, never read by PALEE. A source-shape
guard in `test/cli-update.test.ts` pins both halves: the update module never gains a socket
primitive, and the boundary test's allow-list never gains a second file.

### Platform resolution is a pure function

On win32 npm's launcher is `npm.cmd`, and Node's April 2024 security releases (CVE-2024-27980)
make spawning a `.cmd` without a shell throw `EINVAL` — so win32 spawns `npm.cmd` with `shell: true`
(accepted because the args are fixed constants), while POSIX spawns `npm` with `shell: false`. The
decision lives in `npmInvocationFor(platform, args)` rather than an inline ternary so the win32 arm
is unit-tested on every CI leg; the CI coverage floors (96/96/93/88) leave no room for a
permanently-uncovered platform branch.

### The child's working directory is pinned, not inherited

The shell that CVE-2024-27980 forces has a consequence fixed argv does not cover: `cmd.exe` searches
the current directory before `PATH` for a `.cmd`. Inheriting the directory meant a `palee` run inside
a cloned or downloaded tree would execute an `npm.cmd` planted in that tree, as the user, without
being asked — the notice path reaches a spawn on the first interactive command each day. The same
directory is where npm reads a project-level `.npmrc`, so one planted file could also answer
`npm view` with an attacker's version or point `install -g` at an attacker's registry.

So `spawnNpm` pins `cwd` to `os.homedir()` and omits `cwd` from its options type, which makes the pin
structural rather than a convention every new call site has to remember. Home is not a directory an
attacker gets files into merely by persuading someone to `cd` somewhere, and npm reads the user and
global `.npmrc` regardless of the working directory, so mirrors, proxies and credentials keep working.
Verified on win32 with Node 24: with a fake `npm.cmd` in the working directory the pre-fix code
returned the version that file printed, bypassing the real npm on `PATH`; the regression test
asserts the planted file never executes and the shim answers instead.

### The notice is cached, stderr-only, and human-gated

`<configDir>/update-check.json` records `{ checkedAt, currentVersion, latestVersion }`; a record is
trusted for 24 h and only when written by the same version — config-dir state is machine-global,
and a parallel or renamed install shares it (#311). A failed check is cached as `latestVersion:
null` so an offline user does not re-pay the spawn and its timeout on every run. The bin's
`postAction` hook prints at most one `⚠` line, on **stderr**, and only when stdout is a TTY, no
`--json` was requested, the command is not `update` itself, and `PALEE_NO_UPDATE_CHECK` is unset.
Every one of those gates is visible in the pure `notificationSuppressed`; the whole notice path is
swallow-all — a version notice can never fail a command that already succeeded, never touches
`process.exitCode`, and cannot delay piped or scripted callers, which never reach it at all. The
gates double as the suite's isolation: every spawn-based test pipes stdio, so the 100+ existing CLI
tests cannot trigger a network probe, and the `next`-creates-no-cache-file assertion pins it.

### `palee update` has one flag and no machine surface

`--dry-run` reports current, latest, and the exact command — the repo's established preview
vocabulary (adopt, roadmap, migrate). The real path echoes the command, then hands the terminal to
npm with `stdio: 'inherit'` and no timeout: npm's own progress and error text is what a user needs,
including the cause of an EACCES from an unwritable global prefix. Exit codes stay within the
closed set: 0 on up-to-date, dry-run, or successful install; 2 only via Commander's usage path; 5
when npm could not be run, the query failed or timed out, or the install exited non-zero. There is
no `--json`: during an install npm owns stdout, and the closest sibling — `config test-connection`,
the only provider-reaching command — deliberately has no machine surface either (ADR-0027). A
script that wants the data can read `update-check.json`.

## Consequences

### Positive

- Learners upgrade with `palee update` and learn of releases without configuring anything.
- The INV-29 boundary keeps its letter and its enforcement: the static test is untouched, and the
  only new network-adjacent code is argv constants handed to `child_process`.
- Corporate/mirror npm setups work for free — a direct registry fetch would have silently ignored
  `.npmrc`.
- The suite stays offline by construction; the PATH-shim tests never touch a network.

### Negative / Trade-offs

- PALEE has a `child_process` surface for the first time. It is two argv shapes of constants; the
  source-shape guard exists so drift is loud.
- The 24 h check adds one bounded npm spawn to the first interactive command per day (~0.5–2 s);
  failures are cached so offline runs pay it once a day at most.
- After a successful install the *running* process is still the old version; the cache is rewritten
  as up-to-date so the outgoing build cannot emit a stale notice.
- `palee update` only manages global npm installs. An install via a pnpm/yarn global shim updates
  with its own tool; the command exists for the documented install path.

## Alternatives Considered

1. **Fetch `https://registry.npmjs.org/…` from PALEE and add the file to the boundary test's
   `ALLOWED`.**
   - *Why Rejected*: exactly the second-socket-site class the test's message calls out — own
     timeout, redaction, cancel, and exit-code handling — plus `.npmrc` registry/proxy/auth is
     bypassed, so a mirrored or corporate setup gets a wrong or failing answer, and INV-29's text
     would need re-wording to keep the prose and the check agreeing.
2. **Print the notice on stdout after the command's payload.**
   - *Why Rejected*: breaks the one-document-per-command machine contract (INV-30's non-TTY purity
     and the piped-caller rule); stderr keeps it human-visible and scripted-invisible.
3. **Check the registry on every run (short or no TTL), or run the check unconditionally for piped
   callers.**
   - *Why Rejected*: adds npm-spawn latency and registry traffic to every invocation, including
     CI and scripted runs that asked for nothing, and would put the tests on the network.
4. **Capture install output (`stdio: 'pipe'`) and re-print a palee summary.**
   - *Why Rejected*: hides the actual npm failure (an EACCES prefix error is the common one),
     needs maxBuffer juggling, and buys nothing — the command is not machine-readable by decision.
5. **A `--check` flag.**
   - *Why Rejected*: `--dry-run` is what adopt/roadmap/migrate already mean; two preview words in
     one CLI is API noise.
6. **A `PALEE_NPM_COMMAND` override for testability.**
   - *Why Rejected*: turns an environment value into arbitrary code execution run as the user; a
     PATH shim in tests covers the same ground without shipping the knob.
