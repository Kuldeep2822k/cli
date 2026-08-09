# PALEE CLI Example Workflows

## 1. Initial Setup

### Configure AI Provider
```bash
# Set up free tier provider (e.g., OpenCode Zen)
palee config set-provider
# Enter base_url: https://opencode.ai/zen/v1
# Enter api_key: sk-... (your key)
# Enter model: nemotron-3-ultra-free
```

### Point to Obsidian Vault
```bash
# Connect PALEE to your existing Obsidian vault
palee config set-vault ~/Documents/Obsidian/Learning
```

## 2. Adopting Existing Notes

### Adopt a Single Note
```bash
# Adopt an existing Obsidian note into PALEE
palee adopt "Docker Fundamentals.md"

# PALEE adds frontmatter to the note:
# ---
# palee_schema: 1
# palee_id: T-docker-fundamentals
# topic: Docker Fundamentals
# track: devops
# status: not_started
# difficulty: 2
# dependencies: []
# assessment:
#   conceptual: 0.0
#   practical: 0.0
#   debug: 0.0
#   feynman: 0.0
#   assessed_at: null
# review:
#   interval_days: 1
#   repetition: 0
#   ease_factor: 2.5
#   lapses: 0
#   last_quality: null
#   last_reviewed_at: null
#   due_at: null
# ---
```

### Use or Generate a Personalized Roadmap
```bash
# Use a roadmap the learner already has
palee roadmap --from kubernetes-roadmap.md

# If no roadmap is available, start a guided interview
palee roadmap
```

When generating a roadmap, PALEE asks about the learning goal, current level,
available time, target date, preferred practice style, and constraints. AI then
proposes a learner-specific topic graph. The learner confirms the proposal
before PALEE creates or updates topic notes.

## 3. Daily Study Workflow

### See What to Learn Next
```bash
# Get today's recommended action
palee next

# Output:
# ==================================================
# NEXT ACTION
# ==================================================
# TYPE               : LEARN
# TOPIC              : Pod Lifecycle in Kubernetes
# TOPIC ID           : T-pod-lifecycle-k8s
# TRACK              : devops
# REASON             : Ready to learn; unlocks 3 downstream topic(s)
# ==================================================
```

### Build a Study Session
```bash
# Plan a focused study session
palee plan --limit 3

# Output:
# ==================================================
# SESSION PLAN
# ==================================================
# 1. [learn] Pod Lifecycle in Kubernetes (T-pod-lifecycle-k8s)
#    Reason: Ready to learn; unlocks 3 downstream topic(s)
# 2. [review] Docker Volumes (T-docker-volumes)
#    Reason: Due (Int: 6d, Lapses: 0)
# 3. [learn] Service Discovery (T-service-discovery-k8s)
#    Reason: Ready to learn; unlocks 2 downstream topic(s)
# ==================================================
```

### Track Overall Progress
```bash
# View mastery statistics
palee progress

# Output:
# ============================================================
# PALEE SYSTEM ANALYTICS | Nodes Scanned: 42
# ============================================================
# SYSTEM MASTERY SCORE: 23.45%
# [██████████------------------------------]
#
# TRACK BREAKDOWN:
# - DEVOPS     : 28.7% (25 nodes)
# - CPP        : 15.2% (17 nodes)
# ============================================================
```

## 4. Session Continuity

### Resume Previous Learning

```bash
# Start a context-aware session
palee session start
```

PALEE reads `.palee/hot.md` first. For example, it may show:

```text
Continuing: Git rebase
Last position: interactive rebase conflict resolution
Next action: resolve one conflict and compare rebase with merge
Last session: S-20260808-180000-a1b2
```

The tutor continues from that position instead of restarting with Git basics. Full history is loaded only when requested by its session ID.

### Save a Session

```bash
palee session end
```

PALEE drafts a summary containing what was covered, what the learner demonstrated, unresolved confusion, and the next action. The learner confirms the summary before PALEE writes:

