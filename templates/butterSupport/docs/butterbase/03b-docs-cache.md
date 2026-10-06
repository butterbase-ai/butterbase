---
primed_at: 2026-06-18T02:35:00Z
topics: [overview, substrate, schema, rls, auth, storage, functions, ai, rag, realtime, durable-objects, frontend, integrations, sdk]
source_freshness: MCP butterbase_docs + live docs.butterbase.ai (user requested live verification; auth topic was stale in MCP for magic-link)
---

# Docs Cache

Compact reference for build stages. Re-read before any stage that touches the matching capability. Each entry: one paragraph + URL + any gotcha the build stage MUST know.

## overview
Butterbase = Postgres-backed BaaS with per-app isolation, declarative schema, auto-API, RLS, OAuth, JWT, S3-compat storage, Deno functions, MCP gateway, AI gateway (OpenAI-compatible), RAG, Realtime WS, Durable Objects, Edge SSR, frontend hosting. Every capability is reachable via MCP, REST, SDK, and CLI.
URL: https://docs.butterbase.ai/getting-started/introduction/

## substrate
Per-user memory + action coordination plane. `ctx.substrate` is auto-wired in functions when the app is linked to a substrate user (we are: `249d87fa-a4a9-4456-b647-f05221472bc8`). Writes go through `propose(capability, payload, idempotency_key)` returning a verdict (`auto_approved` / `auto_approved_yolo` / `requires_approval` / `rejected`). Side-effect capabilities ALWAYS require human approval, even with yolo_mode on. Outbox targets registered per-capability with HMAC signing secret deliver POSTs to webhook URLs. WS stream at `/v1/me/substrate/stream` for live ledger/entity/rule events (browser exchange one-shot ticket first).
URL: https://docs.butterbase.ai/core-concepts/substrate/
**Gotcha**: outbox does NOT carry row payloads on WS — clients refetch by id. Substrate-scoped key `bb_sub_*` differs from app key `bb_sk_*`.

## schema
Declarative JSON DSL (`manage_schema apply`). Diffs current vs desired, applies safe DDL. Always preview with `dry_run: true` first. Destructive ops blocked by default — use `_drop` (table-level) or `_dropColumns` (column-level). Max 50 tables/app. Supports `vector(N)` for AI embeddings. Mark seed-table rows with `_seed: true` so clones replay them. Singleton-table pattern: `singleton bool default true primary key check (singleton = true)`.
URL: https://docs.butterbase.ai/core-concepts/database/

