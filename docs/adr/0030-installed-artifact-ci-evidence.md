# ADR-0030: Installed-Artifact CI Evidence

## Status

Accepted

## Context

Two workflows install the real package and check it: `ci.yml`'s `smoke-install` job packs the tarball, runs `scripts/verify-tarball.js`, installs it globally with `npm install -g`, and then runs `palee --version` (against the packed version) and `palee --help`; `release.yml`'s post-publish `smoke-test` installs the published package and repeats the same two flag checks.

Both flag checks exit inside the bin entry. They prove the shim resolves and the version string is right, but they never reach the command dispatcher's data path: no config load, no vault read, no JSON emit, and no dependency between compiled modules. A tarball that packs a broken relative require, drops a runtime file the flags never touch, or ships modules whose inter-dependencies fail at load would keep every smoke check green while the first real user command fails. `verify-tarball.js` asserts that files are present; it cannot assert that they work together.

The two smoke jobs also drift independently — the same class of divergence #269 found in the platform matrix — so the evidence they produce has to be asserted in one place.

## Decision

### One real command, run wherever the package was just installed

`scripts/smoke-installed.js` runs after the flag checks in both jobs. The post-publish job checks the repository out first (pinned, `persist-credentials: false`): `npm install -g` delivers only the published package, and the script ships with the repository, not with the package. It:

- creates an isolated temporary root under `os.tmpdir()` with an empty `vault/` and a `config/config.json` naming that vault as `vaultPath`;
- runs with the temporary root as `cwd`, outside the checkout, so nothing can silently resolve against the repository;
- spawns the PATH-resolved `palee next --json` — exactly what a user's shell resolves — via `cmd /d /s /c` on Windows (`palee.cmd` cannot be launched directly, and `shell: true`'s argument concatenation is deprecated as of Node 24) and directly on POSIX;
- sets `PALEE_CONFIG_DIR` and `NODE_ENV`, and removes `NODE_OPTIONS`/`NODE_PATH` so inherited loader or resolution overrides cannot make the step test something other than the artifact;
- asserts exit 0 and the empty-vault JSON contract — `total_topics: 0`, `due_count: 0`, `next: null` — reporting captured stdout/stderr on any failure;
- bounds the run with a 60 s timeout and removes the temporary root in a `finally` (the failure path sets `process.exitCode` rather than calling `process.exit`, so the cleanup cannot be skipped).

`next --json` is the command because it is the smallest one that traverses dispatch → config resolution → vault read → JSON emit, is read-only, and has a deterministic empty-vault contract already pinned by the unit and e2e suites — so the smoke step asserts the same documented shape at the artifact level, not a new one.

### Both smoke jobs run it, and a guard keeps them from drooping

`ci.yml`'s `smoke-install` runs the script on all three OS legs (macOS included — the platform `npm install -g` was historically broken on), and `release.yml`'s post-publish `smoke-test` runs it after installing the published package. `test/ci-workflow-matrix.test.ts` parses both workflows and asserts each smoke job has a step invoking the script **after** an `actions/checkout` step, and that the script exists — the same workflow-text guard pattern the matrix parity test established. The ordering assertion is what converts a post-release "Cannot find module" from a silent release-day failure back into a failing test.

### Node built-ins only

The step runs outside the checkout's dependency tree; the script uses only `fs`, `os`, `path` and `child_process`, so it behaves identically on Ubuntu, Windows and macOS with no install step of its own.

## Consequences

### Positive

- The packed artifact is proven on a real command — dispatch, config, vault read, JSON output, exit code — on every platform it ships to, before merge and again after publish.
- Failures are diagnosable from the CI log alone: the error carries the exit status and both output streams.
- The workflow guard makes the two smoke jobs diverge only by failing a test, not by silently narrowing what is checked.

### Negative / Tradeoffs

- **The script duplicates three fields of the empty-vault contract.** If that contract changes, this script must change with it — bounded and stated here, but it is a second place the shape is written down (the assertion is deliberately the narrow documented subset, not the full payload).
- **The smoke vault is empty by construction.** Adoption, review and session flows remain e2e coverage; the smoke's claim is presence-of-life for the installed artifact, not behavioral breadth.
- **A couple of extra seconds per smoke leg.** Negligible against the global install the step follows.

## Alternatives Considered

1. **Add more flag probes (`--json`, subcommand `--help`).**
   - *Why Rejected*: they still exit before the data path; breadth of flags is not breadth of behavior.
2. **Run the repository test suite with PATH pointed at the installed binary.**
   - *Why Rejected*: heavyweight, would need the repo's dev dependencies inside the smoke step, and duplicates what `test-matrix` already proves about behavior. It is the right shape for a dedicated follow-up (installed-binary integration coverage), not for a smoke check.
3. **Shell steps per OS instead of one script.**
   - *Why Rejected*: three implementations of the same assertions on three platforms is exactly the drift class this ADR exists to prevent; a Node script is one implementation that runs everywhere.
4. **`npx palee next --json`.**
   - *Why Rejected*: `npx` prefers the local `node_modules/.bin` inside the checkout, which would test the repository build rather than the globally installed artifact — the one object the smoke step exists to exercise.
