# Butterbase self-host and local development

This guide covers running the OSS stack on your machine with `docker-compose.local.yml`. It matches what ships in this repo today (no managed dashboard UI in-tree).

## Prerequisites

| Tool | Version |
|------|---------|
| Docker | Recent Desktop or Engine with Compose v2 |
| Node.js | 22+ |
| npm | 10+ (comes with Node) |

Optional for E2E / move-app tests: `libpq` (`pg_dump`, `psql`) — see [`docs/runbooks/local-e2e.md`](./docs/runbooks/local-e2e.md).

## 1. Get the code

```bash
git clone --recurse-submodules https://github.com/butterbase-ai/butterbase.git
cd butterbase
git submodule update --init --recursive   # if you forgot --recurse-submodules
npm ci
```

## 2. Environment file

```bash
cp .env.example .env
```

### KV Redis (set in compose by default)

`docker-compose.local.yml` sets `KV_REDIS_URL_US_EAST_1=redis://redis:6379` on `control-api`. You only need `.env` for this if you run control-api **outside** Docker:

```bash
KV_REDIS_URL_US_EAST_1=redis://localhost:6379
```

Add one `KV_REDIS_URL_<REGION>` per entry in `BUTTERBASE_REGIONS` (long-form names, e.g. `US_EAST_1` for `us-east-1`).

The local stack uses a single Redis on port `6379` for metering and KV expiry.

### Optional / production placeholders

`.env.example` includes placeholders for Sentry, Stripe, OpenRouter, SES, and R2. They are not required for the default local profile. You may see a log line like `Invalid Sentry Dsn` — safe to ignore locally, or remove `SENTRY_DSN` from `.env`.

Lease and AI credit variables are set in compose for development. If you run control-api outside compose, mirror the values from the `control-api.environment` block in `docker-compose.local.yml`.

## 3. Start services

```bash
docker compose -f docker-compose.local.yml up -d
```

Check status:

```bash
docker compose -f docker-compose.local.yml ps
docker compose -f docker-compose.local.yml logs -f control-api
```

### What runs locally

| Service | Port | Role |
|---------|------|------|
| `control-api` | 4000 | HTTP API + MCP at `/mcp` |
| `deno-runtime` | 7133 | Execute user functions |
| `docs` | 4321 | Static docs (nginx) |
| `control-plane-db` | 5433 | Platform metadata |
| `data-plane-db` | 5435 | Per-app databases |
| `runtime-plane-db` | 5437 | Regional runtime tables |
| `pgbouncer` | 6432 | Pool to data plane |
| `redis` | 6379 | Metering + KV expiry |
| `localstack` | 4566 | S3-compatible storage |
| `traefik` | 80, 8080 | Local routing (optional) |

**Not** started by this compose file (used in managed / production deploys): `agent-runtime`, `build-runner`, `storage-indexer`, `cron-scheduler`, dashboard UI.

First `up` builds the control-api image (monorepo build inside Docker) and may take several minutes.

## 4. Database migrations

Migrations are **not** run automatically when containers start. Apply them from the host while databases are up:

```bash
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export BUTTERBASE_REGIONS=us-east-1

npm run migrate:control   # platform schema (control-plane DB)
npm run migrate:runtime   # runtime schema (runtime-plane DB)
# or: npm run migrate:all
```

Migration SQL lives under `db/control-plane/`, `db/runtime-plane/`, and `db/data-plane/`. Do not apply files with `psql` by hand unless you know the scope headers; use the migrate scripts.

After a **full reset** (`docker compose ... down -v`), run migrations again, then seed the dev user (section 4b).

### 4b. Seed the local dev user

Local compose sets `AUTH_ENABLED=false` and assigns unauthenticated requests to `DEV_OWNER_ID` (`11111111-1111-1111-1111-111111111111` by default). Quota enforcement still looks up that ID in `platform_users`. On a fresh database you must seed it once:

```bash
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
npm run seed:dev
```

This inserts `dev@butterbase.local` and `dev-admin@butterbase.local` with plan `playground` (idempotent). Override IDs with `DEV_OWNER_ID` / `DEV_ADMIN_USER_ID`, or plan with `DEV_SEED_PLAN_ID`.

## 5. Verify the stack

```bash
curl -sf http://localhost:4000/health/ready
curl -sf http://localhost:7133/health
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:4321/
```

Create an app (auth off in local compose):

```bash
curl -X POST http://localhost:4000/init \
  -H "Content-Type: application/json" \
  -d '{"name": "test-app"}'

curl http://localhost:4000/apps
```

## 6. Authentication

### Default local profile: auth disabled

`docker-compose.local.yml` sets `AUTH_ENABLED=false`. Requests to `/init` and `/apps` work without a token. **Do not expose port 4000 to the public internet in this mode.**

### Enable auth (self-host / staging)

Set on the `control-api` service (compose `environment` or `.env` loaded via `env_file`):

```yaml
AUTH_ENABLED: "true"
```

For Cognito-backed dashboard flows you also need `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and `COGNITO_REGION`. The managed dashboard UI is not in this OSS repo; use API keys or your own frontend.

### API keys (MCP / CLI)

1. Ensure auth is enabled and you have a platform user (e.g. insert into `platform_users` or use your IdP flow).
2. Create a key via the dashboard API or admin routes (requires a valid JWT or admin path).
3. Call the API:

```bash
export BUTTERBASE_API_KEY="bb_sk_..."
curl http://localhost:4000/apps \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

## 7. MCP clients

### HTTP (recommended when control-api is running)

