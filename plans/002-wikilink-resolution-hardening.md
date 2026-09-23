# Plan 002: Restrict wikilink resolution to in-scope Markdown notes and fail closed on vault escapes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6bce46d..HEAD -- src/storage/wikilink.ts test/storage-wikilink.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security / data-integrity
- **Planned at**: commit `6bce46d`, 2026-09-22

## Why this matters

`resolveWikilinkTarget` decides which file `palee roadmap` will open and rewrite
YAML frontmatter into. Three of its behaviours turn that decision into data
loss:

1. A target without a `.md` suffix keeps its **bare** form as a candidate, so
   `![[assets/diagram.png]]` resolves to the PNG. The importer then reads it as
   UTF-8 and writes frontmatter back — the asset is destroyed and cannot be
   recovered.
2. When a resolved path escapes the vault, the function `continue`s instead of
   erroring, which drops through to the *basename* lookup and silently resolves
   **a different file the user never named**.
3. Path matching never applies the dot-namespace exclusions that the rest of the
   CLI treats as invisible, so `[[.trash/deleted-note]]` is importable.

The module header already promises the right thing — "Resolution is fail-closed"
(`src/storage/wikilink.ts:9-10`). This plan makes the code match its own
documented contract, and repairs the one existing test that only appears to
cover escapes.

## Current state

- `src/storage/wikilink.ts` — storage layer; owns all `fs` access. Per
  `agent.md:12`, `src/storage/` is the only layer that touches the filesystem.
- `src/storage/vault-walker.ts` — provides `walkVault` / `relativeVaultPath`,
  and defines what counts as a visible note.
- `test/storage-wikilink.test.ts` — unit tests, real files on disk in a temp
  vault, `node:test` + `node:assert`.

The three problem sites:

```ts
// src/storage/wikilink.ts:121-133 — branch 1
  // 1. Exact vault-relative path match (with or without `.md`)
  const pathCandidates = target.toLowerCase().endsWith('.md') ? [target] : [`${target}.md`, target];
  for (const candidate of pathCandidates) {
    const absoluteCandidate = path.resolve(resolvedVault, candidate);
    if (!fs.existsSync(absoluteCandidate) || !fs.statSync(absoluteCandidate).isFile()) {
      continue;
    }
    const canonical = fs.realpathSync(absoluteCandidate);
    if (!isWithinVault(resolvedVault, canonical)) {
      continue;                       // <-- (2) fails OPEN into branch 3
    }
    return { absolutePath: canonical, relativePath: relativeVaultPath(vaultPath, canonical) };
  }
```

```ts
// src/storage/wikilink.ts:83-91 — the escape predicate; keep as-is
function isWithinVault(resolvedVault: string, absolutePath: string): boolean {
  const rel = path.relative(resolvedVault, absolutePath);
  return (
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !rel.split(path.sep).includes('..')
  );
}
```

The exclusion rule you must mirror, from `src/storage/vault-walker.ts:122-126`:

```ts
      // Skip dot-files and dot-directories (.obsidian, .trash, .git, .hidden.md, etc.)
      if (entry.name.startsWith('.')) {
        continue;
      }
```

`EXCLUDED_DIRS` (`src/storage/vault-walker.ts:14-16`) additionally holds
`node_modules`. So a visible note is: inside the vault, every path segment
non-empty and not starting with `.`, not `node_modules`, and ending in `.md`.
Note `EXCLUDED_DIRS` is **not exported** — check before importing it; if it is
not exported, add an exported predicate in `vault-walker.ts` (Step 2) rather
than copying the set literal.

The vacuous test (`test/storage-wikilink.test.ts:114-120`) — the fixture vault
has no `outside` directory and no file named `outside.md`, so the
`isWithinVault` branch is never reached and this passes for the wrong reason:

```ts
    it('rejects vault-escape targets', () => {
      const index = buildVaultNoteIndex(vaultPath);
      assert.throws(
        () => resolveWikilinkTarget(vaultPath, link('[[../outside]]'), index),
        (err: unknown) => err instanceof UnresolvedWikilinkError
      );
    });
```

Existing error classes to reuse, do not invent new ones
(`src/storage/wikilink.ts:27-53`): `AmbiguousWikilinkError`, and
`UnresolvedWikilinkError(link)` whose message is
`` `Unresolved wikilink [[${link}]]: no matching note in the vault` ``.

## Commands you will need

| Purpose   | Command                                                            | Expected on success |
|-----------|--------------------------------------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                                                 | exit 0, no output   |
| Lint      | `npm run lint`                                                      | exit 0, no output   |
| One file  | `node --import tsx --test test/storage-wikilink.test.ts`            | all pass, 0 fail    |
| Full suite| `node --import tsx --test "test/**/*.test.ts"`                      | `ℹ fail 0`          |

