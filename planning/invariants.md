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
- **INV-43** — A draft checkpoint survives interruption; on next startup, interactive mode offers Resume, Save as session, Discard, and Ignore — all four paths must behave correctly and non-interactive mode must never auto-discard. If stdin closes before the current prompt is answered, previously answered actions remain committed, every unanswered checkpoint stays on disk, and the command exits `2`.
- **INV-44** — A confirmed session is written before derived views are regenerated.
- **INV-45** — Corrupt or missing `hot.md` is rebuilt from canonical sessions.

## Auto-Chain and Wikilinks

- **INV-46** — `adopt --auto-chain` derives each note's `depends_on` from structure-justified order only — Tier-0 hygiene classifies first, the numbered tree orders what it covers, and the TOC tier chains what the numbering does not (the binding rules are the sub-clauses below) — validates the planned graph — merged with existing vault topics — for cycles before any write (exit `3`, zero writes on failure), and never modifies already-adopted notes: the plan spans every note in the scanned scope, including notes already adopted there, and such a note is used as a chain predecessor (keeping the `palee_id` and `depends_on` it has on disk) but is never rewritten. Nothing is ever chained from alphabetical accident, every edge's author tier is recorded, and no note written, demoted or skipped goes unaccounted in the report.
  - **Tier-0 hygiene (PAL-205-B).** Before any note is ordered it is classified `backbone` / `leaf` / `excluded` by the fs-free predicates in `src/engine/tier0-hygiene.ts`. `excluded` — repo-meta names, translation copies (a `translations/` path segment, or a locale-suffixed *generic* doc name) and template notes — are neither adopted nor chained and can never gate a real lesson. `leaf` — phase subtrees (`solution|solutions|your-work|start|sketch|answers`), locale-suffixed non-generic names, unnumbered non-content siblings inside a directory, and notes whose `palee_id` is truthy but not a usable string — may keep a predecessor, but nothing chains off them; the backbone bridges over them, so a leaf never restarts or blocks a chain. A stem that parses as a numbered lesson is exempt from the name-based locale arm (`02-es.md` is lesson 2, Elasticsearch); a genuinely translated lesson is excluded by the structural `translations/` arm instead. When the scan knows a note's `palee_id`, the planner re-derives that classification too (the `paleeIdOf` contract): scan-time skip and plan-time demotion can never disagree about what may gate, and any consumer of the planner inherits the same rule. The failure direction is always demote-to-leaf — visible coverage loss in the report — never chain-as-a-lesson — a silent lie. The dry-run and confirmation screens must therefore print backbone count, leaf count, per-rule exclusion counts (meta / translations / template), phase-subtree collapses, the invalid-`palee_id` count, and the excluded total, and must print the block even when nothing survived filtering: those counts are the stop sign telling the learner the vault needs `--exclude`.
  - **Tier composition and precedence (PAL-205-C).** `--auto-chain` accepts `strict|toc|full` (bare flag means `full`; any other value is a usage error, exit `2`, never a silent default back to chaining). Precedence is fixed: Tier-0 hygiene sits above both tiers — no TOC ordering may revive an `excluded` note or re-promote a phase-subtree or translation demotion; within the numbered tree a directory leads with its README-class doc, then numeric prefixes, then `deep-dive → lab → exam`, then remaining names, with homework (`assignment|quiz|solution`) last; and a cross-directory transition gates only when the order between the directories comes from structure — same directory, a nesting relation, or numeric prefixes on both sides of the first differing segment — with exactly one owner-ruled exception (PAL-205-G2): a transition *from the vault root* gates when the target directory's first segment is numbered, because the root README is the document that introduces the curriculum; a root note reaching an unnumbered directory still refuses, and the root group is hoisted to the front of the hygiene plan's order while the exported `planAutoChain` ordering stays byte-identical. `toc` and `full` chain the unnumbered remainder from the repo's own `README`/`SUMMARY` markdown-link enumeration in document order, resolved fail-closed (ambiguous, missing, escaping or out-of-scope targets are skipped and counted, never fatal). Numbering dominance: endpoints inside the numbered tree never receive TOC edges, and a TOC edge *replaces* whatever the alphabetical fallback would have assigned rather than adding to it — the replacement, not the addition, is where the false edges die. Every written edge records its author tier in the additive optional `depends_on_source: numbered|toc` frontmatter field on `palee_schema: 1`; old builds parse such files unchanged and the field never affects gating. Every edge points strictly backward in its tier's own total order and the merged plan is asserted acyclic in code before any write.
  - **Honest refusal (PAL-205-B/C).** The absence of an order signal is a correct outcome, not a failure. The no-signal claim may only be made when the scope carries no numbered layout, the scoped `README`/`SUMMARY` enumeration resolves no TOC link at all, and the final plan writes zero edges — then the command prints `0 edges (no numbered layout, no README TOC links) — consider palee roadmap` and exits `0` with zero fabricated edges; a README that does enumerate its notes keeps their justified numbered edges (a TOC chain head never erases a structurally-justified numbered predecessor unless the keep itself would close a cycle), so the refusal can never fire on a real enumeration. `strict` declining a TOC enumeration that does exist is a configuration choice, not the no-signal case, and does not print the roadmap pointer. Likewise an unjustified cross-directory transition makes the note a chain head — subject to the single root-bridge exception above: opening a new honest chain is the refusal path, chaining from alphabetical position never is.
- **INV-47** — `roadmap --auto-chain` chains topics by their `order` field (unordered topics keep file order, appended after ordered ones); an explicit non-empty `depends_on` always wins over the synthesized chain; a synthesized edge that would close a cycle against an authored dependency is skipped with a warning and that topic starts a new chain, so the rest of the roadmap still imports instead of the whole batch failing on an edge the flag itself invented; the summary line `Auto-chain: N chain edge(s) synthesized across M roadmap topics.` prints only after graph validation passes, with `N` counting only the edges actually synthesized — a skipped cycle-closing edge is never counted, and the line claims synthesis, never that every topic was chained; the wikilink format arrives already chained per `## Track` section and is exempt from this pass.
- **INV-48** — Wikilink roadmap resolution is fail-closed and scoped to roadmap files, where a "roadmap file" is defined: the wikilink format is recognised only in a Markdown document whose frontmatter sets `palee_roadmap: true` (real YAML boolean, not the string `'true'`), and any other `.md` passed to `roadmap --from` — including an ordinary note with a heading and `[[links]]` — is rejected with exit `2` and zero writes. Within a marked roadmap, a chain section opens only at a `##` heading; deeper levels (`###` and below) extend the enclosing section, because every section head is written with `depends_on: []` and extra heads would erase the prerequisites a note already has. Ambiguous `[[Note]]` targets error listing every candidate, unresolvable targets error, `#heading`/`#^block` anchors are stripped, and a note listed twice is rejected (it would depend on itself).
