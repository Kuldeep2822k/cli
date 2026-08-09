# PALEE Invariant and Acceptance Test Blueprint

This document turns the architecture into executable tests. A council review is not proof of correctness; these invariants become verified only when the implementation passes them.

## Storage

- Updating a PALEE field preserves the Markdown body byte-for-byte.
- Unknown frontmatter keys, comments, ordering, block scalars, aliases, and tags survive an update.
- A changed fingerprint causes an OCC conflict and leaves the target untouched.
- A second PALEE writer cannot acquire the target lock and receives exit code `4`.
- Lock heartbeats occur every 15 seconds for long operations; locks become stale only after 60 seconds without a heartbeat on Windows or 120 seconds on other platforms (see [storage_design.md](storage_design.md) for the platform split and configurable override).
- Stale-lock recovery quarantines the old lock before creating a new one.
- Lock release occurs after success, validation failure, conflict, and process interruption.
- A temporary-file or rename failure never truncates the target.
- Five transient Windows lock failures are retried; a persistent lock returns exit code `4`.
- The walker skips excluded directories and symlinks by default.
- A malformed note produces a validation warning and does not abort a vault scan.

## SM-2

- `quality` accepts only integers `0..5`; for newly-adopted topics with no review history, `last_quality`, `last_reviewed_at`, and `due_at` are `null` until the first review is recorded.
- Ease-factor delta is `0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`.
- `ease_factor` is always at least `1.30`.
- Ease factor and intervals use positive decimal half-up rounding.
- `quality < 3` resets repetition to `0` and interval to `1`.
- Successful repetitions use intervals `1`, `6`, then `round(previous_interval * ease_factor)`.
- Lapses increase only when a previously learned topic is forgotten; initial-learning failures do not increase lapses.
- No result produces an interval below `1`.
- Due dates add calendar days in the configured vault timezone.

## Mastery and Graphs

- Topic mastery is `round((conceptual + practical + debug + (feynman * 2)) / 5, 4)` — feynman is double-weighted.
- Global mastery excludes archived topics and includes paused topics.
- With zero active topics, global mastery is `null` with status `no_data`, never numeric zero.
- Missing dependencies block a topic and produce a warning.
- Cycles are quarantined with an exact cycle path; acyclic topics remain usable.
- Unlock scoring never returns a value larger than the number of reachable downstream topics.

## Resolution and CLI

- Resolution precedence is exact ID, exact title/filename, legacy alias, normalized slug, then token-distance match.
- Ambiguous matches require interactive selection or return a deterministic non-interactive error.
- Non-AI commands open no network sockets.
- `--json` and non-TTY output contain no ANSI control sequences.

## Roadmaps

- `roadmap --from` performs no network or AI calls.
- A user-provided roadmap is validated before any vault mutation.
- Guided roadmap generation asks for goal, level, time, deadline, style, and constraints.
- Guided proposals include dependencies, difficulty, rationale, and assumptions.
- No roadmap proposal writes topic notes before explicit learner confirmation.
- Roadmap proposals conform to the schema in `roadmap_design.md`.

## AI and Sessions

- LLM tool schemas contain no assessment, review, or session-write mutations.
- A candidate assessment is rejected if its schema or score range is invalid.
- Unsupported structured output gets at most one retry; only complete schema-valid JSON is accepted.
- Fenced, repaired, regex-extracted, or inferred JSON is never executed or treated as a valid proposal.
- An anomalous-score flag fires only on established topics (prior `assessed_at` exists, all four prior scores above `0.10`); first assessments are never flagged regardless of score magnitude.
- The anomaly flag remains active for ten minutes after `assessed_at`, measured from that timestamp — a session restart during the ten-minute window does not clear the flag.
- A draft checkpoint survives interruption; on next startup, interactive mode offers Resume, Save as session, Discard, and Ignore — all four paths must behave correctly and non-interactive mode must never auto-discard.
- A confirmed session is written before derived views are regenerated.
- Corrupt or missing `hot.md` is rebuilt from canonical sessions.
