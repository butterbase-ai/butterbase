# Changelog

## Unreleased

### Breaking changes

- **CLI**: `bb keys generate --scope` now takes `account|app` (was an arbitrary string array). Use `--extra-scope <token>` for additional allowlisted scope tokens (`ai:gateway`, `substrate`). Migration: `bb keys generate foo --scope ai:gateway` → `bb keys generate foo --scope account --extra-scope ai:gateway`.

### Added

- **CLI**: `bb keys generate --app <id>` flag (required when `--scope app`; auto-resolved from a `bb.config` in the current directory when absent).
- **control-API / dashboard-API**: `POST /api-keys` body accepts `key_scope`, `target_app_id`, `additional_scopes`.
- **MCP**: `manage_auth_config:generate_service_key` accepts `key_scope` and `additional_scopes`; requires `app_id` when `key_scope === 'app'`.
- **Dashboard**: "Generate API key" dialog: scope radio (account / this app) + app picker + advanced scopes disclosure + scope summary on success.

### Fixed

- `AUTH_IMPERSONATION_FORBIDDEN` is now reachable from public surfaces: users can mint the app-scoped service keys needed to call functions with `auth: required` via `X-Butterbase-As-User`, instead of needing to re-run `journey-deploy`.

---

- **MCP**: `create_agent`, `update_agent`, `delete_agent`, `get_agent`, `list_agents`, and `validate_agent_spec` are removed. Use `manage_agents` with `action: "create" | "update" | "delete" | "get" | "list" | "validate"`.
- **MCP**: `move_app`, `move_app_status`, and `teardown_source_replica` are removed. Use `manage_app` with `action: "move" | "move_status" | "teardown_source_replica"`.

Migration is mechanical — the new actions take the same parameters as the standalone tools they replace, plus the `action` discriminator.

### Added

- **Runtime**: `ctx.caller` on every function invocation surfaces validated caller identity — `{ type: 'service_key' | 'end_user_jwt' | 'loopback' | 'anonymous', keyId, scope, userId }`. Use this instead of parsing `req.headers.authorization` by hand for audit logging or in-function policy checks. `keyId` is a non-secret api-key row id safe to log; `userId` is the user the request is acting on behalf of (propagated through `ctx.invoke` chains and `X-Butterbase-As-User` impersonation). See `core-concepts/functions` → Server-to-server function calls.
- **Runtime**: `ctx.invoke('fn-name', body, opts?)` for same-app function-to-function calls. Authenticated with the per-app internal function key (auto-injected, never exposed via `ctx.env`), `ctx.user.id` propagates automatically to the callee, `ctx.caller.type === 'loopback'`. Cycle guard caps chains at depth 4; the 5th hop throws synchronously with `ctx.invoke loop limit exceeded`. Returns a standard `Response`.
- **Runtime / control-api**: per-function impersonation gate via `X-Butterbase-As-User`. App-scoped service keys (`bb_sk_*` with `app:<this-app>` scope) and same-app loopbacks may set this header; the runtime populates `ctx.user.id` with the asserted id before invoking. The gate is per-function (`app_functions.allow_service_key_impersonation`, default `true`) — flip to `false` on admin-only or billing-webhook handlers and the platform 403s any `X-Butterbase-As-User` header on those endpoints at the edge. End-user JWTs and keys scoped to other apps cannot impersonate. Audit rows on impersonated invocations carry `event_data.impersonated_user_id` for downstream "what was done as me" surfaces.
- **MCP / CLI / SDK / dashboard**: `allow_service_key_impersonation` exposed end-to-end. `deploy_function` accepts the field at deploy time; `manage_function` gains a new action `update_settings` (and the underlying `PATCH /v1/{app_id}/functions/{name}/settings`) to flip it without redeploying code; `bb functions deploy --no-allow-impersonation` for the CLI; `apiClient.updateFunctionSettings()` in `@butterbase/sdk`; a "Security — Service-key impersonation" toggle on the function detail page in the dashboard with cache-invalidation so the new value takes effect immediately.
- **Shared types**: new `FunctionCaller` interface in `@butterbase/shared` mirrors `ctx.caller`. Importable from user function code that wants types on the runtime context.
- **Runtime migration**: `024_function_impersonation_flag.sql` adds `app_functions.allow_service_key_impersonation BOOLEAN NOT NULL DEFAULT true`. Defaults preserve pre-Phase-2 behavior — existing functions keep working without any code changes.

