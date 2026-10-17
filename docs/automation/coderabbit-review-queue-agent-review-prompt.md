# Independent review prompt: CodeRabbit review queue for PALEE CLI

Act as an independent senior engineer reviewing a proposed GitHub Actions automation for the repository `Kuldeep2822k/cli` (PALEE CLI). Do not assume the current proposal is correct, complete, or the intended final design. Evaluate the problem from first principles and recommend the safest, simplest approach that satisfies the goals.

## Context and goal

The maintainer wants to reduce manual effort requesting CodeRabbit reviews across open pull requests, while avoiding duplicate requests, unnecessary delays, and CodeRabbit rate-limit exhaustion. There may be several human-authored PRs opened or updated close together. Renovate and other dependency/bot PRs should be excluded by default.

The intended behavior is adaptive: process reviews promptly when CodeRabbit has capacity; defer work when rate-limited; do not impose an arbitrary one-hour slot per PR unless documented limits or observed behavior justify it. No always-on server or 24/7 worker should be required. GitHub Actions jobs should be short-lived.

## Ideas discussed so far, not decisions

- Use pull-request events to notice newly opened or updated PRs.
- Use a single coordinated processor so concurrent events do not send duplicate or overlapping review requests.
- Derive or persist a queue of eligible PRs, excluding bot-authored PRs and PRs already reviewed for their current head commit.
- Trigger CodeRabbit through its supported GitHub integration, potentially with a PR conversation command such as `@coderabbitai review`.
- Inspect GitHub API evidence to distinguish a posted request, pending response, completed review, rate limit, and unrelated failure.
- On rate limiting, use an explicit retry duration/timestamp if CodeRabbit provides one. Otherwise use a bounded, conservative backoff with jitter and avoid tight retry loops.
- Persist enough state to survive workflow exits. A job should save state and exit rather than wait indefinitely.
- A scheduled recovery run could resume pending work if no event occurs at the right time. Consider whether polling is needed and what interval is justified.
- Protect against overlapping workflow runs and recheck state immediately before acting.

These are candidate ideas, not requirements that must all be implemented. Challenge any of them if a different design is more correct or maintainable.

## Please investigate before recommending an implementation

1. Verify CodeRabbit's current documented review-command behavior, rate-limit/quota signals, and whether review requests issued by GitHub Actions-created comments are actually processed by the CodeRabbit app. Do not infer success from the comment being posted.
2. Identify reliable observable signals for request accepted, review started, review completed, rate limited, quota exhausted, and transient/API failure. Confirm whether a retry-after value or rate-limit command exists and is documented for this setup.
3. Inspect the repository's existing workflows, permissions, branch protections, conventions, and tests. Minimize new infrastructure and avoid introducing a dependency solely for convenience.
4. Assess GitHub Actions semantics and limitations: event triggers, `GITHUB_TOKEN` behavior, permissions needed to comment, concurrency behavior, scheduled-run delay, workflow runtime limits, and any risk of recursive or duplicate triggers.
5. Decide whether queue state should be derived from current open PRs, stored in labels/comments/artifacts, stored in a dedicated file/branch, or managed another way. Compare correctness, race conditions, auditability, and maintenance cost.

## Design questions to answer

- What exactly makes a PR eligible? Consider PR state, author type, draft status if relevant, current head SHA, existing CodeRabbit reviews, previous failed requests, and whether a new commit should make the PR eligible again.
- What is the smallest safe trigger model? Consider `pull_request` events, `workflow_dispatch`, and scheduled recovery. Explain why each trigger is needed or not needed.
- How will simultaneous PR events be coalesced or serialized without losing work? Is concurrency control alone enough, or is durable queue state required?
- How will the processor know it hit a CodeRabbit limit? Define evidence-based classification, not guessed phrase matching alone. Explain handling of unknown responses and API errors.
- How should retry times be calculated when responses vary, such as 36 minutes, 44 minutes, or 70 minutes? Prefer a server-provided retry time when reliable; otherwise define a justified backoff policy.
- How will it avoid retrying too early, repeatedly posting commands, or marking a PR complete when only a request comment was posted?
- How will a later run recover queued work after a failure or rate limit, without an always-on worker?
- What permissions and secrets are required? Prefer least privilege and explain whether `GITHUB_TOKEN` is sufficient or a different credential is necessary.
- How can this be tested safely without consuming real CodeRabbit review quota? Include unit tests for parsing/state transitions and an integration/test plan.

## Expected response

Please produce an independent assessment with:

1. A concise problem statement and success criteria.
2. At least two plausible architecture options, with trade-offs.
3. Your recommended architecture and why it is better than the alternatives.
4. A state machine for PR/review processing, including unknown and failure states.
5. Specific risks, assumptions, and questions that must be resolved before merging.
6. A proposed implementation plan with file-level changes and tests.
7. A review of any implementation/PR provided alongside this prompt: identify correctness bugs, race conditions, permissions problems, retry loops, missing tests, and scope creep. Distinguish blocking issues from improvements.
8. Explicitly state if the best recommendation is to reduce scope, defer implementation until CodeRabbit behavior is verified, or not build the automation at all.

Do not treat this prompt as a predetermined specification. You are free to reject the proposed queue/worker/scheduler model, change the scope, or recommend a simpler solution. Explain your reasoning and cite current primary documentation or repository evidence wherever possible. Do not claim tests or live behavior were verified unless you actually verified them.