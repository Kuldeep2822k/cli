# PALEE AI Module Technical Design

## Overview

The AI module provides intelligent tutoring capabilities within the PALEE CLI. It uses Large Language Models (LLMs) to conduct Feynman-style tests, grade user responses, and interactively guide learning sessions.

It also provides session continuity. At the beginning of a session, the AI receives the compact `.palee/hot.md` document. Full session notes are retrieved by stable session ID only when the current task requires additional history.

## Architecture

```
┌─────────────────────────────┐
│        palee test           │
│     (CLI Command)           │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│    AI Session Manager       │
│  (Provider Configuration)   │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│   Tool-Calling Loop         │
│   (Prompt → Read Tools)     │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│    Session Context           │
│ hot.md + requested sessions │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│    Engine Tool Interface    │
│ (Read-only Context Access)  │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│      Engine Core            │
│ (SM-2, Graph, Mastery)      │
└─────────────────────────────┘
```

## Components

### 1. Provider Configuration

Manages connection to LLM providers:
- `base_url`: API endpoint (e.g., `https://opencode.ai/zen/v1`)
- `api_key`: Authentication token
- `model`: Specific model to use
- Storage location:
  - **Unix/macOS**: `~/.config/palee/ai_provider.json` (where `~` expands to `$HOME`)
  - **Windows**: `%LOCALAPPDATA%\palee\ai_provider.json` (typically `C:\Users\<user>\AppData\Local\palee\ai_provider.json`)
  - PALEE uses Node's `os.homedir()` + `.config/palee/` on Unix/macOS, and `process.env.LOCALAPPDATA` + `palee\` on Windows

### 2. Session Manager

Handles the lifecycle of an AI tutoring session:
- Loads provider configuration
- Initializes conversation context
- Manages tool definitions
- Coordinates between user input and LLM responses

### 3. Tool-Calling Loop

The core interaction loop:
1. Send the system prompt, hot memory, topic content, and read-only tools to the LLM (context window is bounded — see Context Limits below)
2. Receive response (either content or read-only tool calls)
3. If tool_calls:
   - Validate function name and arguments
   - Execute read-only calls against the engine
   - Return results to LLM
4. If content:
   - Display to user
   - Wait for user input
5. Repeat until session ends

Older dialogue turns are not appended indefinitely. Once the rolling window exceeds four turns, older turns are summarized and the summary replaces them. If summarization fails, the session continues with a smaller window rather than sending an unbounded request. The tool-calling loop always sends a bounded context regardless of session length.

The AI may draft an assessment, review, or session summary. It must not receive mutation tools. The session manager validates the draft, shows the learner the proposed change, and is the only component allowed to execute a confirmed mutation.

The prompt should keep a bounded budget: system instructions, hot memory, current topic content, a rolling session summary, and only the most recent dialogue turns. The exact token allocation is configurable and must be measured against the selected provider rather than treated as a universal constant.

### 4. Read-Only Tools Exposed to the LLM

Only the tools in this section may be registered in the provider's LLM tool schema. Session-manager mutations are documented in the next section and must never be registered as model tools.

#### Structured assessment proposal
The model returns this structured proposal after a Feynman test using the provider's structured-response/JSON-schema mode when available. It is model output, not a tool, and must never be placed in the provider's `tools` array:
```json
{
  "type": "assessment_proposal",
  "topic_id": "T-git-rebase",
  "scores": {
    "conceptual": 0.7,
    "practical": 0.4,
    "debug": 0.2,
    "feynman": 0.5
  },
  "evidence": ["The learner explained the rebase base change but could not resolve a conflict."]
}
```

PALEE validates the proposal, displays the score changes and evidence, and asks for confirmation. Only then does the session manager call the internal engine mutation:

```json
{
  "topic_id": "T-git-rebase",
  "conceptual": 0.7,
  "practical": 0.4,
  "debug": 0.2,
  "feynman": 0.5
}
```

The internal `record_assessment` operation updates `assessment` only and must never update the SM-2 `review` object.

If a provider does not support structured-response mode, PALEE makes one bounded retry requesting a complete JSON object as the entire response. PALEE may `trim`, parse the whole response with a standard JSON parser, and validate the schema. It must reject fenced JSON, Markdown extraction, regex recovery, bracket repair, string-to-number guessing, or any other inferred proposal. After the retry fails, no proposal is shown as valid; the session reports a provider/model-format error and offers manual assessment or another provider.

#### `get_topic`
Retrieves topic information
```json
{
  "name": "get_topic",
  "description": "Get information about a learning topic",
  "parameters": {
    "type": "object",
    "properties": {
      "topic_id": {"type": "string", "description": "Stable PALEE topic identifier"}
    },
    "required": ["topic_id"]
  }
}
```

#### `get_hot_memory`
Returns the current compact session context, including the active topic, last session ID, unresolved confusion, and next action.

