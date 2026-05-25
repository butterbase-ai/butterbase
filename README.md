# Butterbase

**AI-native, open-source backend-as-a-service.** Postgres data plane, auth, storage, functions, an AI gateway, and a built-in Model Context Protocol (MCP) server. Apache-2.0 licensed.

Butterbase gives you the building blocks for AI-driven applications without lock-in: spin up a Postgres-backed backend with row-level security, ship serverless functions, route LLM traffic through a single gateway, and let agents drive it all via MCP tools.

## Open-source vs. managed

This repo ships the **runtime data plane**:

- `services/control-api` — Fastify control plane (apps, auth, storage, functions, AI gateway, RLS, migrations). Embeds the MCP server at `/mcp`.
- `services/mcp-server` — MCP tool implementations (built into the control-api image; can also run standalone over stdio)
- `services/deno-runtime` — serverless function executor (included in local Docker)
- `services/agent-runtime`, `services/build-runner`, `services/storage-indexer` — used in production / managed deploys; not started by the local compose file
- `packages/sdk`, `packages/cli`, `packages/plugin`, `packages/shared` — client surfaces

The **managed offering** at [butterbase.ai](https://butterbase.ai) adds multi-region orchestration, billing, upstream AI router adapters, lease-based quota enforcement, and ops dashboards. Those live in a private repo that consumes this one as a submodule.

When you self-host, the AI gateway runs without upstream router adapters, billing uses a no-op provider, and quotas are unlimited. Wire your own implementations via the `BillingProvider`, `QuotaEnforcer`, and `RouterAdapter` interfaces in `packages/shared`.

## Quickstart (self-host)

**Requirements:** Docker, Node 22+, npm.

### 1. Clone (with submodules)

The Claude Code plugin (`packages/plugin`) is a git submodule ([butterbase-plugin](https://github.com/NetGPT-Inc/butterbase-plugin)). A plain clone leaves `packages/plugin/` empty and `npm install` silently skips that workspace.

```bash
git clone --recurse-submodules https://github.com/NetGPT-Inc/butterbase-oss.git
cd butterbase-oss
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
                  ┌──────────────────────────────────┐
                  │  Your app / agent / MCP client │
                  └──────────────┬───────────────────┘
                                 │
                  ┌──────────────▼───────────────────┐
                  │     control-api (Fastify)        │
                  │  apps · auth · storage · funcs   │
                  │  AI gateway · RLS · MCP /mcp     │
                  └──┬─────────┬─────────┬────────┬──┘
                     │         │         │        │
              ┌──────▼──┐ ┌────▼────┐ ┌──▼──┐ ┌───▼────────┐
              │ Postgres│ │ Storage │ │Redis│ │deno-runtime│
              │ planes  │ │ (S3/R2) │ │ KV  │ │ (functions)│
              └─────────┘ └─────────┘ └─────┘ └────────────┘
```

The control-api is the main entry point. Platform metadata lives in the control-plane DB; per-app data in the data plane; hot-path runtime tables in the runtime-plane DB (`db/control-plane`, `db/runtime-plane`, `db/data-plane` migrations).

## Documentation

- [`SETUP.md`](./SETUP.md) — self-host and local development guide
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contributor workflow and OSS scope
- [`docs/runbooks/local-e2e.md`](./docs/runbooks/local-e2e.md) — multi-region E2E stack
- [`SUBDOMAIN_IMPLEMENTATION.md`](./SUBDOMAIN_IMPLEMENTATION.md) — tenant subdomain routing
- [`docs/runbooks`](./docs/runbooks) — operational runbooks
- [`Examples/`](./Examples) — example apps

## Project status

Initial open-source release (v0.1.0). The data plane is production-tested by the managed offering. Public APIs and the MCP tool surface are stabilizing; the OSS distribution is new — report self-host issues and we will tighten docs and defaults from feedback.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Read the scope section before PRs that touch billing, quota math, or upstream router adapters.

## Security

See [`SECURITY.md`](./SECURITY.md). Report vulnerabilities to `security@butterbase.ai`.

## License

[Apache-2.0](./LICENSE). Copyright 2026 NetGPT Inc.
