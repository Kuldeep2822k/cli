# PALEE Personalized Roadmap Design

## Two Explicit Modes

PALEE supports two roadmap workflows:

### Import a user-provided roadmap (Phase 1)

```bash
palee roadmap --from kubernetes-roadmap.md
```

This mode is deterministic. PALEE validates the source, reports duplicate IDs, missing dependencies, cycles, invalid difficulty values, and unsafe destinations, then asks for confirmation before writing anything to the vault. The source is never silently rewritten by AI.

### Generate a personalized roadmap (Phase 2)

```bash
palee roadmap
```

When no source is supplied, PALEE asks the learner:

1. What outcome or goal are you working toward?
2. What is your current level?
3. How many hours per week are available?
4. Is there a target date?
5. What practice style do you prefer?
6. What constraints, technologies, or excluded topics matter?

This is a multi-turn CLI interaction: PALEE prints each question one at a time, waits for user input (via `readline` or equivalent), validates non-empty responses, and collects all six answers before sending them to the AI. If the learner abandons mid-interview (Ctrl+C or EOF), PALEE exits cleanly with no partial state written. All six questions must be answered — no defaults are assumed.

The AI uses these answers and selected vault notes to produce a proposal. Vault content is untrusted reference material, and all assumptions must be shown explicitly.

## Proposal Contract

The guided flow must return a complete object matching this contract:

```json
{
  "type": "roadmap_proposal",
  "schema_version": 1,
  "roadmap_id": "R-kubernetes-interview",
  "source": "guided",
  "profile": {
    "goal": "Prepare for a Kubernetes platform-engineering interview",
    "current_level": "intermediate",
    "hours_per_week": 6,
    "target_date": "2026-10-01",
    "practice_style": ["explanation", "hands_on", "debugging"],
    "constraints": ["Use existing Obsidian notes", "Prioritize production operations"]
  },
  "topics": [
    {
      "topic_id": "T-pod-lifecycle-k8s",
      "title": "Pod Lifecycle in Kubernetes",
      "order": 1,
      "difficulty": 2,
      "dependencies": ["T-kubernetes-basics"],
      "estimated_hours": 2,
      "rationale": "Required for debugging scheduling and termination behavior."
    }
  ],
  "assumptions": ["The learner knows basic container concepts."],
  "warnings": []
}
```

## Validation Rules

- `type` must equal `roadmap_proposal`.
- `schema_version` must be supported.
- `roadmap_id` must use the `R-` prefix and be unique.
- Every `topic_id` must use the `T-` prefix and be unique within the proposal.
- Every dependency must refer to a topic in the proposal or an existing valid vault topic.
- `difficulty` must be an integer from `1` to `5`.
- `estimated_hours` must be positive.
- `order` values must be unique and define a deterministic display order.
- Cycles and unresolved dependencies block import or confirmation.
- `assumptions` and `warnings` are displayed before confirmation.

### Exit Codes for Roadmap Commands

| Condition | Exit Code |
|-----------|-----------|
| Successful import or confirmation | `0` |
| Invalid usage (e.g., `--from` path missing) | `2` |
| Validation failure (duplicate IDs, cycles, dangling deps, unsafe paths, schema error) | `3` |
| Learner declines confirmation (aborted, not an error) | `0` |
| Provider or network error during guided roadmap | `5` |

Validation failures from `roadmap --from` use exit code `3` and list every error before touching the vault. Guided roadmap AI failures use exit code `5` and suggest running `palee roadmap --from` with a manually prepared file as an offline fallback.

## Confirmation and Writes

Before writing, PALEE displays the learner profile, topic list, dependency graph, estimated effort, assumptions, and warnings. The learner must confirm the proposal.

After confirmation, PALEE creates or updates the roadmap note and topic notes through the normal lock, fingerprint, AST-preserving frontmatter, and atomic-write contracts. The AI never writes files directly.

Roadmap notes are user-visible Markdown under `Roadmaps/`. Topic notes remain the canonical learning records; the roadmap is a planning view that references them by stable ID.
