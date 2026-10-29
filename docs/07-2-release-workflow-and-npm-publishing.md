---
description: "The PALEE release pipeline is a highly automated, multi-stage workflow designed to ensure that every version published to the NPM registry is verified, consistent, and functional across platforms."
---


# Release Workflow and NPM Publishing
::: details Relevant Source Files

- [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
- [package-lock.json](https://github.com/Kuldeep2822k/cli/blob/main/package-lock.json)
- [scripts/verify-tarball.js](https://github.com/Kuldeep2822k/cli/blob/main/scripts/verify-tarball.js)

:::

The PALEE release pipeline is a highly automated, multi-stage workflow designed to ensure that every version published to the NPM registry is verified, consistent, and functional across platforms. The process is primarily driven by GitHub Actions and triggered by versioned Git tags.

## Release Pipeline Architecture

The workflow is defined in `.github/workflows/release.yml` and consists of four distinct jobs that enforce strict quality gates before a package is made public.

### Workflow Trigger and Concurrency

The pipeline is triggered by the push of a tag matching the `v*.*.*` pattern or via manual `workflow_dispatch`[.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml) To prevent race conditions during publishing, it uses a concurrency group `release-production` with `cancel-in-progress: false`[.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

### Release Data Flow and Code Entities

The following diagram illustrates how the release workflow interacts with codebase entities and external registries.

"Release Process Data Flow"

```mermaid
flowchart TD
    subgraph subGraph2 ["External Registries"]
        NPM["NPM Registry"]
        GH["GitHub Releases"]
    end
    subgraph subGraph1 ["CI: verify-and-pack"]
        VCheck["Version Consistency Check"]
        Build["npm run build"]
        Pack["npm pack"]
        VerifyScript["scripts/verify-tarball.js"]
    end
    subgraph subGraph0 ["Local/Git Space"]
        Tag["Git Tag (vX.Y.Z)"]
        PkgJson["package.json"]
    end
    Tag --> VCheck
    PkgJson --> VCheck
    VCheck --> Build
    Build --> Pack
    Pack --> VerifyScript
    VerifyScript --> NPM
    VerifyScript --> GH
```

Sources: [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)[scripts/verify-tarball.js](https://github.com/Kuldeep2822k/cli/blob/main/scripts/verify-tarball.js)

## Job Details and Implementation

### 1. Verify, Build & Pack (`verify-and-pack`)

This job prepares the distribution artifact. It performs three critical validation steps:

- Version Consistency Check: It extracts the version from the Git tag and compares it against the `version` field in `package.json`. If they do not match, the pipeline fails immediately [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
- Quality Gates: It executes `npm run check` (Lint/Typecheck) and `npm run test:coverage` (Unit/Invariant tests) to ensure the code is stable [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
- Artifact Validation: After running `npm pack`, it invokes a custom validation script, `scripts/verify-tarball.js`[.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

#### `verify-tarball.js` Implementation

The validation script ensures the tarball contains only necessary production files and excludes source code or internal configuration [scripts/verify-tarball.js](https://github.com/Kuldeep2822k/cli/blob/main/scripts/verify-tarball.js)

| Category | Files/Directories |
| --- | --- |
| Required | `package.json`, `dist/`, `README.md`, `LICENSE`, `dist/bin/palee.js`[scripts/verify-tarball.js](https://github.com/Kuldeep2822k/cli/blob/main/scripts/verify-tarball.js) |
| Forbidden | `src/`, `test/`, `.github/`, `planning/`, `coverage/`[scripts/verify-tarball.js](https://github.com/Kuldeep2822k/cli/blob/main/scripts/verify-tarball.js) |

Sources: [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)[scripts/verify-tarball.js](https://github.com/Kuldeep2822k/cli/blob/main/scripts/verify-tarball.js)

### 2. Idempotent NPM Publishing (`publish-npm`)

Publishing waits on two jobs: `verify-and-pack`, which produces the artifact it uploads, and `test-platforms`, which runs the same operating-system and Node matrix CI runs [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml). The gate lives here rather than depending on CI's tag run because a GitHub Actions job cannot depend on another workflow's result — without it, a macOS or Windows failure could occur while the ubuntu-only release path published anyway. `test/ci-workflow-matrix.test.ts` asserts the two matrices stay identical, so the release cannot quietly gate a narrower claim than CI tests.

The publishing job uses the `npm-release` environment and requires `id-token: write` for OIDC-based authentication [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

To ensure the pipeline is idempotent (safe to re-run), it performs a pre-check using `npm view`. It queries the registry for the specific version being released; if the version already exists, the publish step is skipped to avoid "cannot modify existing version" errors [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

Sources: [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

### 3. GitHub Release Creation (`github-release`)

Once the NPM publish is successful, the workflow creates a GitHub Release using `softprops/action-gh-release`. This step:

- Generates automatic release notes based on commit history [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
- Attaches the verified `.tgz` tarball as a release asset [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

Sources: [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

### 4. Post-Release Smoke Test (`smoke-test`)

The final job runs on `windows-latest` to verify the package's behavior in a non-POSIX environment.

Because the NPM registry often has a slight propagation delay (replication lag), the smoke test implements a retry loop. It attempts to install the package globally up to 30 times, waiting 10 seconds between each attempt [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

The real-command smoke ships with the repository, not with the published package, so the job's first step is a pinned `actions/checkout` [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

After installation, it verifies:

1. Binary Availability: Running `palee --version`[.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
2. Version Accuracy: The CLI output must exactly match the release version [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
3. Command Execution: Running `palee --help` to ensure dependencies like `commander` are correctly resolved [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)
4. Real Command: Runs `scripts/smoke-installed.js`, which executes `palee next --json` against an isolated temporary vault outside the checkout and asserts the documented empty-state JSON contract [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

"Smoke Test Execution Flow"

```mermaid
sequenceDiagram
    participant Runner as Windows Runner
    participant Registry as NPM Registry
    participant CLI as palee global bin
    Runner->>Registry: npm install -g @kuldeep2822k/palee@VERSION
    Registry-->>Runner: Package Installed
    Note over Runner: Sleep 10s
    Runner->>CLI: palee --version
    CLI-->>Runner: ACTUAL_VERSION
    Note over Runner: Compare ACTUAL vs EXPECTED
    Runner->>CLI: palee --help
    CLI-->>Runner: Display Help
    Runner->>CLI: palee next --json (isolated temp vault)
    CLI-->>Runner: exit 0, empty-vault JSON contract
```

Sources: [.github/workflows/release.yml](https://github.com/Kuldeep2822k/cli/blob/main/.github/workflows/release.yml)

## Distribution Configuration

The package contents are defined by the `files` allowlist in `package.json`; there is no `.npmignore`. The allowlist publishes the compiled output and changelog, and npm always includes `package.json`, `README.md`, and `LICENSE`:

- `package.json`: Always included by npm. It defines the entry points for the compiled code, and the `bin` field maps the `palee` command to `dist/bin/palee.js` [package.json](https://github.com/Kuldeep2822k/cli/blob/main/package.json)
- `files` allowlist: Publishes `dist/src`, `dist/bin`, `dist/package.json`, and `CHANGELOG.md` [package.json](https://github.com/Kuldeep2822k/cli/blob/main/package.json). Source, tests, and planning documents are excluded by omission rather than by an ignore file.

Sources: [package.json](https://github.com/Kuldeep2822k/cli/blob/main/package.json)