## rls
Three MCP tools: `enable_rls` (raw enable), `create_user_isolation_policy` (one-call helper + auto-INSERT trigger for `user_column`), `create_policy` (custom — power user). **Always pass `role: "user"`** to scope to authenticated end-users; without role scoping, policies apply to ALL roles and can leak. The custom path uses `current_user_id()` (a SQL function the platform installs) in `using_expression` + `with_check_expression`. `secure_app` MCP action flips `access_mode='authenticated'` AND creates isolation policies in one call. Service-role bypass is auto-created on every RLS-enabled table.
URL: https://docs.butterbase.ai/core-concepts/row-level-security/
**Gotcha**: `create_user_isolation_policy` adds a BEFORE INSERT trigger to auto-populate `user_column`. Our team-membership predicate needs custom `create_policy` per table (it's not a per-row owner check). Use `using_expression: 'EXISTS (SELECT 1 FROM memberships WHERE user_id = current_user_id())'`.

## auth
Native magic-link + email/password + OAuth (any provider). Magic-link: `POST /auth/{app_id}/magic-link` then `/magic-link/verify` with 6-digit code, 15-min expiry, single-use. SDK: `auth.sendMagicLink(email)` + `auth.verifyMagicLink(email, code)`. Frictionless signup — new users auto-created on send. Post-auth hook fires on every successful auth event (`magic_link_login`, `oauth_login`, `signup`, `login`) with `{event, user, isNewUser, provider}` payload, runs as service-role (RLS bypassed), fire-and-forget. Configure via `manage_auth_config configure_auth_hook` with the function name. Update JWT TTLs via `update_jwt`.
URL: https://docs.butterbase.ai/core-concepts/authentication/ + https://docs.butterbase.ai/api-reference/auth-api/
**Gotcha**: MCP `butterbase_docs auth` topic was missing magic-link earlier in this session — always cross-check live docs for auth specifics. SDK methods confirmed live.

## storage
Presigned URL upload + download. Upload URLs expire in 5 min, download URLs in 1 hour. **Default max file size = 10MB, default total = 1GB per app.** Our plan calls for 25MB per file — must call `manage_storage update_config` with `maxFileSizeMb: 25` during journey-storage. Per-object `public: true` flag exists for individually-public objects; app-wide `publicReadEnabled` exists too. `objectId` is the durable reference (UUID) — store this, NOT `objectKey` (path) or expiring URLs. Service-role uploads have null `user_id`.
URL: https://docs.butterbase.ai/core-concepts/storage/
**Gotcha**: `objectKey` is a path, NOT a URL. Storing `objectKey` in a column called `image_url` is the #1 mistake — generates broken images. Always re-mint download URLs via `getDownloadUrl(objectId)`.

## functions
Deno runtime, TS/JS. Triggers: HTTP, cron, WebSocket. `ctx` provides: `env` (function env vars), `db` (DB access; `db.asUser(id, cb)` to run as a specific end-user with RLS enforced; `db.asAnon(cb)`), `user` (current end-user when JWT-invoked), `idempotency.claim(key, {scope, ttlSeconds})` (atomic dedupe via `_idempotency_keys` system table — runtime never cleans up, write a cron), `substrate` (auto-wired), `integrations.asUser(userId).execute(tool, params)` (Composio canonical form — no env API key needed). Function-specific env vars via `ctx.env.VAR`. Deploy via `deploy_function` MCP. Default 30s timeout, max 300s; 128MB RAM default, max 1024MB. Service-key (`butterbase_service`) bypasses RLS — used when invoked via API key or cron.
URL: https://docs.butterbase.ai/core-concepts/serverless-functions/
**Gotcha**: cron-invoked = `ctx.user` is null + service-role. Functions invoked with JWT see `ctx.user.id`. The `x-user-id` header is auto-set when an end-user token is present.

## ai
OpenAI-compatible gateway. `POST /v1/{app_id}/chat/completions` and `/embeddings`. Supports Claude (Anthropic), GPT (OpenAI), Llama, Gemini, etc. Vision/multimodal supported on `claude-sonnet-4.6`, `gpt-4o`, `gemini-pro-vision`. Streaming via `"stream": true`. `manage_ai update_config` sets `defaultModel`, `maxTokensPerRequest` (1-100k), `allowedModels` (lock list to prevent runaway model use). BYOK config is separate (out of scope until customers configure). Usage tracked: `GET /v1/{app_id}/ai/usage`. Embedding models: `openai/text-embedding-3-small` (1536d, matches schema default), `text-embedding-3-large` (3072d).
URL: https://docs.butterbase.ai/core-concepts/ai-gateway/
**Gotcha**: Pro plan $10/mo AI credits; Free plan $0.10 lifetime. Overage at $0.10/credit. Inside functions, the runtime injects `BUTTERBASE_APP_ID` + `BUTTERBASE_API_URL` but NOT `BUTTERBASE_API_KEY` — set that explicitly via envVars at deploy time.

## rag
Built on pgvector. Collections (`access_mode: private|shared|custom`). `manage_rag_content` for collection + document ops: `create_collection`, `ingest` (text OR `storage_object_id` from upload), `status`, `list`, `delete`. `rag_query` for retrieval: `top_k`, `threshold`, `filter` (metadata), `synthesize: false` returns raw chunks, `synthesize: true` returns an AI-generated answer (default model `claude-haiku-4.5`). Ingestion is async (`pending → processing → ready`).
URL: https://docs.butterbase.ai/core-concepts/rag/
**Gotcha**: Embedding costs count against AI credits. Supported file types via storage upload: PDF, TXT, MD, CSV, HTML, DOCX, XLSX, PPTX. Our plan deliberately uses `synthesize: false` so the agent's main LLM call sees raw chunks (for citations + confidence gating).

## realtime
`ws://api.butterbase.local/v1/{app_id}/realtime` (or `wss://api.butterbase.ai/...`). Browser: pass JWT as `?token=` query param (WebSocket API can't set custom headers). Subscribe per table with optional `filter: {column: value}` for exact-column subscriptions. RLS enforced — `butterbase_user` subscribers only receive changes for rows they can SELECT. Frames: `connected`, `subscribed`, `change` (with `record` + `old_record` + `op`), `heartbeat`, `error`. **Presence tracking built-in** via `presence_track` / `presence_update` / `presence_state` — could surface "Alice is viewing this ticket" without bespoke code. **WebSocket triggers** are a thing — functions with `trigger: { type: "websocket", config: { event } }` fire on client-sent custom events, response returned synchronously.
URL: https://docs.butterbase.ai/core-concepts/realtime/
**Gotcha**: Events during LISTEN reconnection may be lost — clients should re-fetch state on reconnect. Whole row sent on change (no column filtering yet).

## durable-objects
Stateful per-key actors via Cloudflare Workers. Each DO = `class + instance_id`. URL: `https://<subdomain>.butterbase.dev/_do/<name>/<instance>`. Same URL accepts HTTP and WebSocket upgrade. **Constraints**: single-file source, no npm imports (only `cloudflare:workers`), 5 DO classes per app max, 10MB bundle (sum compressed), 128KB per `state.storage` KV value, `state.storage` is transactional. **No service bindings** — functions/Edge SSR must reach DOs via HTTP fetch, not env bindings. Deploy: `butterbase do deploy file.ts --name X` (CLI) or `deploy_durable_object` (MCP). Re-deploying evicts in-memory instances; KV survives. Class rename not supported. Class delete is permanent.
URL: https://docs.butterbase.ai/core-concepts/durable-objects/
**Gotcha**: Authenticated mode rejects WS upgrades without bearer token. For our DO: founder UI must pass `Authorization: Bearer <jwt>` on the upgrade or `?token=<jwt>` query param (same pattern as realtime). The DO verifies team-member status in its `fetch` handler.

## frontend
Frontend Deployment for static SPAs (Vite, Next static, plain HTML). Deploy flow: `create_frontend_deployment` → upload zip via presigned URL → `manage_frontend start_deployment`. SPA `_redirects` auto-injected. Env vars set separately via `manage_frontend set_env` — must be `VITE_*` for Vite, `NEXT_PUBLIC_*` for Next.js (injected at build time, NOT runtime). **Max deployment size: 100MB compressed**. **Free plan: 1 active deployment per app** (replaces on redeploy). Pro+: unlimited deployments. After `READY`, Cloudflare edge takes minutes — verify via HTTP GET before claiming live.
URL: https://docs.butterbase.ai/core-concepts/frontend-deployment/
**Gotcha 1**: **Zip must use forward slashes inside entry paths.** Windows Explorer's "Send to → Compressed folder" and PowerShell `Compress-Archive` produce backslash entries → Cloudflare can't match paths → JS served as `text/html` → broken site. Use the Node `archiver` script (cross-platform) or `cd dist && zip -r ../frontend.zip .` from Git Bash/WSL. Document this in the recipe README for cloners on Windows.
**Gotcha 2**: **Our plan needs TWO frontend deployments** (console + widget). On free plan, that's not possible (1 active deployment limit). Either (a) bundle widget into the console's zip and serve `widget.js` as a static asset alongside `index.html` (with a `_redirects` rule to NOT route `/widget.js` to SPA fallback), or (b) require Pro plan. **Recommend (a)** for OSS-clone simplicity.

## integrations
Composio-backed. Curated toolkits: gmail, slack, google-calendar, github, hubspot, notion, outlook, google-drive, google-sheets, discord. 1000+ via search. Per-app config: `manage_integrations configure` (admin one-time), `connect` (end-user OAuth), `execute_action` (run tool on user's connected account). **Canonical pattern inside functions: `ctx.integrations.asUser(userId).execute(toolName, params)`** — function-key auto-recognized for same-app calls; no need to set `BUTTERBASE_API_KEY` as env var for integration calls. Tool catalog discoverable via `list_tools(toolkit)`.
URL: https://docs.butterbase.ai/core-concepts/integrations/
**Gotcha**: User must connect their account first (OAuth flow via `connect`). Our `execute-escalation` function reads which user's account to send-as from `escalation_targets.config` — that user's `team_integrations` row must have a live Composio connection for the chosen toolkit, OR we use a service-account model where the founder connects once and all escalations send from that account.

## sdk
`@butterbase/sdk` — works browser + Node + Deno. Auth: `signUp`, `signIn`, `sendMagicLink`, `verifyMagicLink`, `signInWithOAuth`, `getUser`, `signOut`, `refreshSession`, `onAuthStateChange`. Data: `bb.from(table).select/insert/update/delete().eq()/.order()/.limit()/.offset()`. Storage: `bb.storage.upload(file)`, `getDownloadUrl(objectId)`, `list()`, `delete()`. Functions: `bb.functions.invoke(name, {body, method})`. Sessions auto-persist to localStorage + auto-refresh access tokens. SDK has an `admin.*` namespace (schema, rls, oauth, config, functions, frontend, realtime, domains, apiKeys, auditLogs) for service-key contexts.
URL: https://docs.butterbase.ai/sdks-and-tools/typescript-sdk/
**Gotcha**: `authUrl` parameter was removed in 1.0 — use just `apiUrl`. The SDK has `bb.realtime.subscribe(table, cb)` for the realtime WS pattern.

---

# Plan adjustments triggered by this docs verification

These should fold into `02-plan.md` before journey-schema starts:

1. **Storage maxFileSizeMb = 25** (default is 10). Add to journey-storage stage: `manage_storage update_config maxFileSizeMb: 25` for the `docs_uploads` bucket.

2. **One frontend deployment containing both console + widget.** Bundle the widget as a static asset at `/widget.js` inside the console's zip. Free-plan-friendly. Add a `_redirects` rule to NOT route `/widget.js` and `/widget.css` to the SPA fallback. Plan section "Frontend → Deployment" must be revised.

3. **Composio escalation pattern**: `execute-escalation` uses `ctx.integrations.asUser(connected_user_id).execute(...)` — no separate API key plumbing. Connected user comes from `escalation_targets.config.connected_user_id` (added field). Founder connects Slack + Gmail once in `/settings/integrations`; the team_integrations row stores `composio_account_id` + `user_id` (the founder's). Add `connected_user_id` to `escalation_targets.config` schema.

4. **Realtime presence is "free"** — could power a "team members viewing this ticket" indicator in v1 without bespoke code. Optional UX nice-to-have; not blocking.

5. **Magic-link endpoints confirmed live** — `auth.sendMagicLink` + `auth.verifyMagicLink` in SDK. Our Auth section is correct.

6. **`butterbase do deploy` is the CLI command** to ship the SupportTicketDO bundle. Already in plan toolchain section.

7. **DO WS upgrade needs `Authorization: Bearer` or `?token=` query param** — same pattern as Realtime. Console `<TicketDetail>` must pass the user's JWT. Already implied in plan but worth confirming during journey-durable.
