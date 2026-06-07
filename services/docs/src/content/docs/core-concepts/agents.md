---
title: Agents
description: Define multi-step LLM agents as graph specs that call built-in tools, MCP servers, and your own serverless functions.
---

Agents are multi-step LLM workflows defined declaratively as a **graph spec**. A graph spec is JSON: a set of nodes connected by edges, where each node is either an LLM call, a tool call, or an end marker. The agent runtime executes the graph step by step, persists checkpoints between steps so runs can resume, and streams events back to the caller over SSE.

Agents are stored per-app. They can be invoked from your dashboard, the CLI, the MCP server, the SDK, or — for `public` agents — anonymous HTTP.

## Graph spec at a glance

```json
{
  "spec_version": "1",
  "entry": "classify",
  "nodes": {
    "classify": {
      "type": "llm",
      "model": "anthropic/claude-3.5-haiku",
      "system_prompt": "Classify the user's request as 'billing', 'support', or 'sales'.",
      "input_template": "{{ input.message }}",
      "output_key": "category",
      "tools": []
    },
    "respond": {
      "type": "llm",
      "model": "anthropic/claude-3.5-sonnet",
      "system_prompt": "You are a {{ state.category }} agent.",
      "input_template": "{{ input.message }}",
      "output_key": "reply",
      "tools": [
        { "source": "function", "name": "lookup_account" }
      ]
    },
    "done": { "type": "end", "output_template": "{{ state.reply }}" }
  },
  "edges": [
    { "from": "classify", "to": "respond" },
    { "from": "respond", "to": "done" }
  ],
  "tools": {
    "builtin": ["select_rows"],
    "mcp_servers": [],
    "functions": ["lookup_account"]
  },
  "limits": {
    "max_steps": 20,
    "max_tool_calls": 50,
    "max_parallel_tools": 4,
    "timeout_seconds": 300,
    "human_timeout_seconds": 86400
  }
}
```

The spec is versioned (`spec_version: "1"`), validated server-side, and rejected at run time if it references a tool that does not exist.

## Node types

| Type | Purpose |
|---|---|
| `llm` | Call a model. Renders `system_prompt` and `input_template` against current state, optionally exposes `tools` to the model, writes the response (or any tool results) into `output_key`. |
| `tool` | Invoke a tool directly without an LLM. Useful for deterministic preprocessing (`select_rows`, a known function call, etc). |
| `end` | Render `output_template` against state and emit it as the run's final output. |

Edges describe sequencing — each node, when it finishes, transitions to its outgoing edge's target. The graph must be a DAG that reaches `end` from `entry`.

## Tools

Three sources can be exposed to an agent:

### Built-in tools

Platform-managed tools that talk to your app's database, storage, KV, etc. Listed in `tools.builtin` by name. The runtime enforces RLS by mapping the caller (`end_user` → `butterbase_user`, otherwise `butterbase_service`).

### MCP tools

Tools served by a Model Context Protocol server you've registered via `POST /v1/{app_id}/mcp-servers`. Reference them in `tools.mcp_servers` by `server_id` + the subset of tool names you want exposed.

### Functions

Any [serverless function](/core-concepts/functions/) you've deployed and **marked as an agent tool** is callable by the agent. Mark a function:

```http
POST /v1/{app_id}/functions
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email or account ID.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

Then list it in the agent spec's `tools.functions` array. If you reference a function that does not have `agent_tool: true`, the runtime silently skips it — the dashboard editor warns you about this before save.

`agent_tool_mode`:
- `read_only` — no approval needed.
- `read_write` — the runtime pauses the run and emits a `run_paused` event with an approval payload; resume the run after a human approves.

`agent_tool_exposed_to`:
- `developer_only` — usable only from dashboard / CLI test runs.
- `end_user` — also usable from public agent invocations.

## Run lifecycle

```
queued → running → (paused →) running → completed | failed | cancelled
```

A run progresses through the graph one step at a time. After each node, a checkpoint is written. If the runtime restarts, the run resumes from the last checkpoint.

Pausing happens when a `read_write` tool is invoked or the agent explicitly calls a HITL primitive — the next `POST /runs/{id}/resume` (or dashboard "Approve" button) continues from the checkpoint.

The complete event stream over SSE:

| Event | When |
|---|---|
| `run_start` | Run accepted, before any node runs. |
| `node_start` / `node_end` | A node is about to run / has finished. Includes `node_id` and `step`. |
| `tool_call_start` / `tool_call_end` | A tool is about to be invoked / has returned. Includes `tool_name`, `args`, `result`. |
| `llm_token_usage` | Per-LLM-call token counts. |
| `run_paused` | A `read_write` tool needs human approval. |
| `run_cancelled` | The caller cancelled the run. |
| `run_failed` | An error terminated the run. |
| `run_end` | Run completed successfully; payload contains the rendered `output_template`. |

## Idempotency

Every `POST /runs` carries an implicit idempotency key — a SHA-256 hash of the request body. Re-posting the same body returns the existing run (HTTP 200) instead of creating a duplicate. Submitting a *different* body with the same agent name within the dedupe window returns `409 conflict`.

## Limits

Each spec declares its own limits. The runtime hard-caps them server-side:

| Limit | Cap |
|---|---|
| `max_steps` | 200 graph traversals per run |
| `max_tool_calls` | 500 tool invocations per run |
| `max_parallel_tools` | 16 tools in flight |
| `timeout_seconds` | 1 hour wall-clock |
| `human_timeout_seconds` | 7 days while paused for approval |

Apps also have per-agent access controls — `max_runs_per_user_per_hour`, `daily_budget_usd`, `max_concurrent_runs`, etc. — set via the dashboard's "Access and limits" section or `PATCH /v1/{app_id}/agents/{name}`.

## Visibility

| Visibility | Who can start runs |
|---|---|
| `private` | Owner of the app (dashboard, CLI, MCP). |
| `authenticated` | Any logged-in user of the app. |
| `public` | Anyone with the app's public anon key. Use with caution — combine with strict rate limits and a `daily_budget_usd`. |

## See also

- [Agents quickstart](/getting-started/agents-quickstart/) — deploy a function, expose it as a tool, run an agent end-to-end.
- [Agents API reference](/api-reference/agents-api/) — every REST endpoint, every event payload.
- [Serverless functions](/core-concepts/functions/) — how to deploy the functions you'll expose as tools.
