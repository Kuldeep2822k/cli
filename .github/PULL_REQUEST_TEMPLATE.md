<!--
    Thank you for contributing to PALEE!
-->

#### Prerequisites checklist

- [ ] I have read the [contributing guidelines](https://kuldeep2822k.github.io/cli/).
- [ ] I have searched for related issues / PRs to avoid duplicates.

#### AI acknowledgment

Check all that apply:

- [ ] I did _not_ use AI to generate this PR
- [ ] I used AI to write or edit the description of this PR (including translation)
- [ ] I used AI to understand the codebase
- [ ] I used AI to write or edit the files in this PR _and_ I reviewed the files

#### What is the purpose of this pull request? (put an "X" next to an item)

<!--
    The purpose section is intentionally not a markdown checkbox list.
    Instead, mark one item and explain below.
-->

[ ] This is a new feature

    <!-- Explain: e.g. `palee plan --shuffle` adds randomized session ordering -->

[ ] This is a bug fix

    <!-- If this fixes an issue, link it below: e.g. Fixes #123 -->

[ ] This is a documentation update

    <!-- e.g. README update, VitePress docs, JSDoc -->

[ ] This is a refactor / performance improvement / internal change

    <!-- e.g. vault scanner, session memory, build pipeline -->

[ ] This is a test / CI change

    <!-- e.g. new test suite, coverage gate, CI workflow -->

[ ] Other, please explain:

    <!--

-->

#### Description

<!-- Give an overview of the changes. Link relevant issues. -->

Fixes #[issue number]

#### Type of impact

<!-- Check all that apply -->

- [ ] Core scheduling engine (SM-2, DAG, mastery)
- [ ] Vault scanning / frontmatter preservation
- [ ] Session continuity (hot.md, sessions/)
- [ ] Obsidian integration
- [ ] AI provider / Phase 2 (test, tutor, roadmap interview)
- [ ] CLI UX / machine-readable output (`--json`)
- [ ] Migration / data integrity
- [ ] This is a **breaking** change (add the `breaking` label)

#### Checklist

- [ ] Code compiles cleanly via `npx tsc --noEmit`
- [ ] Tests pass via `npm test`
- [ ] Production build succeeds via `npm run build`
- [ ] `npm pack --dry-run` produces clean package output
- [ ] Zero `any` casts in `src/`
- [ ] New commands/flags documented in the README `## Commands` section
- [ ] Exit-code behavior documented/tested (if applicable: `0`, `1`, `2`, `3`, `4`, `5`)
- [ ] No new network calls outside `palee config test-connection` and `palee update` (enforced by `test/ai-network-boundary.test.ts`)
- [ ] Security/privacy-sensitive changes reviewed against README "Windows Notes"

#### Anything else?

<!-- Reviewers: is there anything that needs extra attention? -->

<!-- markdownlint-disable-file MD004 -->
