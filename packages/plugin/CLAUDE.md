# Butterbase

You are working with Butterbase, an AI-Native Backend-as-a-Service. Butterbase lets AI agents provision databases, manage schemas, configure auth, deploy serverless functions, and manage storage — all through MCP tools.

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `BUTTERBASE_API_KEY` | Platform API key (service role, bypasses RLS) | `bb_sk_a1b2c3...` |
| `CONTROL_API_URL` | API base URL (default: `https://api.butterbase.ai`) | `http://localhost:4000` |
| `VITE_API_URL` | Frontend env: API URL for Vite/React apps | `https://api.butterbase.ai/v1/app_abc123` |
| `VITE_APP_ID` | Frontend env: App ID for Vite/React apps | `app_abc123` |

## Core Workflow

The standard sequence for building a Butterbase app:

1. `init_app` — Create app, get `app_id` and `api_base`
2. `apply_schema` — Define tables declaratively (preview with `dry_run_schema`)
3. `create_user_isolation_policy` — Secure user-owned tables with RLS
4. `configure_oauth_provider` — Set up social sign-in (Google, GitHub, etc.)
5. `deploy_function` — Add backend logic (HTTP, cron, WebSocket triggers)
6. `create_frontend_deployment` + `manage_frontend` (action: "start_deployment") — Deploy frontend to live URL

## Important Patterns

### Storage
- Persist `objectId` (UUID) from upload response — NOT `objectKey` (bucket path)
- `objectKey` is not a URL — it cannot be used as `img src` or `href`
- Resolve download URLs at render time via `generate_download_url(objectId)` — presigned URLs expire
- For lists with many files, resolve presigned URLs in parallel (`Promise.all`)

### Serverless Functions
- Handler signature: `export async function handler(request: Request, context: { db, env, user }): Promise<Response>`
- **MUST return `new Response()`** (Web API standard) — NOT plain objects like `{ status: 200 }`
- `ctx.db` for database queries, `ctx.env` for environment variables, `ctx.user` for authenticated user

### Row-Level Security (RLS)
Three built-in roles assigned automatically based on auth:
- `butterbase_anon` — No auth header. Default deny unless policies exist.
- `butterbase_user` — Valid end-user JWT. `current_user_id()` returns their UUID.
- `butterbase_service` — API key (`bb_sk_`). Bypasses ALL RLS policies.

### Schema
- Declarative diffs — describe desired state, platform generates safe DDL
- Destructive operations require explicit opt-in: `_drop: ["table"]` or `_dropColumns: ["col"]`
- Preview changes with `dry_run_schema` before applying

### Branding
- API key prefix: `bb_sk_`
- Domain: `butterbase.ai`
- Environment variable prefix: `BUTTERBASE_`

## Documentation

Call the `butterbase_docs` MCP tool for comprehensive reference documentation:

| Topic | What it covers |
|-------|---------------|
| `overview` | Platform introduction and key features |
| `mcp` | All 42+ MCP tools with usage examples |
| `rest` | Auto-generated REST API (CRUD, filtering, sorting, pagination) |
| `auth` | End-user authentication (email/password, OAuth, JWT) |
| `storage` | File upload/download with presigned URLs |
| `functions` | Serverless functions (triggers, context, deployment) |
| `frontend` | Static frontend deployment to live URLs |
| `ai` | AI model gateway (chat completions, BYOK) |
| `billing` | Plans, usage metering, Stripe Connect |
| `schema` | Schema DSL reference (types, indexes, constraints) |
| `sdk` | TypeScript SDK (`@butterbase/sdk`) |
| `cli` | CLI tool (`@butterbase/cli`) |
| `realtime` | WebSocket realtime subscriptions |

Usage: `butterbase_docs` with `topic: "auth"` (or any topic above, or `"all"` for everything)

## Local Development

When running the Butterbase monorepo locally, override the MCP URL:
- Control API: `http://localhost:4000`
- Dashboard API: `http://localhost:4100`
- Start the stack: `docker-compose -f docker-compose.local.yml up`

## Available Skills

| Skill | When to use |
|-------|------------|
| `butterbase:build-app` | Building a new app from scratch (init → schema → RLS → auth → deploy) |
| `butterbase:schema-design` | Designing database schemas, choosing column types, adding indexes |
| `butterbase:deploy-frontend` | Deploying React/Next.js/HTML frontends to live URLs |
| `butterbase:debug-rls` | Debugging Row-Level Security issues (access denied, wrong data) |
| `butterbase:function-dev` | Developing serverless functions (webhooks, cron jobs, APIs) |
| `butterbase:contributing` | Contributing to the Butterbase codebase (adding MCP tools, routes) |