No vitest; tests run on `node:test` + `tsx`. Do not install anything.

## Scope

**In scope** (the only files you should modify):
- `src/storage/wikilink.ts`
- `test/storage-wikilink.test.ts`
- `src/storage/vault-walker.ts` — **only** to export a reusable
  "is this path segment/note visible" predicate, if one does not already exist.

**Out of scope** (do NOT touch, even though they look related):
- `src/cli/roadmap.ts` — the auto-chain interaction is plan 005; the import loop
  is plan 006. Changing both here makes neither reviewable.
- `src/storage/roadmap-parser.ts` — heading scope and format gating is plan 004.
- `src/engine/auto-chain.ts` — the wikilink *regexes* stay as they are; a link
  that parses but does not resolve must fail at this storage boundary instead.
- `isWithinVault`'s logic — it is correct; only its *consequence* changes.
- Symlink-following semantics in `walkVault` — already safe (`followSymlinks` is
  off by default and out-of-vault symlink targets are dropped).

## Git workflow

- Work on the open PR branch `feat/73-auto-chain`.
- Commit style: `fix(storage): fail closed on non-markdown and escaping wikilink targets (#73)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing tests first

In `test/storage-wikilink.test.ts`, extend the `before` fixture
(lines 25-43) with an asset and a dot-namespace note, keeping every existing
fixture file untouched:

```ts
    fs.mkdirSync(path.join(vaultPath, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'assets', 'diagram.png'), 'PNGDATA');
    fs.mkdirSync(path.join(vaultPath, '.trash'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '.trash', 'deleted-note.md'), '# Deleted\n');
    // A real file outside the vault that shares a basename with an in-vault note,
    // so a failed escape check can be observed hijacking to the wrong file.
    fs.writeFileSync(path.join(vaultPath, '..', 'outside-note.md'), '# Outside\n');
