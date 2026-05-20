---
title: Platform API
description: Platform-level endpoints including MCP over HTTP, agent guidance, and subdomains.
sidebar:
  order: 9
---

## MCP over HTTP

The same MCP tool surface is available over HTTP:

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTP MCP session |

Send `Authorization: Bearer {platform_api_key}` so requests run as your account. Use this when your assistant or automation can't use stdio MCP but can call HTTPS.

## Apps & regions

See the [Regions](/core-concepts/regions/) concept guide for an overview.

### List supported regions

```http
GET /v1/regions
```

Public — no API key required.

```json
{ "regions": ["us-east-1", "us-west-2"] }
```

### Create an app

```http
POST /init
Authorization: Bearer {api_key}

{
  "name": "my-app",
  "region": "us-west-2"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | App display name; also used to derive the subdomain. |
| `region` | No | One of the regions returned by `GET /v1/regions`. Defaults to the platform default if omitted. |

Returns `{ app_id, api_base_url, region, ... }`.

### Move an app to another region

```http
POST /v1/apps/{app_id}/move
Authorization: Bearer {api_key}

{ "dest_region": "us-east-1" }
```

Returns `{ migration_id, status: "queued" }`. The app stays available for reads during the move; writes pause briefly during the cutover and resume automatically when the move completes.

### Check move status

```http
GET /v1/apps/{app_id}/migrations/{migration_id}
Authorization: Bearer {api_key}
```

Returns the current step, source and destination regions, and timing.

## Agent guidance

| Method | Path | Purpose |
|--------|------|---------|
| GET | /llms.txt | Plain-text guidance for LLM agents |

Provides quick start patterns, common patterns, error shape, and response metadata.

## App access mode

Control whether anonymous (unauthenticated) requests can reach the data API and realtime WebSocket. See [Access modes](/core-concepts/authentication#access-modes) for the conceptual overview.

| Method | Path | Purpose |
|--------|------|---------|
| PATCH | /v1/\{app_id}/config/access-mode | Toggle between `public` and `authenticated` |
| POST | /v1/\{app_id}/secure | Set `access_mode = "authenticated"` and create user-isolation RLS policies in one call |

### Toggle access mode

```json
PATCH /v1/{app_id}/config/access-mode
Authorization: Bearer {token}

{ "access_mode": "authenticated" }
```

### Secure (composite)

```json
POST /v1/{app_id}/secure
Authorization: Bearer {token}

{
  "tables": [
    { "table_name": "posts", "user_column": "author_id" },
    { "table_name": "comments", "user_column": "user_id", "public_read_column": "is_published" }
  ]
}
```

Pass an empty body or omit `tables` to flip access mode only. Response includes `tables_secured` and a `table_errors` array — failures on individual tables don't roll back the whole call.

## Per-app subdomains

When subdomain routing is enabled, each app has a subdomain derived from its name. Traffic to `https://{subdomain}.{base_domain}` resolves the app from the Host header, so you omit `{app_id}` from paths.

| Subdomain path | Equivalent purpose |
|----------------|-------------------|
| /data/\{table} | Data API CRUD |
| /fn/\{function_name} | Invoke function |
| /auth/signup, /auth/login, ... | End-user auth |
| /storage/upload, /storage/objects, ... | File storage |
| /schema, /schema/apply, /migrations | Schema management |

## Product suggestions

**MCP tool:** `submit_suggestion`

**HTTP:**

```json
POST /suggestions
Authorization: Bearer {api_key}

{
  "category": "feature_request",
  "description": "Add support for GraphQL subscriptions",
  "severity": "medium",
  "source": "human_prompted"
}
```

| Field | Required | Values |
|-------|----------|--------|
| `category` | Yes | `bug_report`, `feature_request`, `improvement`, `documentation` |
| `description` | Yes | Description text |
| `severity` | No | `low`, `medium`, `high`, `critical` |
| `affected_tool` | No | Tool name if applicable |
| `proposed_solution` | No | Suggested fix |
| `source` | No | `agent` or `human_prompted` |

## Health checks

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Liveness check |
| GET | /health/ready | Readiness check (database connectivity) |

## Error format

All errors include structured objects:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Table 'nonexistent' does not exist",
    "remediation": "Check the table name and ensure it exists in your schema",
    "documentation_url": "https://docs.butterbase.ai/api-reference/data-api"
  }
}
```

Follow the `remediation` field before retrying.

## Rate limiting

Sensitive routes (especially auth) have strict per-route rate limits. Other routes may have additional limits depending on deployment configuration.