```json
{
  "name": "get_hot_memory",
  "description": "Read the current compact PALEE session context",
  "parameters": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### `get_session`
Retrieves one full session record by stable session ID. The AI must request a specific session instead of loading the entire session directory.

```json
{
  "name": "get_session",
  "description": "Read one confirmed PALEE session by ID",
  "parameters": {
    "type": "object",
    "properties": {
      "session_id": {"type": "string", "description": "Stable session identifier"}
    },
    "required": ["session_id"],
    "additionalProperties": false
  }
}
```

### 5. Session-Manager-Only Mutation API

The following operations are internal application APIs. They are called only after validation and explicit learner confirmation; their schemas must not be included in the LLM tool list.

#### `record_assessment`
Records confirmed assessment scores for one topic. It updates `assessment` only and never updates the SM-2 `review` object.

```json
{
  "topic_id": "T-git-rebase",
  "conceptual": 0.7,
  "practical": 0.4,
  "debug": 0.2,
  "feynman": 0.5
}
```

#### `record_review`
Records a confirmed spaced-repetition review. It updates `review` only and never overwrites assessment values.
```json
{
  "topic_id": "T-git-rebase",
  "quality": 4
}
```

#### `save_session`
Writes a confirmed session summary, updates the derived index, and regenerates hot memory. It is called only after the learner approves the summary.

## Security & Safety

### Tool Containment
- LLM can only call predefined read-only functions
- All arguments are schema-validated before execution
- No direct file system or shell access
- All proposed mutations include an explicit topic or session ID
- Session summaries and assessment/review changes are durable only after user confirmation

### Prompt Injection Resistance

Vault note bodies are untrusted learning material. PALEE must escape and provide them in a clearly delimited data section and explicitly instruct the model not to follow instructions found inside the note. A per-request nonce and content hash may be included as integrity metadata, but they are not a permission boundary and must not be treated as cryptographic prompt-injection prevention.

For assessment flows, mutation operations are unavailable to the model. The model can only return a candidate proposal, which is validated by PALEE and confirmed by the learner before the deterministic engine writes it.

PALEE should flag an assessment proposal as anomalous when the topic already has a prior assessed result (i.e., `assessment.assessed_at` exists and all four prior scores are above `0.10`), and any single score increases by more than `0.40` relative to its previous value, or aggregate topic mastery increases by more than `0.35` compared to the mastery recorded at `assessment.assessed_at`. The ten-minute window is stateless and always computed from disk: if `(current_wall_clock_time - assessed_at_timestamp) < 600_seconds`, the anomaly flag is active. A session restart does not clear the flag — it is recomputed from the stored `assessed_at` on every assessment. Wall-clock time is always UTC; `assessed_at` is stored as ISO-8601 with timezone and converted to UTC for comparison. First assessments on a newly adopted topic are never flagged — a jump from `0.0` to `0.70` on first test is expected. The learner must explicitly type `CONFIRM` for an anomalous proposal. These thresholds are safety heuristics, not proof that a score is correct.

### Human Confirm Gate
Critical operations require explicit user approval:
- Before recording assessment scores
- Before recording review results
- Before saving a session summary or changing hot memory
- Display proposed values for confirmation

### Credential Management
- API keys stored securely (OS keychain when available)
- Never logged or displayed
- Configuration files excluded from version control

## Error Handling

### Connection Errors
- Network timeouts
- Invalid credentials
- Provider downtime
- Graceful fallback messaging
- Run an AI-provider preflight with a short configurable timeout (default 2.5 seconds)
- Abort clearly with exit code `5` when the provider is unavailable; never hang waiting indefinitely
- Suggest deterministic offline commands such as `palee review` or `palee progress`
- An offline flashcard/self-assessment mode remains a later feature, not a hidden fallback

### Tool Validation Errors
- Invalid function names
- Malformed arguments
- Missing required parameters
- Out-of-range values

### Model Response Errors
- Non-tool-calling responses when tools expected
- Malformed JSON in tool arguments
- Inaccessible topics or invalid IDs
- Invalid assessment proposal shape or out-of-range scores
- Never execute tool calls extracted from arbitrary Markdown or code fences

## Performance Considerations

### Caching
- Provider model lists cached temporarily
- Frequently accessed topics cached in session
- Hot memory is loaded first; full sessions are retrieved by explicit ID

### Rate Limiting
- Respectful delays between API calls
- Configurable timeout settings
- Retry logic with exponential backoff
- Full-jitter retries for transient `429` and `503` responses
- Circuit breaker after three consecutive transient provider failures, with a short cooldown

### Streaming
- Real-time response streaming when supported
- Progressive display of long responses
- Interruptible operations

### Context Limits

Interactive tutoring keeps the system prompt, current hot memory, current topic content, and the last four dialogue turns. Older turns are summarized in memory and are not appended indefinitely. If summarization fails, the session continues with a smaller window rather than sending an unbounded request.

### Guided Roadmap Flow

`palee roadmap --from <file>` is handled by the deterministic importer and does not call the AI. When no source is provided, the session manager asks the learner for:

- learning goal and target outcome
- current experience level
- available hours per week
- target date, if any
- preferred practice style
- constraints, required technologies, or excluded topics

The AI then returns a roadmap proposal containing topic IDs, dependencies, difficulty, rationale, and explicit assumptions. The proposal is shown for confirmation before the session manager creates or updates topic notes. The model never writes roadmap or topic files directly.

## Extensibility

### New Tools
Easy to add new engine functions as available tools:
1. Define tool schema
2. Implement engine function
3. Add to tool registry

### Provider Support
Designed for multiple provider backends:
- OpenAI-compatible endpoints
- Anthropic native API
- Local model servers (Ollama, LM Studio)

### Custom Prompts
Template-based system for different tutoring styles:
- Feynman testing
- Concept explanation
- Practice problem generation
- Debug scenario walkthrough
