fix(cli): `migrate --fix` exits 4 on OCC / lock conflict (closes #128)

## Problem

`palee migrate --fix` calls `atomicWrite` with an `expectedFingerprint`
(`src/cli/migrate.ts:60`), but its catch hard-codes `process.exitCode = 5`
(`migrate.ts:99`). A concurrent edit during migration therefore reports
"unexpected error" (5) instead of the documented OCC conflict (4), and
`docs/02-0-cli-commands.md:71` documents exit 4 as the conflict contract.

The other 9 handlers in `src/cli/*` are correct on this point — `adopt`,
`review`, `roadmap`, and `session` all use `isConflictError(e) ? 4 : 5`.
`migrate` is the only writing handler that bypasses the mapping.

## What this PR does

1. Imports `isConflictError` from `../storage`.
2. Tracks an OCC/lock conflict inside the per-file `--fix` loop and sets
   `process.exitCode = 4` (winning over the exit-3 "unrecognized schema"
   branch because the migration could not complete).
3. Maps the outer-catch error to `isConflictError(e) ? 4 : 5`.
4. Updates the JSDoc to document exit code 4 alongside 2, 3, 5.

## Why this scope (and not the meta-refactor)

The issue body lists five read-only handlers (`next`, `plan`, `progress`,
`validate`, `dashboard`) that also hard-code `exitCode = 5`. None of them
write files, so the contract is internally consistent for them — there is
no OCC conflict they could produce. Migrating them all to a shared
`withExitCode()` / `runCommand()` helper is a separate refactor tracked
under #65 and would balloon this PR. This PR fixes the documented
contract violation in the *only* writing handler that was wrong.

## Tests

Two new tests in `test/cli-commands.test.ts`, mirroring the existing
review/adopt conflict tests:

- `migrate --fix exits with code 4 on concurrent lock conflict` — uses
  `Lock.acquire()` on a schema-less note, then runs `palee migrate --fix`
  via `runCLI` and asserts status 4.
- `migrate --fix exits with code 4 on OCC TOCTOU conflict` — directly
  invokes `migrateCommand({ fix: true })` with an `fs.readFileSync` spy
  that returns externally modified content on the second read, asserting
  `process.exitCode === 4` and that the logged error mentions "OCC
  conflict".

## Validation

- `npm run check` — green (typecheck + lint)
- Test pattern mirrors `test/cli-commands.test.ts:678, 736` (review TOCTOU
  + deleted-topic) and `:560, 595, 623` (lock conflict for review/adopt/
  roadmap) which are the reference tests for this contract.

## Related

- Fixes #128
- #65 (broader `runCommand` / application-layer extraction)
- #76, #77 (earlier work that landed the exit-4 emission and the
  `process.exitCode`-vs-`process.exit` cleanup respectively)
