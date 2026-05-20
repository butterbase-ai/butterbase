# Butterbase

**AI-native, open-source backend-as-a-service.** Postgres data plane, auth, storage, functions, an AI gateway, and a built-in Model Context Protocol (MCP) server. Apache-2.0 licensed.

Butterbase gives you the building blocks for AI-driven applications without lock-in: spin up a Postgres-backed backend with row-level security, ship serverless functions, route LLM traffic through a single gateway, and let agents drive it all via MCP tools.

## Open-source vs. managed

This repo ships the **runtime data plane**:

- `services/control-api` — Fastify control plane (apps, auth, storage, functions, AI gateway, RLS, migrations)
- `services/mcp-server` — MCP server exposing 30+ backend ops as tools
- `services/agent-runtime`, `services/deno-runtime`, `services/build-runner` — function and frontend execution
- `services/storage-indexer` — async storage indexing
- `packages/sdk`, `packages/cli`, `packages/plugin`, `packages/shared` — client surfaces

The **managed offering** at [butterbase.ai](https://butterbase.ai) adds: multi-region orchestration, billing, the AI router's upstream provider adapters, lease-based quota enforcement, and ops dashboards. Those live in a private repo that consumes this one as a submodule.

When you self-host this repo, the AI gateway runs with no upstream router adapters registered, billing uses a no-op provider, and quotas are unlimited — you wire your own implementations against the `BillingProvider`, `QuotaEnforcer`, and `RouterAdapter` interfaces in `packages/shared`.

## Quickstart

Requirements: Docker, Node 22+, npm.

```bash
git clone https://github.com/NetGPT-Inc/butterbase-oss.git
cd butterbase-oss
cp .env.example .env
docker compose -f docker-compose.local.yml up -d
```

The control-api will be available at `http://localhost:4000`. See `SETUP.md` for full setup including auth provider configuration.

## Architecture

```
                  ┌──────────────────────────────────┐
                  │  Your app / agent / MCP client   │
                  └──────────────┬───────────────────┘
                                 │
                  ┌──────────────▼───────────────────┐
                  │     control-api (Fastify)        │
                  │  apps · auth · storage · funcs   │
                  │  AI gateway · RLS · migrations   │
                  └──┬─────────┬─────────┬────────┬──┘
                     │         │         │        │
              ┌──────▼──┐ ┌────▼────┐ ┌──▼──┐ ┌───▼────┐
              │ Postgres│ │ Storage │ │ MCP │ │Function│
              │ runtime │ │ indexer │ │ srv │ │runtime │
              └─────────┘ └─────────┘ └─────┘ └────────┘
```

The control-api is the single entry point. Postgres holds tenant runtime metadata in `db/runtime-plane` and per-app data in `db/data-plane`. Functions run in `agent-runtime` or `deno-runtime` workers dispatched via Cloudflare Workers (`dispatch-worker`).

## Documentation

- [`SETUP.md`](./SETUP.md) — self-hoster setup guide
- [`SUBDOMAIN_IMPLEMENTATION.md`](./SUBDOMAIN_IMPLEMENTATION.md) — tenant subdomain routing
- [`docs/runbooks`](./docs/runbooks) — operational runbooks
- [`Examples/`](./Examples) — example apps you can deploy as-is

## Project status

Initial open-source release (v0.1.0). The internal data plane is production-tested by the managed offering. Public APIs and the MCP tool surface are stable but the OSS distribution is new — expect some self-host rough edges that we will smooth out from issues and PRs.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The boundary between OSS and the managed offering is intentional — please read the "scope" section before opening a PR that touches billing, quota math, or upstream router adapters.

## Security

See [`SECURITY.md`](./SECURITY.md). Report vulnerabilities to `security@butterbase.ai`.

## License

[Apache-2.0](./LICENSE). Copyright 2026 NetGPT Inc.
