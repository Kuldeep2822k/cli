# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The installed artifact is smoke-tested with a real command, not just flags** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): `scripts/smoke-installed.js` runs the PATH-resolved `palee next --json` against an isolated temporary vault, asserting exit 0 and the documented empty-vault JSON contract, in CI's `smoke-install` (Ubuntu, Windows and macOS alike) and in the post-publish smoke test; `test/ci-workflow-matrix.test.ts` keeps both workflows wired. Recorded as ADR-0030.
- **ADR-0009 through ADR-0013** ([#434](https://github.com/Kuldeep2822k/cli/issues/434)): the auto-chain inference policy and gating model are recorded as architecture decision records — the `depends_on_source` advisory/gating split, Tier-0 hygiene classification, tiered `strict|full` composition, declared prerequisites read from a note's own text, and the proposed per-edge blocking policy. First ADRs since ADR-0008.
- **ADR-0014 through ADR-0019** ([#435](https://github.com/Kuldeep2822k/cli/issues/435)): the storage layer's contracts are recorded — atomic-write durability and vault containment (mode preservation, directory fsync, the existence-expectation API), identity preservation on import, frontmatter byte fidelity and Unicode fold discipline, roadmap import safety (pre-write graph re-check, ID-format gate, full dry-run), the note read path (comment tolerance, negative caching, size cap, fingerprint-verified staleness, lock liveness, 4-byte id entropy), and session-memory lifecycle (rebuild-before-retire, the 24h clamp as a recorded policy, counted unreadable sessions).
- **ADR-0020 through ADR-0026** ([#436](https://github.com/Kuldeep2822k/cli/issues/436)): the command surface's contracts are recorded — readiness and scheduling (one shared prerequisite gate, the two-case blocked report, archived-topic placement), the assessment surface (only supplied pillars written, corrupt values refused not clamped, exact-id resolution, the Feynman hint), adoption (hand-written `depends_on` preserved, filter honesty, `--undo` with the `PALEE_OWNED_KEYS` contract), `migrate --relabel-ties` (the surface ruling, the adjacency rule, the three counted refusals, existence-based `vanished` classification), exit codes and the machine-readable error contract (one classifier, flush policy, parsed-options JSON detection), the application layer and the CLI boundary, and the test-discipline rulings (falsifiability, equal-work comparisons, which side of a policy change moves).
- **ADR-0027 and ADR-0028** ([#437](https://github.com/Kuldeep2822k/cli/issues/437)): the AI module's boundary and the Phase-2 designs are recorded — the injected-`Transport` adapter, the reserved-address-space refusals (`fe80::/10` as `fe[89ab]`, unwrapped IPv4-mapped literals, `::1` exempt, `.internal` refused, RFC 1918 permitted by design), the streaming 256 KiB read bound, credential handling (never argv, `••••••••` on show, `PALEE_API_KEY` precedence, the Windows "location, not ACL" ruling), and the four Phase-2 designs (#24 provider abstraction, #70 deterministic recommendation engine, #206 downgrade-only AI chain verification, #224 per-edge policy) recorded as Proposed. ADR-0028 also records the external bug-ledger gap.
- **`palee adopt --undo`** ([#299](https://github.com/Kuldeep2822k/cli/issues/299)): reverses an adoption by stripping only the frontmatter keys adoption writes, leaving every other key byte-for-byte and previewable with `--dry-run`.
- **Every mutating command names the vault it writes to** ([#311](https://github.com/Kuldeep2822k/cli/issues/311)).
- **`palee update` and a new-version notice** ([#253](https://github.com/Kuldeep2822k/cli/issues/253)): upgrades the global install by delegating to the user's own `npm` (`--dry-run` reports the current and latest versions and the exact command, installing nothing); an interactive run prints one `⚠` line on `stderr` when a newer version is published, at most once per 24 hours and once per published version, silenced by `PALEE_NO_UPDATE_CHECK` and never seen by piped, `--json`, or failed runs. PALEE's own process opens no socket (INV-29); npm performs the network access.
- **ADR-0033** ([#253](https://github.com/Kuldeep2822k/cli/issues/253)): records the npm child-process boundary — why the registry is queried through a child process rather than a second socket site, the Windows `npm.cmd` shell resolution and the working directory it pins so a planted `npm.cmd` cannot run, the cached stderr-only TTY-gated notice, and why `update` has no `--json` surface.

### Changed

- **The exit-code contract is enforced, not only documented** ([#207](https://github.com/Kuldeep2822k/cli/issues/207)): `eslint.config.mjs` now arms `no-empty` (empty `catch` still allowed), `@typescript-eslint/no-unused-vars` (`^_` exemptions, rethrow-only bindings), `eqeqeq` (the `x != null` idiom preserved), `prefer-const` and `@typescript-eslint/no-useless-empty-export` with surgical options instead of blanket `off`, and gates `src/**`+`bin/**` on a `projectService` program with `@typescript-eslint/no-floating-promises` — zero findings in shipped code, `test/**` exempt by design where the same rule measures 2314 fire-and-forget fixtures — `no-promise-executor-return`, and a `no-restricted-syntax` pattern rejecting `process.exitCode = <numeric literal>`. 44 handler sites that hard-coded the literal import `ExitCode` instead, value-for-value under its `as const`, so no command changes the number it exits with; `test/eslint-exit-code-guard.test.ts` reads the selector out of the live config, so deleting the pattern reddens the suite instead of silently un-pinning the header of `src/cli/exit-codes.ts`. Adds `npm run lint:fix`, and joins `.qoder/**` to the ignored paths: a second copy of the repo in the tree — an agent worktree, a scratch clone — brings its own `eslint.config.mjs`, and once ESLint merges two configs that each request a TS program, every file in the run fails to parse (217 main-tree files, measured) rather than just the copy. Documents the two `palee session end` paths that really do exit `1` (undeleted draft checkpoints, an uncleared `hot.md` marker) where the matrix claimed `N/A`, and corrects `agent.md` and the CI page's stale account of which gates are armed.
- **Quarantine builds the adjacency and its SCC decomposition once** ([#345](https://github.com/Kuldeep2822k/cli/issues/345)): `findCyclicSccNodes` and `detectCyclesBounded` each rebuilt the pair from the same graph, so a vault with cycles paid for two identical `O(V+E)` passes per `plan`/`next`. No output changes — a 400-graph differential run of the old and new code is byte-identical — and an acyclic vault already cost one pass, which is still one.
- **The `migrate --relabel-ties` fault-injection tests pin the output they force** ([#237](https://github.com/Kuldeep2822k/cli/issues/237)): the EACCES write-error and scan-to-write-drift cases called `migrateCommand` in-process and asserted only `process.exitCode`, so the refusal lines they exist to produce streamed into the `npm test` and coverage console — a green run printed `Error: 1 relabel write(s) failed` and `Error: OCC conflict or active lock detected`, which reads as two failures. Both now run under the `withCapturedOutput` helper their four neighbours in the same file already use, and the captured text is asserted: the OS error behind the refused note, the predecessor the drift line names, and the counted summary on stdout. Each new assertion was proved load-bearing (ADR-0026) by a separate mutation of `src/cli/migrate.ts`. Test-only; no command behaviour changes.
- **`npm test` bounds its worker pool the same way coverage does** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): the plain test script now passes `--test-concurrency=4`, matching `test:coverage` (ADR-0029). Uncapped, `node:test` spawns one `tsx` worker per core regardless of what memory is actually available: on a 16-core dev box sitting at ~2 GB free the `cli-*` suites produced 86 spurious failures and then died with `FATAL ERROR: Zone Allocation failed - process out of memory`, while the identical suites passed 534/534 capped at 4. `test/ci-workflow-matrix.test.ts` pins the bound on both launch paths and requires the two values to agree.
- **Direct CLI spawns in the test suite carry the same budget as `runPalee`** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): `execSync`/`spawnSync`/`execFileSync` calls that bypass `test/e2e/test-env.ts` blocked their worker with no way back, so one hung child stalled a suite for ~20 minutes and surfaced as an unexplained hang rather than a failure. `CLI_SPAWN_TIMEOUT_MS` (120 s — measured at roughly a hundred times the slowest single invocation in these suites, and the budget `runPalee` already uses) now bounds the highest-density offenders, and `test/cli-spawn-timeouts.test.ts` fails on any new unbounded direct spawn; the 21 files still to migrate are held in an allow-list that the same guard shrinks.
- **ADR-0032 corrects ADR-0029's spawn-bounding claim** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): ADR-0029's section heading "Every spawn is bounded" was false at acceptance — #456 bounded launches through `runPalee`/`runPaleeInteractive` only, leaving 24 of the 25 files containing a real direct spawn call with no per-spawn timeout, and #460 recorded that remainder as "by design" while ADR-0029's own alternatives rejected it. ADR-0032 scopes the claim to the helper path, names `test/cli-spawn-timeouts.test.ts` as the check that pins the direct path, withdraws "by design" in favour of the shrink-only allow-list, and records the guard's blind spots (it is a line-window heuristic, not an argument parser). ADR-0029's Status, heading and consequences are amended in place; the `PALEE_ARGV`/`PALEE_CMD` centralisation it claims holds for 28 of the 30 direct call sites, the two exceptions being a Windows path probe that launches no CLI and `cli-program-name`'s deliberately copied entry.
- **Test-time CLI launch policy kept `tsx` under coverage; `test:coverage` builds once and caps concurrency** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): routing coverage children through the compiled `dist` entry was trialed and rejected — the tsc-emitted function maps do not merge with the tsx parent's, dropping function coverage from 94.35% to 87.07% (below the 93% floor; ADR-0029 records the evidence). The coverage script now builds via `pretest:coverage` ahead of the run, wraps the Node test runner directly instead of a nested `npm test`, and bounds the runner pool with `--test-concurrency=4`.
- **CLI subprocess helpers are bounded** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): `runPalee` fails with the command name and captured output after a 120 s default timeout instead of hanging its worker; `runPaleeInteractive` accepts `cwd`/`env`/`timeout` overrides; `PALEE_CMD` pins the quoted `process.execPath` rather than PATH-resolved `node`.
- **Piped/redirected output no longer forces JSON** ([#357](https://github.com/Kuldeep2822k/cli/issues/357)): `isJsonOutput()` now selects JSON only on the explicit `--json` flag or `PALEE_JSON=1` (`true`); `palee plan > out.txt` and `palee dashboard | less` keep the human-readable report.
- **Every arm of `config` and `session` answers JSON when JSON is selected** ([#45](https://github.com/Kuldeep2822k/cli/issues/45), [#357](https://github.com/Kuldeep2822k/cli/issues/357)): the gate was right but the coverage was not, so a run that asked for machine-readable output still received prose. `palee session start --json` exited 0 with the working-memory banner, `session draft`/`end` printed a line per consumed draft above their document, and every `config` write except `show` answered a sentence. Writes now answer `{status, <field>}`, refusals answer `{error}` on stderr with guidance folded into `remedy`/`valid_actions`, heads-ups travel inside `warnings`, and the exit-5 catch-alls of both commands route through `emitError()`. Human output is byte-for-byte unchanged; `review`, `adopt`, `assess`, `roadmap` and `migrate` still do not declare `--json` and commander still refuses the flag for them — `PALEE_JSON` leaves those five human end to end instead of only switching their vault refusals to JSON, and `session start --interactive --json` writes the recovery menu to `stderr` so `stdout` still carries exactly one document.
- **TypeScript strictness raised to the last two flags** ([#381](https://github.com/Kuldeep2822k/cli/issues/381)): `tsconfig.json` now enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Indexed reads are captured-and-guarded, and optional properties keep their narrow type — an absent value omits the key instead of widening to `?: T | undefined`. No runtime behavior change.
- **Auto-chain tiers are now `strict` and `full`**: the redundant `toc` alias was removed; `full` adds advisory TOC enumeration to the numbered plan.
- **`ValidationError` is a discriminated union and `TopicNode` drops its catch-all index signature** ([#337](https://github.com/Kuldeep2822k/cli/issues/337)).
- **`prepublishOnly` rebuilds `dist/` on publish** ([#336](https://github.com/Kuldeep2822k/cli/issues/336)) so a manual `npm publish` cannot ship a stale build.
- **README no longer advertises commands that are not implemented** ([#321](https://github.com/Kuldeep2822k/cli/issues/321)).

### Fixed

- **The default config is described per-user, not machine-global**: `palee --help` told users an unset `PALEE_CONFIG_DIR` means "the machine-global config … every command on this machine shares one config", and the `PaleeConfig` doc comment named `~/.palee/config.json` — a path `getConfigPath()` never produces. Both real defaults (`%LOCALAPPDATA%\palee` on Windows, `~/.config/palee` elsewhere) sit under the current user's profile, so the old wording hid that two accounts keep separate vaults and credentials.
- **A `## Requirements` heading declares its prerequisites** ([#340](https://github.com/Kuldeep2822k/cli/issues/340)): the section scan accepted `## Prerequisites`, `## Requires`, `## Required knowledge` and `## Depends on`, but a note titling its own list `## Requirements` silently gated nothing.
- **A non-numeric stored SM-2 field is refused, not scheduled** ([#342](https://github.com/Kuldeep2822k/cli/issues/342)): `interval_days: soon` slipped past the range guards because `"soon" < 1` is false, and the note was written back with a `NaN` interval; `processReview` now refuses a value that is not a finite number, so the field is named and `validate --fix` can repair it. The same precondition block also refuses a repetition count above `Number.MAX_SAFE_INTEGER - 1` (whose increment would silently no-op) and a stored interval or ease factor whose schedule arithmetic overflows to a non-finite result.
- **HTML-comment blanking is linear on unterminated `<!--` runs** ([#385](https://github.com/Kuldeep2822k/cli/issues/385)): the shared `stripUnfollowableMarkup` now scans comments with successive `indexOf` calls that resume after each match, instead of a lazy regex that rescanned to end-of-text for every opener — a quadratic the `extractTocLinks` complexity guards could not see because the blanking pass was charged a flat one-read cost.
- **A root folder link chains onto the vault README** ([#344](https://github.com/Kuldeep2822k/cli/issues/344)): `[Home](/)` folded to an empty path because the folder→README rewrite wrote `segments[-1]` — a non-index property `join('/')` silently drops — and the enumeration then logged a well-behaved link as `escaped-vault`.
- **`palee review` never mints pillar scores and names an off-schedule (early) review** ([#300](https://github.com/Kuldeep2822k/cli/issues/300), [#301](https://github.com/Kuldeep2822k/cli/issues/301)).
- **`atomicWrite` preserves the destination's permission mode and fsyncs the parent directory** ([#318](https://github.com/Kuldeep2822k/cli/issues/318), [#333](https://github.com/Kuldeep2822k/cli/issues/333)).
- **The machine-readable error contract holds on every failure path** ([#320](https://github.com/Kuldeep2822k/cli/issues/320), [#325](https://github.com/Kuldeep2822k/cli/issues/325), [#326](https://github.com/Kuldeep2822k/cli/issues/326), [#338](https://github.com/Kuldeep2822k/cli/issues/338)): JSON mode and exit codes stay consistent, no raw error object is dumped, and `process.exit()` no longer truncates output.
- **An empty-stem or non-`.md` path classifies as a leaf, not the gating backbone** ([#330](https://github.com/Kuldeep2822k/cli/issues/330)).
- **Topic-note eligibility is unified across the three managed-note validation gates** ([#324](https://github.com/Kuldeep2822k/cli/issues/324)).
- **`next` gates on prerequisites, lists a blocked note once, and excludes archived topics** ([#305](https://github.com/Kuldeep2822k/cli/issues/305), [#306](https://github.com/Kuldeep2822k/cli/issues/306)) — consistent with `plan` and `dashboard`.
- **`roadmap` gains `--dry-run`, corrects its `--auto-chain` help, and preserves a chain head's existing `depends_on`** ([#309](https://github.com/Kuldeep2822k/cli/issues/309), [#310](https://github.com/Kuldeep2822k/cli/issues/310), [#322](https://github.com/Kuldeep2822k/cli/issues/322)).
- **The note read path accepts `##` YAML comments in frontmatter, caches non-topics, and caps note size** ([#319](https://github.com/Kuldeep2822k/cli/issues/319), [#331](https://github.com/Kuldeep2822k/cli/issues/331), [#332](https://github.com/Kuldeep2822k/cli/issues/332)).
- **`validate --fix` honours each rule's `fixable` metadata and completes both repairs on one note in a single pass** ([#323](https://github.com/Kuldeep2822k/cli/issues/323)).
- **`adopt` refuses batch filters in single-file mode and names a pattern that matched nothing** ([#303](https://github.com/Kuldeep2822k/cli/issues/303), [#312](https://github.com/Kuldeep2822k/cli/issues/312)).
- **`roadmap` enforces the topic ID format before any write** ([#308](https://github.com/Kuldeep2822k/cli/issues/308)).
- **Draft recovery rebuilds before retiring the draft, keeps hot `started_at`, and never dedupes on an empty notes body** ([#328](https://github.com/Kuldeep2822k/cli/issues/328), [#329](https://github.com/Kuldeep2822k/cli/issues/329)).
- **`session` resolves `--topic` against the vault and still ends a session whose note was deleted mid-flight** ([#302](https://github.com/Kuldeep2822k/cli/issues/302), [#313](https://github.com/Kuldeep2822k/cli/issues/313)).
- **A first-creation write and a lost lock are detectable, so concurrent `hot.md`/`index.md` writes cannot silently clobber** ([#327](https://github.com/Kuldeep2822k/cli/issues/327), [#334](https://github.com/Kuldeep2822k/cli/issues/334)).
- **`palee` usage text prints the program name the process was actually invoked as** ([#314](https://github.com/Kuldeep2822k/cli/issues/314)).
- **Documentation drift corrected after the repo-wide command-invocation audit** ([#451](https://github.com/Kuldeep2822k/cli/issues/451)): `agent.md` and `docs/07-1` state the real c8 thresholds (96/96/93/88) and the test launch policy from ADR-0029; `docs/06-2` drops hard-coded per-suite test counts and the "11 commands" claim; `docs/05-0` names the real config path; `README` documents `palee assess`, `session draft`/`list` and the previously missing options, and states the Node floor; the planning and architecture documents are labeled for what they are — unshipped proposals and a dated evidence snapshot — and ADR-0031 records the policy.

### Security

- **`config set-base-url` no longer re-targets a stored API key silently** ([#482](https://github.com/Kuldeep2822k/cli/issues/482)): changing the endpoint to a different origin (scheme, host or port) now prompts on a terminal unless `--keep-key` is passed, and a non-interactive or `--json` run refuses with exit `2` without it. Declining the prompt leaves both the old URL and the key unchanged; a previous base URL that cannot be parsed is treated as a change. The key remains one config field rather than gaining a per-origin schema.
- **`ensureVaultDirectory` is contained before it creates** ([#335](https://github.com/Kuldeep2822k/cli/issues/335)): the target is checked against the vault root before any `mkdir`, blocking a mid-path symlink escape.
- **Docs toolchain audit pins**: the full npm audit (push-time, dev included) fails on advisories published 2026-10 — `katex` prototype pollution (via `mermaid 11`, GHSA-238p-pmpm-9mq7) and the `@xmldom/xmldom ≤ 0.9.11` batch (via `speech-rule-engine 4.1.4`, ~12 GHSAs). Scoped `overrides` pin the fixed `katex 0.18.11` (mermaid 11's declared range caps below the fix; `vitepress-plugin-mermaid@2.0.17` — unmaintained — still peers `mermaid 10 || 11`, so mermaid 12 is not installable) and `@xmldom/xmldom 0.9.12` (SRE 4.1.4 pins 0.9.10 exactly). `npm audit --audit-level=high` → 0.

## [1.0.0] - 2026-10-11

First stable release. 1.0.0 marks API stability for the deterministic core — SM-2 scheduling, the dependency graph, and the storage/atomic-write (OCC) layer — and ships the AI provider foundation. No breaking changes from 0.6.0: the AI additions are additive, and the 0.6.0 prerequisite-label migration below still applies to vaults built under 0.5.x. Higher-level AI features (Feynman testing, tutoring) ship in later releases.

### Added

- **Provider endpoint and credential configuration** ([#82](https://github.com/Kuldeep2822k/cli/issues/82)): `palee config` gains `set-base-url`, `set-api-key` and `unset-api-key` (with `baseUrl`/`apiKey` in `PaleeConfig`); the key is accepted only via `--from-env <VAR>`, a pipe or a prompt, masked by `config show`, and stored `0600` in a `0700` directory.
- **`palee config test-connection` and an OpenAI-compatible provider adapter** ([#24](https://github.com/Kuldeep2822k/cli/issues/24), on top of [#82](https://github.com/Kuldeep2822k/cli/issues/82)): the only network caller in `src/` (INV-29), with endpoint/credential hardening — redaction, loopback-only HTTP, reserved-address refusal, a 256 KiB response bound, request deadlines and strict one-retry JSON — covered by 48 tests.

### Security

- **`set-api-key` refuses an insecure config directory on Windows** ([#316](https://github.com/Kuldeep2822k/cli/issues/316)): where the `0600` mode is a no-op on NTFS, the key is written only when the config directory resolves under the user's profile roots (`%USERPROFILE%` / `%LOCALAPPDATA%`), else `PALEE_API_KEY` or `PALEE_ALLOW_INSECURE_CONFIG_DIR=1` is required.

### Fixed

- **`migrate --relabel-ties` now reports the candidates it declines** ([#237](https://github.com/Kuldeep2822k/cli/issues/237)) instead of exiting `0` in silence over a note it leaves gated; no label is written and no exit code moves.
- **Three identity comparisons now fold case *and* Unicode** ([#269](https://github.com/Kuldeep2822k/cli/issues/269)): `adopt --auto-chain`'s prerequisite index, the section-scan dedupe key and `matchesPattern`'s `excludeDirs` check all fold through `foldIdentity`, so a decomposed stored name matches a composed link on NTFS and ext4 too.
- **`roadmap --from` resolves cycles against what unreadable notes actually hold before writing** ([#267](https://github.com/Kuldeep2822k/cli/issues/267)), refusing a would-be-cyclic import (exit `3`, zero writes, INV-46) instead of leaving the vault in a cycle the validator rejects.
- **Links inside HTML comments and inline code spans no longer author chain edges** ([#284](https://github.com/Kuldeep2822k/cli/issues/284)): a single shared `stripUnfollowableMarkup`, used by both the TOC and `## Prerequisites` scanners, blanks them so a commented-out Contents entry stops gating.
- **The angle-bracket link-destination walk is now bounded** ([#287](https://github.com/Kuldeep2822k/cli/issues/287)) by two suffix tables built once per scan, so a README of stray `<` no longer stalls `adopt --auto-chain`; a 16-shape differential corpus pins the parse.
- **`atomicWrite` refuses a destination that resolves outside the vault** ([#264](https://github.com/Kuldeep2822k/cli/issues/264)) before taking the lock and again before each write, so a planted link cannot redirect a note out of the vault (exit `3`, zero writes); the lock tree and all write paths inherit the guard.
- **A hedged or negated `## Prerequisites` item no longer authors a gate** ([#261](https://github.com/Kuldeep2822k/cli/issues/261)): `does not require [[x]]`, `requires [[x]] or [[y]]` and `is a prerequisite for [[x]]` contribute nothing, while an unambiguous bullet still writes its `declared` edge.
- **`withWalkedCasing` folds both sides of its path comparison the same way** ([#269](https://github.com/Kuldeep2822k/cli/issues/269)), so an APFS-decomposed note name resolves to a real path instead of one no directory listing contains.
- **The README link scan is no longer quadratic on a stray `]` or unbalanced `(`** ([#263](https://github.com/Kuldeep2822k/cli/issues/263)): label and destination closure are answered from balance passes, and a TOC document over 512 KiB is declined as `oversized`.
- **Same-rank `assignment`/`quiz` and `README`/`SUMMARY` pairs are labelled advisory `tie`, not gating `numbered`** ([#255](https://github.com/Kuldeep2822k/cli/issues/255)), the warning counts them, and `migrate --relabel-ties` can retire the ones v0.6.0 wrote.
- **`palee migrate --relabel-ties` demotes only edges the chain could have written** ([#251](https://github.com/Kuldeep2822k/cli/issues/251)): a stored `numbered` edge that steps over a same-rank sibling still in the directory keeps gating, while the nearest *surviving* sibling still demotes — so deleting the middle note never strands the vault behind a false gate.
- **A TOC destination no longer resolves onto a note nobody named** ([#262](https://github.com/Kuldeep2822k/cli/issues/262)): the anchor is split before percent-decoding, an unescaped space is refused rather than truncated, and a backslash escapes exactly CommonMark's ASCII punctuation class (bare and `<angle>` forms alike).
- **`palee assess` names `--feynman` when a sub-threshold score supplied none** ([#260](https://github.com/Kuldeep2822k/cli/issues/260)): the other three pillars cap at `0.60`, so the hint names the double-weighted Feynman pillar instead of reading as "your score was too low".

## [0.6.0] - 2026-10-01

### Migration

0.6.0 changes which `depends_on` edges gate a note, and nothing rewrites an already-adopted note, so a vault built under 0.5.x needs one explicit step to feel the fix. `palee plan` names the victims under `Blocked by prerequisites`.

- **Notes that carry a label.** Run `palee migrate --relabel-ties --dry-run` to list every candidate, then `palee migrate --relabel-ties` to demote the stale `depends_on_source: numbered` ties to `tie`. Only the label is written.
- **Notes with no label, which is what the 0.5.x auto-chain wrote.** An absent `depends_on_source` means "the learner typed this list", so these keep gating and `--relabel-ties` alone neither touches nor mentions them ([#266](https://github.com/Kuldeep2822k/cli/issues/266)). Once you have confirmed the unlabeled notes are chained lessons rather than prerequisites you authored, run `palee migrate --relabel-ties --include-unlabeled-ties --dry-run`, read the whole list, then repeat without `--dry-run`. Notes that are not a single backward edge onto a same-rank sibling — a multi-entry list, an edge into another directory, an edge over a surviving sibling, a note also carrying the legacy `dependencies` key — are refused and stay gated.
- **Nothing else.** No upgrade path, no `palee migrate` run without flags, and no `--dry-run` writes anything; `palee_schema` stays at `1`.

### Added

- **`palee adopt --auto-chain`**: derives each note's `depends_on` from numbered directory/file prefixes, bridges modules and already-adopted notes, and validates the planned graph for cycles before any write (exit `3`, zero writes on failure); conflicts with `--depends-on` and single-file mode (exit `2`). ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- **`palee roadmap --auto-chain`**: chains roadmap topics by their `order` field; explicit non-empty `depends_on` always wins; an edge that would close a cycle against an authored dependency is skipped with a warning. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- **Wikilink roadmap format**: a Markdown roadmap that sets `palee_roadmap: true` in frontmatter chains headings + `[[links]]` per section; links resolve by exact path then unique basename, and ambiguous or unresolvable links fail closed (exit `3`, zero writes). ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- **Tier-0 hygiene filters** ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205)): before chaining, notes are classified `backbone`/`leaf`/`excluded` — repo-meta files, translation copies, templates, and phase-directory contents (`solution/`, `answers/`, …) never become prerequisites; the report prints backbone, leaf, and per-rule skip counts.
- **`--chain-tier <strict|toc|full>`** ([PAL-205-C](https://github.com/Kuldeep2822k/cli/issues/73)): `strict` (default) chains the numbered tree only; `toc`/`full` additionally chain the repo's `README`/`SUMMARY` enumeration in document order, fail-closed on unresolvable links; unknown tier values are a usage error (exit `2`).
- **A note's own prerequisites author its edges** ([PAL-205](https://github.com/Kuldeep2822k/cli/issues/205)): a `## Prerequisites` section's wikilinks and markdown links become `depends_on` with `depends_on_source: declared`, replacing the inferred edge — prose sentences are not parsed.
- **`palee assess <topic>`** ([#227](https://github.com/Kuldeep2822k/cli/issues/227)): records the four assessment pillars and recomputes `topic_mastery` with the existing weighting; scores outside `0–1` are rejected, not clamped.
- **`palee validate --fix` now repairs invalid SM-2 fields** ([#210](https://github.com/Kuldeep2822k/cli/pull/210)).
- **The auto-chain report counts the notes it leaves ungated** ([#205](https://github.com/Kuldeep2822k/cli/issues/205), [#245](https://github.com/Kuldeep2822k/cli/pull/245)): a plan that opens chains prints an `Unchained:` line so chain heads are visible instead of silent.

### Fixed

- `--include`/`--exclude`/`--tag` filters now apply before the already-adopted check, so an excluded note can no longer enter the chain. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- Fenced code blocks are stripped with a CommonMark-correct line-based parser, so examples can no longer rewrite a roadmap or mint a title. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- Resolved paths are re-spelled from the vault index, so a differently-cased wikilink can no longer overwrite an adopted note's `palee_id`. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- Escaped `\[[links]]` are treated as literal text, not links. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- The alphabetical-order warning now counts the notes it actually describes. ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205))
- The adopt summary reports the edges actually written per tier instead of claiming every note was chained by prefix order. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- `adopt --auto-chain <path>` works again: the tier moved to `--chain-tier` and the flag is a plain boolean. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- The TOC tier no longer misreports its own enumeration order as alphabetical. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- The vault root no longer trips the unnumbered-directory warning. ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205))
- Directory comparison only consults the level that decides the order. ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205))
- **`palee plan` names the notes it holds back** ([#219](https://github.com/Kuldeep2822k/cli/issues/219), [#220](https://github.com/Kuldeep2822k/cli/pull/220)): a new `Blocked by prerequisites` section (plus a `blocked` array in `--json`) distinguishes unmet prerequisites from ids missing from the vault, and `palee roadmap --from` reports edges to ids that were never written.
- **A valueless `--chain-tier` is a usage error, not the widest tier** ([#247](https://github.com/Kuldeep2822k/cli/pull/247)): it now returns `null`, which the CLI turns into a usage error instead of silently selecting `full`.
- **Draft recovery exits 2 when input runs out** ([#202](https://github.com/Kuldeep2822k/cli/pull/202)).
- **Commander usage errors follow the exit-code contract**: help, `--version`, and bare invocation exit 0; all other usage errors exit 2. ([#197](https://github.com/Kuldeep2822k/cli/pull/197))
- **Roadmap import no longer mints zero-valued pillar scores** ([#196](https://github.com/Kuldeep2822k/cli/pull/196)).
- **Hot-memory rebuild keeps sessions with unparseable timestamps** ([#211](https://github.com/Kuldeep2822k/cli/pull/211)).
- **Stale draft timestamps clamped to 24h** ([#208](https://github.com/Kuldeep2822k/cli/pull/208)).
- **Roadmap import no longer reads through a symlinked note path** ([#217](https://github.com/Kuldeep2822k/cli/issues/217), [#218](https://github.com/Kuldeep2822k/cli/pull/218)).

### Changed

- **Enumeration order no longer gates** ([#205](https://github.com/Kuldeep2822k/cli/issues/205)): `depends_on_source: toc` and `tie` edges are advisory — they rank and take part in cycle detection but never hide a note from the ready list.
- **`palee adopt --auto-chain` now defaults to `--chain-tier strict`**; chaining a `README`/`SUMMARY` enumeration requires `--chain-tier toc` or `--chain-tier full`.
- **A same-number tie is reported, labelled `tie`, and no longer gates**: the dry-run names the tied pair instead of ordering them by filename. ([#234](https://github.com/Kuldeep2822k/cli/pull/234))
- **Stored ties can be relabelled without touching the edges** ([#237](https://github.com/Kuldeep2822k/cli/issues/237), [#239](https://github.com/Kuldeep2822k/cli/pull/239)): `palee migrate --relabel-ties` rewrites stale `numbered` labels to `tie`, putting those notes back on the ready list. As shipped that reached only notes carrying the label, which is not every note it advertised — the 0.5.x auto-chain left its edges with no `depends_on_source` key at all, and those need the `--include-unlabeled-ties` opt-in ([#266](https://github.com/Kuldeep2822k/cli/issues/266)).
- **Homework no longer opens the next module**: cross-module bridges attach to the last non-homework backbone note, so a lesson is never gated behind another module's assignment.
- **An enumeration that chains nothing is a refusal, not a success**: a README with no chainable order prints `0 edges …` with a pointer (`palee roadmap` or `--chain-tier toc`) instead of a success line.
- **Wikilink roadmap detection requires `palee_roadmap: true`** ([#73](https://github.com/Kuldeep2822k/cli/issues/73)): `palee roadmap --from` rejects unmarked Markdown documents with exit 2 and zero writes.
- **Documentation refresh**: site refresh ([#189](https://github.com/Kuldeep2822k/cli/pull/189)); INV-46/47 restated with auto-chain docs aligned to shipped behavior ([PAL-205-D](https://github.com/Kuldeep2822k/cli/issues/205)).
- **Docs corrected to the shipped gating model**: `strict` default and four-value `depends_on_source` ([#238](https://github.com/Kuldeep2822k/cli/issues/238), [#246](https://github.com/Kuldeep2822k/cli/pull/246)); new `architecture/` views with stated drift ([#249](https://github.com/Kuldeep2822k/cli/pull/249)).
- **Dependency updates**: `duriantaco/skylos` 4.36.1 → 4.39.2, `yaml` 2.9.0 → 2.9.1. ([#203](https://github.com/Kuldeep2822k/cli/pull/203), [#174](https://github.com/Kuldeep2822k/cli/pull/174), [#229](https://github.com/Kuldeep2822k/cli/pull/229))



---

## [0.5.2] - 2026-09-19

### Fixed

- **Frontmatter parser robustness**: detects body text swallowed into frontmatter by unclosed fences; supports quoted keys with colons and unquoted keys with spaces, slashes, or non-ASCII characters; preserves `raw`/`body` for whitespace-only fenced blocks. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation rule runner is exception-safe**: rule crashes now surface as structured findings instead of exit-5 crashes. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation barrel export order aligned** with rule registration order. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **`valid-dependency-list` covers the legacy `dependencies` alias** with an advisory warning to migrate to `depends_on`. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#181](https://github.com/Kuldeep2822k/cli/issues/181), [#187](https://github.com/Kuldeep2822k/cli/pull/187))

### Changed

- **Documented the legacy `dependencies` alias advisory** in rule metadata, docs, and Mermaid diagrams. ([#187](https://github.com/Kuldeep2822k/cli/pull/187))

---

## [0.5.1] - 2026-09-18

### Fixed

- **`no-dependency-cycle` reports every cycle**, not just the first (bounded at 1000, with a truncation finding). ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#184](https://github.com/Kuldeep2822k/cli/pull/184))
- **Derived-view rebuilds never delete canonical sessions**; draft sessions are excluded from the hot-memory rebuild. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#185](https://github.com/Kuldeep2822k/cli/pull/185))
- **Numeric `assessed_at` values normalize to ISO 8601** through the adopt/loader round-trip. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#186](https://github.com/Kuldeep2822k/cli/pull/186))
- **Leading BOM stripped** so frontmatter parses for files saved by Windows editors. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#183](https://github.com/Kuldeep2822k/cli/pull/183))

### Changed

- **ADR-0008 review clarifications**; v0.5.0 entries moved out of `[Unreleased]`. ([#182](https://github.com/Kuldeep2822k/cli/pull/182))
- **Dependency updates**: `duriantaco/skylos` 4.35.0 → 4.36.1. ([#175](https://github.com/Kuldeep2822k/cli/pull/175))

---

## [0.5.0] - 2026-09-15

### Added

- **Validation rule framework**: single-read vault collector, deterministic runner, human/JSON formatters; duplicate-ID, missing-dependency, and cycle checks ported as pure rules. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#26](https://github.com/Kuldeep2822k/cli/issues/26), [#30](https://github.com/Kuldeep2822k/cli/issues/30), [#158](https://github.com/Kuldeep2822k/cli/pull/158))
- **Validation rules for schema, topic IDs, and status**: `palee_schema: 1` enforcement, `T-` kebab-case topic ID policy, four-state `status` validation; `adopt` generates compliant IDs. ([#28](https://github.com/Kuldeep2822k/cli/issues/28), [#29](https://github.com/Kuldeep2822k/cli/issues/29), [#31](https://github.com/Kuldeep2822k/cli/issues/31), [#159](https://github.com/Kuldeep2822k/cli/pull/159))
- **`validate --strict` warning escalation** and a `src/validation/` public barrel with census test. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#162](https://github.com/Kuldeep2822k/cli/pull/162))
- **Assessment and mastery validation rules** (`valid-assessment-fields`, `valid-topic-mastery`); #40 enforced as command-level regression tests. ([#36](https://github.com/Kuldeep2822k/cli/issues/36), [#37](https://github.com/Kuldeep2822k/cli/issues/37), [#40](https://github.com/Kuldeep2822k/cli/issues/40), [#163](https://github.com/Kuldeep2822k/cli/pull/163))
- **Review-state, review-dates, and dependency-list validation rules**; `no-missing-dependency` downgraded to warning per ADR-0008. ([#33](https://github.com/Kuldeep2822k/cli/issues/33), [#34](https://github.com/Kuldeep2822k/cli/issues/34), [#38](https://github.com/Kuldeep2822k/cli/issues/38), [#39](https://github.com/Kuldeep2822k/cli/issues/39), [#165](https://github.com/Kuldeep2822k/cli/pull/165))
- **Memory-subsystem validation rules** (`valid-managed-note-kind`, `valid-session-schema`, `no-session-unknown-topic`, `valid-session-index`). ([#27](https://github.com/Kuldeep2822k/cli/issues/27), [#41](https://github.com/Kuldeep2822k/cli/issues/41), [#42](https://github.com/Kuldeep2822k/cli/issues/42), [#44](https://github.com/Kuldeep2822k/cli/issues/44), [#168](https://github.com/Kuldeep2822k/cli/pull/168))
- **Hot-memory and safe-vault-paths validation rules**; shared `displayValue` helper fixes `NaN`/`Infinity` rendering in diagnostics. ([#43](https://github.com/Kuldeep2822k/cli/issues/43), [#45](https://github.com/Kuldeep2822k/cli/issues/45), [#166](https://github.com/Kuldeep2822k/cli/issues/166), [#169](https://github.com/Kuldeep2822k/cli/pull/169))
- **Multi-cycle enumeration and quarantine** in the dependency engine (bounded display with `truncated` flag). ([#79](https://github.com/Kuldeep2822k/cli/issues/79), [#157](https://github.com/Kuldeep2822k/cli/pull/157))

### Changed

- **Parallel test execution**: full suite ~112s → ~38s; added `test:unit`, `test:fast`, `test:e2e`, `test:fuzz` scripts. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Windows lock-directory stale recovery** with bounded 5-attempt backoff instead of exit-5 crashes. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Internal refactors**: single shared derivation for roadmap imports, centralized `hot.md` reads and exit-code mapping, injectable `loadTopics` cache. ([#139](https://github.com/Kuldeep2822k/cli/issues/139), [#130](https://github.com/Kuldeep2822k/cli/issues/130), [#129](https://github.com/Kuldeep2822k/cli/issues/129), [#128](https://github.com/Kuldeep2822k/cli/issues/128), [#154](https://github.com/Kuldeep2822k/cli/pull/154), [#145](https://github.com/Kuldeep2822k/cli/pull/145), [#151](https://github.com/Kuldeep2822k/cli/pull/151), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **ADR-0008: validation-framework decisions** recorded; dangling planning-doc references fixed. ([#170](https://github.com/Kuldeep2822k/cli/issues/170), [#172](https://github.com/Kuldeep2822k/cli/pull/172))
- **Dependency and workflow updates**: workflow security hardening, GitHub Actions bumps, dead-code detection via Skylos. ([#143](https://github.com/Kuldeep2822k/cli/pull/143), [#148](https://github.com/Kuldeep2822k/cli/pull/148), [#141](https://github.com/Kuldeep2822k/cli/pull/141))

### Fixed

- **Vault-relative paths through symlinked roots** via `realpathSync`. ([#160](https://github.com/Kuldeep2822k/cli/issues/160), [#161](https://github.com/Kuldeep2822k/cli/pull/161))
- **Exit code 4 on OCC conflict** in `palee migrate --fix`. ([#128](https://github.com/Kuldeep2822k/cli/issues/128), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **Explicit `0` preserved in SM-2 fields** (`ease_factor`, `interval_days`, `repetition`, `lapses`). ([#127](https://github.com/Kuldeep2822k/cli/issues/127))
- **`depends_on`/`dependencies` aliases normalized consistently** across loader, validator, and roadmap. ([#126](https://github.com/Kuldeep2822k/cli/issues/126))
- **Unsupported `palee_schema` in hot.md triggers rebuild** (ADR-0007). ([#130](https://github.com/Kuldeep2822k/cli/issues/130))
- **npm audit fixes applied**; published package files optimized via `.npmignore`. ([#156](https://github.com/Kuldeep2822k/cli/pull/156), [#173](https://github.com/Kuldeep2822k/cli/pull/173))

### Removed

- **Lock internals pruned from the storage barrel** (`HEARTBEAT_INTERVAL`, `STALE_TIMEOUT`; still in `src/storage/lock.ts`). ([#131](https://github.com/Kuldeep2822k/cli/issues/131))

---

## [0.4.0] - 2026-08-31

### Added

- **Storage layer isolation**: all vault filesystem mutations behind the `src/storage/index.ts` facade. ([#86](https://github.com/Kuldeep2822k/cli/issues/86), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **True session durations** persisted to `.palee/hot.md` and draft checkpoints. ([#88](https://github.com/Kuldeep2822k/cli/issues/88), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Resilient roadmap batch ingestion**: per-topic failures no longer block remaining imports. ([#89](https://github.com/Kuldeep2822k/cli/issues/89), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Interactive Mermaid pan-zoom controls** in the docs site. ([#115](https://github.com/Kuldeep2822k/cli/pull/115), [#116](https://github.com/Kuldeep2822k/cli/pull/116))
- **`palee migrate --fix`**: atomically upgrades schema-less notes to `palee_schema: 1`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Custom vault traversal exclusions** (`excludeDirs`). ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Session draft checkpoint invariants**: exit code 2 and `drafts_pending` JSON when drafts block `session start`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Flexible dependency aliases**: `dependencies` supported alongside `depends_on`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Fixed

- **Review OCC race eliminated**: target note re-read before atomic write; exit 4 on concurrent modification. ([#87](https://github.com/Kuldeep2822k/cli/issues/87), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Mastery output and dashboard alignment** standardized. ([#91](https://github.com/Kuldeep2822k/cli/issues/91), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Deterministic file-cache operation** (2,000 ms unsettled horizon). ([#90](https://github.com/Kuldeep2822k/cli/issues/90), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **macOS canonical path resolution** for symlinked `/var/folders` paths. ([#122](https://github.com/Kuldeep2822k/cli/pull/122))
- **Config resilience**: `SyntaxError` recovery in `loadConfig()` with atomic saves. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Timezone-safe due-date computation** with 2-digit year guard. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Atomic write concurrency** via cryptographic entropy in temp filenames. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Duplicate topic IDs**: dependencies merged for complete graph connectivity. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Structured JSON errors** on unhandled rejections with `--json`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **CST frontmatter formatting**: unified `Document` serialization for clean YAML block lists. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Changed

- **npm OIDC trusted publishing** with build provenance attestations. ([#124](https://github.com/Kuldeep2822k/cli/pull/124))

---

## [0.3.1] - 2026-08-23

### Fixed

- **README logo URL** fixed for npm registry rendering.

### Changed

- **GitHub Actions dependencies bumped**. ([#99](https://github.com/Kuldeep2822k/cli/pull/99), [#100](https://github.com/Kuldeep2822k/cli/pull/100), [#101](https://github.com/Kuldeep2822k/cli/pull/101), [#102](https://github.com/Kuldeep2822k/cli/pull/102))

---

## [0.3.0] - 2026-08-20

### Added

- **Batch note adoption (`palee adopt`)** with `--dry-run`, `--yes`, `--tag`, `--include`, `--exclude` filters. ([#50](https://github.com/Kuldeep2822k/cli/pull/50), [#74](https://github.com/Kuldeep2822k/cli/pull/74))
- **Multi-format roadmap parser** (pure YAML, frontmatter YAML, embedded code-fence YAML). ([#112](https://github.com/Kuldeep2822k/cli/pull/112))
- **Technical documentation suite**: 35-chapter VitePress docs with interactive architecture diagrams. ([#108](https://github.com/Kuldeep2822k/cli/pull/108), [#112](https://github.com/Kuldeep2822k/cli/pull/112), [#114](https://github.com/Kuldeep2822k/cli/pull/114))
- **Distinct exit code 4** on OCC and file-lock conflicts. ([#76](https://github.com/Kuldeep2822k/cli/pull/76), [#107](https://github.com/Kuldeep2822k/cli/pull/107))

### Changed

- **Exit-code standardization**: `process.exitCode` replaces `process.exit()` for clean stream flushing. ([#77](https://github.com/Kuldeep2822k/cli/issues/77), [#110](https://github.com/Kuldeep2822k/cli/pull/110))
- **Centralized vault validation** through `validateVaultPath`. ([#78](https://github.com/Kuldeep2822k/cli/issues/78), [#111](https://github.com/Kuldeep2822k/cli/pull/111))
- **Unified storage layer boundary** with in-memory caching and single-pass discovery. ([#98](https://github.com/Kuldeep2822k/cli/pull/98))
- **Shared mastery engine** with extracted `MASTERY_THRESHOLD`. ([#85](https://github.com/Kuldeep2822k/cli/issues/85), [#94](https://github.com/Kuldeep2822k/cli/pull/94), [#95](https://github.com/Kuldeep2822k/cli/pull/95), [#106](https://github.com/Kuldeep2822k/cli/pull/106))

### Fixed

- **Archived topics excluded** from global mastery calculation. ([#97](https://github.com/Kuldeep2822k/cli/pull/97))
- **Invalid-date guard** in progress date parsing. ([#96](https://github.com/Kuldeep2822k/cli/pull/96))

---

## [0.2.0] - 2026-08-14

### Added

- **Machine-readable `--json` output** across reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, `session list`); non-TTY output defaults to JSON.
- **Structured JSON setup errors** with exit code 2 in JSON/non-TTY mode.
- **Standardized `Difficulty` enum** (`beginner` | `intermediate` | `advanced`) with `normalizeDifficulty()` runtime helper.
- **Empty-vault onboarding guidance** pointing at `palee adopt` and `palee roadmap --from`.
- **`--topic <id>` option** for `palee session` with active-topic fallback.

### Fixed

- **Dashboard division-by-zero guard** against `NaN%` on empty vaults.
- **Vault validation and permissions**: clean returns on empty states plus directory/read-permission checks at the vault root.
- **Phantom topic elimination**: no more default `T-general` topic notes during session operations.

---

## [0.1.0] - 2026-08-12

### Added

- Project setup with `commander`, `yaml`, and Node.js testing.
- Conflict-aware atomic storage layer with file fingerprinting, OCC, and robust file locking.
- Deterministic engine core (SM-2, mastery calculation, dependency graph resolution, cycle detection).
- CLI layer with deterministic commands (`plan`, `next`, `progress`, `review`, `validate`, `roadmap --from`, `adopt`).
- Phase 1 session memory system (`hot.md`, `index.md`, durable session logs, draft recovery).
- Full Windows path and lock-recovery support.
- Interactive draft checkpoint recovery.

### Fixed

- Strict TypeScript enforcement with dead code removed.
- Narrative comments purged to conform to strict code standards.
