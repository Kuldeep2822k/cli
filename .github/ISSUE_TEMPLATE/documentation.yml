name: "📝 Docs"
description: "Request an improvement or addition to documentation"
title: "Docs: (fill in)"
labels:
    - documentation
    - "good first issue"
body:
    - type: markdown
      attributes:
          value: |
              By opening an issue, you agree to help keep PALEE's documentation accurate and helpful.
              Docs include the README, VitePress site (https://kuldeep2822k.github.io/cli/),
              inline JSDoc, and planning docs.
    - type: textarea
      id: doc-area
      attributes:
          label: Documentation area
          description: |
              Where does this change belong?
          value: |
              https://kuldeep2822k.github.io/cli/...
          placeholder: |
              e.g. README.md "Data Model" section, or docs/api/cli.md
      validations:
          required: true
    - type: textarea
      id: problem
      attributes:
          label: What documentation issue do you want to solve?
          description: |
              Explain the gap or error in as much detail as possible.
          placeholder: |
              The docs currently...
      validations:
          required: true
    - type: textarea
      id: solution
      attributes:
          label: What do you think is the correct solution?
          description: |
              Explain how you'd like the docs to change.
          placeholder: |
              I'd like the docs to...
      validations:
          required: true
    - type: checkboxes
      attributes:
          label: Participation
          options:
              - label: "I am willing to submit a pull request for this change."
                required: false
    - type: markdown
      attributes:
          value: |
            Please **do not** open a pull request until this issue has been accepted by the team.
    - type: checkboxes
      attributes:
          label: AI acknowledgment
          options:
              - label: "I did not use AI to generate this issue report."
                required: false
              - label: "(If the above is not checked) I have reviewed the AI-generated content before submitting."
                required: false
    - type: textarea
      id: comments
      attributes:
          label: Additional comments
          description: Is there anything else that's important for the team to know?
      validations:
          required: false
