---
primed_at: 2026-06-02T07:05:00Z
topics: [overview, platform, schema, auth, storage, functions, ai, realtime, frontend, sdk, cli, substrate]
---

# Docs Cache

## schema
Declarative JSON DSL. PKs use `uuid` + `default "gen_random_uuid()"`. FKs via `references: {table, column}`. Indexes named under `indexes`. Destructive ops blocked unless `_drop:true` / `_dropColumns: [...]`. Always run with `dry_run:true` first via `manage_schema action:"apply"`. Max 50 tables per schema definition. RLS helper `create_user_isolation` only does single-column ownership — for our membership-join model we'll need custom SQL via `manage_rls`.
URL: https://docs.butterbase.ai/schema

## auth
Per-app end-user auth at `/auth/{app_id}/...`. Email/password (signup → 6-digit verify → login), refresh-token rotation, password reset, social OAuth (Google built-in needs only client_id/secret/redirect_uris via `manage_oauth action:"configure"`). Access token default 1h, refresh 7d, configurable via `manage_auth_config action:"update_jwt"`. JWKS at `/auth/{app_id}/.well-known/jwks.json` for in-house verification. Custom JWT claims are NOT a documented feature here — we collapsed `mint-workspace-jwt` and use membership-join RLS instead.
URL: https://docs.butterbase.ai/auth

## storage
Presigned upload (`POST /storage/{app_id}/upload` → `{uploadUrl, objectId, objectKey, expiresIn:300}`) then PUT directly to S3-compatible bucket. Persist **`objectId`** only — `objectKey` is NOT a URL; `uploadUrl`/`downloadUrl` expire (1h download). Showing images: call `getDownloadUrl(objectId)` per render, `Promise.all` in lists. Per-object `public:true` flag (set at upload) lets unauth'd users download — that's our path for D1 seed-workspace logos. Defaults: 10 MB/file, 1 GB total — bump file cap to 25 MB for attachments via `manage_storage action:"update_config"`. (Update at storage stage: `update_config` does not expose file size; 10MB accepted for v1.)
URL: https://docs.butterbase.ai/storage

## functions
TypeScript/JS, default-exported `handler(req, ctx)`. RLS-aware role: end-user JWT → `butterbase_user`; API key or cron → `butterbase_service` (RLS bypassed). Use `ctx.db.asUser(userId, cb)` to drop down to user-scoped queries from a service function. `ctx.idempotency.claim(key, {scope})` for webhook dedupe. Function env vars via `ctx.env`. Logs via `manage_function action:"get_logs"`. HTTP path: `ANY /v1/{app_id}/fn/{name}` — frontend forwards the user's bearer token. **Critical gotcha discovered:** `butterbase_service` lacks `CREATE` on `public` schema — `CREATE FUNCTION`/`CREATE TRIGGER` from a function returns `permission denied for schema public`. This forced B1→B2 (app-code activity logging instead of DB triggers).
URL: https://docs.butterbase.ai/functions

## ai
OpenAI-compatible: `POST /v1/{app_id}/chat/completions`. Inside a function, runtime auto-injects `BUTTERBASE_APP_ID` + `BUTTERBASE_API_URL` into `ctx.env`; pass `BUTTERBASE_API_KEY` as a function env var. Model id for our plan: `anthropic/claude-haiku-4.5`. AI credits: $0.10 lifetime Free / $10/mo Pro + $0.10 overage. `summarize-company` fits well under Free (verified $0.000044 for a PONG test).
URL: https://docs.butterbase.ai/ai

## realtime
`manage_realtime action:"configure"` with table list installs triggers + pg_notify. Browser connect: `wss://api.butterbase.ai/v1/{app_id}/realtime?token={user_jwt}` (no custom headers possible). After `connected`, send `{type:"subscribe", table:"companies"}` (etc). Server pushes `{type:"change", op, table, record, old_record}`. RLS enforced — `butterbase_user` only gets rows they could `SELECT`. Filters are single-column exact match (e.g. workspace_id) which is exactly what we need to scope team feeds. Presence available but skipped per Q9 option 1.
URL: https://docs.butterbase.ai/realtime

