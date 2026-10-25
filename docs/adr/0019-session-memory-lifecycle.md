---
description: ".palee/hot.md is derived working memory and .palee/sessions/ is canonical history (ADR-0007 owns the read-side contract; ADR-0006 the write side). The v1.0.0..."
---


# ADR-0019: Session-Memory Lifecycle and Staleness Clamps

## Status

Accepted

## Context

`.palee/hot.md` is derived working memory and `.palee/sessions/` is canonical history (ADR-0007 owns the read-side contract; ADR-0006 the write side). The v1.0.0 round hardened the lifecycle between them: what happens to a draft when a session ends, how far a recovered timestamp may sit from now, and how a rebuild treats sessions it cannot read.

Two of the rulings here are recorded because they are **policy decisions that were deliberately not reverted** when their tests contradicted them — the audit's most interesting failure mode, where the code was right, the test encoded the old policy, and the choice of which one moves is the decision.

## Decision

### The hot rebuild happens before the draft is retired

A half-finished recovery must be replayable: if `session end` deletes the draft first and the rebuild then fails, the recovery state is gone. The rebuild runs, the session start is carried through into the rebuilt hot memory, and the draft is retired last. A draft is also never deduped on an empty notes body — an empty checkpoint is a legitimate checkpoint, and deduping it silently drops a same-topic session.

### A recovered `started_at` is clamped to a 24-hour floor, with a 60-second future band

Three sites recover a timestamp the learner may have abandoned days ago:

- **Tier-1** (`recoverDraft`) and **Tier-2** (`session end`'s hot-memory branch) clamp a start older than 24 hours to the floor, so an abandoned session's `duration_minutes` cannot report days of study that never happened. `session end` with a 10-day-old `started_at` used to write `duration_minutes = 14400`.
- A start **within 60 seconds of now**, future or past, is accepted as-is — the clock-skew band; more than 60 seconds in the future clamps to now.

**Why this is an ADR and not a changelog line:** when the clamp landed, the existing test still asserted the old policy — it built a 48-hour-old `started_at`, called `session end`, and asserted `duration_minutes === 2880` under the description "no age limit." The test had kept all three matrices red since the PR opened. The resolution was recorded explicitly: *"the assertion encodes a policy decision, and #212 is approved and waiting on merge, so silently rewriting it would hide a behaviour change."* **The test moved to the clamp; the code did not move back.** The file header and section banner that both said "no age limit" were corrected in the same commit — those two stale lines were why the contradicting test survived the clamp in the first place. The ruling originated as **Supervisor ruling 3 of 2026-09-25**, raised from a reviewer follow-up on #208, in a bug ledger that was never committed to the repository (see the fourth backfill issue).

### An unsupported schema version is refused, not coerced

`regenerateIndex` used to silently coerce an unknown or missing `palee_schema` to `1`. Unsupported-schema confirmed sessions are now skipped using the exported `SUPPORTED_SCHEMA_VERSION` constant — the same strict check `readHotMemory` applies (ADR-0007) — so the rebuild and the read cannot disagree about what a v1 session is.

### Unreadable sessions are counted, not silently dropped

A confirmed session that cannot be read (I/O error) or parsed (corrupt frontmatter) is counted, and the skipped total is surfaced in the index report, so "Total: N" never quietly means "N of M." A zero-byte session file was already handled; the locked/unreadable case was not, and the report's silence made the rebuild look complete when it was not.

### Rebuilds never delete, and both derived views share one eligibility predicate

`regenerateIndex` and `rebuildHotAndIndex` no longer unlink session files on any path — including the exception paths (a stat or read throwing a code-less error), which are pinned by tests that force the throw and assert the file survives with unchanged content. When a draft session would be selected as the "newest session" for `hot.md`, it creates a phantom reference from a derived view to a session that should be excluded — so both views apply the same confirmed-session eligibility predicate, keeping `index.md` and `hot.md` internally consistent.

## Consequences

### Positive

- An abandoned session cannot report days of phantom study time; the floor is visible in the test names and the file headers, not just the code.
- A failed rebuild leaves the draft replayable.
- The index report accounts for every session it saw — including the ones it could not read.
- The derived views cannot disagree about which sessions are real.

### Negative / Tradeoffs

- **The 24h floor is a guess about intent.** A learner who genuinely studied for 30 hours straight loses the first 6 hours of recorded duration. The policy chooses "under-report" over "over-report," because an inflated duration corrupts the learning signal the whole product is built on — and the ruling that chose it lives outside the repository, which is exactly the gap the ADR backfill exists to close.
- **Strict schema checking means a future-format hot.md rebuilds from scratch** (lossless — it is derived — but the invalid file's body text is discarded). Pinned by characterization tests so the tradeoff stays visible.
- **Exception-path tests force real throws** (mocking `statSync`/`readFileSync`), which is a heavier test pattern than the zero-byte case they supplement — deliberate, because the zero-byte path had already proven that the obvious test shape can pass without exercising the catch block.

## Alternatives Considered

1. **Revert the code to the old "no age limit" policy** when the test contradicted it.
   - *Why Rejected*: the clamp was the approved fix (#212) and the test encoded the pre-fix policy. Moving the code back would have preserved a bug through a review round; moving the test is the honest resolution, stated in the PR thread rather than done quietly.
2. **No clamp at all — report whatever the file says.**
   - *Why Rejected*: `duration_minutes = 14400` for an abandoned session is a fabricated learning signal. The whole scheduling model (SM-2, ADR-0001) consumes these numbers.
3. **Coerce unknown session schemas to v1 on rebuild** (the pre-#361 behaviour).
   - *Why Rejected*: it silently consumes a format the code cannot interpret — the same stance ADR-0007 takes on the read side and ADR-0005 takes on migration. The rebuild and the read now agree.
4. **Skip unreadable sessions silently** (the pre-#362 behaviour).
   - *Why Rejected*: the report's total then lies by omission. Counting them costs one line of output and makes "Total: N of M" true.
5. **Delete unreadable/corrupt session files during rebuild** (a cleanup pass).
   - *Why Rejected*: the canonical store is history; a rebuild is a derived-view operation. Deleting canonical files from a rebuild is how #177's defect class starts — the fix there was removing four `unlinkSync` sites for exactly this reason.
