# Product Validation Loop

This document keeps product feedback alongside PALEE's engineering checks without
adding telemetry or collecting vault contents. It implements the lightweight loop
tracked by #68.

## Purpose and boundaries

The loop answers whether a person can get from a fresh installation to a useful
study workflow. It complements, rather than replaces, unit tests, invariants, and
CI.

- Run the protocol manually against a vault the participant is allowed to use.
- Use a copy or a dedicated test branch of a vault when adoption or a session will
  write files.
- Record commands, outcomes, counts, and friction descriptions; do not commit note
  bodies, personal paths, credentials, or analytics data.
- Do not add telemetry, tracking pixels, or new PALEE runtime network calls as part
  of this loop.

## When to run it

Run a first-run validation before prioritizing a major Phase 2 expansion and after a
change that materially affects installation, configuration, adoption, recommendations,
or session flow. Review the accumulated findings before selecting the next Phase 2
slice.

The same participant should attempt a short re-entry after one day and one week. The
re-entry check is qualitative: could they find a useful next action and continue
without assistance? Record an absence of return as a result, not as a telemetry
metric.

## First-run checklist

### Prepare

- [ ] Select an existing, representative Markdown collection that was not created as
      a PALEE demo. Obtain the owner's permission before copying it.
- [ ] Use an isolated `PALEE_CONFIG_DIR` and a disposable vault copy if the run writes.
- [ ] Record the package version, operating system, Node version, and whether the
      package was installed from a packed artifact or a registry release.

### Exercise

- [ ] Install the package and confirm `palee --version`.
- [ ] Configure the vault with `palee config set-vault <path>`.
- [ ] Run `palee adopt --all --dry-run`; confirm the scope and exclusions are
      understandable before making a write.
- [ ] Adopt the intended notes, then run `palee next` and `palee plan`.
- [ ] Start and end a session for the recommended topic, using the canonical topic ID
      shown by `palee next` when a title is ambiguous.
- [ ] Run `palee validate` after the session.
- [ ] Record whether each of these outcomes succeeded without assistance: first-run
      setup, first useful recommendation, first completed session, and validation.

### Record and act

For every run, record the corpus type and size, the command sequence, outcome for each
checklist item, and the first point where the participant needed help or stopped.
Classify each finding as one of:

- **Bug**: behavior is incorrect, loses data, or contradicts the documented contract.
- **UX problem**: the correct path exists but is unclear or unnecessarily difficult.
- **Documentation problem**: the product can complete the task but its instructions
  are absent, misleading, or hard to find.
- **Missing capability**: the intended workflow cannot be completed with the current
  product.

Open a focused issue for a reproducible blocker or a finding that changes product
priorities. Link it to the run and #68. Keep minor, recoverable observations in the
run record until another run confirms they merit their own issue.

## Run record: 2026-11-07

### Setup

- **Build under test:** `@kuldeep2822k/palee@1.1.0`, packed from commit `22d1e64` and
  installed into an isolated local prefix.
- **Environment:** Windows with Node `v24.19.0`; `PALEE_CONFIG_DIR` was isolated from
  the user's normal configuration.
- **Corpus:** a disposable copy of the English documentation tree from
  [`obsidianmd/obsidian-docs`](https://github.com/obsidianmd/obsidian-docs/tree/dd47b6d/en)
  at commit `dd47b6d`. This public corpus was not created as a PALEE demo and
  contained 179 Markdown files.
- **Privacy:** the PALEE commands used a public corpus and no private user notes,
  credentials, or analytics.
  The package was installed from a local tarball, although npm may resolve its
  dependencies through the configured registry.

### Command sequence

With an isolated `PALEE_CONFIG_DIR` and disposable `<vault>`, the run used the
following equivalent commands:

```text
npm pack --pack-destination <package-dir>
npm install --prefix <prefix> --ignore-scripts <package-tarball>
palee --version
palee config set-vault <vault>
palee adopt --all --dry-run
palee adopt --all --yes
palee next --json
palee plan
palee session start --topic <id returned by palee next>
palee session end
palee session list
palee validate
```

### Results

| Outcome | Evidence | Result |
| --- | --- | --- |
| First-run setup | The packed artifact installed, reported its version, and accepted `config set-vault`. | Passed |
| Onboarding preview | `adopt --all --dry-run` scanned 179 files, identified 174 candidates, and explained five exclusions (two metadata notes and three templates). | Passed |
| First useful result | Adoption completed for 174 notes; `next` returned a recommended topic and `plan` reported the same 174 notes as due and ready. | Passed |
| First completed session | `session start --topic <recommended-id>` followed by `session end` recorded one session and rebuilt the derived memory files. | Passed |
| Data integrity | `validate` found 174 PALEE topics in 179 files and reported no errors. | Passed |

### Friction and triage

No reproducible blocker arose in this run: the exact ID emitted by `palee next` started
and completed the first session without assistance. The corpus had no declared learning
dependencies, so all adopted notes were due and ready. That is expected for this corpus
and is not a product finding about dependency handling.

This functional run does not replace a participant's first-impression feedback. A
participant who hesitates, misunderstands an exclusion, or cannot choose the next action
should have that observation classified using the protocol above; open a focused issue
when it is a reproducible blocker or changes product priorities.

### Return check

This run established the baseline. Re-entry remains to be observed with the same
participant or an approved volunteer on 2026-11-08 and 2026-11-14. Record whether they
can locate `palee next`, select a topic, and continue or complete a session without
assistance; file a focused issue if the return workflow reveals a reproducible blocker.
