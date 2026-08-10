# PALEE CLI

A smart, AI-powered study tracker that optimizes learning with spaced repetition and dependency-aware recommendations.

## Overview

PALEE helps you learn efficiently by:
- Recommending what to study next based on dependencies and SM-2 scheduling
- Tracking mastery across conceptual, practical, debug, and teaching dimensions
- Scheduling reviews using scientifically-proven spaced repetition
- Integrating natively with Obsidian notes
- Providing AI-powered Feynman testing
- Remembering learning context between sessions through durable session logs and a compact hot-memory file

## Quick Start

### Installation
```bash
npm install -g @kuldeep2822k/palee
```

### Connect to Your Obsidian Vault
```bash
palee config set-vault ~/Documents/Obsidian/Learning
```

### Configure Free AI (Optional)
```bash
palee config set-provider
# base_url: https://opencode.ai/zen/v1
# api_key: YOUR_FREE_TIER_KEY
# model: nemotron-3-ultra-free
```

### Start Learning
```bash
# See what to study next
palee next

# Build a study session
palee plan --limit 3

# Track your progress
palee progress
```

## Key Features

### Smart Recommendations
- **Dependency-aware**: Never study topics before prerequisites
- **Spaced repetition**: Reviews scheduled using SM-2 algorithm
- **Unlock-based scoring**: Topics scored by how many they unlock

### Obsidian Integration
- **Native vault support**: Works directly with your existing notes
- **Frontmatter metadata**: Study data stored in note frontmatter
- **Zero duplication**: Vault IS the data store

### AI-Powered Testing
- **Feynman method**: AI tests your ability to explain concepts
- **Multi-dimensional grading**: Conceptual, practical, debug, teaching scores
- **Tool-constrained**: AI receives read-only validated context tools; PALEE owns confirmed writes

### Progress Tracking
- **Mastery visualization**: Track mastery across all topics
- **Review scheduling**: Never miss a review
- **Track analytics**: See your learning patterns

### Session Continuity
- **Durable session logs**: Every confirmed session is saved as a searchable Obsidian note
- **Hot memory**: The next session starts with a concise summary of the current learning position
- **Stable references**: Topics, sessions, and durable decisions use immutable IDs

## Example Workflow

```bash
# 1. Adopt your existing notes
palee adopt "Docker Fundamentals.md"

# 2. See what to learn next
palee next
# → Learn: Pod Lifecycle in Kubernetes

# 3. Test your understanding
palee test T-pod-lifecycle-k8s
# → AI asks you to explain the concept
# → You write your answer
# → AI grades and suggests scores
# → You confirm and record mastery

# 4. Track progress
palee progress
# → 23.45% overall mastery
```

## Commands

| Command | Description |
|---------|-------------|
| `palee next` | Show next recommended action |
| `palee plan [--limit N]` | Build study session plan |
| `palee progress` | View mastery statistics |
| `palee test <topic>` | AI-powered Feynman test |
| `palee tutor <topic>` | Interactive tutoring session |
| `palee review <topic> --quality N` | Record review result (0-5) |
| `palee session start` | Resume learning from hot memory; starts AI tutor if provider is configured |
| `palee session end` | Save a confirmed session summary and refresh hot memory |
| `palee migrate` | Upgrade versioned PALEE data safely |
| `palee adopt <note>` | Adopt Obsidian note into PALEE |
| `palee roadmap --from <file>` | Validate and import a user-provided roadmap (no AI, no network) |
| `palee roadmap` | Build a personalized roadmap through a guided AI interview |
| `palee dashboard` | Show system status |
| `palee validate` | Check data integrity |
| `palee config set-vault <path>` | Set the Obsidian vault path |
| `palee config set-provider` | Configure AI provider (base_url, api_key, model) |
| `palee config show` | Display current config — vault path, provider endpoint, model; never prints api_key |

## Configuration

### Provider Setup
```bash
palee config set-provider
# Supports any OpenAI-compatible endpoint
# Recommended free option: OpenCode Zen
```

### Vault Connection
```bash
palee config set-vault /path/to/obsidian/vault
# PALEE will scan for notes with frontmatter
```

## Data Model

Each topic is tracked with:
```yaml
---
palee_schema: 1
palee_id: T-docker-volumes
topic: Docker Volumes
track: devops
status: learning
difficulty: 2
dependencies:
  - T-docker-basics
assessment:
  conceptual: 0.85
  practical: 0.70
  debug: 0.60
  feynman: 0.75
  assessed_at: 2026-01-15
review:
  interval_days: 6
  repetition: 1
  ease_factor: 2.36
  lapses: 0
  last_quality: 4
  last_reviewed_at: 2026-01-15
  due_at: 2026-01-21
---
```

`assessment` measures understanding and is independent from `review`, which records recall quality for SM-2 scheduling. PALEE uses `not_started`, `learning`, `paused`, and `archived` as operational statuses; mastery is derived from assessment scores rather than stored as an ambiguous `completed` status.

Session memory is stored inside the connected vault:

```text
.palee/
├── hot.md
├── sessions/
└── index.md
```

`hot.md` is capped at 250 words and points to the latest full session. Full session notes preserve the learning history without forcing every future AI prompt to load the entire log.

See [memory_design.md](memory_design.md) for the session-memory format, lifecycle, stable IDs, and recovery rules.

See [storage_design.md](storage_design.md) for frontmatter preservation, atomic writes, vault traversal, validation, and cache behavior.

See [invariants.md](invariants.md) for the acceptance-test blueprint that must pass before Phase 1 is considered complete.

See [roadmap_design.md](roadmap_design.md) for the imported-roadmap and guided personalized-roadmap contracts.

## Philosophy

PALEE is built on three principles:
1. **Deterministic core**: Reliable SM-2 scheduling and dependency tracking
2. **AI augmentation**: Intelligent tutoring constrained to validated actions
3. **Human oversight**: You confirm all consequential actions

## Exit Codes

PALEE uses standard exit codes to facilitate scripting:
- `0`: Success
- `2`: Usage error (e.g., missing argument, unconfigured vault)
- `3`: Validation error (e.g., malformed roadmap, invalid dependency)
- `4`: Optimistic concurrency conflict (file was modified by another process)
- `5`: Unexpected error (e.g., Node.js exception)

## Windows Notes

- **Path Normalization**: PALEE natively handles both forward slashes (`/`) and backslashes (`\`) for vault configuration and file references.
- **Lock Timeouts**: On Windows, file locks become stale after 60 seconds (vs 120s on Unix) to accommodate aggressive process termination without `finally` blocks executing.
- **Config Storage**: The config file on Windows is stored in `%LOCALAPPDATA%\palee\config.json`.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

Detailed contribution guidelines will be added with the implementation source.

## License

Planned license: MIT. The license file will be added before distribution.