### Changed

- **Clone job**: auto-mints **one** `bb_sk_*` per cloned app instead of one per function. Previously the clone replay minted a distinct key per function, with the label `Auto-mint for clone (<dest_app_id>/<fn_name>)`; cross-function calls that compared the bearer to `ctx.env.BUTTERBASE_API_KEY` therefore 401d because each fn's env held a different key. The new shape labels the key `Auto-mint for clone (<dest_app_id>)` and writes the same value into every fn's env. Existing already-cloned apps are not retroactively fixed by this change — run `scripts/backfill-consolidate-clone-keys.ts` against the affected runtime DBs to consolidate retroactively.

### Deprecated

- **Templates / user code**: the bearer-equality auth pattern in function code is deprecated. Code that compared `req.headers.get('authorization') === \`Bearer ${ctx.env.BUTTERBASE_API_KEY}\`` to decide whether to trust an `as_user_id` body field worked only when every caller and callee shared one key — a coincidence the clone job no longer (and arguably never should have) guaranteed. Replace with `ctx.user.id` (impersonation is now a platform concern, gated per-function) or `ctx.invoke('fn-name', body)` for same-app calls (no bearer involved). The platform will keep accepting the old pattern for back-compat in this release; it will not be removed without a separate breaking-change notice.

### Operational

- **Backfill script**: `scripts/backfill-consolidate-clone-keys.ts` scans every runtime DB for apps whose functions disagree on the value of `BUTTERBASE_API_KEY` / `BB_SUBSTRATE_KEY` and rewrites every function's env to one canonical value (the alphabetically-first existing value — deterministic, no new key mint). Dry-run by default; `--fix` to apply; `--app <id>` to scope to one app. Safe to run multiple times (idempotent), and does not revoke the displaced api_keys rows (orphan revocation is a separate ops task).

- **Runtime**: function `ctx` now surfaces platform-known values so user code doesn't have to set them as env vars by hand. Two parallel surfaces, same source of truth:
  - Flat `ctx.env.BUTTERBASE_*` (muscle-memory `Deno.env`-style):
    - Always present: `BUTTERBASE_APP_ID`, `BUTTERBASE_API_URL`, `BUTTERBASE_APP_NAME`, `BUTTERBASE_REGION`, `BUTTERBASE_ANON_KEY`.
    - Present when configured (omitted otherwise — branch with `typeof === "string"`, not empty-string checks): `BUTTERBASE_FRONTEND_URL`, `BUTTERBASE_SUBDOMAIN`, `BUTTERBASE_STRIPE_ACCOUNT_ID`, `BUTTERBASE_AI_DEFAULT_MODEL`.
  - Structured `ctx.app = { id, name, ownerId, substrateUserId, region, subdomain, anonKey, allowedOrigins, frontend, auth, ai, billing }` with optional sub-objects (`frontend`, `ai`, `billing`) set to `null` when unconfigured. `ctx.app.auth` is always present (`{ accessTokenTtl, refreshTokenTtlDays, hookFunction }`). `ctx.app.substrateUserId` is the linked substrate user id (or `null` when the app is not substrate-linked — `ctx.substrate` is omitted in that case for the same reason).
  - Per-invocation `ctx.request = { id, ip, country, functionName }` derived from `X-Request-Id` / `Fly-Client-Ip` / `Cf-Connecting-Ip` / `X-Forwarded-For` / `Cf-Ipcountry` / `Fly-Region` headers.
  - Platform keys are injected **after** user `envVars` so user-set vars can't shadow them. No new infra; one extended `apps` SELECT in `function-loader.ts`. See `core-concepts/functions` → Platform context.

