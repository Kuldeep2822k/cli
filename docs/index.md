---
layout: home

hero:
  name: "PALEE CLI"
  text: "Personal Active Learning & Evaluation Engine"
  tagline: "A deterministic study tracker with spaced repetition and dependency-aware topic scheduling for Obsidian vaults."
  actions:
    - theme: brand
      text: Get Started
      link: /01-1-getting-started
    - theme: alt
      text: CLI Reference
      link: /02-0-cli-commands
    - theme: alt
      text: Architecture
      link: /01-2-architecture-overview

features:
  - icon: 🧠
    title: Deterministic SM-2 Engine
    details: Spaced repetition scheduling with ease factor clamping (min 1.3), lapse tracking, and exact calendar-day interval progression.
  - icon: 🌲
    title: Dependency Graph & DAG
    details: Prerequisite topic gating, automated cycle detection, and mastery-threshold readiness checks before advancing.
  - icon: 💎
    title: Obsidian-Native Vault
    details: Markdown files with YAML frontmatter serve as the canonical source of truth—preserving comments, formatting, and custom metadata.
  - icon: 🔒
    title: Atomic Writes & Advisory Locks
    details: Crash-resilient OCC SHA-256 fingerprinting, staged file writes with fsync, and cross-platform heartbeat-managed directory locks.
  - icon: ⚡
    title: Session Memory (hot.md)
    details: Bounded 250-word working memory and durable ISO-8601 session logging designed for LLM context continuity.
  - icon: 🛠️
    title: Developer & Pipeline Ready
    details: High performance CLI built in TypeScript with machine-readable non-TTY JSON streaming and 100% invariant test coverage.
---
