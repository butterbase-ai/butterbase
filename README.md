<p align="center">
  <img src=".github/assets/logo.png" alt="Butterbase" width="420" />
</p>

<p align="center"><strong>AI-native, open-source backend-as-a-service.</strong><br/>Postgres · Auth · Storage · Functions · AI Gateway · MCP server</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
  <a href="https://github.com/butterbase-ai/butterbase/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/butterbase-ai/butterbase?style=social"></a>
  <a href="https://github.com/butterbase-ai/butterbase/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/butterbase-ai/butterbase?style=social"></a>
  <br/>
  <a href="https://discord.gg/Aq7q5mqbrt"><img alt="Join Discord" src="https://img.shields.io/badge/Join-Discord-5865F2?logo=discord&logoColor=white"></a>
  <a href="https://www.linkedin.com/company/butterbase/?trk=public_profile_following-company_profile-result-card_result-card_title"><img alt="Follow us on LinkedIn" src="https://img.shields.io/badge/Follow-LinkedIn-0A66C2?logo=linkedin&logoColor=white"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Postgres" src="https://img.shields.io/badge/Postgres-336791?logo=postgresql&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white">
</p>

<p align="center">
  <a href="https://butterbase.ai"><strong>Website</strong></a> ·
  <a href="https://discord.gg/Aq7q5mqbrt"><strong>Discord</strong></a> ·
  <a href="https://www.linkedin.com/company/butterbase/?trk=public_profile_following-company_profile-result-card_result-card_title"><strong>LinkedIn</strong></a> ·
  <a href="./SETUP.md"><strong>Self-host</strong></a> ·
  <a href="./docs"><strong>Docs</strong></a> ·
  <a href="./ROADMAP.md"><strong>Roadmap</strong></a> ·
  <a href="./Examples"><strong>Examples</strong></a> ·
  <a href="./CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

---

<!-- Drop a demo gif at .github/assets/demo.gif and uncomment:
<p align="center"><img src=".github/assets/demo.gif" alt="Butterbase demo" width="720" /></p>
-->

Butterbase gives you the building blocks for AI-driven applications without lock-in: a Postgres-backed backend with row-level security, serverless functions, an LLM gateway, realtime subscriptions, key-value store, file storage, RAG, durable per-key actors, and a built-in **Model Context Protocol (MCP) server** so agents can operate your backend with tools instead of glue code.

## Features

**Data**
- **Postgres data plane** — per-app databases with declarative schema (`/schema`), automatic REST endpoints (`/auto-api`), and migrations.
- **Row-Level Security** — first-class RLS policy management with user-isolation helpers (`/rls`).
- **Key-Value store** — regional, quota-protected KV with TTL, audit trail, and dashboard expose rules (`/v1/:app/kv/*`). *New in v0.2.0.*
- **File storage** — S3/R2-backed object storage with presigned URLs, ACLs, and async indexing (`/storage`).

**Compute**
- **Serverless functions** — TypeScript functions executed on the Deno runtime (`/functions`).
- **Durable Objects** — stateful per-key actors for chat rooms, multiplayer, rate limiters, long-running agents (`/durable-objects`).
- **Realtime** — WebSocket subscriptions to table changes for live UIs and presence (`/realtime`).
- **Edge SSR** — deploy Next.js / Remix / Astro edge handlers from source (`/edge-ssr`, `/edge-ssr-from-source`).
- **Frontend hosting** — zip or build-from-source static / SPA deploys with custom domains (`/frontend`, `/custom-domains`).

**AI**
- **AI gateway** — single endpoint for chat, embeddings, model listing; pluggable router adapters (`/gateway`, `/ai-config`).
- **RAG** — managed collections, document ingestion, semantic search and synthesized answers (`/rag`).
- **Integrations** — third-party tool access via Composio (`/integrations`).

**Identity & ops**
- **Auth** — email + OAuth (Google, GitHub, Apple, X, …), JWT tuning, post-login hooks, service keys (`/auth`, `/oauth-config`, `/api-keys`).
- **Audit logs** — structured request audit trail across KV and other surfaces (`/audit-logs`).
- **Webhooks** — outbound webhooks for app events (`/webhooks`).
- **Multi-region app moves** — relocate an app across regions with retained source replicas (`scripts/move-app/`).

