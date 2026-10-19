# ADR-0029: Test-Time CLI Launch Policy

## Status

Accepted — amended in part by [ADR-0032](./0032-direct-spawn-bounding.md), which corrects the scope of the "every spawn is bounded" claim below. Every other decision in this record stands.

## Context

Every `execSync`- and `spawnSync`-launched CLI child in the suite goes through one pair of exports in `test/palee-cli.ts` — `PALEE_ARGV` for spawn-style launches, `PALEE_CMD` for shell-string launches. The #451 audit of test-time command invocation found the policy around them had gone soft in five places:

1. The dist/tsx switch existed only to keep `src/**` coverage attribution, and nothing recorded why or what the alternative measured.
2. `test:coverage` nested the whole run — the `pretest` build included — inside a c8-wrapped `npm test`, so c8 instrumented a build that contributes no `src/**` coverage.
3. No spawn had a timeout: a CLI child that never finished blocked its test worker for the life of the job.
4. `PALEE_CMD` resolved `node` through PATH even though `PALEE_ARGV` spawns pinned `process.execPath` — two launches could exercise two different runtimes, and on the machine where the audit ran the execPath contains a space (`C:\Program Files\nodejs\node.exe`).
5. Two `cli-*` file comments still described the dist entry as unconditional, and a third in `cli-program-name.test.ts` described a launch shape the policy had already moved past.

The one thing the switch buys is per-spawn cost: a tsx child re-pays an esbuild transform the dist entry has pre-compiled. ADR-0025 records the test suite's ~561 ms cold spawn figure, which #404 later cut to ~224 ms by other means — so the ticket asked: can the dist entry serve under coverage too, and retire the switch?

## Decision

### Coverage children keep launching the tsx sources — the dist trial was measured and rejected

