# Contributing

Thanks for helping improve PALEE. The usual workflow is:

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and run the verification checks below.
4. Open a pull request.

Use a [Conventional Commit](https://www.conventionalcommits.org/) title for the pull request. Before changing code, read [AGENTS.md](AGENTS.md); it contains the repository's architecture, invariants, on-disk formats, and development conventions.

## Clone to green

PALEE requires Node `>=22.12.0` (the package's `engines` floor). The CI workflow runs the suite on the supported Node versions and operating systems.

```bash
git clone https://github.com/Kuldeep2822k/cli.git
cd cli
npm ci --ignore-scripts --no-workspaces
npm run check
npm test
```

When those commands exit `0`, the clone is green. The `check` script runs the typecheck and lint gates; `npm test` builds `dist/` through the `pretest` hook before running the full test suite.

For release-shaped changes — including build output, `package.json`, or anything shipped in the tarball — also run:

```bash
npm run build && npm pack && node scripts/verify-tarball.js
```

Tests use real temporary directories and spawn the built CLI, so changes should be verified through the same paths users run.
