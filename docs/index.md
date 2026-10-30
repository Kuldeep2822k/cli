---
layout: home
description: "A deterministic study tracker with spaced repetition and dependency-aware topic scheduling for Obsidian vaults."

hero:
  name: "PALEE CLI"
  text: "Personal Active Learning & Evaluation Engine"
  tagline: "A deterministic study tracker with spaced repetition and dependency-aware topic scheduling for Obsidian vaults."
  image:
    src: /palee-logo.png
    alt: PALEE CLI
  actions:
    - theme: brand
      text: Get Started
      link: /01-1-getting-started
    - theme: alt
      text: CLI Reference
      link: /02-0-cli-commands

features:
  - icon:
      src: /icons/sm2.svg
      width: 24
      height: 24
    title: Deterministic SM-2 Engine
    details: Spaced repetition scheduling with ease factor clamping (min 1.3), lapse tracking, and exact calendar-day interval progression.

  - icon:
      src: /icons/dag.svg
      width: 24
      height: 24
    title: Dependency Graph & DAG
    details: Prerequisite topic gating, automated cycle detection, and mastery-threshold readiness checks before advancing.

  - icon:
      src: /icons/vault.svg
      width: 24
      height: 24
    title: Obsidian-Native Vault
    details: Markdown files with YAML frontmatter serve as the canonical source of truth—preserving comments, formatting, and custom metadata.

  - icon:
      src: /icons/lock.svg
      width: 24
      height: 24
    title: Atomic Writes & Advisory Locks
    details: Crash-resilient OCC SHA-256 fingerprinting, staged file writes with fsync, and cross-platform heartbeat-managed directory locks.

  - icon:
      src: /icons/memory.svg
      width: 24
      height: 24
    title: Session Memory (hot.md)
    details: Bounded 250-word working memory and durable ISO-8601 session logging designed for LLM context continuity.

  - icon:
      src: /icons/terminal.svg
      width: 24
      height: 24
    title: Developer & Pipeline Ready
    details: High performance CLI built in TypeScript with machine-readable JSON output (--json / PALEE_JSON) and 96.7% line coverage, enforced at 96% in CI.
---