Running every child from the prebuilt `dist/bin/palee.js` under coverage was trialed first, exactly as the ticket proposed: `tsconfig.json` gained `"sourceMap": true`, `.c8rc.json` gained `"exclude-after-remap": true` (so c8's `exclude`/`include` filters apply to the remapped `src/**` paths, not the compiled `dist/**` ones), and `PALEE_ARGV` dropped the switch.

The trial failed the parity gate, and the failure is structural rather than a configuration gap. Under coverage, parent and children contribute coverage for the same source file through **different compilers**: the parent runner is tsx (esbuild — its helper functions `__export`, `__copyProps`, `__toCommonJS` sit at line 1), while a dist child is tsc output, which compiles each `export *` re-export into a `get` accessor function attributed to the re-export's own source line. When c8 merges the two v8-istanbul lineages for one file, the function maps do not union: the merged report keeps one side's function map and the other side's hits are dropped.

The measured evidence (full suite, this 16-worker Windows machine, 2026-10-16; duration is the runner's test phase):

| Report | Stmts | Branch | Funcs | Lines | Test phase |
| --- | --- | --- | --- | --- | --- |
| Baseline (tsx children, uncapped pool) | 96.66 | 89.19 | **94.35** | 96.66 | 156 s |
| Trial (dist children, pool capped at 4) | 96.77 | 92.73 | **87.07** | 96.77 | 106 s |
| Shipped (tsx children, pool capped at 4) | 96.61 | 89.14 | 94.26 | 96.61 | 229 s |

Under the trial, statements, branches and lines held or improved — the loss is entirely in function attribution, six points below the 93% floor. The clearest single case is `src/validation/index.ts`: the merged report kept the tsc side (24 uncovered `get` accessors) and dropped the parent's covered entries (`collectVault`, `formatHuman`, `runRules`, …), so a file whose functions all run read as 4.16% covered. A focused run that loaded the barrel through the parent only — where no dist child touched it — kept the esbuild map instead, confirming the collision rather than a general remap failure.

The shipped configuration clears every threshold with margin, and its small deltas against the baseline (−0.05 pp statements/lines/branches, −0.09 pp functions) sit entirely in the storage-concurrency files whose retry and heartbeat branches depend on worker interleaving (`atomic-write.ts`, `lock.ts`, `cache.ts`); the `src/cli/**` surface is bit-identical across all three runs.

Lowering a threshold, or accepting the drop as noise, would legalize losing coverage numbers whenever two transform lineages meet in one report — precisely the failure mode a coverage gate exists to surface. So the switch stays, now with its reason recorded and the trial's numbers as evidence.

### Normal-run children keep launching the prebuilt dist entry

`npm test`, `test:e2e` and the other non-coverage scripts still spawn `dist/bin/palee.js`. The build is guaranteed by the pretest hooks (`pretest`, `pretest:coverage`, `pretest:e2e`, `pretest:fast`, `pretest:fuzz`), so a normal run exercises the artifact that ships.

### Launches through the helpers are bounded, and a timeout names the command

`runPalee` passes a `timeout` to `spawnSync` — 120 s by default, overridable per call. On expiry it throws an error naming the command, the budget, and the captured stdout/stderr, instead of leaving the worker to hang until the CI job's own cutoff. `runPaleeInteractive` accepts the same per-call `{ cwd, env, timeout }` options `runPalee` does (60 s default), with the same env layering: `process.env` → isolated `PALEE_CONFIG_DIR`/`NODE_ENV` → caller overrides. `test/e2e/timeout-bound.test.ts` pins both branches: a 1 ms budget turns a real invocation into the named timeout error, and the default budget leaves a fast invocation alone.

**Scope.** This bounds launches *through the helpers*. Suites that build their own `spawnSync(process.execPath, [...PALEE_ARGV, …], opts)` calls honour the `PALEE_ARGV`/`PALEE_CMD` centralisation above but sit outside this paragraph: #456 gave the direct path no budget, and 24 of the 25 files containing a real direct call had no per-spawn timeout when this record was accepted. #496 migrated 3 of them to the same 120 s (`CLI_SPAWN_TIMEOUT_MS`) and added `test/cli-spawn-timeouts.test.ts`, which fails on any new unbounded direct spawn and holds the remaining 21 files in a shrinking `PARTIALLY_BOUNDED` allow-list. The heading this section originally carried — "Every spawn is bounded" — stated an aspiration as a shipped property; [ADR-0032](./0032-direct-spawn-bounding.md) records why it was wrong, what #460 said about it, and which check now pins it.

### `PALEE_CMD` pins `process.execPath`, quoted

Shell launches now use the same runtime as spawn launches — `"${process.execPath}"` — instead of PATH-resolved `node`, quoted because the path can contain spaces. This closes a real divergence class: a shell launch could otherwise resolve a different Node than the child spawns beside it in the same test file.

### `test:coverage` builds outside the umbrella and bounds its pool

The script is now `pretest:coverage` (the build) plus a c8 invocation that wraps the Node test runner directly — no nested `npm test` — with `--test-concurrency=4`. The build no longer runs inside c8's instrumented tree, and the worker pool is bounded instead of defaulting to every core, which keeps the memory headroom c8 needs while it merges ~600 child coverage files.

### Comments and guards describe the policy, not one path

The two `cli-*` doc comments that described `node dist/bin/palee.js` as unconditional now name `PALEE_CMD` and both of its paths. The `cli-program-name.test.ts` adaptive copy logic (reuse the entry's loader flags; keep the `.ts` extension when the entry is TypeScript) stays — it is the guard for the coverage path, and it is why that file catches a bare-`node`-on-TypeScript copy error instead of dying by it.

## Consequences

### Positive

- A hung CLI child launched through the helpers can no longer consume a test worker silently; its failure names the command and shows how far it got. Direct spawns were not covered when this was written — see the Scope note above and ADR-0032.
- Shell and spawn launches agree on the runtime being tested.
- The coverage run no longer instruments its own build, and its concurrency is a bounded, documented constant.
- The dist-under-coverage question is settled with measurements, so it is not re-proposed as an obvious simplification.
- The comments that drifted are corrected, including the two the audit flagged.

### Negative / Tradeoffs

- **Coverage runs still pay the per-spawn tsx cold start.** That cost is now deliberate and recorded rather than latent — the switch is what keeps the two coverage lineages identical. If the cost becomes dominant, the honest fix is one transform lineage for the whole report, not a partial switch (see alternatives).
- **`--test-concurrency=4` costs wall time on many-core machines.** The pool bound trades it for a bounded peak fan-out: on this 16-worker machine the capped run needed 229 s where the uncapped baseline needed 156 s. CI runners expose roughly 4-way parallelism, so the bound is near-free there; it exists for 16-core dev machines, where the default pool fans out sixteen tsx children at a time, each an esbuild transform. The same three-way measurement prices the rejected dist path: with the cap held constant, cheaper children finished the phase in 106 s — the ~123 s difference is what the per-spawn tsx cold start costs the suite (ADR-0025 records ~224 ms per cold spawn).
- **No source maps are emitted** for the normal build (`sourceMap` was added for the trial and removed with it). Nothing in the shipped package changes; a future re-trial needs both `sourceMap` and `exclude-after-remap` together, which this ADR records.

## Alternatives Considered

1. **Run coverage children from the compiled dist entry.** (The trial above.)
   - *Why Rejected*: the measured function-coverage collapse (94.35% → 87.07%, threshold 93%) caused by merging esbuild and tsc function maps for the same source file. Statements, branches and lines hid the problem; only the function gate caught it.
2. **Build a second, esbuild-compiled copy of the CLI for coverage children so both sides share tsx's transformer.**
   - *Why Rejected*: coverage children would stop exercising the shipped tsc artifact — the one thing the dist launch path is for — in exchange for map alignment that esbuild's bundling options do not guarantee anyway (tsx transforms per-file; a bundle emits different helper placement). It adds a test-only build pipeline to maintain.
3. **Move the whole report to one transform: compile the tests too and run everything from built output.**
   - *Why Rejected*: disproportionate to a per-spawn cost. Unit tests import `src/**` directly by design, and building tests would change the dev loop, the watched-glob scripts, and what coverage measures. Recorded here as the honest fix if spawn cost ever dominates the suite.
4. **Keep spawns unbounded; rely on the CI job's own timeout.**
   - *Why Rejected*: a hung child blocks its worker for the entire job, the failure never names the command, and the captured output that makes a hang diagnosable is discarded. The 1 ms-budget guard costs milliseconds.
5. **Raise or waive the functions threshold for the trial.**
   - *Why Rejected*: the drop was attribution loss, not untested code — the function bodies kept running. Relaxing the gate would mask the next lineage-merge regression instead of surfacing it.
