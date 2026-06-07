---
title: Functions API
description: Complete reference for serverless function endpoints.
sidebar:
  order: 4
---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/functions | Deploy or update a function |
| GET | /v1/\{app_id}/functions | List all functions |
| GET | /v1/\{app_id}/functions/\{name} | Get function details and metrics |
| DELETE | /v1/\{app_id}/functions/\{name} | Delete a function |
| POST | /v1/\{app_id}/functions/\{name}/invoke | Test-invoke a function |
| GET | /v1/\{app_id}/functions/\{name}/logs | View invocation logs |

## Public invocation

| Method | Path | Purpose |
|--------|------|---------|
| ANY | /v1/\{app_id}/fn/\{function_name} | Call a deployed function (any HTTP method) |

End-user tokens are forwarded to the function.

## Deploy a function

```json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\n    headers: { 'Content-Type': 'application/json' }\n  });\n}",
  "description": "A simple greeting function",
  "triggers": [
    { "type": "http", "config": { "auth": "required" } },
    { "type": "cron", "config": { "schedule": "0 9 * * *" } }
  ],
  "envVars": {
    "API_KEY": "secret123"
  },
  "timeoutMs": 30000,
  "memoryLimitMb": 128
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `name` | Unique name (1-100 characters) |
| `code` | Source code with default export handler |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `description` | — | What the function does |
| `envVars` | — | Environment variables (encrypted) |
| `timeoutMs` | 30000 | Max execution time (max: 300000) |
| `memoryLimitMb` | 128 | Memory limit (range: 64-1024) |
| `triggers` | `[{type: "http"}]` | Array of trigger configs. At most one per type. |
| `trigger` | — | **Legacy** single-trigger shorthand; normalized server-side to a 1-element `triggers` array. |
| `agent_tool` | `false` | Expose this function to agents as a tool. |
| `agent_tool_description` | — | Short description shown to the LLM (max 500 chars). |
| `agent_tool_mode` | `read_only` | `read_only` or `read_write`. `read_write` requires HITL approval. |
| `agent_tool_exposed_to` | `developer_only` | `developer_only` or `end_user`. |

### Trigger types

Each trigger object has a `type` and a type-specific `config`. At most one trigger of each type may be attached to a function (enforced by a unique index).

| Type | Config | Notes |
|------|--------|-------|
| `http` | `{ method?, path?, auth? }` | `auth` defaults to `required` — anonymous callers get 401 at the edge. Set `none` only for intentionally public endpoints. |
| `cron` | `{ schedule, timezone? }` | `schedule` is a cron expression (e.g. `*/5 * * * *`). `timezone` defaults to UTC. |
| `s3_upload` | `{ bucket, prefix?, contentTypes? }` | Fires when an object lands in the bucket matching `prefix` and (optionally) the listed MIME types. |
| `webhook` | `{ secret_required?, allowed_sources? }` | Generates a signed webhook URL. `allowed_sources` is a comma-separated list of provider tags. |
| `websocket` | `{}` | Invoked on each incoming WebSocket frame from the realtime channel. |

### Exposing a function as an agent tool

When `agent_tool: true`, this function becomes callable from any agent in the same app whose graph spec lists its name under `tools.functions[]`. See the [Agents API](/api-reference/agents-api/) for how agents reference function tools.

```json
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email. Returns id, plan, status.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

The 4 `agent_tool*` fields are returned on `GET /functions` and `GET /functions/{name}` so clients can render UI state.

## Update environment variables

```json
PATCH /v1/{app_id}/functions/{name}/env
Authorization: Bearer {token}

{
  "envVars": {
    "API_KEY": "new-secret",
    "NEW_VAR": "value",
    "OLD_VAR": null
  }
}
```

Values are **merged** with existing env vars (not replaced). Set a value to `null` to delete a key.

## Invocation logs

```
GET /v1/{app_id}/functions/{name}/logs?limit=50&since=2026-01-01T00:00:00Z&level=error
```

| Parameter | Description |
|-----------|-------------|
| `limit` | Number of log entries |
| `since` | ISO date filter |
| `level` | Filter by level (`error`, `all`) |
| `include_deleted` | `true` to read logs for a soft-deleted function (post-incident forensics). Default `false`. |

### Log entry fields

| Field | Description |
|-------|-------------|
| `method` | HTTP method |
| `path` | Request path |
| `status_code` | Response status |
| `duration_ms` | Execution time |
| `memory_mb` | Memory used |
| `error` | Error message (if any) |
| `consoleLogs` | Array of captured console output (`{ level, message, timestamp }`) |

## Function metrics

| Metric | Description |
|--------|-------------|
| `total_invocations` | Total invocation count |
| `error_count` | Number of errors |
| `error_rate` | Error percentage |
| `avg_duration_ms` | Average execution time |
| `last_invocation` | Timestamp of last call |
