# Phase 2 — Gaps & Design Decisions

Captured from design review on 2026-08-11.

---

## 1. Roadmap: Support `.md` Instead of YAML-Only

### Problem

`palee roadmap --from` currently only accepts `.yaml` files (`yaml.parse()` on the whole file). But:

- The design spec (`roadmap_design.md` line 10) shows `kubernetes-roadmap.md` as the example — `.md` was the original intent.
- PALEE is an Obsidian-native tool; `.yaml` files are invisible/ugly in Obsidian.
- Users shouldn't have to maintain a separate `.yaml` file when the roadmap could live as a first-class `.md` note in the vault.
- A `.md` roadmap can include user notes, context, and links alongside the structured data.

### Proposed Design

The roadmap `.md` file uses frontmatter for structured data:

```markdown
---
roadmap_id: R-kubernetes
topics:
  - id: T-pod-lifecycle
    title: Pod Lifecycle
    difficulty: beginner
    depends_on: [T-k8s-basics]
    path: kubernetes/pod-lifecycle.md
  - id: T-k8s-basics
    title: Kubernetes Basics
    difficulty: beginner
    path: kubernetes/k8s-basics.md
---

# Kubernetes Roadmap

My notes about this learning path...
```

### Engine Safety

The roadmap file uses `roadmap_id` (not `palee_id`), so the engine naturally ignores it:

| Command     | Filters on    | Sees roadmap file? |
|-------------|---------------|--------------------|
| `next`      | `palee_id`    | ❌ Skipped          |
| `plan`      | `palee_id`    | ❌ Skipped          |
| `progress`  | `palee_id`    | ❌ Skipped          |
| `review`    | topic ID match| ❌ No match         |
| `dashboard` | `palee_id`    | ❌ Skipped          |
| `validate`  | `palee_id`    | ❌ Skipped          |

No quality regression. Zero risk to the existing engine.

### Implementation Notes

- Detect file extension: `.yaml`/`.yml` → `yaml.parse(wholeFile)` (keep as fallback), `.md` → `parseFrontmatter()` then read `topics` from frontmatter.
- We already have `parseFrontmatter()` in the codebase — reuse it.
- Update README examples to show `.md` as the primary format.

---

## 2. Batch Adopt — The Onboarding Gap

### Problem

A beginner copies a complete DevOps guide (50+ markdown files) into their Obsidian vault. To start using PALEE, they must either:

1. Run `palee adopt "note.md"` **one file at a time** — tedious for 50 files.
2. Manually create a roadmap file listing every topic — redundant since the notes already exist.

Neither is acceptable for the "I just dropped my notes in, now help me learn" use case.

### Proposed Solution

Add batch adopt support:

```bash
# Adopt all .md files in vault that don't already have palee_id
palee adopt --all

# Adopt all .md files in a specific folder
palee adopt --dir "devops/"

# Preview what would be adopted (dry run)
palee adopt --all --dry-run
```

### Auto-ID Generation

When batch-adopting, auto-generate `palee_id` from the filename:

| File                      | Generated `palee_id`        |
|---------------------------|-----------------------------|
| `Docker Fundamentals.md`  | `T-docker-fundamentals`     |
| `Pod Lifecycle.md`        | `T-pod-lifecycle`           |
| `K8s Networking Deep Dive.md` | `T-k8s-networking-deep-dive` |

Rule: `T-` prefix + lowercase + spaces/special chars → hyphens. Collision check against existing IDs.

### Behavior

- Only adopts `.md` files that do NOT already have `palee_id` in frontmatter.
- Injects PALEE tracking fields directly into the note's frontmatter (same as single `adopt`).
- Shows summary: "Found 50 notes, adopted 47 (3 already tracked)."
- Respects vault boundary checks (no symlink escapes).

---

## 3. Missing Commands — `test` and `tutor`

### Problem

The README lists `palee test <topic>` and `palee tutor <topic>` as available commands, but:

- No `test.ts` or `tutor.ts` exists in `src/cli/`.
- No command is registered in `bin/palee.ts`.
- These are Phase 2 AI-dependent features.

### Status

| Command               | AI Required? | Status             |
|-----------------------|-------------|---------------------|
| `palee test <topic>`  | ✅ Yes       | ❌ Not implemented   |
| `palee tutor <topic>` | ✅ Yes       | ❌ Not implemented   |

### Decision Needed

Either:
- **Remove from README** until implemented (avoid false advertising).
- **Add stub commands** that print "Coming in Phase 2. Configure AI provider with `palee config set-provider` to prepare."

### How Testing Works (Design Intent)

When `palee test` is implemented:

1. Reads the **existing topic note** for context (the note IS the study material).
2. AI asks Feynman-method questions based on note content.
3. User explains concepts in their own words.
4. AI grades across 4 dimensions: conceptual, practical, debug, feynman.
5. Scores are written back **into the same note's frontmatter** — no separate test files.
6. SM-2 review scheduling is updated based on results.

