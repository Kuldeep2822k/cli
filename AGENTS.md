# AGENTS.md

The conventions document for this repository is **[agent.md](agent.md)** — the
authoritative brief for AI coding agents and human contributors alike: the six-layer
architecture, the sacred invariants (all test-pinned), the on-disk formats, the CLI
conventions, and the verification loop every change must pass before it is done.
Read it before changing any file.

`agent.md` is the single source of truth for conventions. This file exists only so
tooling that looks for `AGENTS.md` finds its way there — keep it a pointer; do not
fork conventions content into it.

## Clone to green

Requires Node `>=22.12.0` (the package's `engines` floor; CI runs the suite on Node
22/24/26 across ubuntu/windows/macos).

```bash
git clone https://github.com/Kuldeep2822k/cli.git
cd cli
npm ci --ignore-scripts --no-workspaces   # exactly what CI installs (--no-workspaces skips the docs workspace)
npm run check                             # typecheck + lint; strict tsc --noEmit is the real quality gate
npm test                                  # the pretest hook builds dist/, then the full node:test suite runs
```

When those exit `0`, the clone is green. Release-shaped changes (build output,
`package.json`, anything the tarball ships) additionally need
`npm run build && npm pack && node scripts/verify-tarball.js`.

Full contributing steps live in [README.md](README.md#contributing); conventions and
design intent live in [agent.md](agent.md).
