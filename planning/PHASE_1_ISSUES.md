# Phase 1 — Non-AI Issues

Discovered during code review on 2026-08-12. These are bugs, spec gaps, and polish items in the existing Phase 1 deterministic codebase.

---

## 1. `--json` Flag Not Implemented

### Problem

The invariant (`invariants.md` line 45) requires:

> `--json` and non-TTY output contain no ANSI control sequences.

No command accepts a `--json` flag. None of the command definitions in `bin/palee.ts` include `.option('--json', ...)`.

### Impact

- **Scripting blocked**: Users who want to integrate PALEE into scripts or CI pipelines must parse human-readable text output — fragile and breaks if formatting changes.
- **Piped output**: When stdout is piped (e.g., `palee progress | grep mastery`), output should strip any formatting. Currently no ANSI codes are used (no `chalk` dependency), so no visible bug — but the spec item is unimplemented.

### Example

```bash
# What should work:
$ palee progress --json
{"total": 5, "mastered": 2, "learning": 2, "new": 1, "avg_mastery": 0.42}

# What actually happens:
$ palee progress --json
error: unknown option '--json'
```

### Fix

Add `--json` option to commands that produce output: `next`, `plan`, `progress`, `dashboard`, `validate`, `session list`. When active, output a single JSON object to stdout with no decoration.

### Severity: 🟡 Medium

---

## 2. No Topic Resolution System

### Problem

The invariant (`invariants.md` line 42) specifies:

> Resolution precedence is exact ID, exact title/filename, legacy alias, normalized slug, then token-distance match.

The actual resolution in `src/cli/review.ts:50-53`:

```typescript
if (id === topicQuery || id.includes(topicQuery) ||
    title.toLowerCase().includes(topicQuery.toLowerCase())) {
  candidates.push({ ... });
}
```

This is a simple substring match — no precedence order, no slug normalization, no token-distance.

### Impact

1. **False multi-matches**: `palee review docker 4` matches `T-docker-fundamentals`, `T-docker-networking`, and `T-docker-volumes` because all IDs contain "docker". Command errors with "Multiple topics match."
2. **No smart resolution**: No slug normalization or fuzzy matching.
3. **Inconsistent**: `review` and `progress --topic` have substring logic; `next`, `plan`, `dashboard` don't support topic queries at all.

### Example

```bash
# User has: T-docker-fundamentals, T-docker-networking, T-docker-volumes

$ palee review docker 4
Error: Multiple topics match "docker":
  - T-docker-fundamentals: Docker Fundamentals
  - T-docker-networking: Docker Networking
  - T-docker-volumes: Docker Volumes
Please provide a more specific query.
```

### Fix

Create a shared `resolveTopic()` utility in `src/engine/` with the spec'd precedence chain. Use it in every command that accepts a topic argument.

### Severity: 🟡 Medium

---

## 3. `plan` / `dashboard` Show Ugly Empty State

### Problem

When there are zero topics in the vault, `palee plan` outputs ~20 blank lines followed by all-zero stats. `palee dashboard` has the same issue.

### Impact

- Bad first impression for new users who run `palee plan` before adopting any notes.
- No guidance on what to do next.

### Example

```
=== Today's Learning Plan ===

(20 blank lines)

Reviews Due: 0

Ready to Learn: 0

Progress Summary:
  Total Topics: 0
  Mastered (≥70%): 0
  Learning: 0
  New: 0
```

### Fix

Detect zero topics early and print a helpful message:

```
No topics found in vault.

To get started:
  palee adopt "your-note.md"        # Track a single note
  palee roadmap --from roadmap.md   # Import a learning roadmap
```

Apply same pattern to `dashboard`, `progress`, and `next`.

### Severity: 🟢 Low

---

## 4. `dashboard` Division by Zero Risk

### Problem

In `src/cli/dashboard.ts:72-74`:

```typescript
console.log(`Mastered (≥70%):   ${mastered} (${(mastered / total * 100 || 0).toFixed(1)}%)`);
```

When `total` is `0`: `mastered / 0 * 100` = `NaN`, then `NaN || 0` = `0`. Works by accident because `NaN` is falsy in JavaScript.

The `progress` command (`src/cli/progress.ts:96`) handles this correctly with explicit `total > 0` checks.

### Impact

- Currently no visible bug — output shows `0.0%`
- But the code is fragile — any refactor that removes the `|| 0` would print `NaN%`

### Fix