```

Note: `vaultPath` is created with `mkdtempSync`, so `path.join(vaultPath, '..',
'outside-note.md')` lands in the OS temp dir, not in the user's tree, and the
existing `after()` `rmSync` on `vaultPath` will not remove it. Create it under a
sibling `mkdtempSync` dir you also `rmSync` in `after()` instead — that keeps
temp hygiene identical to the file's existing pattern.

Add four tests to the `resolveWikilinkTarget` describe block:

1. **Non-markdown rejected** — `resolveWikilinkTarget(vaultPath, link('[[assets/diagram.png]]'), index)`
   throws `UnresolvedWikilinkError`.
2. **Embed syntax rejected** — resolving the link extracted from
   `'- ![[assets/diagram.png]]'` (use `extractWikilinks` from
   `../src/engine/auto-chain`) throws `UnresolvedWikilinkError`.
3. **Dot-namespace rejected** — `link('[[.trash/deleted-note]]')` throws
   `UnresolvedWikilinkError`.
4. **Escape fails closed, not sideways** — create a note whose *basename*
   matches the outside file's basename, then assert that
   `link('../../<tmpdir-basename>/outside-note')` throws
   `UnresolvedWikilinkError` **and specifically does not return** the in-vault
   `outside-note.md`. Assert on the thrown error, not on a returned path.

**Verify**: `node --import tsx --test test/storage-wikilink.test.ts`
→ expected: tests 1-4 **FAIL** (1-3 currently resolve to the real file; 4
currently resolves to the in-vault namesake). If they already pass, STOP.

### Step 2: Add a shared note-visibility predicate

In `src/storage/vault-walker.ts`, add and export one predicate that answers
"may a wikilink resolve to this vault-relative path?", so the rule lives in the
layer that already owns vault visibility:

- input: a vault-relative POSIX path (`'MODULES/01-a.md'`, `'.trash/x.md'`)
- true only when: it ends in `.md` (case-insensitive), no `/`-separated segment
  is empty or starts with `.`, and no segment is in `EXCLUDED_DIRS`.

Document it with a one-line JSDoc matching the file's style, and reference
`walkVault`'s exclusion list so the two stay together in review. If
`walkVault` already exposes an equivalent predicate, reuse it instead of adding
one and note that in your commit message.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Make branch 1 markdown-only and fail closed

In `src/storage/wikilink.ts`, replace lines 121-133 with logic that:

- drops the bare candidate: `const pathCandidates = target.toLowerCase().endsWith('.md') ? [target] : [`${target}.md`];`
- keeps the `existsSync` / `isFile` / `realpathSync` sequence unchanged
- on `!isWithinVault(...)`, **throws** `new UnresolvedWikilinkError(target)`
  rather than `continue`
- after the vault check, applies the Step 2 predicate to
  `relativeVaultPath(vaultPath, canonical)` and throws
  `UnresolvedWikilinkError(target)` when it is not a visible note

Add a short comment above `pathCandidates` stating *why* only `.md` is a valid
candidate — the roadmap importer writes YAML frontmatter into whatever this
returns, so a non-Markdown match destroys the file. That is a hidden invariant
and belongs in a comment.

Also update the module `@remarks` block (lines 9-14) so the fail-closed claim
mentions that escapes and non-Markdown targets are rejected rather than skipped.

**Verify**: `node --import tsx --test test/storage-wikilink.test.ts` → all pass,
including the 4 new tests and the pre-existing `rejects vault-escape targets`.

### Step 4: Repair the vacuous escape test

Rewrite the pre-existing `it('rejects vault-escape targets', ...)` at
`test/storage-wikilink.test.ts:114` so its fixture genuinely contains a real
file outside the vault **and** a basename-matching file inside it, and assert
the thrown error type. The current version passes without ever reaching
`isWithinVault`; leaving it means Step 3's central guarantee has no test.

**Verify**: `node --import tsx --test test/storage-wikilink.test.ts` → all pass.

### Step 5: Full gates

**Verify**: `npm run typecheck` → exit 0 · `npm run lint` → exit 0 ·
`node --import tsx --test "test/**/*.test.ts"` → `ℹ fail 0`.

If `test/cli-roadmap-wikilink.test.ts` fails, check whether it linked a
non-`.md` path or relied on the old fall-through before changing anything —
STOP and report if it did.

## Test plan

- 4 new tests in `test/storage-wikilink.test.ts` (Step 1) + the repaired escape
  test (Step 4), modelled on the existing `it(...)` blocks in the
  `resolveWikilinkTarget` describe (lines 84-121), which already use
  `assert.throws` with an error-type predicate and assert `.link` on the error.
- Fixture files are real on disk (`fs.writeFileSync` in `before`, lines 26-43),
  so `assets/diagram.png` and `.trash/deleted-note.md` are directly resolvable
  and the tests exercise the actual bug.
- Verification: `node --import tsx --test test/storage-wikilink.test.ts` → all
  pass, including 4 new.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `node --import tsx --test "test/**/*.test.ts"` reports `ℹ fail 0`
- [ ] `grep -n '`${target}.md`, target' src/storage/wikilink.ts` returns **no** match (bare candidate removed)
- [ ] `grep -n "isWithinVault" src/storage/wikilink.ts` shows a `throw` on the failure path, not a `continue`
- [ ] The non-markdown, embed, dot-namespace and escape-hijack tests exist and pass
- [ ] `git diff --name-only` lists only `src/storage/wikilink.ts`, `test/storage-wikilink.test.ts`, and (if the predicate was added) `src/storage/vault-walker.ts`
- [ ] `plans/README.md` status row for 002 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's tests already pass — you would be "fixing" a non-defect.
- Adding the `.md` restriction breaks a **pre-existing passing** test other than
  the ones named here. Do not delete or weaken that test; report it, because it
  means something legitimately resolved to a non-`.md` path.
- `EXCLUDED_DIRS` cannot be reused without exporting it and you judge that
  change too invasive — report instead of duplicating the literal set, which is
  the drift this plan is meant to avoid.
- The vault-relative path handed to the Step 2 predicate is not POSIX-separated
  on Windows. `relativeVaultPath` normalizes to `/`; if you observe `\`, STOP —
  that is a separate defect and this plan's segment checks assume `/`.
- You find the roadmap importer writes to a path that did **not** come from
  `resolveWikilinkTarget` — then the corruption route is elsewhere and this plan
  does not close it.

## Maintenance notes

- After this, `resolveWikilinkTarget` is the single choke point for "which file
  may a wikilink touch". Any future resolver (e.g. link-based `adopt`, or a
  Phase-2 AI feature) must go through it, not re-implement candidate building.
- Reviewer should scrutinize: that the escape case throws **before** the
  basename lookup (the whole point), and that a legitimate relative link such as
  `[[MODULES/01-foundations/01-systems]]` still resolves — the existing tests
  cover that, so a false rejection shows up immediately.
- Case-insensitive filesystems (CI runs `windows-latest`) remain a known
  limitation: branch 1 can match a differently-cased in-vault file on NTFS that
  branch 2 would not pick on Linux. Not addressed here and not made worse;
  tracked as a follow-up in `plans/README.md`.
