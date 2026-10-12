# ADR-0024: Exit Codes and the Machine-Readable Error Contract

## Status

Accepted

## Context

The exit codes are documented as a contract — 0 success, 1 partial, 2 usage, 3 validation, 4 conflict, 5 unexpected — and the code broke the contract at every layer. Nine handlers hard-coded `ExitCode.Unexpected` in their top-level catch while five routed through `exitCodeFor`, so the same error class could exit differently depending on which command caught it. The JSON error branch printed its payload and then called `process.exit()`, which does not flush pending async writes to a redirected stdout — "green interactively, broken piped." `--json` mode was sniffed with `process.argv.includes('--json')`, which also fires when `--json` is merely a *value*. And the usage-error branch dumped the whole error object, stack and all, at users while using only `err.message` for the JSON payload.

A script parsing `palee <cmd> --json` could receive truncated, unparseable JSON and a misleading exit code. The contract is what makes the CLI scriptable; it has to hold on the failure paths, which is the only place anyone checks it.

## Decision

### One classifier, every handler

`exitCodeFor` in `src/cli/exit-codes.ts` is the single source of truth, and every handler's catch routes through it:

| error | exit | why |
|---|---|---|
| OCC / lock conflict | 4 | retryable — re-read and re-run |
| containment refusal (`ECONTAINMENT`) | 3 | a vault integrity condition, not a crash and not a collision — the same class a roadmap path that escapes the vault already reports, and no retry makes an escaping path safe |
| provider `config` kind (bad endpoint, unsupported provider) | 2 | configuration |
| provider `schema` kind (reply broke the output contract) | 3 | validation |
| provider 401/403 | 2 | a user-fixable credential problem, not a crash — `status` is carried precisely so it can be told apart from a 5xx or an unreachable endpoint |
| everything else | 5 | unexpected |

The provider mapping lives in the classifier rather than at each call site, so the same provider refusal cannot exit 2 from `config set-base-url` and 5 from a command that read the same stored value.

### `process.exitCode`, never `process.exit`, on every handled path

The Commander usage-error branch immediately above the JSON one already used `process.exitCode = N; return` to avoid exactly the truncation — the policy is stated in `agent.md` and is now uniform. The only `process.exit` left is the fatal top-level 5, where flushing is moot.

### JSON mode is detected from the parsed options, not argv

`process.argv.includes('--json')` fires when `--json` is merely a value (`palee config -- --json`). The parsed options answer the question the contract asks.

### Every failure path carries a JSON branch

All five reading handlers caught errors as plain `Error: <message>` with no JSON branch; they now emit the machine-readable payload, and the usage-error branch uses `err.message` for the payload rather than dumping the stack at users.

### The premise that was corrected while fixing it

Both issues behind the classifier swap assert an *observable* misreport, and it is not reachable today: `next`, `plan`, `dashboard` and `progress` import only config/vault/topics, so neither `ECONFLICT` nor `ECONTAINMENT` can be raised on those paths and `exitCodeFor(e)` returns 5 for every error they can see — identical to what they return now. The PR ships the classifier swap only, with no new exit-code behaviour and no docs changes, and says so. Routing the catch through the one classifier is the fix for the *class* of bug (a handler that forgets), not for a reproducible misreport.

## Consequences

### Positive

- The same error class exits the same code from every command; a script can branch on the exit code without knowing which command produced it.
- Piped JSON is complete — the flush policy is uniform and the truncation is structurally impossible on handled paths.
- Containment refusals join validation where they belong, so a security refusal is distinguishable from a crash and from a retryable collision.

### Negative / Tradeoffs

- **The classifier swap changed no observable behaviour** for the seven handlers, because their error paths cannot produce the classified errors. That is worth stating plainly: the value is structural (one routing point) rather than a fixed bug, and the PR says which is which rather than claiming a fix it cannot demonstrate.
- **A 401/403 exits 2 (usage), not 5.** That is deliberate — it is a user-fixable credential problem — but it means "authentication failed" and "you typo'd a flag" share an exit code. The `status` field on the error keeps them distinguishable in JSON; the exit code alone does not.

## Alternatives Considered

1. **Keep per-handler exit mapping** (each command decides its own codes).
   - *Why Rejected*: seven handlers hard-coded 5 while five routed through the classifier — the same class of bug the centralization exists to prevent, waiting for the next handler that forgets.
2. **Map containment to 5** (treat it as a crash).
   - *Why Rejected*: a planted link moving a note outside the vault is a vault integrity condition — the same class a roadmap path that escapes the vault already reports at 3 — and unlike `ECONFLICT` no retry makes it safe. It belongs with validation.
3. **Keep `process.exit()` in the JSON branch** (flush by exiting after a tick).
   - *Why Rejected*: the neighbouring Commander branch already documented why not — pending async writes to a redirected stdout are lost. The uniform policy is `process.exitCode` + return.
4. **Sniff `--json` from argv.**
   - *Why Rejected*: it fires when `--json` is merely a value. The parsed options are the only thing that knows what the user asked for.
5. **Dump the full error object in the usage branch** (debuggability).
   - *Why Rejected*: users get a stack for a typo. The JSON payload carries `err.message`; the stack belongs to the 5-class unexpected path, where it is genuinely diagnostic.
