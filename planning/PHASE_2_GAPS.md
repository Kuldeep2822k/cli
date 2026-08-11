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

## Priority Order

1. **Batch adopt** — Biggest onboarding blocker. Users can't start easily.
2. **Roadmap `.md` support** — Design intent was `.md`; current YAML-only is a bug.
3. **README cleanup** — Remove or stub unimplemented commands.
4. **Beginner's guide** — Helps adoption after the above are fixed.
5. **`test` / `tutor` commands** — Phase 2 AI features, implement after provider layer is solid.
