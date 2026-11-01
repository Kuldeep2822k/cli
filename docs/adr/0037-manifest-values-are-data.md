# ADR-0037: Manifest Values Reach the Shell as Data, Never as Interpolation

## Status

Accepted

## Context

The release pipeline builds, packs, verifies and publishes a tarball, and the publish step is the one place in this repository where a runner holds `NPM_TOKEN` and `id-token: write` at the same time. Four `run:` blocks in `release.yml` and two in `ci.yml` read values out of `package.json` and interpolated them directly:

```yaml
run: |
  VERSION=${{ needs.verify-and-pack.outputs.version }}
run: npm publish ${{ needs.verify-and-pack.outputs.package-filename }} --access public --provenance
run: npm install -g --ignore-scripts ${{ steps.pack.outputs.filename }}
```

`scripts/verify-tarball.js` did the same thing from the other direction, building `tar -tzf ${filename}` in a template string and handing it to `execSync`.

GitHub's expression substitution happens before the shell runs, and the shell then parses the result. A `version` or `name` containing a space, a semicolon, `$()` or a backtick is therefore not a version — it is shell syntax on a credentialed runner, executing before `npm` starts. The trigger is a write or a tag, so this is a supply-chain hardening issue rather than an unauthenticated attack; the finding that produced it (#565 P1-06) was filed with that scope stated.

The values also had two homes. `pack-package.js` and `verify-tarball.js` each computed the tarball filename with the same expression, so a change to one was a silent divergence from the other.

## Decision

### 1. Validate the manifest before anything reads it

`scripts/release-manifest.js` is the single home for the rules: a strict semver (prerelease and build suffixes allowed), an npm package name, and the one tarball-filename derivation. It is side-effect free on require, so the guard suite can assert the rules without running a release.

`pack-package.js` calls it **before** `npm pack` and before writing `GITHUB_OUTPUT`, so a malformed manifest fails the job before the outputs every downstream job consumes are created. A value that cannot be produced cannot be interpolated. `test/package-publish-guard.test.ts` pins that ordering rather than the rules alone: it runs the packer against a manifest carrying shell syntax and asserts that `npm pack` was never invoked and that no output line was appended.

### 2. Pass values through `env:`, quote them at use, and keep them out of string-built commands

Every former interpolation now appears as an `env:` entry and is referenced as `"$VARIABLE"` (or `$env:VARIABLE` under pwsh) inside the `run:` block, and every such step declares the shell that reference belongs to. Declaring `shell: bash` is not decoration: `ci.yml`'s install step first shipped this change without it, and on the `windows-latest` legs the default shell is pwsh, where a bare `$TARBALL` is an undefined PowerShell variable that expands to the empty string — so the step ran `npm install -g --ignore-scripts ""` and installed nothing. `test/package-publish-guard.test.ts` now asserts both halves: every `env:` value carrying an output is referenced by the step, and a POSIX `$NAME` reference only counts when the step declares `shell: bash`. `verify-tarball.js` uses `execFileSync('tar', ['-tzf', filename])`, so the filename is one argv element and no shell exists to parse it.

### 3. Guard the class, not the line

The previous guard in `test/package-publish-guard.test.ts` pinned the vulnerable text with a regex — it could only be satisfied by keeping the interpolation. It now parses both workflows with `yaml` and asserts that **no** `run:` block in **either** file contains an `outputs.` expression, plus that the publish step still publishes the filename `verify-and-pack` produced. That is strictly broader than the line it replaced, and it survives a legitimate rename of the step or the output.

`ci.yml`'s `contains(needs.*.result, …)` condition is deliberately untouched: it is a boolean expression with no value, and it contains no `outputs.`.

## Consequences

- A hostile or fat-fingered `package.json` fails the pack job at its first line instead of reaching a shell on the publish runner.
- The tarball name has one derivation; `verify-tarball.js` no longer needs `pkg.name.replace(...)`.
- The workflow edits are `env:` moves with no behavioural change: the same value is read at the same step, quoted rather than expanded.
- `npm pack` stays on `execSync` with a constant command — `npm` is `npm.cmd` on Windows, and `execFileSync` without `shell` refuses `.cmd` on current Node. There is no interpolated value to protect there.
- The `version` a release may carry is now the semver grammar, not "whatever the manifest says". A four-part `1.0.0.1` is refused rather than packed.

## Alternatives considered

**Validation only, leaving the interpolations in place.** Smaller and avoids touching the one workflow that cannot be re-tested locally, but it does not remove the class: any future `run:` line that interpolates a new output reintroduces it, and the values were already reaching `env:`-less shell contexts in `ci.yml`.

**Quoting only, without validation.** Quoting survives most metacharacters but not every consumer: the filename is also an artifact path, an install argument, and a `tar` argument. Refusing a non-semver at the source is the only place where "this value is safe to use anywhere" can be asserted once.
