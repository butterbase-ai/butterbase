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

## App visibility

Control whether other Butterbase users can discover and clone your app as a template. This is separate from [access mode](#app-access-mode), which controls whether anonymous requests reach the data API. An app can be `visibility="public"` (template-shareable) and `access_mode="authenticated"` (no anonymous data reads) at the same time.

`visibility` defaults to `"private"`. Setting it to `"public"` reserves the flag for when browse-and-clone features ship; that consumer experience is being rolled out in stages and is not yet available in the current release.

| Method | Path | Purpose |
|--------|------|---------|
| PATCH | /v1/\{app_id}/config/visibility | Set `visibility` and optionally `listed` |

### Toggle visibility

```json
PATCH /v1/{app_id}/config/visibility
Authorization: Bearer {token}

{ "visibility": "public" }
```

Response:

```json
{ "message": "Visibility updated to \"public\"", "app_id": "{app_id}", "visibility": "public", "listed": true }
```

`listed` is optional. When `true` (the default for public apps), the app will appear in the upcoming public templates browser. Pass `"listed": false` to keep the app accessible by direct link while hiding it from the browse list.

`visibility` accepts `"public"` or `"private"`. Defaults to `"private"`.

### Read current visibility

`GET /v1/{app_id}/config` returns `visibility` and `listed` alongside the other app settings.

## App repo

Push a codebase to your app as a content-addressed snapshot. Useful as a cross-device backup / source of truth for your app's files. Snapshots are content-addressed: re-pushing an unchanged file does not re-upload it. The last 5 snapshots are retained.

Repo content is stored in your app's object storage under a reserved prefix and is **not** counted as a normal storage object — uploads go through a separate two-phase flow.

Push has two phases:

1. `prepare` — send the manifest (file paths + their sha256 + sizes). Server validates and returns presigned PUT URLs for any blobs it doesn't already have.
2. `commit` — after uploading the listed blobs to S3 with the returned URLs, send the manifest again. Server verifies every blob landed at the declared size, writes the manifest, and points `latest` at the new snapshot.

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/repo/snapshots/prepare | Validate a manifest; receive presigned PUTs for missing blobs |
| POST | /v1/\{app_id}/repo/snapshots/commit | Finalize the snapshot after all blobs are uploaded |
| GET | /v1/\{app_id}/repo/snapshots/latest | Fetch the current snapshot manifest |
| GET | /v1/\{app_id}/repo/snapshots/\{snapshot_id} | Fetch a specific snapshot's manifest |
| GET | /v1/\{app_id}/repo/blobs/\{sha256} | Receive a presigned GET URL for a single blob |
| DELETE | /v1/\{app_id}/repo | Wipe the entire repo |

Reads (`GET`) on a **public** app are anonymous. On a **private** app, only the owner can read or write.

### Manifest shape

```json
{
  "files": [
    { "path": "src/index.ts", "sha256": "<64 hex>", "size": 1234 }
  ],
  "message": "optional push message"
}
```

Paths must be relative, ASCII-safe, contain no `..` segments, no leading `/`, no backslashes, no null bytes, and be at most 4 KB. Hard caps: 10 MB per file, 100 MB per snapshot.

### Prepare

```json
POST /v1/{app_id}/repo/snapshots/prepare
Authorization: Bearer {token}

{ "files": [ { "path": "a.txt", "sha256": "...", "size": 5 } ] }
```

Response:

```json
{
  "snapshot_id": "<64 hex>",
  "total_bytes": 5,
  "file_count": 1,
  "missing_blobs": [ { "sha256": "...", "uploadUrl": "https://..." } ]
}
```

Upload each `missing_blob.uploadUrl` with `PUT`. The presigned URL expires after 10 minutes.

### Commit

```json
POST /v1/{app_id}/repo/snapshots/commit
Authorization: Bearer {token}

{ "manifest": { "files": [ ... ], "message": "..." } }
```

If any blob is still missing or its uploaded size doesn't match the manifest, the response is 409 with `details.missing_shas` and `details.size_mismatches`. Re-upload the listed blobs and re-call commit.

### Pull

```http
GET /v1/{app_id}/repo/snapshots/latest
```

Returns `{ snapshot_id, manifest }`. For each file in the manifest, request `GET /v1/{app_id}/repo/blobs/{sha256}` to receive a presigned GET URL (1 hour expiry), then fetch.

### Wipe

`DELETE /v1/{app_id}/repo` removes every snapshot, blob, and the `latest` pointer. Cannot be undone.

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
