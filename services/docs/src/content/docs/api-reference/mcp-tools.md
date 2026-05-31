---
title: MCP Tools
description: Complete reference for all MCP tools available to AI assistants.
sidebar:
  order: 8
---

These tools are available when connected via MCP. See [MCP Setup](/getting-started/mcp-setup) for connection instructions.

## App Management

| Tool | Description |
|------|-------------|
| `init_app` | Create a new app. Accepts an optional `region` slug. Returns app_id and API base URL. |
| `list_regions` | List the regions an app can be created or moved to. |
| `move_app` | Move an existing app to another region. |
| `move_app_status` | Check the progress of an app move. |
| `list_apps` | List all apps with metadata. |
| `delete_app` | Permanently delete an app. Irreversible. |
| `pause_app` | Kill-switch — pause/resume all data-plane traffic. Returns 503 (`APP_PAUSED`) on data-plane endpoints while paused. |
| `get_app_config` | Read app configuration (CORS, JWT, storage limits). |
| `update_cors` | Set allowed CORS origins. |
| `update_jwt_config` | Configure access/refresh token lifetimes. |
| `update_app_access_mode` | Toggle anonymous vs authenticated-only access. |
| `set_visibility` | Mark an app public or private, optionally setting the templates-browser `listed` flag. |
| `generate_service_key` | Generate a `bb_sk_` API key. Shown only once. |

## Schema & Migrations

| Tool | Description |
|------|-------------|
| `get_schema` | Read current database schema. |
| `apply_schema` | Apply declarative schema. Set `dry_run: true` to preview. |
| `dry_run_schema` | Preview SQL without executing. |
| `list_migrations` | View migration history. |

## Data Operations

| Tool | Description |
|------|-------------|
| `select_rows` | Query rows with filtering, sorting, pagination. |
| `insert_row` | Insert a row into a table. |
| `seed_database` | Bulk-insert up to 100 rows in one call. Bypasses RLS (uses platform role). |

## Authentication & Security

| Tool | Description |
|------|-------------|
| `configure_oauth_provider` | Register a social sign-in provider. |
| `get_oauth_config` | List configured OAuth providers. |
| `update_oauth_provider` | Modify an OAuth provider. |
| `delete_oauth_provider` | Remove an OAuth provider. |
| `enable_rls` | Enable row-level security on a table. |
| `create_policy` | Create a custom RLS policy. |
| `create_user_isolation_policy` | Quick user isolation setup. |
| `get_rls_policies` | List active RLS policies. |
| `delete_rls_policy` | Remove RLS from a table. |
| `query_audit_logs` | Search auth audit logs. |
| `update_app_access_mode` | Toggle an app's data-API access between `public` and `authenticated`. |
| `secure_app` | Set `access_mode = "authenticated"` and create user-isolation RLS policies on listed tables in one call. |
| `configure_auth_hook` | Configure (or remove) the function invoked after every successful auth event. |

## Storage

| Tool | Description |
|------|-------------|
| `generate_upload_url` | Get a presigned upload URL. |
| `generate_download_url` | Get a presigned download URL. |
| `get_storage_objects` | List all files. |
| `delete_storage_object` | Delete a file. |
| `update_storage_config` | Toggle app-wide public read access for storage objects. |

## Serverless Functions

| Tool | Description |
|------|-------------|
| `deploy_function` | Deploy a TypeScript/JavaScript function. |
| `list_functions` | List deployed functions. |
| `invoke_function` | Test-invoke a function. |
| `delete_function` | Delete a function. |
| `update_function_env` | Update environment variables. |
| `get_function_logs` | View invocation logs. |

## Frontend Deployment

| Tool | Description |
|------|-------------|
| `create_frontend_deployment` | Create deployment and get upload URL. |
| `start_frontend_deployment` | Start deployment after upload. |
| `list_frontend_deployments` | View deployment history. |
| `set_frontend_env` | Configure build environment variables. |

## Realtime

| Tool | Description |
|------|-------------|
| `configure_realtime` | Enable realtime on tables. |
| `get_realtime_config` | View realtime configuration. |

## AI Gateway

All AI actions are routed through the single `manage_ai` MCP tool. Pass `{ app_id, action, ... }` where `action` selects the operation.

