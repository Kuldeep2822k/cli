name: "🔧 Task"
description: "Internal task, refactor, test improvement, or maintenance work"
title: "Task: (fill in)"
labels:
    - chore
    - core
body:
    - type: markdown
      attributes:
          value: |
              By opening an issue, you agree to help keep PALEE's codebase healthy and well-tested.
              Use this template for planned engineering work: refactors, test coverage improvements,
              dependency upgrades, and internal maintenance.
    - type: textarea
      id: description
      attributes:
          label: Description
          description: What work needs to be done?
          placeholder: |
              Refactor the vault scanner to handle symlink cycles
      validations:
          required: true
    - type: textarea
      id: motivation
      attributes:
          label: Motivation
          description: Why this work matters — what's blocked, what's risky, what's tech debt.
          placeholder: |
              This is blocking #123 and the migration path needs it to handle symlinks
      validations:
          required: true
    - type: textarea
      id: acceptance
      attributes:
          label: Acceptance criteria
          description: |
              What does "done" look like? List concrete, testable outcomes.
          render: json
          placeholder: |
              - `palee adopt --dry-run` exits 0 on a symlinked vault
              - New test: test/storage-vault.test.ts covers symlink cycles
              - No performance regression on 1000-note benchmark
      validations:
          required: true
    - type: dropdown
      id: area
      attributes:
          label: Area
          description: |
              Which subsystem is affected?
          options:
              - "Core engine (src/engine/)"
              - "Storage / vault scanning (src/storage/)"
              - "Session memory (src/session/)"
              - "CLI / bin layer"
              - "Tests"
              - "Config / migration"
              - "AI / Phase 2 (src/ai/)"
              - "Build / CI"
              - "Documentation"
      validations:
          required: true
    - type: input
      id: time
      attributes:
          label: Estimated effort (optional)
          description: |
              Time budget if known
          placeholder: "e.g. ~30 min, ~2 hours, ~1 day"
      validations:
          required: false
    - type: checkboxes
      attributes:
          label: Participation
          options:
              - label: "I am willing to work on this."
                required: false
    - type: checkboxes
      attributes:
          label: AI acknowledgment
          options:
              - label: "I did not use AI to generate this issue."
                required: false
              - label: "(If the above is not checked) I have reviewed the AI-generated content before submitting."
                required: false
    - type: textarea
      id: comments
      attributes:
          label: Additional comments
          description: Links to related issues, PRs, or design docs.
      validations:
          required: false
