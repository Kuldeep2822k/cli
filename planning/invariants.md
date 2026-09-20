# PALEE Invariant and Acceptance Test Blueprint

This document turns the architecture into executable tests. A council review is not proof of correctness; these invariants become verified only when the implementation passes them.
Every invariant is addressed by its stable `INV-` ID (for example `INV-11`), never by document line number or bare `#NN`.

## Storage

- **INV-01** — Updating a PALEE field preserves the Markdown body byte-for-byte.
- **INV-02** — Unknown frontmatter keys, comments, ordering, block scalars, aliases, and tags survive an update.
- **INV-03** — A changed fingerprint causes an OCC conflict and leaves the target untouched.
- **INV-04** — A second PALEE writer cannot acquire the target lock and receives exit code `4`.
- **INV-05** — Lock heartbeats occur every 15 seconds for long operations; locks become stale only after 60 seconds without a heartbeat on Windows or 120 seconds on other platforms (see [storage_design.md](storage_design.md) for the platform split and configurable override).
- **INV-06** — Stale-lock recovery quarantines the old lock before creating a new one.
- **INV-07** — Lock release occurs after success, validation failure, conflict, and process interruption.
- **INV-08** — A temporary-file or rename failure never truncates the target.
- **INV-09** — Five transient Windows lock failures are retried; a persistent lock returns exit code `4`.
- **INV-10** — The walker skips excluded directories and symlinks by default.
- **INV-11** — A malformed note produces a validation warning and does not abort a vault scan.

## SM-2

- **INV-12** — `quality` accepts only integers `0..5`; for newly-adopted topics with no review history, `last_quality`, `last_reviewed_at`, and `due_at` are `null` until the first review is recorded.
- **INV-13** — Ease-factor delta is `0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`.
- **INV-14** — `ease_factor` is always at least `1.30`.
- **INV-15** — Ease factor and intervals use positive decimal half-up rounding.
- **INV-16** — `quality < 3` resets repetition to `0` and interval to `1`.
- **INV-17** — Successful repetitions use intervals `1`, `6`, then `round(previous_interval * ease_factor)`.
- **INV-18** — Lapses increase only when a previously learned topic is forgotten; initial-learning failures do not increase lapses.
- **INV-19** — No result produces an interval below `1`.
- **INV-20** — Due dates add calendar days in the configured vault timezone.

## Mastery and Graphs

- **INV-21** — Topic mastery is `round((conceptual + practical + debug + (feynman * 2)) / 5, 4)` — feynman is double-weighted.
- **INV-22** — Global mastery excludes archived topics and includes paused topics.
- **INV-23** — With zero active topics, global mastery is `null` with status `no_data`, never numeric zero.
- **INV-24** — Missing dependencies block a topic and produce a warning.
- **INV-25** — Cycles are quarantined with an exact cycle path; acyclic topics remain usable.
- **INV-26** — Unlock scoring never returns a value larger than the number of reachable downstream topics.

## Resolution and CLI

- **INV-27** — Resolution precedence is exact ID, exact title/filename, legacy alias, normalized slug, then token-distance match.
- **INV-28** — Ambiguous matches require interactive selection or return a deterministic non-interactive error.
- **INV-29** — Non-AI commands open no network sockets.
- **INV-30** — `--json` and non-TTY output contain no ANSI control sequences.

## Roadmaps

- **INV-31** — `roadmap --from` performs no network or AI calls.
- **INV-32** — A user-provided roadmap is validated before any vault mutation.
- **INV-33** — Guided roadmap generation asks for goal, level, time, deadline, style, and constraints.
- **INV-34** — Guided proposals include dependencies, difficulty, rationale, and assumptions.
- **INV-35** — No roadmap proposal writes topic notes before explicit learner confirmation.
- **INV-36** — Roadmap proposals conform to the schema in `roadmap_design.md`.

## AI and Sessions

- **INV-37** — LLM tool schemas contain no assessment, review, or session-write mutations.
- **INV-38** — A candidate assessment is rejected if its schema or score range is invalid.
- **INV-39** — Unsupported structured output gets at most one retry; only complete schema-valid JSON is accepted.
- **INV-40** — Fenced, repaired, regex-extracted, or inferred JSON is never executed or treated as a valid proposal.
- **INV-41** — An anomalous-score flag fires only on established topics (prior `assessed_at` exists, all four prior scores above `0.10`); first assessments are never flagged regardless of score magnitude.
- **INV-42** — The anomaly flag remains active for ten minutes after `assessed_at`, measured from that timestamp — a session restart during the ten-minute window does not clear the flag.
- **INV-43** — A draft checkpoint survives interruption; on next startup, interactive mode offers Resume, Save as session, Discard, and Ignore — all four paths must behave correctly and non-interactive mode must never auto-discard.
- **INV-44** — A confirmed session is written before derived views are regenerated.
- **INV-45** — Corrupt or missing `hot.md` is rebuilt from canonical sessions.
