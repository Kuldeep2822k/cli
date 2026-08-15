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
  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><path d="M12 6v6l4 2"/></svg>'
    title: Deterministic SM-2 Engine
    details: Spaced repetition scheduling with ease factor clamping (min 1.3), lapse tracking, and exact calendar-day interval progression.

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><line x1="8.59" y1="7.41" x2="15.42" y2="10.59"/><line x1="8.59" y1="16.59" x2="15.42" y2="13.41"/></svg>'
    title: Dependency Graph & DAG
    details: Prerequisite topic gating, automated cycle detection, and mastery-threshold readiness checks before advancing.

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
    title: Obsidian-Native Vault
    details: Markdown files with YAML frontmatter serve as the canonical source of truth—preserving comments, formatting, and custom metadata.

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
    title: Atomic Writes & Advisory Locks
    details: Crash-resilient OCC SHA-256 fingerprinting, staged file writes with fsync, and cross-platform heartbeat-managed directory locks.

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h8"/><path d="M8 16h6"/></svg>'
    title: Session Memory (hot.md)
    details: Bounded 250-word working memory and durable ISO-8601 session logging designed for LLM context continuity.

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
    title: Developer & Pipeline Ready
    details: High performance CLI built in TypeScript with machine-readable non-TTY JSON streaming and 100% invariant test coverage.
---
