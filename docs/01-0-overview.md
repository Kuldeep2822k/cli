---
description: "The Personal Active Learning & Evaluation Engine (PALEE) is a smart, AI-powered study tracker designed to optimize learning through a deterministic core of..."
---


# Overview
::: details Relevant Source Files

- [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)
- [bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts)
- [package.json](https://github.com/Kuldeep2822k/cli/blob/main/package.json)
- [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)
- [src/index.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/index.ts)

:::

The Personal Active Learning & Evaluation Engine (PALEE) is a smart, AI-powered study tracker designed to optimize learning through a deterministic core of spaced repetition and dependency-aware recommendations. It integrates natively with Obsidian vaults, treating Markdown files as the canonical source of truth for both learning content and progress metadata.

PALEE bridges the gap between static notes and active learning by providing a structured engine that calculates what you should study next, while offering an optional AI layer for interactive tutoring and Feynman-style testing.

## Core Philosophy

PALEE is built on three architectural pillars [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1):

1. Deterministic Core: Reliable scheduling using the SM-2 algorithm and strict dependency graph tracking.
2. AI Augmentation: Intelligent tutoring and assessment constrained to validated, read-only context tools.
3. Human Oversight: A "Human Confirm Gate" ensures that no consequential state changes (like updating mastery scores) occur without explicit user approval [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)

## System Architecture

The system is organized into layered modules with a strict downward dependency flow to ensure data integrity and separation of concerns [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)

### 1. Storage Layer (The Vault)

The Obsidian vault is the single source of truth. PALEE stores metadata in YAML frontmatter within individual topic notes and manages session history in a hidden `.palee/` directory [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)

- Topic Notes: Contain `palee_id`, mastery scores, and SM-2 state [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)
- Session Memory: Includes `hot.md` (a 250-word working memory cap) and durable session logs [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)

### 2. Engine Core

A pure-function library responsible for the logic of learning. It handles:

- SM-2 Algorithm: Calculating review intervals and ease factors [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)
- Dependency Graph: Managing prerequisites and detecting cycles [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)
- Mastery Calculation: Deriving overall mastery from conceptual, practical, debug, and Feynman scores [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)

### 3. Interface Layer (CLI & Tools)

The command-line interface provides the primary way to interact with the engine. It includes commands for adoption, planning, reviewing, and session management [bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts)

### System Component Mapping

The following diagram illustrates how Natural Language concepts map to specific code entities and storage structures.

#### Entity Relationship Diagram: Logic to Code Mapping

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'background': '#000000',
    'primaryColor': '#000000',
    'primaryTextColor': '#e0e0e0',
    'primaryBorderColor': '#2d3139',
    'lineColor': '#5a606b',
    'secondaryColor': '#000000',
    'tertiaryColor': '#000000',
    'clusterBkg': '#0a0b0d',
    'clusterBorder': '#1e2128',
    'titleColor': '#8b949e',
    'edgeLabelBackground': '#000000',
    'fontFamily': 'Inter, system-ui, sans-serif'
  }
}}%%
flowchart TD
    subgraph NLSpace ["Natural Language Space"]
        direction LR
        LT["Learning Topic"]
        RS["Review Schedule"]
        SS["Study Session"]
        LT ~~~ RS ~~~ SS
    end

    subgraph CodeSpace ["Code Entity Space (src/types)"]
        direction LR
        TI["Topic Interface"]
        RI["Review Interface"]
        SRI["SessionRecord Interface"]
        TI ~~~ RI ~~~ SRI
    end

    subgraph StorageSpace ["Storage Space (Obsidian Vault)"]
        direction LR
        MF["Markdown Frontmatter"]
        Hot["'.palee/hot.md'"]
        Sessions["'.palee/sessions/'"]
        MF ~~~ Hot ~~~ Sessions
    end

    LT --> TI
    RS --> RI
    SS --> SRI

    TI --> MF
    RI --> MF
    SRI --> Hot
    SRI --> Sessions

    style NLSpace fill:#08090b,stroke:#1e2128,stroke-width:1px,color:#8b949e
    style CodeSpace fill:#08090b,stroke:#1e2128,stroke-width:1px,color:#8b949e
    style StorageSpace fill:#08090b,stroke:#1e2128,stroke-width:1px,color:#8b949e

    style LT fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style RS fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style SS fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style TI fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style RI fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style SRI fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style MF fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style Hot fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
    style Sessions fill:#000000,stroke:#2d3139,stroke-width:1px,color:#ffffff
```

Sources: [src/types.ts](https://github.com/Kuldeep2822k/cli/blob/main/src/types.ts)[README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)[planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)

## Navigation and Learning Paths

To explore the PALEE codebase and documentation, follow these paths:

### Setup and Usage

- [Getting Started](./01-1-getting-started.md): Learn how to install the `@kuldeep2822k/palee` package via NPM [package.json](https://github.com/Kuldeep2822k/cli/blob/main/package.json) configure your vault path using `palee config set-vault`[README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1) and set up AI providers [README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)

### Technical Deep Dives

- [Architecture Overview](./01-2-architecture-overview.md): A detailed look at the layered architecture, the file-safety contract (atomic writes and locking), and the "Obsidian-Native" storage strategy [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)
- CLI Commands: Comprehensive reference for commands like `palee next`[bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts)`palee plan`[bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts) and `palee session`[bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts)

### Implementation Details

The system's behavior is governed by specific modules:

- Scheduling: Logic residing in the SM-2 engine.
- Validation: Vault integrity checks handled by the `validate` command [bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts)
- Safety: Atomic write operations and optimistic concurrency control (OCC) [planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)

#### Data Flow: Command to Storage

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'background': '#000000',
    'primaryColor': '#000000',
    'primaryTextColor': '#e0e0e0',
    'primaryBorderColor': '#2d3139',
    'lineColor': '#5a606b',
    'secondaryColor': '#000000',
    'tertiaryColor': '#000000',
    'clusterBkg': '#0a0b0d',
    'clusterBorder': '#1e2128',
    'titleColor': '#8b949e',
    'edgeLabelBackground': '#000000',
    'fontFamily': 'Inter, system-ui, sans-serif'
  }
}}%%
sequenceDiagram
    autonumber
    actor User as Learner
    participant CLI as CLI Command (bin/palee.ts)
    participant Engine as Engine Core (src/engine/)
    participant Storage as Storage Layer (src/storage/)
    participant Vault as Obsidian Vault (.md)

    User->>CLI: Execute command (e.g. palee review / next)
    CLI->>Storage: Read note frontmatter
    Storage->>Vault: Read file & compute SHA-256
    Vault-->>Storage: Content & fingerprint
    Storage-->>CLI: Parsed YAML metadata
    CLI->>Engine: Calculate state (SM-2 / Dependency)
    Engine-->>CLI: Updated learning state
    CLI->>Storage: atomicWrite(target, updatedYAML, expectedFP)
    Storage->>Vault: Write temp -> fsync -> rename
    Vault-->>Storage: Write confirmed
    Storage-->>CLI: Success
    CLI-->>User: Visual CLI output / explicit --json or PALEE_JSON
```

Sources: [bin/palee.ts](https://github.com/Kuldeep2822k/cli/blob/main/bin/palee.ts)[planning/palee_cli_spec.md](https://github.com/Kuldeep2822k/cli/blob/main/planning/palee_cli_spec.md?plain=1)[README.md](https://github.com/Kuldeep2822k/cli/blob/main/README.md?plain=1)