| Action | Description |
|--------|-------------|
| `chat` | Synchronous chat completion (OpenAI-compatible). Pass `messages`, optional `model`, `temperature`, `max_tokens`. |
| `embed` | Generate vector embeddings. Pass `input` (string or array), optional `model`, `encoding_format`. |
| `list_models` | List models available through the app's gateway (chat, embedding, and video). |
| `get_config` | Read the app's AI configuration (default model, allowed models, max tokens). |
| `update_config` | Update AI configuration. Can rotate BYOK keys, set default model, set allowed models. |
| `get_usage` | Aggregate token counts and credit spend over a date window. |
| `submit_video` | Submit an async video generation job. Pass `model`, `prompt`, optional `duration`, `resolution`, `aspect_ratio`, `generate_audio`, `seed`. Returns `{ job_id, status, polling_url }`. |
| `poll_video` | Poll a video job's status. Pass `job_id`. Returns the current job state including `content_urls` (absolute) and `charged_credits_usd` when `status === 'completed'`. |

For the full HTTP request/response shapes and end-to-end video example, see the [AI API reference](./ai-api.md).

## RAG (Retrieval-Augmented Generation)

| Tool | Description |
|------|-------------|
| `rag_create_collection` | Create a named collection for storing and querying documents. |
| `rag_list_collections` | List all RAG collections with document counts. |
| `rag_delete_collection` | Delete a collection and all its documents, chunks, and embeddings. |
| `rag_ingest` | Ingest raw text or an uploaded file into a collection. Returns a document ID; processing is async. |
| `rag_ingest_status` | Poll ingestion status (`pending` → `processing` → `ready` / `failed`). |
| `rag_query` | Semantic search over a collection. Returns ranked chunks; optionally synthesizes an AI answer. |
| `rag_list_documents` | List all documents in a collection with status and metadata. |
| `rag_delete_document` | Delete a document and all its vector chunks. |

## Integrations

| Tool | Description |
|------|-------------|
| `configure_integration` | Enable a toolkit (Gmail, Slack, etc.) for an app. |
| `list_available_integrations` | List curated toolkits or search the full catalog. |
| `list_integration_tools` | List executable tools for a connected toolkit. |
| `execute_integration_action` | Execute a tool on behalf of a user. |
| `list_connected_accounts` | List all users with connected accounts for an app. |

## KV Store

| Tool | Description |
|------|-------------|
| `manage_kv` | Manage app KV store: config rules (expose/unexpose namespaces) and data-plane operations (get/set/del/incr/etc). |

### manage_kv actions

| Action | Description |
|--------|-------------|
| `list_rules` | List all KV namespace exposure rules for the app |
| `expose` | Expose a key pattern with read/write role access control |
| `unexpose` | Remove an exposure rule by pattern |
| `stats` | Get KV usage stats (key count, memory, etc.) |
| `scan` | Scan keys by prefix (cursor-based pagination) |
| `flush` | Delete all keys in the KV store (requires confirm: true) |
| `get` | Get the value of a key |
| `set` | Set a key to a value with optional TTL or ephemeral flag |
| `del` | Delete one key |
| `incr` | Increment a key's integer value |
| `decr` | Decrement a key's integer value |
| `setnx` | Set a key only if it does not already exist |
| `setex` | Set a key with an explicit TTL in seconds |
| `cas` | Compare-and-swap: atomically set next only if current value matches expected |
| `exists` | Check if a key exists |
| `ttl` | Get remaining TTL of a key in seconds |
| `expire` | Set a TTL on an existing key |
| `mget` | Get values of multiple keys at once |
| `mset` | Set multiple key-value pairs at once |

### manage_kv example

```json
{
  "action": "manage_kv",
  "app_id": "app_abc123",
  "action": "set",
  "key": "counter:requests",
  "value": 42,
  "ttl": 3600
}
```

## Custom Domains

| Tool | Description |
|------|-------------|
| `configure_custom_domain` | Add, list, check status, verify, or remove custom domains. Actions: `add`, `list`, `status`, `verify`, `remove`. |

## Hackathon

These tools are listed whenever any hackathon's submission window is open. Multiple hackathons can be open simultaneously; tools that target one require an explicit `hackathon_slug`. See [Hackathon](/hackathon).

| Tool | Description |
|------|-------------|
| `prep_and_submit_hackathon_entry` | Two-step flow. `action: "prep"` resolves the hackathon from your `submission_code` and returns its `field_schema` plus a `next_call` template — a fully-formed example `submit` invocation with a placeholder per field. `action: "submit"` sends the confirmed `data` (use `matched.slug` from prep as `hackathon_slug`). First submission also needs `submission_code`. Pass `app_id` (from `manage_app` `list`) so automated scoring can award feature points and judges can verify your app. |

## Feedback & Documentation

| Tool | Description |
|------|-------------|
| `submit_suggestion` | Submit feedback, bug reports, or feature requests. |
| `butterbase_docs` | Read documentation by topic. |
