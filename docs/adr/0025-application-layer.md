# ADR-0025: The Application Layer and the CLI Boundary

## Status

Accepted

## Context

Command handlers combined argument handling, configuration loading, vault/storage access, domain logic, output formatting, and process/exit handling in one module. That is manageable while the command surface is small, and it stopped being manageable the moment a second interface was plausible — the design docs name a TUI, a web UI, and AI tool-calling as future consumers, and #65 was filed specifically to establish the boundary before those arrived, not after.

The issue is explicit that this is not a rewrite: extract only genuinely reusable logic, do not create unnecessary abstractions, start with `palee next` as the reference migration.

## Decision

A `src/application/` layer sits between the CLI handlers and the engine/storage layers. The CLI parses arguments, invokes the use-case, formats the result, and maps errors to exit codes (ADR-0024). The use-cases are pure — no Commander, no `process`, no OCC, no `fs`:

| module | what moved out of the handlers |
|---|---|
| `due-topics.ts` | `normalizeDueDate`, `compareDue`, `partitionDue` — the due-selection primitives previously copy-pasted across `next`, `plan` and `dashboard` |
| `get-next-topics.ts` | the pure core behind `palee next`, including the prerequisite gate (ADR-0020) |
| `mastery-summary.ts` | `summarizeMastery` — the mastery buckets previously copy-pasted in `plan`, `dashboard` and `progress` |
| `topic-query.ts` *(stayed in `src/cli/` — shared by the CLI layer, never moved)* | `resolveTopicQuery` — the match resolver previously duplicated in `review`, `progress` and `assess` |
| `record-review.ts` | `buildReviewUpdate` — coerces stored SM-2 state (preserving a literal `0`), runs `processReview`, computes the next due date, resolves four-pillar mastery |
| `record-assessment.ts` | `buildAssessmentUpdate` and `assessmentAvailabilityDiff` — the merge of supplied pillars over stored ones, and the unlock/block delta (ADR-0021) |

Each application module is a single source of truth with multiple callers; the CLI keeps everything to the right of the pure core — the OCC read-reread, the atomic write, output formatting, exit-code mapping.

### The resolution policy stays in the CLI; only the predicate is shared

`topic-query.ts` never left the CLI layer, and the split it encodes is the point: it shares the *predicate*, not the policy. `review` and `assess` resolve exact-id-wins-then-fuzzy (ADR-0021), `progress` keeps its own tolerance, and the commands differ in wording and JSON shape. Only the choice of topic is shared — the four commands (`review`, `assess`, `progress`, `session`) call `resolveTopicQuery` and each keeps its own policy on top. The same split governs the session flows' hot-memory policies in ADR-0007 — classification shared, policy local.

### "Due" means two things, and the split is now first-class

The subtle point the extraction made explicit rather than altered: a note is *due* by date (never-reviewed, or an elapsed review) and *ready* by graph (prerequisites satisfied). Those were divergent inline filters in three commands; they are now `partitionDue` (the date axis) and the prerequisite gate (the graph axis), composed in `getNextTopics`. Runtime behaviour is unchanged by the extraction — the value is that the two axes are named.

## Consequences

### Positive

- A future interface calls the same use-case the CLI does, without copying logic out of a handler or spawning the binary.
- The write cores (`buildReviewUpdate`, `buildAssessmentUpdate`) are unit-testable without touching disk or OCC — which is how the corrupt-stored-value and literal-zero cases got pinned (ADR-0021).
- Duplicated expressions have one owner, so the three-commands-one-answer class of defect (ADR-0020) cannot recur by copy-paste.

### Negative / Tradeoffs

- **One more layer to cross for a reader.** A `palee next` invocation now reads CLI → application → engine/storage; the indirection is worth it only because the consumers are real, and #65 says so ("do not create unnecessary abstractions").
- **Policy-vs-predicate is a convention, not a type.** Nothing stops a future caller from wrapping the shared predicate in a new policy and re-creating the divergence — the guard is review, not the compiler.

## Alternatives Considered

1. **Leave the logic in the handlers and let a future interface spawn the CLI.**
   - *Why Rejected*: process-spawn is the integration of last resort — output parsing, exit-code mapping, and a per-spawn cost (the test suite measures ~561 ms cold per spawn, which #404 later cut to ~224 ms by other means). The use-cases are callable in-process.
2. **Extract everything into a service layer** (a fat application layer owning I/O too).
   - *Why Rejected*: #65 explicitly scopes this to genuinely reusable logic. A service layer that owns I/O just moves the handler's responsibilities down a level and doubles the surface.
3. **Share the whole topic-resolution policy, not just the predicate.**
   - *Why Rejected*: the commands deliberately differ — `review` refuses ambiguity, `progress` tolerates it, and the JSON shapes differ. Sharing the policy would have flattened a deliberate difference to remove a duplication that was not actually a defect.
4. **Put the use-cases in `src/engine/`** (no new layer).
   - *Why Rejected*: the engine is fs-free and pure by contract (`agent.md`); the use-cases consume `LoadedTopic` (a storage type) and, for the write cores, frontmatter coercion rules. They are application logic, and the engine's purity is worth keeping sharp.
