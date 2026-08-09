# PALEE Session Memory Design

## Purpose

PALEE should continue a learning conversation without requiring the learner to restate the previous session. If the learner was studying Git and stopped during rebase conflict resolution, the next session should begin from that position rather than restarting with Git fundamentals.

Obsidian remains the source of truth. Session memory is ordinary Markdown with YAML frontmatter, stored in the connected vault.

## Storage Layout

```text
.palee/
├── hot.md
├── sessions/
│   ├── S-20260808-180000-a1b2.md
│   └── S-20260808-181500-c3d4.md
└── index.md
```

- `hot.md` is the compact working memory loaded at session start.
- `sessions/` contains one durable note per confirmed session.
- `index.md` links sessions and supports human browsing; it is rebuildable.

`sessions/` is the canonical session history. `hot.md` and `index.md` are derived views and may always be regenerated from the session records. A failed hot/index write must never invalidate or overwrite a saved session.

The system must not depend on an ever-growing single log file. Individual notes are easier to search, migrate, inspect, and recover with Git.

## Stable Addresses

IDs are immutable references, not descriptions:

| Prefix | Meaning | Example |
|--------|---------|---------|
| `T-` | Topic | `T-git-rebase` |
| `S-` | Learning session | `S-20260808-180000-a1b2` |
| `H-` | Hot-memory singleton | `H-active` |

All new IDs use an entity prefix, a stable slug or timestamp, and a short collision suffix where needed. Topic IDs are stored as `palee_id: T-git-rebase`; legacy IDs such as `git_rebase` may be read as migration aliases but must not be generated for new notes. IDs must be unique and must not be regenerated when a note is renamed.

## Hot Memory Contract

`hot.md` must contain no more than 250 words in its human-readable **body** (the Markdown content below the closing `---` of the frontmatter). The YAML frontmatter block itself is excluded from the word count. Its purpose is orientation, not complete history.

```yaml
---
palee_schema: 1
memory_id: H-active
last_session: S-20260808-180000-a1b2
active_topic: T-git-rebase
updated_at: 2026-08-08
---

We are learning Git. We reached interactive rebase. The learner understands
that rebase reapplies commits onto a new base but is still unclear about
conflict resolution and when to use --force-with-lease.

Next action: resolve one rebase conflict, inspect the commit graph, then
compare rebase with merge.

Source: [[S-20260808-180000-a1b2]]
```

The `updated_at` field in hot.md frontmatter uses `YYYY-MM-DD` (date only, no time or timezone). It records which calendar day the hot file was last regenerated — sub-day precision is not needed because hot.md is always regenerated from the most recent confirmed session, and the session record carries the full ISO-8601 timestamp. If two confirmed sessions occur on the same day, the later session's ID becomes `last_session` and replaces the earlier one.

## Session Record

```yaml
---
palee_schema: 1
session_id: S-20260808-180000-a1b2
topic_id: T-git-rebase
started_at: 2026-08-08T18:00:00+05:30
ended_at: 2026-08-08T18:45:00+05:30
status: completed
---
```

The body should record:

- topics covered
- what the learner demonstrated
- explanations or exercises completed
- remaining confusion
- the next recommended action
- references to topic notes

The session summary may be drafted by AI, but the learner confirms it before it becomes durable memory. Uncertain or invented context must never be written as fact.

During an active session, PALEE writes a checkpoint draft after each meaningful learner exchange or tool result. Drafts use `DRAFT-S-...` IDs and are never treated as confirmed history. On normal session end, the confirmed session replaces the draft. On crash or forced termination, the draft remains available for recovery.

## Lifecycle

1. `palee session start` reads `hot.md`; if it is missing or invalid, PALEE rebuilds it from the newest confirmed session.
2. The session manager loads the referenced full session only when needed.
3. The learner and tutor continue from `next_action`.
4. PALEE writes checkpoint drafts during the session.
5. `palee session end` drafts a summary.
6. The learner confirms or edits the summary.
7. PALEE writes the canonical session note atomically.
8. PALEE regenerates `index.md` and `hot.md` as derived views under the 250-word limit.

When startup finds a draft, interactive mode offers `Resume`, `Save as session`, `Discard`, or `Ignore`. Non-interactive mode never discards it automatically.

## Retrieval Rules

The AI receives `hot.md` by default. It may request a specific session by ID, but it must not receive the entire session directory automatically. This keeps prompts small and makes continuity predictable.

## Failure Handling

If `hot.md` is missing or invalid, PALEE should rebuild it from the newest confirmed session. If no session exists, it should start with the active topic note. A corrupt hot file must never cause PALEE to overwrite session history.

All session and view writes use the same conflict-aware atomic write contract as topic notes. If a view cannot be regenerated, PALEE reports the issue while preserving the canonical session record.