## [0.3.0] - 2026-06-08

### Added

- **Agents** — multi-step LLM workflows defined declaratively as a graph spec (`spec_version: "1"`), with `llm` / `tool` / `end` nodes, edges, and a `tools` block that combines built-in tools, MCP servers, and user functions. Runtime persists checkpoints between steps so runs resume; events stream over SSE/WebSocket.
- `services/agent-runtime` — Python service that compiles and executes graph specs. Calls upstream models through the existing AI gateway (no separate per-agent keys), enforces per-agent limits (steps, tool calls, parallel tools, wall clock, human timeout), emits `run_start`, `node_start/end`, `tool_call_start/end`, `llm_token_usage`, `run_paused`, `run_cancelled`, `run_failed`, `run_end`.
- Agents REST API on `control-api`: agent CRUD + `validate`, runs (`POST /runs` with body-hash idempotency, `GET`, `cancel`, `resume`, `events.json`, SSE `events`), public-mode runs for `visibility: "public"` agents (with one-time stream tokens, SSE + WebSocket), and MCP-server registration (`list/add/delete/probe`).
- **Function-as-agent-tool**: `app_functions.agent_tool`, `agent_tool_description`, `agent_tool_mode` (`read_only` | `read_write`), `agent_tool_exposed_to` (`developer_only` | `end_user`). The Python runtime loads any function with `agent_tool=true` that's listed in the agent spec's `tools.functions[]`. `read_write` tools pause the run for human approval before mutating.
- **Multi-trigger functions** — functions can now declare multiple triggers as `triggers: [{type, config, enabled}]` (one per type, enforced by a DB unique index). New trigger types `s3_upload` and `webhook` join the existing `http`, `cron`, `websocket`. The webhook handler generates a signed URL and routes verified inbound payloads to the function.
- MCP server agent tools (6): `list_agents`, `get_agent`, `create_agent`, `update_agent`, `delete_agent`, `validate_agent_spec`. `deploy_function` and `manage_function` gain `agent_tool*` parameters and the canonical `triggers` array (legacy singular `trigger` retained).
- CLI: `butterbase agents list|get|create|update|delete`. `butterbase functions deploy` gains `--agent-tool`, `--agent-tool-description`, `--agent-tool-mode`, `--agent-tool-exposed-to`. `butterbase functions list` shows trigger types and a 🤖 marker for agent-exposed functions.
- SDK (`@butterbase/sdk`): `DeployFunctionParams` / `FunctionSummary` / `FunctionDetails` extend a shared `AgentToolFields` mixin; `FunctionSummary.triggers` is the canonical plural array.
- `runtime-plane` migration 020 drops the dead `agents.byok_override` column (added but never read by routes — BYOK is handled at the AI router, not per-agent).
- Docs: new `core-concepts/agents`, `getting-started/agents-quickstart`, `api-reference/agents-api`. Refreshed `core-concepts/functions` and `api-reference/functions-api` for the multi-trigger cutover and `agent_tool*` fields. CLI doc updated with `bb agents` and the new `bb functions deploy` flags.
- Example bundles in `Examples/agents/`:
  - `support-readonly` — triage → answer LLM nodes calling a `read_only` function tool.
  - `approval-hitl` — single LLM node with a `read_write` tool; demonstrates the `run_paused` → approve/deny flow.
  - `mcp-docs` — external MCP server (Stripe docs) referenced via `tools.mcp_servers`.

### Changed

- **`POST /v1/{app_id}/functions`** now canonically accepts `triggers: [{type, config, enabled}]`. The legacy singular `trigger` is still accepted and normalized server-side to a 1-element array via `normalizeTriggers()`. `GET /functions` and `GET /functions/{name}` return the plural `triggers` field; the legacy singular `trigger` is no longer in the response.
- SDK admin types: `FunctionSummary.trigger?: FunctionTrigger` → `triggers?: FunctionTrigger[]`. Response-shape tests updated; request-shape tests retain the singular shorthand to exercise the back-compat shim.
- MCP `manage_function` list response type declares `triggers[]` to match the actual API response.