**Agent surface**
- **MCP server** — every capability above is exposed as MCP tools at `/mcp` (HTTP) or via stdio (`@butterbase/mcp` — `npx @butterbase/mcp`).
- **Claude Code plugin** — `packages/plugin` (submodule of [butterbase-skills](https://github.com/butterbase-ai/butterbase-skills)) ships 30+ guided skills (idea → plan → schema → auth → functions → deploy → submit) for agentic app building.

## Open-source vs. managed

This repo ships the **runtime data plane** — everything required to self-host a fully featured Butterbase instance. The **managed offering** at [butterbase.ai](https://butterbase.ai) adds multi-region orchestration, billing, upstream AI router adapters, lease-based quota enforcement, and ops dashboards (those live in a private repo that consumes this one as a submodule).

When you self-host, the AI gateway runs without upstream router adapters, billing uses a no-op provider, and quotas are unlimited. Wire your own implementations via the `BillingProvider`, `QuotaEnforcer`, and `RouterAdapter` interfaces in `packages/shared`.

## Quickstart (self-host)

**Requirements:** Docker, Node 22+, npm.

### 1. Clone (with submodules)

The Claude Code plugin containing skills (`packages/plugin`) is a git submodule ([butterbase-skills](https://github.com/butterbase-ai/butterbase-skills)). A plain clone leaves `packages/plugin/` empty and `npm install` silently skips that workspace.

```bash
git clone --recurse-submodules https://github.com/butterbase-ai/butterbase.git
cd butterbase
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

Optional — keep submodules updated on every pull:

```bash
git config --global submodule.recurse true
```

### 2. Install dependencies and configure env

```bash
npm ci
cp .env.example .env
```

`docker-compose.local.yml` sets `KV_REDIS_URL_US_EAST_1` for you. Edit `.env` only if you override defaults (e.g. run control-api on the host — use `redis://localhost:6379`).

### 3. Start the stack

First run builds images and can take several minutes.

```bash
docker compose -f docker-compose.local.yml up -d
```

Wait until control-api is healthy:

```bash
curl -sf http://localhost:4000/health/ready
```

### 4. Run database migrations

Schema is **not** applied automatically on container start. From the repo root (with the stack running):

```bash
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export BUTTERBASE_REGIONS=us-east-1

npm run migrate:all
```

### 5. Seed the local dev user

With `AUTH_ENABLED=false`, the API uses `DEV_OWNER_ID` from compose. That user must exist in `platform_users` (fresh volumes start empty):

```bash
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
npm run seed:dev
```

### 6. Smoke test

Auth is disabled in the local compose profile (`AUTH_ENABLED=false`):

```bash
curl -X POST http://localhost:4000/init \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'

curl http://localhost:4000/apps
```

### Local endpoints

| Service | URL / port |
|---------|------------|
| Control API | http://localhost:4000 |
| MCP (HTTP, via control-api) | http://localhost:4000/mcp |
| Deno runtime | http://localhost:7133 |
| Docs site | http://localhost:4321 |
| Control plane Postgres | `localhost:5433` |
| Data plane Postgres | `localhost:5435` |
| Runtime plane Postgres | `localhost:5437` |
| LocalStack (S3) | http://localhost:4566 |

Full setup (auth, MCP clients, troubleshooting, production notes): **[`SETUP.md`](./SETUP.md)**.

## Architecture

```
              ┌──────────────────────────────────────────┐
              │    Your app · agent · MCP client · CLI   │
              └──────────────────────┬───────────────────┘
                                     │  REST · WebSocket · MCP
              ┌──────────────────────▼───────────────────┐
              │            control-api (Fastify)         │
              │   apps · auth · schema · auto-api · RLS  │
              │   storage · functions · KV · realtime    │
              │   AI gateway · RAG · DOs · MCP at /mcp   │
              └──┬──────┬───────┬───────┬────────┬───────┘
                 │      │       │       │        │
        ┌────────▼─┐ ┌──▼───┐ ┌─▼──┐ ┌──▼─────┐ ┌▼─────────────┐
        │ Postgres │ │ S3 / │ │Redis│ │ Deno   │ │ Python agent │
        │ 3 planes │ │ R2   │ │ KV  │ │runtime │ │   runtime    │
        └──────────┘ └──────┘ └────┘ └────────┘ └──────────────┘
                                              ┌──────────────────┐
                                              │ Cloudflare:      │
                                              │ build-runner ·   │
                                              │ dispatch-worker  │
                                              └──────────────────┘
```

**Three Postgres planes:**
- **control-plane** (`db/control-plane/`) — platform metadata: users, apps, billing, audit.
- **runtime-plane** (`db/runtime-plane/`) — hot-path runtime tables (KV expose rules, realtime channels, sessions).
- **data-plane** (`db/data-plane/`) — per-app user data; each app gets isolated schemas with RLS.

## Repo layout

**Services** (`services/`)

| Service | Language | What it does |
|---|---|---|
| `control-api` | Node.js / Fastify | Main entry point. All public APIs, embeds MCP at `/mcp`. |
| `mcp-server` | Node.js | MCP tool implementations (built into control-api; also ships as `butterbase-mcp` stdio binary). |
| `deno-runtime` | Deno | Executes user serverless functions in isolates. |
| `agent-runtime` | Python (uv) | Long-running agent executor for `manage_ai` / agent tasks. |
| `build-runner` | Cloudflare Worker | Builds frontends and edge-SSR bundles from source. |
| `storage-indexer` | Node.js | Async indexer for uploaded objects. |
| `docs` | Astro | Public documentation site (also served locally at `:4321`). |

**Packages** (`packages/`)

| Package | Description |
|---|---|
| `@butterbase/sdk` | Universal TypeScript SDK (browser + server). |
| `@butterbase/cli` | `butterbase` CLI for scaffolding and backend management. |
| `@butterbase/plugin` | Claude Code plugin — 30+ guided skills for AI-driven app building. Git submodule of [butterbase-skills](https://github.com/butterbase-ai/butterbase-skills). |
| `@butterbase/shared` | Shared types, constants, and pluggable interfaces (`BillingProvider`, `QuotaEnforcer`, `RouterAdapter`). |

**Other top-level pieces**
- `dispatch-worker/` — Cloudflare Worker that routes per-app subdomain traffic.
- `bb-placeholder/` — placeholder origin for unprovisioned subdomains.
- `infra/` — `pgbouncer` and `traefik` configs for self-host.
- `db/` — SQL migrations for the three Postgres planes.
- `Examples/` — `todo-2026-04-02`, `grocery-list-2026-04-03`.

## What's *not* in this repo

The OSS / managed boundary is intentional. The following are private to the managed offering:

- Multi-region orchestration and the cross-region scheduler.
- Billing logic, lease-based quota math, and Stripe wire-up beyond the no-op provider.
- Upstream AI router adapters (OpenAI / Anthropic / Bedrock provider integrations beyond the gateway interface).
- Customer / admin dashboards, hackathon-host dashboards, and ops tooling.

If you need these for self-host, implement against the interfaces in `packages/shared` — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the scope rules.

## Documentation

- [`SETUP.md`](./SETUP.md) — self-host and local development guide
- [`CHANGELOG.md`](./CHANGELOG.md) — release notes (latest: **v0.2.0**, 2026-05-25 — KV store)
- [`ROADMAP.md`](./ROADMAP.md) — what's next
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contributor workflow and OSS scope
- [`SUBDOMAIN_IMPLEMENTATION.md`](./SUBDOMAIN_IMPLEMENTATION.md) — tenant subdomain routing
- [`docs/runbooks/local-e2e.md`](./docs/runbooks/local-e2e.md) — multi-region E2E stack
- [`docs/runbooks`](./docs/runbooks) — operational runbooks
- [`Examples/`](./Examples) — example apps (todo, grocery list)
- Docs site (local): `http://localhost:4321` after `docker compose up`

## Project status

Latest release: **v0.2.0** (2026-05-25) — adds the KV store across SDK / REST / CLI / MCP. The data plane is production-tested by the managed offering; the OSS distribution is young — please file self-host issues and we'll tighten docs and defaults from feedback. See [`CHANGELOG.md`](./CHANGELOG.md) for the full history.

## Community & support

- **[Discord](https://discord.gg/Aq7q5mqbrt)** — chat with the team and other builders
- **[LinkedIn](https://www.linkedin.com/company/butterbase/?trk=public_profile_following-company_profile-result-card_result-card_title)** — follow us for product updates and announcements
- **[GitHub Issues](https://github.com/butterbase-ai/butterbase/issues)** — bug reports, feature requests
- **Email** — [yuki@butterbase.ai](mailto:yuki@butterbase.ai) for direct contact

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The boundary between OSS and the managed offering is intentional — please read the scope section before opening a PR that touches billing, quota math, or upstream router adapters.

## Security

See [`SECURITY.md`](./SECURITY.md). Report vulnerabilities to `security@butterbase.ai`.

## License

[Apache-2.0](./LICENSE). Copyright 2026 NetGPT Inc.

## Contributors

<a href="https://github.com/butterbase-ai/butterbase/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=butterbase-ai/butterbase" alt="Contributors" />
</a>

## Star history

<a href="https://www.star-history.com/#butterbase-ai/butterbase&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=butterbase-ai/butterbase&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=butterbase-ai/butterbase&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=butterbase-ai/butterbase&type=Date" />
  </picture>
</a>