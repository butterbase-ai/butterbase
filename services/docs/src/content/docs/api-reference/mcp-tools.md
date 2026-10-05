---
title: MCP Tools
description: Complete reference for all MCP tools available to AI assistants.
sidebar:
  order: 8
---

The open-source MCP server exposes 38 tools; the hosted platform adds `manage_substrate`. Most areas are consolidated into a single `manage_*` tool that takes an `action` argument (for example `manage_schema` with `action: "apply"`).

These tools are available when connected via MCP. See [MCP Setup](/getting-started/mcp-setup) for connection instructions.

## App Management

| Tool | Description |
|------|-------------|
| `init_app` | Create a new app. Accepts an optional `region` slug. Returns app_id and API base URL. |
| `list_regions` | List the regions an app can be created or moved to. |
| `manage_app` | Comprehensive app management: list/delete/pause, configure access/visibility, move between regions, clone templates, set webhooks. See `manage_app` actions below. |

### manage_app actions

| Action | Description |
|--------|-------------|
| `list` | List all apps with metadata. |
| `delete` | Permanently delete an app. Irreversible. |
| `pause` | Kill-switch — pause/resume all data-plane traffic. Returns 503 (`APP_PAUSED`) on data-plane endpoints while paused. |
| `get_config` | Read app configuration (CORS, JWT, storage limits). |
| `secure` | Set `access_mode = "authenticated"` and create user-isolation RLS policies on the listed `tables` in one call. |
| `update_cors` | Set allowed CORS origins. |
| `update_access_mode` | Toggle anonymous vs authenticated-only access. |
| `set_visibility` | Mark an app public or private, optionally setting the templates-browser `listed` flag. |
| `move` | Move an existing app to another region. Pass `dest_region`. Returns a `migration_id`; the app stays available for reads during the move. |
| `move_status` | Check the progress of a move in flight. Pass `migration_id` (returned by `action: "move"`). |
| `teardown_source_replica` | After a completed move, decommission the retained source-region replica. Pass `migration_id`. |
| `preview_clone_env_vars` | Preview which env vars a source app's functions and Durable Objects need before cloning. Pass `source_app_id`. |
| `find_templates` | Search public, listed app templates. Pass optional `q` (name prefix), `region`, `sort` (`recent` or `popular`), `limit` (max 50), `offset`. Returns `{ items: [...], total, limit, offset }`. |
| `clone` | Clone a public app's repo snapshot into a new app you own. Pass `source_app_id` and optionally `name` and `region`. Returns `{ job_id, status: "pending" }`. |
| `get_clone_job` | Poll the status of a clone job by `job_id`. Returns `status` (`pending`, `completed`, or `failed`), `dest_app_id` when completed, and `error_message` when failed. |
| `set_clone_webhook` | Configure a webhook that fires when someone clones this app. Pass `webhook_url` and `webhook_secret`, or `clear_webhook: true` to remove. |
| `link_substrate` / `unlink_substrate` / `set_substrate_autopropagate` | Link or unlink the app to your substrate and control event auto-propagation. |
| `publish_template_release` / `list_template_releases` / `get_template_release` / `check_template_updates` / `update_from_template` | Publish versioned releases of a template app and let forks check for and pull updates. |
| `get_env` | Read the app-level environment variable **key names** (values are never returned). Returns `{ keys: string[], updated_at }`. See [Environment variables](/core-concepts/functions/#environment-variables). |
| `update_env` | Merge app-level env vars in one call. Pass `env: { KEY: "value" }` to set/upsert, or `env: { KEY: null }` to delete. Values live for every function in the app via `ctx.env.<KEY>`. Response reports `updated_keys` plus the list of functions whose cache was invalidated. Keys matching `/^BUTTERBASE_/i` are rejected as reserved. |

## Schema & Migrations

| Tool | Description |
|------|-------------|
| `manage_schema` | Read, apply, preview, and list schema migrations. See actions below. |
| `manage_migrations` | Read and control in-flight region migrations (complements `manage_app` `move`). |

### manage_schema actions

| Action | Description |
|--------|-------------|
| `get` | Read the current database schema. |
| `apply` | Apply a declarative schema. Pass `schema` and optionally `name`. |
| `dry_run` | Preview the SQL a schema would run without executing it. |
| `list_migrations` | View migration history. |

### manage_migrations actions

| Action | Description |
|--------|-------------|
| `get_active` | Return the running migration for an app, or `{ migration: null }`. |
| `abort` | Cancel a migration that has not yet reached cutover. Pass `migration_id`. |
| `reverse` | Roll a completed migration back to the source region while the source replica is retained. Pass `migration_id`. |
| `list_source_replicas` | List retained source replicas for your apps. |

## Data Operations

| Tool | Description |
|------|-------------|
| `select_rows` | Query rows with filtering, sorting, pagination. |
| `insert_row` | Insert a row into a table. |
| `seed_database` | Bulk-insert up to 100 rows in one call. Bypasses RLS (uses platform role). |

## Authentication & Security

| Tool | Description |
|------|-------------|
| `manage_oauth` | Configure social sign-in providers. |
| `manage_rls` | Manage row-level security on tables. |
| `manage_auth_config` | Auth hook, JWT lifetimes, and service keys. |
| `manage_auth_users` | List or delete an app's end users. |
| `manage_api_keys` | List or revoke platform API keys. |
| `query_audit_logs` | Search auth, admin, and function audit logs. |

### manage_oauth actions

| Action | Description |
|--------|-------------|
| `configure` | Register a social sign-in provider (`provider`, `client_id`, `client_secret`, `redirect_uris`). |
| `get` | List configured OAuth providers, or one by `provider`. |
| `update` | Modify an OAuth provider. |
| `delete` | Remove an OAuth provider. |

### manage_rls actions

| Action | Description |
|--------|-------------|
| `enable` | Enable row-level security on a table. Pass `table_name`. |
| `create_policy` | Create a custom RLS policy (`table_name`, `policy_name`, `command`, `role`, `using_expression`, `with_check_expression`, optional `user_column`). |
| `update_policy` | Modify an existing policy. |
| `create_user_isolation` | Quick user isolation setup. Pass `table_name` and `user_column`, optionally `public_read_column`. |
| `list` | List active RLS policies. |
| `delete` | Remove one policy (`policy_name`) or all policies on a table. |

To set `access_mode` or secure many tables at once, use `manage_app` actions `update_access_mode` and `secure`.

### manage_auth_config actions

| Action | Description |
|--------|-------------|
| `configure_auth_hook` | Configure (or remove) the function invoked after every successful auth event. |
| `update_jwt` | Update access and refresh token lifetimes. |
| `generate_service_key` | Generate a service key. |

### manage_auth_users actions

| Action | Description |
|--------|-------------|
| `list` | List end users (`limit`, `cursor`). |
| `delete` | Delete an end user by `user_id`. |

### manage_api_keys actions

| Action | Description |
|--------|-------------|
| `list` | List API keys (prefix `bb_sk_`). |
| `revoke` | Revoke a key by `key_id`. |

## App Repo

| Tool | Description |
|------|-------------|
| `manage_repo` | Push, pull, inspect, or wipe your app's repo (content-addressed code snapshots). MCP pushes are capped at ~1 MB; for larger snapshots shell out to `butterbase repo push`. |

## Storage

| Tool | Description |
|------|-------------|
| `manage_storage` | Presigned upload/download URLs, file listing and deletion, and storage config. |

### manage_storage actions

| Action | Description |
|--------|-------------|
| `upload_url` | Get a presigned upload URL. Pass `filename`, `content_type`, `size_bytes`. Returns `object_id`. |
| `download_url` | Get a presigned download URL for an `object_id`. |
| `list` | List all files. |
| `delete` | Delete a file by `object_id`. |
| `update_config` | Toggle app-wide public read access and storage limits. |

## Serverless Functions

| Tool | Description |
|------|-------------|
| `deploy_function` | Deploy a TypeScript/JavaScript function. |
| `invoke_function` | Test-invoke a function. |
| `manage_function` | List, inspect, delete, configure, and read logs for deployed functions. |

### manage_function actions

| Action | Description |
|--------|-------------|
| `list` | List deployed functions. |
| `get` | Get a function's details. |
| `delete` | Delete a function. |
| `get_logs` | View invocation logs. |
| `update_env` | Update **function-level** environment variables (overrides app-level values on collision). For env vars shared across every function in the app, use `manage_app` action `update_env` instead. See [Environment variables](/core-concepts/functions/#environment-variables). |
| `update_settings` | Update function settings such as `allow_service_key_impersonation`. |

## Durable Objects

| Tool | Description |
|------|-------------|
| `manage_durable_objects` | Deploy and manage Durable Objects. |

### manage_durable_objects actions

`deploy`, `list`, `get`, `delete`, `usage`, `list_env`, `set_env`, `delete_env`.

## Frontend Deployment

| Tool | Description |
|------|-------------|
| `create_frontend_deployment` | Create deployment and get upload URL. |
| `manage_frontend` | Start deployments, list history, set build env vars, and manage custom domains. |
| `manage_edge_ssr` | Deploy and list Edge SSR (Cloudflare Workers) deployments. |

### manage_frontend actions

| Action | Description |
|--------|-------------|
| `start_deployment` | Start deployment after upload. Pass `deployment_id`. |
| `list_deployments` | View deployment history. |
| `create_from_source` / `start_from_source` | Server-side build flow from a source zip. |
| `set_env` | Configure build environment variables (`vars`). |
| `configure_custom_domain` | Add, list, check status, verify, or remove custom domains via `domain_action` (`add`, `list`, `status`, `verify`, `remove`). |

### manage_edge_ssr actions

`create`, `start`, `create_from_source`, `start_from_source`, `list`.

## Previews

| Tool | Description |
|------|-------------|
| `manage_preview` | Create and manage a preview deployment, a safe copy of the live app. Actions: `create`, `status`, `reset`, `get_env_overrides`, `set_env_overrides`. |
| `promote_preview` | Push a preview's structure and code onto the live app. Actions: `check`, `run`. |

## Realtime

| Tool | Description |
|------|-------------|
| `manage_realtime` | Enable and read realtime configuration. Actions: `configure` (enable realtime on `tables`), `get`. |

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
| `configure_meetings_webhook` | Configure where Butterbase forwards meeting-bot events for this app. Pass `forward_url` and optionally `rotate_secret: true` to mint a fresh signing-secret identifier (returned **once**). The stored hash is used in the `x-bb-key-id` header so your handler can detect post-rotation staleness. |
| `decide` | Constrained decision call over a set of options. |
| `submit_image` / `poll_image` | Submit and poll an async image generation job. |
| `start_meeting` / `get_meeting` / `list_meetings` / `stop_meeting` / `estimate_meeting` | Manage meeting-bot sessions. |
| `usage_meetings` | List recent meeting-bot usage rows for this app — `actor_id`, dimension (`recording` or `transcription`), `seconds`, `usd_charged`, `created_at`. Last 100 rows ordered by time desc. |

For the full HTTP request/response shapes and end-to-end video example, see the [AI API reference](./ai-api.md).

## RAG (Retrieval-Augmented Generation)

| Tool | Description |
|------|-------------|
| `manage_rag_content` | Manage collections and documents. |
| `rag_query` | Semantic search over a collection. Returns ranked chunks; optionally synthesizes an AI answer. |

### manage_rag_content actions

| Action | Description |
|--------|-------------|
| `create_collection` | Create a named collection for storing and querying documents. |
| `list_collections` | List all RAG collections with document counts. |
| `get_collection` | Get one collection. |
| `delete_collection` | Delete a collection and all its documents, chunks, and embeddings. |
| `ingest_document` | Ingest raw text or an uploaded file into a collection. Returns a document ID; processing is async. |
| `list_documents` | List all documents in a collection with status and metadata. |
| `get_document_status` | Poll ingestion status (`pending`, `processing`, `ready`, `failed`). |
| `delete_document` | Delete a document and all its vector chunks. |

## Integrations

| Tool | Description |
|------|-------------|
| `manage_integrations` | Enable toolkits (Gmail, Slack, etc.) and execute their actions. |

### manage_integrations actions

| Action | Description |
|--------|-------------|
| `configure` | Enable a toolkit for an app. |
| `rotate_credentials` | Rotate a toolkit's OAuth credentials. |
| `disable` | Disable a toolkit. |
| `list_available` | List curated toolkits or search the full catalog. |
| `list_connected` | List all users with connected accounts for an app. |
| `list_tools` | List executable tools for a connected toolkit. |
| `execute_action` | Execute a tool on behalf of a user. |

## Agents

| Tool | Description |
|------|-------------|
| `manage_agents` | Manage agent definitions. Actions: `list`, `get`, `create`, `update`, `delete`, `validate`. |

## People (people / company search + enrichment)

| Tool | Description |
|------|-------------|
| `manage_people` | Search for people and companies using structured filters or natural-language queries, enrich profiles by LinkedIn URL (with 30-day cache), and queue async work-email lookups. All metered against the user's Butterbase credits at platform pricing. See [People API](./people-api.md) for HTTP shapes, response payloads, and pricing details. |

Each action is routed to one of two configurable backends (`primary` or `secondary`); routing is operator-controlled at deploy time and not visible to MCP callers.

### manage_people actions

All actions take `{ app_id, action, ... }` where `action` selects the operation.

| Action | Description |
|--------|-------------|
| `search_person` | Search for people using structured filters, a free-form `query`, or both. When `query` is set it takes priority; otherwise structured filters are used. Structured filters: `current_role_title`, `past_role_title`, `current_company_name`, `current_company_industry`, `country`, `region`, `city`, `education_school_name`, `education_degree_name`, `education_field_of_study`, plus `page_size`, `next_token`. Boolean operators in structured fields are honored as ranking hints. Empty searches are free. |
| `search_company` | Search for companies using structured filters, a free-form `query`, or both. Filters: `industry`, `country`, `employee_count_max`, plus `page_size`, `next_token`. |
| `get_profile` | Fetch a full profile by LinkedIn URL with cache. Pass `linkedin_profile_url`. Optional `live_fetch: "force"` skips cache. 2 credits on a cache miss, 0 on a hit (cache TTL: 30d for hits, 7d for not-found, 1h for failed). |
| `queue_email_lookup` | Queue an async work-email lookup. Pass `linkedin_profile_url`. Returns `lookup_id` and `status: "pending"`. Poll with `get_email_lookup`. Charged ~3 credits at queue time and 1 more when the webhook resolves. |
| `set_byok_key` / `clear_byok_key` | Store or remove your own provider key (bring your own key). |
| `get_email_lookup` | Poll an email lookup by `id`. Returns `{ status, email, credits_consumed }`. |

### Search examples

```jsonc
// Semantic query — natural-language description of the ideal match
{
  "action": "search_person",
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "page_size": 25
}

// Structured filters — boolean syntax honored as ranking hints
{
  "action": "search_person",
  "current_role_title": "(VP OR \"Vice President\") AND NOT assistant",
  "education_school_name": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "page_size": 25
}

// Company search
{
  "action": "search_company",
  "industry": "Financial Services",
  "employee_count_max": 200,
  "country": "US"
}

// Profile lookup — cache absorbs duplicates within 30 days
{ "action": "get_profile", "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123" }
```

### Pricing summary

Costs vary by which provider the operator routes the action to. Numbers below are typical defaults; actual cost is always reported in the `x-people-*` response headers and the `usage` body. See [People API](./people-api.md#pricing) for the full table.

| Action | Typical credits | Typical USD |
|---|---|---|
| `search_person` / `search_company` (up to 10 results) | 7 | $0.0084 |
| `get_profile` cache miss | 2 | $0.040 |
| `get_profile` cache hit | 0 | $0 |
| `queue_email_lookup` queue accept | 3 | $0.060 |
| Webhook email resolution | 1 | $0.020 |
| Empty search (0 results) | 0 | $0 |

### Errors

`manage_people` returns `isError: true` with the underlying control-api error text. Common conditions:

- `insufficient_credits` (402) — user's Butterbase balance is below the minimum gate ($0.05 default). No provider call is made.
- `forbidden` (403) — authed user doesn't own the app.
- `people_disabled` (503) — feature flag is off on this deployment.
- `people_unavailable` (503) — feature not enabled or required platform configuration missing on this deployment.
- `provider_not_registered` (503) — operator misconfiguration; no provider configured for the slot this action routed to.
- `provider_action_unsupported` (503) — operator misconfiguration; the configured provider for this slot doesn't support this action.

### Conceptual notes

- **Caching saves real money.** Repeated `get_profile` calls against the same normalized LinkedIn URL within 30 days cost $0. Treat the cache as durable and feel free to re-fetch on render.
- **Searches return 0 credits when there are 0 results** — use a `page_size: 1` probe to preview cost (look at `data.totalResultCount`) before paginating.
- **Async email is genuinely async.** The queue call returns immediately; the email lands minutes later via webhook. Plan your UI for a `pending` state.
- **Phone numbers are not supported** at this tier.

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

## Substrate

> Hosted platform only (butterbase.ai). `manage_substrate` ships with the managed service and is not one of the 38 tools in the open-source MCP server.

All substrate operations are routed through the single `manage_substrate` MCP tool. Pass `{ action, ... }` where `action` selects the operation. The agent's calling user is implicit — there is no `app_id` and no `substrate_user_id`; every call operates on the substrate that belongs to the caller.

| Tool | Description |
|------|-------------|
| `manage_substrate` | Read/write the caller's substrate: propose/approve/reject actions, browse the ledger, look up entities and source artifacts, search memory, manage outbox and attention rules, read snapshots, toggle yolo. See `manage_substrate` actions below. |

### manage_substrate actions

Writes — every substrate write (decisions, commitments, learnings, entities, source artifacts, side-effects) goes through `propose` with the appropriate `capability`.

| Action | Description |
|--------|-------------|
| `propose` | Propose an action. Pass `capability`, `payload`, optional `idempotency_key`, optional `dangerously_skip_approval`. Returns `{ action_id, verdict, requires_approval, result? }`. |
| `approve` | Approve a pending action. Pass `action_id`. |
| `reject` | Reject a pending action. Pass `action_id`, optional `reason`. |

Action ledger.

| Action | Description |
|--------|-------------|
| `list_actions` | List ledger rows. Optional `status` (`proposed` \| `executed` \| `rejected`), `capability`, `source_app_id`, `source_rule_id`, `limit` (1–500, default 100), `before` (ISO timestamp). |
| `get_action` | Fetch one action by `action_id`. |

Entities.

| Action | Description |
|--------|-------------|
| `find_entities` | List/search entities. Optional `type` (`person` \| `company` \| `fund` \| `workspace` \| `team` \| `project` \| `event` \| `agent` \| `self`), `q` (display-name search), `limit` (1–200, default 50). |
| `get_entity` | Fetch one entity by `entity_id`. |

Source artifacts — durable source material (meeting transcripts, email threads, call recordings, documents) that decisions, commitments, and learnings can link back to.

| Action | Description |
|--------|-------------|
| `list_source_artifacts` | List/search artifacts. Optional `kind`, `q` (FTS over title+summary+content), `limit`, `count` (`true` to include `total`). |
| `get_source_artifact` | Fetch one artifact by `artifact_id`, including its full `content`. |

Memory.

| Action | Description |
|--------|-------------|
| `search_memory` | Full-text search across long-form memory. Pass `q`; optional `kinds` (any subset of `decisions`, `commitments`, `learnings`, `source_artifacts` — defaults to all of them), `limit`. |

Outbox.

| Action | Description |
|--------|-------------|
| `list_outbox` | List outbox deliveries. Optional `status`, `limit`. |
| `retry_outbox` | Retry a failed delivery by `outbox_id`. |
| `cancel_outbox` | Cancel a pending delivery by `outbox_id`. |

Attention rules.

| Action | Description |
|--------|-------------|
| `list_rules` | List rules. Optional `enabled` filter. |
| `get_rule` | Fetch one rule by `rule_id`. |
| `create_rule` | Create a rule. Pass `rule` (see [Substrate API](./substrate-api.md#attention-rules) for the body shape). |
| `update_rule` | Update a rule. Pass `rule_id` and `rule`. |
| `delete_rule` | Delete a rule by `rule_id`. |
| `enable_rule` | Enable a rule by `rule_id`. |
| `disable_rule` | Disable a rule by `rule_id`. |
| `list_rule_firings` | List firings for a rule. Pass `rule_id`; optional `status`, `limit`, `before`. |

Snapshots & settings.

| Action | Description |
|--------|-------------|
| `snapshots` | List daily substrate snapshots. Optional `days` (default 7). |
| `get_settings` | Read per-user toggles (yolo mode, etc.). |
| `set_yolo` | Toggle yolo mode. Pass `yolo_mode: true \| false`. |

### manage_substrate example

```json
{
  "tool": "manage_substrate",
  "action": "propose",
  "capability": "upsert_source_artifact",
  "payload": {
    "kind": "meeting_transcript",
    "title": "Weekly product sync — 2026-06-09",
    "external_system": "fireflies",
    "external_id": "abc123",
    "content": "Alice: we should ship phase 6 by Friday…"
  }
}
```

## Billing

| Tool | Description |
|------|-------------|
| `manage_billing` | Account billing. Actions: `status`, `portal`, `topup`, `cap_get`, `cap_raise`, `plans`, `usage`. |

## Partner APIs & Regions

| Tool | Description |
|------|-------------|
| `list_partner_apis` | List partner APIs available to hackathon apps. |
| `list_regions` | List available regions. |

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
