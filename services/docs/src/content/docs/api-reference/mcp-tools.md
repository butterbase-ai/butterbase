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
| `manage_app` | Comprehensive app management: list/delete/pause, configure access/visibility, move between regions, clone templates, set webhooks. See `manage_app` actions below. |

### manage_app actions

| Action | Description |
|--------|-------------|
| `list` | List all apps with metadata. |
| `delete` | Permanently delete an app. Irreversible. |
| `pause` | Kill-switch — pause/resume all data-plane traffic. Returns 503 (`APP_PAUSED`) on data-plane endpoints while paused. |
| `get_config` | Read app configuration (CORS, JWT, storage limits). |
| `update_cors` | Set allowed CORS origins. |
| `update_access_mode` | Toggle anonymous vs authenticated-only access. |
| `set_visibility` | Mark an app public or private, optionally setting the templates-browser `listed` flag. |
| `move` | Move an existing app to another region. Pass `dest_region`. Returns a `migration_id`; the app stays available for reads during the move. |
| `move_status` | Check the progress of a move in flight. Pass `migration_id` (returned by `action: "move"`). |
| `teardown_source_replica` | After a completed move, decommission the retained source-region replica. Pass `migration_id`. |
| `find_templates` | Search public, listed app templates. Pass optional `q` (name prefix), `region`, `sort` (`recent` or `popular`), `limit` (max 50), `offset`. Returns `{ items: [...], total, limit, offset }`. |
| `clone` | Clone a public app's repo snapshot into a new app you own. Pass `source_app_id` and optionally `name` and `region`. Returns `{ job_id, status: "pending" }`. |
| `get_clone_job` | Poll the status of a clone job by `job_id`. Returns `status` (`pending`, `completed`, or `failed`), `dest_app_id` when completed, and `error_message` when failed. |
| `set_clone_webhook` | Configure a webhook that fires when someone clones this app. Pass `webhook_url` and `webhook_secret`, or `clear_webhook: true` to remove. |

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
| `set_visibility` | Mark an app public or private as a template, optionally setting the templates browser `listed` flag. |
| `secure_app` | Set `access_mode = "authenticated"` and create user-isolation RLS policies on listed tables in one call. |
| `configure_auth_hook` | Configure (or remove) the function invoked after every successful auth event. |

## App Repo

| Tool | Description |
|------|-------------|
| `manage_repo` | Push, pull, inspect, or wipe your app's repo (content-addressed code snapshots). MCP pushes are capped at ~1 MB; for larger snapshots shell out to `butterbase repo push`. |

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
| `configure_meetings_webhook` | Configure where Butterbase forwards meeting-bot events for this app. Pass `forward_url` and optionally `rotate_secret: true` to mint a fresh signing-secret identifier (returned **once**). The stored hash is used in the `x-bb-key-id` header so your handler can detect post-rotation staleness. |
| `usage_meetings` | List recent meeting-bot usage rows for this app — `actor_id`, dimension (`recording` or `transcription`), `seconds`, `usd_charged`, `created_at`. Last 100 rows ordered by time desc. |

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

## People (people / company search + enrichment)

| Tool | Description |
|------|-------------|
| `manage_people` | Search LinkedIn people/companies with structured filters, enrich profiles by URL (with 30-day cache), and queue async work-email lookups. All metered against the user's Butterbase credits at platform pricing. See [People API](./people-api.md) for HTTP shapes, response payloads, and pricing math. |

Each action is routed to one of two configurable backends (`primary` or `secondary`); routing is operator-controlled at deploy time and not visible to MCP callers.

### manage_people actions

All actions take `{ app_id, action, ... }` where `action` selects the operation.

| Action | Description |
|--------|-------------|
| `search_person` | Structured-filter search for people. Every filter accepts boolean syntax (`OR`, `AND`, `NOT`, parens, double-quoted phrases). Filters: `current_role_title`, `past_role_title`, `current_company_name`, `current_company_industry`, `country`, `region`, `city`, `education_school_name`, `education_degree_name`, `education_field_of_study`, plus `page_size`, `next_token`, `enrich_profiles`. Costs 3 credits per result returned. Empty searches are free. |
| `search_company` | Structured-filter search for companies. Filters: `industry`, `country`, `employee_count_max`, plus `page_size`, `next_token`, `enrich_profiles`. |
| `get_profile` | Fetch a full LinkedIn profile by URL with cache. Pass `linkedin_profile_url`. Optional `live_fetch: "force"` skips cache. 2 credits on a cache miss, 0 on a hit (cache TTL: 30d for hits, 7d for not-found, 1h for failed). |
| `queue_email_lookup` | Queue an async work-email lookup. Pass `linkedin_profile_url`. Returns `lookup_id` and `status: "pending"`. Poll with `get_email_lookup`. People charges ~3 credits at queue time and 1 more when the webhook resolves. |
| `get_email_lookup` | Poll an email lookup by `id`. Returns `{ status, email, credits_consumed }`. |
| `get_credit_balance` | Read the platform's People credit balance (not the user's Butterbase balance). Doesn't deduct credits. |

### Boolean syntax examples

```jsonc
// VPs from top colleges
{
  "action": "search_person",
  "current_role_title": "(VP OR \"Vice President\") AND NOT assistant",
  "education_school_name": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "page_size": 25
}

// CTOs at fintech startups under 200 employees
{
  "action": "search_company",
  "industry": "Financial Services",
  "employee_count_max": 200,
  "country": "US"
}

// Profile lookup — cache absorbs duplicates
{ "action": "get_profile", "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123" }
```

### Pricing summary (default rate ≈ $0.02016 / People credit)

| What | Cost |
|---|---|
| `search_person`/`search_company` (URLs only) | 3 credits × results returned (~$0.06/result) |
| Same with `enrich_profiles: true` | 3 + N per result (~$0.12+/result) |
| `get_profile` cache miss | 2 credits (~$0.04) |
| `get_profile` cache hit | 0 |
| `queue_email_lookup` queue accept | 3 credits (~$0.06) |
| Webhook resolution callback | 1 credit (~$0.02) |
| `get_credit_balance` | 0 |

### Errors

`manage_people` returns `isError: true` with the underlying control-api error text. Common conditions:

- `insufficient_credits` (402) — user's Butterbase balance is below the minimum gate ($0.05 default). No vendor call is made.
- `forbidden` (403) — authed user doesn't own the app.
- `people_disabled` (503) — feature flag is off on this deployment.
- `people_unavailable` (503) — platform key not configured or `PEOPLE_WEBHOOK_HOST_URL` missing for async email.

### Conceptual notes

- **Caching saves real money.** Repeated `get_profile` calls against the same normalized LinkedIn URL within 30 days cost $0. Treat the cache as durable and feel free to re-fetch on render.
- **Searches return 0 credits charged when there are 0 results** — use a `page_size: 1` probe to preview cost (look at `data.totalResultCount`) before paginating.
- **Async email is genuinely async.** The queue call returns immediately; the email lands minutes later via webhook. Plan your UI for a `pending` state.
- **Phone numbers are not supported** — People doesn't expose them. Layer a second vendor when needed.

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