```typescript
const pct = total > 0 ? (mastered / total * 100).toFixed(1) : '0.0';
```

### Severity: 🟢 Low

---

## 5. `difficulty` Type Mismatch Between Spec and Code

### Problem

In `src/types.ts:27`:

```typescript
export interface Topic {
  difficulty: number;  // ← defined as number (1-5)
}
```

But everywhere in the CLI, difficulty is treated as a string:

- `adopt.ts:54`: `['beginner', 'intermediate', 'advanced']`
- `plan.ts:99`: `{ beginner: 0, intermediate: 1, advanced: 2 }`
- `roadmap.ts:81`: `['beginner', 'intermediate', 'advanced'].includes(difficulty)`
- `dashboard.ts:81`: `t.difficulty === 'beginner'`

The `roadmap_design.md` says `"difficulty": 2` (integer 1-5), while all CLI code uses string labels.

### Impact

- No runtime error (TypeScript types are erased, and CLI code uses local interfaces not `Topic`).
- But the `Topic` type is misleading for anyone writing new code.
- Conflicting standards between design docs and implementation.

### Fix

Decide on one standard:
- **Option A**: Change `Topic.difficulty` to `'beginner' | 'intermediate' | 'advanced'` (match the CLI).
- **Option B**: Map strings to numbers everywhere (match the design doc).

Option A is simpler — it matches what's actually in the frontmatter files.

### Severity: 🟢 Low

---

## 6. `session end` Defaults to Phantom Topic `T-general`

### Problem

In `src/cli/session.ts:121`:

```typescript
const topicId = options.topic || 'T-general';
```

If you run `palee session end` without `--topic`, it creates a session for `T-general` — a topic that doesn't exist in anyone's vault.

### Impact

- Session records accumulate with `topic_id: T-general` — meaningless metadata.
- `hot.md` references `T-general` as active topic.
- No error shown — user thinks session was recorded properly.
- Sessions for `T-general` become orphaned data that can't be correlated with real topics.

### Fix

Either:
- **Require `--topic`**: Print error if not provided.
- **Prompt for topic**: List available topics and ask user to pick one.
- **Use last active topic**: Read from `hot.md` and default to whatever was active.

### Severity: 🟢 Low

---

## 7. `adopt` Doesn't Set a `title` Field

### Problem

`src/cli/adopt.ts:64-82` writes `palee_id`, `difficulty`, `depends_on`, and SM-2 fields — but **no `title` field**.

Compare with `roadmap.ts:219` which does set `title: topic.title`.

### Impact

- Commands fall back to filename via `path.basename(filePath, '.md')` for display.
- Filenames can be ugly: `docker-fundamentals` instead of `Docker Fundamentals`.
- If user renames file, the displayed title changes — no stable title.
- Inconsistency: roadmap-imported topics have `title`, adopted topics don't.

### Fix

Derive title from:
1. First `# heading` in the markdown body (best), or
2. Clean up the filename (capitalize, replace hyphens with spaces), or
3. Accept `--title` flag on `palee adopt`

### Severity: 🟢 Low

---

## 8. `validate --fix` Is a No-Op

### Problem

The `--fix` flag is accepted (`bin/palee.ts:78`) but the implementation (`src/cli/validate.ts:88-90`) just prints:

```
Note: --fix is not implemented in Phase 1
```

### Impact

- User discovers issues via `palee validate`, tries `--fix`, gets told it doesn't work.
- Has to manually fix frontmatter themselves.

### Fix

Either:
- **Implement basic fixes** (remove duplicate IDs, fix broken dependency refs).
- **Remove the flag** until it's implemented (avoid false expectations).
- **Keep as-is** with clear "Phase 2" labeling (current approach, acceptable).

### Severity: 🟢 Low — Expected for Phase 1

---

## Summary

| # | Issue | Severity | Fix Effort |
|---|-------|----------|------------|
| 1 | `--json` not implemented | 🟡 Medium | Medium |
| 2 | No topic resolution system | 🟡 Medium | High |
| 3 | Ugly empty state in `plan`/`dashboard` | 🟢 Low | Low |
| 4 | Dashboard division by zero | 🟢 Low | Low |
| 5 | `difficulty` type mismatch | 🟢 Low | Low |
| 6 | `session end` defaults to `T-general` | 🟢 Low | Low |
| 7 | `adopt` doesn't set `title` | 🟢 Low | Low |
| 8 | `validate --fix` is a no-op | 🟢 Low | N/A |