---

## 4. Guided Roadmap (`palee roadmap` Without `--from`)

### Status

Running `palee roadmap` without `--from` currently prints:

```
Error: Phase 1 only supports --from <file>
```

This is the AI-powered interview mode described in `roadmap_design.md`. It requires an AI provider and is a Phase 2 feature.

---

## 5. Beginner's Quick Guide

### Problem

No dedicated beginner walkthrough exists. The README has a "Quick Start" section but it's more reference than tutorial.

### Proposal

Create a `GUIDE.md` at the repo root (or `docs/beginners-guide.md`) covering:

1. What is PALEE (one-paragraph intro)
2. Prerequisites (Node.js, Obsidian vault)
3. Installation step-by-step
4. First-time setup (set-vault, set-provider)
5. Your first study session (adopt a note → `next` → `review` → `progress`)
6. Understanding the output (mastery scores, SM-2 scheduling)
7. Common commands cheat sheet
8. Troubleshooting / FAQ

---

## 6. `config set-provider` Is Broken — Blocks All AI Features

### Problem

The README shows an interactive prompt flow:

```bash
palee config set-provider
# base_url: https://opencode.ai/zen/v1
# api_key: YOUR_FREE_TIER_KEY
# model: nemotron-3-ultra-free
```

But the actual implementation (`src/cli/config.ts:86-97`) takes a single string argument and stores it as `aiProvider`. There's no prompt, no `base_url`, no `api_key` storage.

The `PaleeConfig` type (`src/types.ts:76-80`) only has:

```typescript
interface PaleeConfig {
  vaultPath?: string;
  aiProvider?: string;  // Just a single string
  model?: string;
}
```

No `apiKey`, no `baseUrl` field exists.

### Impact

- User follows README → gets `Error: provider name required` — confusing
- No way to store API credentials → all Phase 2 AI commands will have no credentials to use
- `palee test`, `palee tutor`, guided roadmap — all blocked

### Fix Required

- Add `baseUrl` and `apiKey` to `PaleeConfig`
- Make `set-provider` an interactive prompt (or accept 3 arguments)
- Store `apiKey` in the config file
- Update `config show` to explicitly redact `api_key` (invariant: "config show never prints api_key")

---

## 7. `config show` — No `api_key` Redaction (Because None Exists)

### Problem

The invariant says: "`config show` never prints `api_key`."

The implementation doesn't print one — but only because the `api_key` field doesn't exist at all. The invariant passes vacuously.

### Impact

When `api_key` is added (to fix issue #6), someone could accidentally print it if redaction isn't explicitly implemented.

### Fix Required

Fix together with issue #6 — when adding `apiKey` to config, add explicit redaction:

```typescript
console.log(`  API Key: ${config.apiKey ? '••••••••' : '(not set)'}`);
```

---

## 8. Mastery Scores Depend on AI Testing — No Phase 1 Workaround

### Problem

Topic mastery is computed from 4 assessment scores: `conceptual`, `practical`, `debug`, `feynman`. These are meant to be set by `palee test` (AI Feynman testing), which doesn't exist yet.

Meanwhile, `palee review` only updates SM-2 scheduling fields (`ease_factor`, `interval_days`, `repetition`) but never touches mastery. Result: **users review topics but mastery stays at 0% forever**.

```bash
$ palee review T-docker 5    # Perfect review!
$ palee progress
  Mastery: 0.0%               # Still zero — demoralizing
```

### Design Intent

The design separates "review" (recall scheduling) from "assessment" (understanding depth). This is correct architecturally, but leaves Phase 1 with **no visible progress feedback**.

### Options

1. **Phase 1 stopgap**: Let `review` update a rough mastery estimate from quality scores (e.g., `topic_mastery = avg(last_N_qualities) / 5`). Not spec-accurate but gives users feedback.
2. **Accept the gap**: Document that mastery requires AI provider. Add a note in `progress` output: "Mastery scores require AI testing (`palee test`). Currently showing review-only data."
3. **Wait for Phase 2**: Implement `palee test` first, which properly sets assessment scores and triggers mastery computation.

### Missing Code

No `computeTopicMastery()` function exists anywhere in the codebase. Even when `palee test` is built, someone will need to implement the formula: `round((conceptual + practical + debug + (feynman * 2)) / 5, 4)`.

---

## Priority Order

1. **Batch adopt** — Biggest onboarding blocker. Users can't start easily.
2. **Roadmap `.md` support** — Design intent was `.md`; current YAML-only is a bug.
3. **README cleanup** — Remove or stub unimplemented commands.
4. **Beginner's guide** — Helps adoption after the above are fixed.
5. **`test` / `tutor` commands** — Phase 2 AI features, implement after provider layer is solid.
