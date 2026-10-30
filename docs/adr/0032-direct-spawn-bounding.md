---
description: "ADR-0029's universal \"every spawn is bounded\" claim was false: 24 of 25 direct-spawn test files carried no timeout at that commit."
---


# ADR-0032: Direct Spawn Bounding — What ADR-0029 Claimed, and the Check That Pins It

## Status

Accepted

Amends ADR-0029 in part (the section "Every spawn is bounded, and a timeout names the command"). ADR-0029's other decisions stand unchanged. Supersedes the "by design" line in #460.

## Context

ADR-0029 was accepted in `0204f39` (#456), whose title is *"test: bound CLI spawns"*. One of its section headings asserts:

> ### Every spawn is bounded, and a timeout names the command

The paragraph under it delivers something narrower: `runPalee` passes a `timeout` to `spawnSync`, and `runPaleeInteractive` accepts the same options. Both are helper functions. The heading is a universal claim about spawns; the body establishes a property of the helpers. Nothing bridges them, and the universal was false the moment it was written.

Sampling three direct-spawn files at `0204f39` — `test/cli-vault-echo.test.ts`, `test/cli-commands.test.ts`, `test/cli-roadmap-dry-run.test.ts` — gives one spawn site and **zero** `timeout` lines in each. #456 bounded the helper path and nothing else: its three `cli-*` edits reworded comments and a launch shape, and those files also show zero `timeout` lines at that commit (`cli-adopt-autochain` 1 call / 0, `cli-program-name` 2 / 0, `cli-roadmap-wikilink` 1 / 0). Counted with the guard's own definition — a `spawnSync(` written in a comment is not a call — **25** files contained a real direct call at that commit and **24** of them carried no bound at all. The single exception was `test/e2e/test-env.ts`, which is where #456 put the `runPalee`/`runPaleeInteractive` timeouts. (#496's survey reports the same 24.)

It is worth being precise about which ADR-0029 claim survived and which did not, because they are easy to conflate:

- **True in substance, and still true:** every `execSync`- and `spawnSync`-launched CLI child goes through one pair of exports in `test/palee-cli.ts` — `PALEE_ARGV` for spawn-style launches, `PALEE_CMD` for shell-string launches. `test/cli-vault-echo.test.ts:40` is the proof case: it does not call `runPalee`, and it still spawns `[...PALEE_ARGV, ...args]`. It is not literally universal — of the 30 direct call sites under `test/`, 28 reference the pair — but the two exceptions are not launches the premise was ever about: `test/cli-config-provider-credentials.test.ts:392` runs a Windows 8.3-path probe that starts no CLI, and `test/cli-program-name.test.ts:66` spawns a deliberately *copied* entry, which is the thing that test exists to exercise and which ADR-0029's own final section records.
- **False:** that centralisation implies a bound. Centralised *command material* is not a centralised *launch policy*. A file can honour the first and ignore the second completely, which is exactly what 24 files did.

The repo then produced two records that disagree with the ADR and with each other:

- #460, still open, records under *"Test-suite observations (recorded, not scheduled)"*: *"The 26 suites that call `spawnSync`/`execSync`/`spawn` directly keep no per-spawn timeout **by design** — the ticket scoped the timeout to `runPalee`, which #456 added."*
- ADR-0029's own Alternatives §4 rejects keeping spawns unbounded: *"Keep spawns unbounded; rely on the CI job's own timeout — Why Rejected: a hung child blocks its worker for the entire job, the failure never names the command…"*

So one document calls the unbounded set **by design**, another calls it **rejected**, and the heading calls it **finished**. No check adjudicated, because none existed: with no guard, "every spawn is bounded" was a claim that could not fail.

This is the failure mode ADR-0031 anticipated when it closed its own consequences with *"Prose is still unguarded… the guards define the floor, not the ceiling."* The cost of an unguarded claim is not abstract: an unbounded synchronous child blocks its worker with no diagnostic, and during #496 that produced a ~20 minute stall in `test/cli-config-provider-credentials.test.ts` which was initially misdiagnosed as a defect in the diff under review.

## Decision

1. **ADR-0029's heading is corrected to the scope its body actually establishes.** It now reads *"Launches through the helpers are bounded, and a timeout names the command"*, with the direct-spawn situation and this ADR named in the same section. The premise about `PALEE_ARGV`/`PALEE_CMD` centralisation is untouched — it is true.

2. **The bounding claim gets an executable source of truth.** `test/cli-spawn-timeouts.test.ts` (#496) scans every `.ts` under `test/` for direct `execSync`/`spawnSync`/`execFileSync` calls and requires each call's own options to carry an **active, positive, top-level** `timeout`. Two assertions: any file outside `PARTIALLY_BOUNDED` with an unbounded call fails, and any listed file that has become fully bounded but stays listed fails. The list can therefore only shrink.

3. **"By design" is withdrawn for this class.** #460's observation line is superseded. The remaining unbounded sites are tracked debt with a ratchet, not sanctioned behaviour, and a new unbounded direct spawn is now a red test rather than a permitted drift.

4. **What the guard pins is stated at its real scope: no new unbounded direct spawn, not every spawn bounded.** 21 of the 25 files with a real direct call still hold unbounded sites — one bounded by #456 (the helper), three migrated by #496, 21 to go. #460's figure is also imprecise: it says "the 26 suites", but one of those files only mentions `spawnSync` in a comment, so the real count is 25. Migration is one line per call site; the guard schedules nothing by itself.

5. **Its blind spots are recorded rather than glossed.** It is a line-window heuristic, not an argument parser: a window ends at the call's own closing line, the next call, or 12 lines. `{ timeout }` shorthand, an identifier value and a `120_000` separator all count as bounding, because no static answer exists for spread and non-literal options and guessing would flag bounded code. An options object assembled elsewhere is invisible to it and is reported as debt — fail-closed. Values are honoured only at the options argument's own depth, and comment text and quoted spans are excluded, because Node ignores `timeout: 0` and ignores a nested `timeout` entirely: measured on a live child, `{nested:{timeout:1}}` let it run to completion (3059 ms, `status 0`) where `{timeout:1}` killed it at 9 ms with `ETIMEDOUT`.

6. **A repeat of this class is refused by policy.** Any future document making a universal claim of the "every X is bounded/enforced/validated" form names the check that pins it, or is written in the scoped form the check actually supports. Per ADR-0031, where prose and an executable check disagree, the check is right and the prose is stale.

## Consequences

### Positive

- A claim that could not fail can now fail, on every CI leg, on all three platforms.
- The ADR / #460 contradiction is resolved in one direction instead of left as two records readers must reconcile: unbounded direct spawns are debt.
- The next hung child names the command and its budget instead of presenting as an unexplained stall, which is how the ~20 minute incident was misread.
- The correction is cheap and bounded: one heading, one paragraph, one new record. Nothing in the shipped package changes.

### Negative / Tradeoffs

- **The guard is 56 lines of scanner (119 with its docstrings) inside a test file, and every defect it found was latent.** Four review rounds produced no real offender in the tree — old and new predicates report 21 unbounded with no per-file shift. The scanner is insurance against a future shape, priced at roughly a hundred times the code it checks. Recorded here so the next reader does not mistake it for a bug fix.
- **A false positive in this guard is worse than a false negative, and that asymmetry shaped the design.** A wrongly-flagged file must join `PARTIALLY_BOUNDED`, and removing it later re-fails the stale-entry assertion — the file is locked into the debt list. This is why non-static forms are accepted as bounded rather than guessed at, and why the depth walk starts at the call rather than at column 0.
- **The 21 files stay unbounded until someone migrates them.** The ratchet stops growth; it does not pay down the balance, and nothing escalates it.
- **ADR-0029 is now a partial record.** A reader of ADR-0029 alone gets a corrected heading but must follow the pointer to learn why the universal was wrong and what pins it now. Amending in place was preferred to replacement; the pointer is the cost.

## Alternatives Considered

1. **Leave ADR-0029's heading alone and add this ADR beside it.**
   - *Why Rejected*: it leaves a present-tense false universal in the accepted record, which is precisely what ADR-0031 rule 1 forbids ("user-facing documents state only current, shipped behavior"). ADR-0031 already rejected the softer version of this — date-stamping a section instead of fixing the claim — on the grounds that "a date does not make a present-tense false statement true; readers act on the claim".
2. **Supersede ADR-0029 entirely.**
   - *Why Rejected*: its substantive decisions all stand — `tsx` children under coverage with the measured 94.35% → 87.07% function-coverage evidence, `PALEE_CMD` pinning the quoted `process.execPath`, the build outside c8's umbrella, `--test-concurrency=4`, and the helper timeouts. Only the scope of one claim was wrong. Replacing the record would orphan that evidence from the decision it prices.
3. **Bound all 25 direct-spawn files in one pass and skip the guard.**
   - *Why Rejected*: it fixes today and re-opens tomorrow — nothing would stop the next direct spawn from landing unbounded, which is how the gap reached 24 files under a heading that said it was closed. The guard is the part that persists; migration is the part that can be one line at a time.
4. **Keep #460's "by design" as the operative record and let the ADR stand.**
   - *Why Rejected*: it contradicts ADR-0029's own Alternatives §4, and a design ruling that makes future unbounded spawns un-refusable is worse than tracked debt with a ratchet.
5. **Rewrite the guard as an options-argument parser, as review suggested.**
   - *Why Rejected*: spread options (`{ ...opts }`) and non-literal options objects have no static answer, so a parser trades this false negative for false positives — and a false positive here is permanent (see Tradeoffs). Depth tracking, key-position checks and quoted-span blanking close the reported class without that machinery. Verified: previous and final predicates agree on every file in `test/`.
