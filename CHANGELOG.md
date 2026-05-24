# Changelog

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