The MCP server is served by control-api. Clients must accept **both** `application/json` and `text/event-stream`.

Cursor example:

```json
{
  "mcpServers": {
    "butterbase": {
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BUTTERBASE_MCP_TOKEN}"
      }
    }
  }
}
```

```bash
export BUTTERBASE_MCP_TOKEN="bb_sk_..."   # when AUTH_ENABLED=true
```

### Stdio (contributors)

Build the MCP package, then point your client at the built entrypoint:

```bash
npm run build --workspace=services/mcp-server
```

```json
{
  "mcpServers": {
    "butterbase": {
      "command": "node",
      "args": ["./services/mcp-server/dist/index.js"],
      "env": {
        "BUTTERBASE_API_URL": "http://localhost:4000",
        "BUTTERBASE_API_KEY": "bb_sk_..."
      }
    }
  }
}
```

Exact env names depend on your MCP client; see `services/mcp-server` README if present.

## 8. Development workflow

### Run control-api on the host (hot reload)

Keep databases and redis running in Docker:

```bash
docker compose -f docker-compose.local.yml up -d control-plane-db data-plane-db runtime-plane-db redis localstack pgbouncer
```

```bash
cd services/control-api
export CONTROL_DB_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export KV_REDIS_URL_US_EAST_1=redis://localhost:6379
export AUTH_ENABLED=false
# ... other vars from docker-compose.local.yml control-api.environment
npm run dev
```

### Run deno-runtime on the host

```bash
cd services/deno-runtime
# Match env from compose deno-runtime service
deno run --allow-net --allow-env --allow-read server.ts
```

### Build workspaces

```bash
npm run build --workspace=@butterbase/shared
npm run build --workspace=services/control-api
npm run build --workspace=services/mcp-server
```

## 9. Testing

There is **no** `npm test` at the repo root. Run per workspace:

```bash
npm test --workspace=services/control-api
npm test --workspace=services/mcp-server
npm test --workspace=@butterbase/shared
```

Multi-region integration tests:

```bash
npm run e2e:all    # bootstrap compose + migrate + vitest
```

See [`docs/runbooks/local-e2e.md`](./docs/runbooks/local-e2e.md).

## 10. Troubleshooting

### control-api exits immediately: `Missing KV_REDIS_URL_US_EAST_1`

Usually means `BUTTERBASE_REGIONS` includes a region with no matching `KV_REDIS_URL_<REGION>` env var. For the default single-region stack, recreate control-api so compose env is applied:

```bash
docker compose -f docker-compose.local.yml up -d control-api
```

If you run control-api on the host, set `KV_REDIS_URL_US_EAST_1=redis://localhost:6379` in your shell or `.env`.

### `/init` or `/apps` returns `401` / `User not found`

Run `npm run seed:dev` (section 4b) after migrations. The dev owner row must exist in `platform_users`.

### `/init` or `/apps` returns database errors

Run migrations (section 4). Confirm DB containers are healthy:

```bash
docker compose -f docker-compose.local.yml ps
```

### control-api unhealthy after `up`

```bash
docker compose -f docker-compose.local.yml logs control-api --tail 100
```

Common causes: missing KV env, databases not ready, LocalStack still starting.

### Reset everything (destructive)

```bash
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d
# re-run migrations (section 4)
```

### Storage uploads fail in the browser

Presigned URLs must use a host the browser can reach. Local compose sets `S3_PUBLIC_ENDPOINT=http://localhost:4566`. For remote clients, align `S3_PUBLIC_ENDPOINT` with your public LocalStack or R2 endpoint and configure CORS on the bucket.

### Neon / production DB permission errors

When migrating hosted app databases on Neon:

1. Prefer the **direct** endpoint, not the pooler, for owner-level DDL.
2. On PG 15+, grant schema rights if provisioning skipped:

```sql
GRANT ALL ON SCHEMA public TO butterbase;
```

Backfill per-app migrations:

```bash
CONTROL_DB_URL=postgresql://... npx tsx scripts/backfill-migrations.ts app_abc123
```

### Invalid JWT / API key

- Cognito pool and client IDs must match env vars when auth is enabled.
- API keys are shown once at creation; revoked keys return 401.

## 11. Optional integrations

| Feature | Env vars (see `.env.example`) |
|---------|-------------------------------|
| AI via OpenRouter | `OPENROUTER_API_KEY`, `AI_MARKUP_PERCENT` |
| Real AWS / R2 storage | `AWS_*`, `S3_*`, drop LocalStack endpoints |
| Email (SES) | `SES_*`, `SES_FROM_EMAIL` |
| Stripe billing | `STRIPE_*` (noop billing locally in OSS mode) |
| Cloudflare WfP deploys | `CLOUDFLARE_DISPATCH_*`, `DEPLOYMENT_DEFAULT_BACKEND` |

In OSS mode, control-api logs: `No cloud overlays found, running in OSS mode (Noop billing, Unlimited quotas)`.

## 12. Next steps

- Explore [`Examples/`](./Examples) and deploy with [`packages/cli`](./packages/cli/README.md).
- Use the SDK: [`packages/sdk`](./packages/sdk/README.md).
- Read MCP tool docs via the butterbase MCP server or `services/mcp-server/src/docs/user-documentation.ts`.
- Production deploy patterns: [`docs/runbooks`](./docs/runbooks), [`SECURITY.md`](./SECURITY.md).

For issues, open a [bug report](https://github.com/butterbase-ai/butterbase/issues/new?template=bug.yml) with `docker compose ps` and relevant logs.
