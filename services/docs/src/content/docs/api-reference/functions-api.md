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
  "trigger": {
    "type": "http",
    "config": {}
  },
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
| `trigger.type` | `http` | `http`, `cron`, or `websocket` |
| `trigger.config` | `{}` | Trigger-specific config |

### Trigger configs

| Type | Config | Example |
|------|--------|---------|
| `http` | `{}` | — |
| `cron` | `{"schedule": "cron_expr"}` | `{"schedule": "*/5 * * * *"}` |
| `websocket` | `{"event": "event_name"}` | `{"event": "chat_message"}` |

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
