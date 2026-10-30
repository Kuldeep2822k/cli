---
description: "A 15-slice audit of every command invocation in the repository (#451) found documentation drift in four classes: numbers, command surfaces, planning docs, and architecture evidence."
---


# ADR-0031: Documentation Truth — Current-State Docs, Labeled History

## Status

Accepted

Applied in Phase 3 of #451.

## Context

A 15-slice audit of every command invocation in the repository (#451) found documentation drift in four classes:

1. **Numbers contradicting the configuration.** `agent.md` and `docs/07-1` stated c8 thresholds of 60/75/65 against a real 96/96/93/88; `docs/06-2` carried per-suite test counts and the claim that the CLI has 11 commands (the dispatcher registers 12); the README install block named no Node version while `engines` requires `>=22.12.0`.
2. **A command and option surface that had outgrown the README.** `palee assess`, `session draft`/`list` and shipped options (`adopt --undo`, `adopt --auto-chain`, `validate --fix`, `migrate --fix`, `migrate --relabel-ties`, `roadmap --auto-chain`, plus the verified extras) appeared nowhere the learner reads; `review` was shown with a `--quality` flag that does not exist.
3. **Planning documents reading as current usage.** `planning/example_workflows.md` demonstrated `palee test`, `palee tutor` and a guided `palee roadmap` interview with full transcripts, none of which are registered commands. `planning/PHASE_2_GAPS.md` still described `--from` as YAML-only, quoted an error text that no longer prints, proposed `adopt --dir` (never shipped), and claimed `computeTopicMastery()` did not exist.
4. **Architecture evidence that could not be reproduced.** Thirteen architecture files instructed `node scripts/arch-*.cjs`; none of those generator scripts — nor the session Mermaid lint — is in the repository.

Exploration also disproved several suspected drifts, which changed what was *not* edited (see **Recorded disproofs**).

## Decision

1. **User-facing documents state only current, shipped behavior.** Where a number has a source of truth in configuration (`.c8rc.json`), the prose quotes it exactly. Where a count has no source of truth but the dispatcher does (per-suite test counts, "all 11 commands"), the count is removed or replaced by the source: the CLI registers the commands; only the subset carrying `--json` streams machine-readable output.
2. **Planning documents are design history and are labeled as such at the point of use.** Examples of unshipped commands get an explicit "Phase 2 — not implemented" caveat in the example itself; shipped outcomes replace stale present-tense limitations (`--from` formats, the current error text, where the mastery formula lives). The proposals themselves are kept — they are the design record.
3. **Architecture evidence is a dated historical snapshot, and the docs say so.** The import graph and DOT views are labeled as a 2026-09-22 snapshot (60 modules, 216 edges) produced by scripts that are not in the repository. The snapshot is neither regenerated nor deleted, and nothing pretends the scripts exist.
4. **Drift claims that exploration disproved are recorded, not "fixed."** Where the behavior was already correct but the documentation was ambiguous, the remedy is a one-line clarification (both `adopt --auto-chain` orders are valid; topic queries resolve ids, id/title substrings, and vault paths), not a correction.

### Recorded disproofs

The audit considered and disproved these suspected problems; the next audit should not re-litigate them:

- **YAML-only roadmap input** — `--from` already accepts `.yaml`, Markdown frontmatter, fenced YAML blocks, and `[[wikilink]]` lists. The stale *statement* (in `PHASE_2_GAPS.md`) was removed; the `.md` examples everywhere else were already true.
- **Invalid adopt argument order** — the adoption path may precede or follow `--auto-chain`; both forms are the same run.
- **Conflicting `-i` / `--interactive` spellings** — they are aliases, and `docs/02-4` already documents them as such; no edit needed.
- **Timestamp-only accepted IDs** — slug IDs (`T-docker-volumes`) and legacy timestamp IDs both resolve; only the *generated* form is the timestamp shape.
- **README advertising unimplemented commands** — `palee test`, `palee tutor` and the roadmap interview were already labeled as not implemented before this pass.

## Consequences

### Positive

- The README option surface is complete for `adopt`, `validate`, `migrate` and `roadmap`, so the next audit starts from a baseline instead of a gap list.
- Every number that remains in the touched prose now has a source of truth (`.c8rc.json`, `package.json` `engines`, the dispatcher). Numbers without one were removed rather than updated.
- The planning and architecture documents keep their value — proposal rationale and a dated evidence snapshot — without instructing readers to run commands that do not exist.

### Negative / Tradeoffs

- **Prose is still unguarded.** The existing guard tests (`docs-command-matrix`, `ci-workflow-matrix`, `package-publish-guard`) pin contracts parsed from `bin/palee.ts` and the workflows, not README prose. This pass will re-drift; the guards define the floor, not the ceiling.
- **The inline caveats are maintenance debt.** When `palee test`, `palee tutor` or the interview ship, their "Phase 2 — not implemented" labels must be removed in the same PR that registers them.
- **Removed counts lose survey information on purpose.** "How big is each suite" is no longer statically readable; the suites' own output is the source.

## Alternatives Considered

1. **Regenerate the architecture evidence in place.**
   - *Why Rejected*: the generator scripts are not in the repository and were never committed; committing one-off session scripts just to make two snapshot artifacts reproducible would add unmaintained code with no runtime role.
2. **Date-stamp every section instead of fixing claims.**
   - *Why Rejected*: a date does not make a present-tense false statement true; readers act on the claim, not the timestamp.
3. **Delete the planning documents once their proposals ship.**
   - *Why Rejected*: they are the design rationale the implementation issues cite; removing them breaks the chain from proposal to PR.
4. **Update the hard-coded per-suite counts instead of removing them.**
   - *Why Rejected*: they were already wrong at audit time with no source of truth to derive them from; a number nobody can check is a future lie.
5. **Silently correct the disproved drift claims too.**
   - *Why Rejected*: rewriting correct behavior confuses future audits about what was actually wrong; recording the disproofs is cheaper and safer.