### Fixed

- `cli functions list` previously read `func.trigger?.type` (which is no longer in the response), causing a literal "undefined" to print. Now reads `triggers[].type` joined.
- Dashboard `FunctionsPage` and `FunctionDetailPage` previously crashed in render on the singular `fn.trigger.type` after any mutation refetch returned the new plural shape. Pages now consume `triggers[]` directly and support add/remove of all 5 trigger types in the editor — no more silent downgrade of webhook/s3_upload/websocket triggers to HTTP on save.
- Dashboard agent editor: model dropdown reads from `useAiCatalog(appId)` (the same source as `AiModelsPage`) instead of a hardcoded 5-entry list, so newer / app-configured models actually appear.
- Dashboard agent editor: cross-references `graph_spec.tools.functions[]` against `useFunctions(appId)` and surfaces a yellow warning when a referenced function either doesn't exist or has `agent_tool=false` (runtime would silently drop these — now caught before save).
- `manage_app` MCP tool tests updated for the consolidated `link_substrate` / `set_clone_webhook` / `unlink_substrate` actions.

### Removed

- `agents.byok_override` column (runtime-plane). Never read by control-api agent routes or the Python runtime; the dashboard's BYOK toggle has also been removed. BYOK as a user-facing concept no longer exists for agents — the platform-level BYOK infrastructure (AI router, key encryption tables, billing attribution) is untouched.

## [0.2.0] - 2026-05-25

### Added
- **Key-Value Store** — first-class KV primitive across SDK (`ctx.kv`), REST (`/v1/:app_id/kv/*`), CLI (`butterbase kv …`), and MCP (`manage_kv`). Regional (us-east-1, us-west-2), per-app quota-protected, `move_app`-aware. See `docs/kv`.
- Customer dashboard KV tab — usage, expose rules, key browser, recent errors.
- Admin dashboard KV page — cluster health, top apps, hotspots.
- `audit_logs` table + `kv-audit-writer` plugin recording every 4xx/5xx KV response.
- Bytes-on-TTL sidecar size index for accurate storage counters across expirations.

### Fixed
- `resolveKvAuth` accepts platform-owner JWTs as apiKey identity (unblocks dashboard KV tab).
- Service-key validation runs before dev escape hatch (MCP/CLI calls now attribute to real owner).
- `PUT /v1/:app_id/kv/_expose` bulk-replace endpoint (unblocks dashboard expose-rule save).
- MCP api-client handles 204 No Content responses without throwing.

## [0.1.0] - 2026-05-20

Initial open-source release.

### What's in the box

- `services/control-api` — Fastify-based control plane for apps, auth, storage, functions, AI gateway
- `services/mcp-server` — Model Context Protocol server exposing backend operations as tools
- `services/agent-runtime`, `services/deno-runtime`, `services/build-runner` — function and frontend execution
- `services/storage-indexer` — async storage indexing
- `services/docs` — public documentation site
- `packages/sdk`, `packages/cli`, `packages/plugin`, `packages/shared` — client surfaces and shared types
- `dispatch-worker`, `bb-placeholder` — Cloudflare Workers infrastructure
- `db/control-plane`, `db/runtime-plane`, `db/data-plane` — schema migrations
- Self-hoster docs, examples, runbooks, e2e tests

### Prior development

Butterbase was developed privately from 2026-02 through 2026-05 by NetGPT Inc. This OSS release represents the data-plane core; multi-region orchestration, billing logic, AI router upstream provider adapters, and managed-service dashboards remain in a private cloud repo that consumes this repo as the source of truth.

### Credit

Lead developer: Kenneth ([@kcflexigbo](https://github.com/kcflexigbo))
