# CodeRabbit review queue: design proposal

## Status

Proposal for independent review only. This document does not enable automatic CodeRabbit review requests. Do not merge an implementation until trigger behavior, rate-limit signals, and credential behavior have been verified against the repository's actual CodeRabbit installation.

## Problem

PALEE has multiple human-authored pull requests open at once. The maintainer wants a reliable way to request CodeRabbit reviews without reviewing dependency-bot PRs, duplicating requests for the same commit, or wasting review quota during rate limits.

## Goals

- Process eligible PRs promptly when CodeRabbit has capacity.
- Exclude Renovate and other bot-authored PRs by default.
- Avoid duplicate requests for the same PR head SHA.
- Distinguish a posted command from an accepted, running, completed, or rate-limited review.
- Respect variable retry durations returned by CodeRabbit; do not hard-code one hour per PR.
- Use short-lived GitHub Actions jobs, not an always-on worker.
- Recover pending work after failures or rate limits.
- Keep permissions minimal and make the process observable and testable.

## Non-goals

- No permanent server or 24/7 polling process.
- No automatic merging or code changes from CodeRabbit.
- No assumption that posting a comment means a review has started or completed.
- No promise of exact-minute execution from GitHub Actions schedules.

## Candidate architecture

1. Pull-request events notice newly opened, reopened, or updated PRs. A manual trigger supports controlled testing. A scheduled recovery trigger can recover pending work when no PR event occurs.
2. A single coordinated processor inventories open PRs, excludes bot authors, and evaluates each PR against its current head SHA and review history.
3. The processor chooses one eligible PR at a time. It records an idempotency key based on PR number and head SHA before attempting an action, with recovery rules for interrupted attempts.
4. It issues the documented CodeRabbit review command only after verifying that the installed CodeRabbit integration processes this kind of request and that the chosen credential is accepted.
5. It inspects GitHub API evidence for a response. A command comment alone is not success. The state model should include READY, REQUESTED, PENDING, COMPLETED, RATE_LIMITED, QUOTA_EXHAUSTED, RETRY_WAIT, and ERROR.
6. If a reliable retry timestamp or duration is provided, persist the corresponding eligible-at timestamp. If no retry guidance exists, use bounded exponential backoff with jitter and a maximum attempt count. Never tight-loop.
7. The job exits after bounded polling or when there is no work. A later event or recovery run resumes from durable state.

## Important design decision still open

Queue persistence could be derived from current open PRs and their review/comment history, or stored separately. Deriving state is simpler but can be ambiguous after interrupted requests; explicit durable state is clearer but adds write permissions and a storage mechanism. The implementation should choose after analyzing failure modes and repository constraints.

GitHub Actions concurrency is useful for preventing overlapping processors, but it is not itself a durable FIFO queue. Scheduled runs may start late. The processor must recheck eligibility and persisted state before acting.

## Verification required before implementation

- Confirm CodeRabbit's current supported review command and whether comments created by `GITHUB_TOKEN` or an Actions bot trigger the CodeRabbit app.
- Confirm actual rate-limit and quota-exhaustion signals and whether the response exposes a retry duration or timestamp.
- Confirm whether a rate-limit status/check can be green despite no review being performed.
- Confirm least-privilege permissions for reading PRs and creating comments.
- Decide how to distinguish a review on the current head SHA from a review of an older commit.
- Determine safe test coverage without consuming real review quota.

## Acceptance criteria for a future implementation

- Bot-authored PRs are excluded by default.
- A PR already reviewed at its current head SHA is not requested again.
- A new head SHA can become eligible again.
- Concurrent PR events cannot cause duplicate simultaneous requests.
- Rate limiting produces a recorded deferred state and no immediate retry loop.
- Variable retry durations are honored when reliably supplied.
- Missing or unknown responses remain pending/error, not falsely marked completed.
- The workflow is bounded, least-privilege, observable, and recoverable.
- Unit tests cover eligibility, parsing, state transitions, retries, and idempotency.
- The PR clearly documents any repository settings or secrets that must be configured.