```text
.palee/sessions/S-20260808-180000-a1b2.md
.palee/hot.md
```

`hot.md` is limited to 250 words. It is a compact working-memory document, not the complete history.

## 5. AI-Powered Testing

### Conduct a Feynman Test
```bash
# Test your understanding with AI
palee test T-pod-lifecycle-k8s

# AI Tutor: "Explain the Kubernetes Pod lifecycle from creation to termination.
# Include the roles of kubelet, container runtime, and init containers."

# [Your written response here...]

# AI analyzes your answer and proposes scores:
# Conceptual: 0.85
# Practical: 0.70
# Debug: 0.60
# Feynman: 0.75

# Confirm these scores? (y/N): y

# Assessment recorded: Pod Lifecycle in Kubernetes (T-pod-lifecycle-k8s) — status: learning
# Topic mastery: 72.5%
```

### Interactive Tutoring Session
```bash
# Engage in a guided learning session
palee tutor T-service-discovery-k8s

# AI Tutor: "Let's explore Kubernetes service discovery. 
# First, what are the main challenges in service discovery?"

# [Your response...]

# AI Tutor: "Good point about network complexity. Now, how does DNS-based
# service discovery work in Kubernetes?"

# [Continue interactive learning...]

# Session complete. Would you like to record this as a review? (y/N): y
# Quality (0-5): 4

# Review recorded: Service Discovery (T-service-discovery-k8s) | interval=6 repetition=1
```

## 6. Review Management

### View Due Reviews
```bash
# Check what needs review
palee dashboard

# Output:
# ==================================================
# VIEW                : GLOBAL SYSTEM
# TOTAL TOPICS        : 42
# BLOCKED TOPICS      : 8
# DUE REVIEWS         : 5
# GLOBAL MASTERY      : 23.45%
# ==================================================
#
# TOP PRIORITY REVIEWS:
# - Docker Volumes (Due (Int: 6d, Lapses: 0))
# - Container Networking (Never Reviewed)
# - Pod Lifecycle (Due (Int: 1d, Lapses: 0))
```

### Record a Review Session
```bash
# Manually record a review after offline study
palee review T-docker-volumes --quality 4

# Output:
# Review recorded: Docker Volumes (T-docker-volumes) | interval=6 repetition=1
```

## 7. Data Integrity

### Validate the Vault
```bash
# Check all PALEE-managed notes for schema errors
palee validate

# Output:
# Scanned 42 notes.
# 2 warnings:
#   notes/Old-Draft.md — missing palee_id
#   notes/Docker-Swarm.md — dependency T-docker-compose not found (dangling reference)
# 40 notes valid.
```

### Check System Status
```bash
palee dashboard

# Output:
# ==================================================
# VIEW                : GLOBAL SYSTEM
# TOTAL TOPICS        : 42
# BLOCKED TOPICS      : 8
# DUE REVIEWS         : 5
# GLOBAL MASTERY      : 23.45%
# ==================================================
#
# TOP PRIORITY REVIEWS:
# - Docker Volumes (Due (Int: 6d, Lapses: 0))
# - Container Networking (Never Reviewed)
# - Pod Lifecycle (Due (Int: 1d, Lapses: 0))
```

## 8. Configuration

### Inspect Current Config
```bash
palee config show

# Output:
# Vault  : C:\Users\you\Documents\Obsidian\Learning
# Provider: https://opencode.ai/zen/v1
# Model  : nemotron-3-ultra-free
# API Key: (configured, not shown)
```

### Change Vault Path
```bash
palee config set-vault "C:\Users\you\Documents\Obsidian\Learning"
# Windows backslash paths are accepted and normalized internally.
```

### Switch AI Provider
```bash
palee config set-provider
# Enter base_url: https://opencode.ai/zen/v1
# Enter api_key: sk-...
# Enter model: deepseek-v4-flash-free
```