## frontend
Upload zip via `create_frontend_deployment` → PUT `uploadUrl` → `manage_frontend action:"start_deployment"` → poll until `READY` (then verify with HTTP GET; CDN propagation can be minutes). Framework: `react-vite` (zip the **contents** of `dist/`, not the folder itself). **Critical: zip must use forward slashes** — use Node `archiver` to produce `frontend.zip` on macOS too. Env vars via `manage_frontend action:"set_env"` (only keys returned on list). Auto `_redirects` for SPA routing.
URL: https://docs.butterbase.ai/frontend

## sdk
`@butterbase/sdk`. `createClient({appId, apiUrl, anonKey?})`. `.from('companies').select('*').eq('workspace_id', id).order('updated_at', {ascending: false})`. Auth: `auth.signIn`, `auth.signInWithOAuth({provider:'google', redirectTo})`, `onAuthStateChange`. Storage: `storage.upload(file)`, `storage.getDownloadUrl(objectId)`. Realtime + Functions also exposed. TypeScript generics: `.from<Company>('companies')`. Session auto-persists to localStorage and auto-refreshes.
URL: https://docs.butterbase.ai/sdk

## cli
`butterbase login`, `apps create|use|list`, `schema get|apply` (with `--dry-run`), `functions deploy|logs|list`, `storage upload|list`, `domains add|status`, `keys generate --substrate`, `plugin setup` for `.mcp.json`. CLI reads `BUTTERBASE_API_KEY` from env or `~/.butterbase/config.json`. We've written `.env` — source it before CLI calls.
URL: https://docs.butterbase.ai/cli

## substrate
Per-user cross-app memory + action coordination. **Requires a substrate-scoped key** (`bb_sub_*`) — generate via `butterbase keys generate --substrate` (the `generate_service_key` MCP with `substrate_access:true` errored INTERNAL_ERROR in this session — revisit at substrate stage). Routes under `/v1/me/substrate/...`. We'll surface Companies/People as substrate **entities** (`findEntities({type:'person'})`, `getEntity(id)`). Inside a function, `ctx.substrate` is wired automatically when the app is linked to a substrate user. WS stream + outbox webhooks are out of scope for v1.
URL: https://docs.butterbase.ai/substrate

## platform
Per-app subdomain routing means we can use `https://butterbase-crm.butterbase.dev/data/{table}` etc. and skip `{app_id}` in paths. `/llms.txt` available for agent guidance. Structured error objects have `code`, `message`, `remediation` — follow `remediation` before retrying.

**`llms.txt` endpoints verified live (2026-06-02):**
- `https://docs.butterbase.ai/llms.txt` — site index of canonical doc URLs by section (getting-started, core concepts, SDKs & tools, framework guides, API reference, error reference). Use it to look up the canonical URL for a topic before fetching deeper.
- `https://api.butterbase.ai/llms.txt` — control-API agent guidance. Workflow sequence matches our build order. Reaffirms: always check `_meta.next_actions` on successful responses, always read `remediation` on errors.

## Gotchas captured for build stages

- **RLS:** Butterbase's `create_user_isolation` helper is single-column. Our workspace-via-membership predicate must be hand-written SQL through `manage_rls`. Plan ahead in the rls stage.
- **RLS type cast:** `current_user_id()` returns `text` — must cast to `::uuid` for comparison with uuid columns or you'll get `RLS_TYPE_MISMATCH: operator does not exist: uuid = text`.
- **Workspace-scoped JWT:** No documented native custom-claim mechanism in `auth`. Collapsed `mint-workspace-jwt` and use membership-join RLS instead.
- **`butterbase_service` schema permissions:** cannot `CREATE FUNCTION/TRIGGER` from a function (`permission denied for schema public`). DB-trigger plans (B1) must fall back to app-code (B2).
- **Storage `public:true`** is set per-upload — seed script must mark seed-workspace logos as public at upload time, not after.
- **Frontend zip:** must use forward slashes; bundle `archiver` into the deploy script.
- **Substrate key:** generate via CLI (`butterbase keys generate --substrate`) — MCP `substrate_access:true` flag returned INTERNAL_ERROR.
- **Realtime token:** browsers use `?token=` query param, not Authorization header.
- **App access_mode + function auth:** with `access_mode=authenticated`, even functions with `auth: required` reject service-key calls (they want an end-user JWT). For one-shot setup tasks call as `auth: none` and gate with an in-body secret.
