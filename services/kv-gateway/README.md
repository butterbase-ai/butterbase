# kv-gateway

A Cloudflare Worker that fronts per-app, per-region Redis instances. Resolves API keys and app IDs via control-api, enforces hash-tag isolation (`{appId}:u:<key>`), and exposes a JSON HTTP API for serverless function KV operations and future REST surfaces.

## Local Development

```bash
docker compose -f docker-compose.local.yml up -d kv-gateway
curl http://localhost:8787/health
```

## Architecture

- **Request flow**: Bearer token (api_key or per-app kv_function_key) → control-api key resolution → RedisClient to per-region kv-redis-N container.
- **Hash-tag isolation**: User keys become `{appId}:u:<key>`; TTLs land at `{appId}:_ttl:<key>` (same slot, reserved `_` namespace).
- **Storage tiers**: Durable (DB 0, persistent) and ephemeral (DB 1, cache) with durable-first read fanout.

## Operations

- `get`, `set`, `del`
- `incr`, `decr`
- `setnx`, `setex`, `cas`
- `exists`, `ttl`, `expire`
- `mget`, `mset`
- `_batch` (multi-op transaction)
- `touch=true` query param for read-through TTL refresh
- Ephemeral mode for cache-only operations
- 30-day default TTL
- 256 KB value size limit per key

## REST surface

Same routes serve SDK and REST. The gateway disambiguates by token shape:
- Dotted token (`xxx.yyy.zzz`) → treated as a JWT, verified via control-api `resolve-jwt`, expose rules enforced before the op runs.
- Flat hex token → treated as an API key or `kv_function_key`, expose bypassed (dev trust model).

No `Authorization` header → anonymous; only matching `read: "public"` GET routes succeed. `_expose*` and `_batch` are rejected for anonymous callers.

## expose rules

- `PUT /v1/{app}/kv/_expose/<urlencoded-pattern>` body `{read, write}` registers a rule.
- `DELETE /v1/{app}/kv/_expose/<pattern>` removes it.
- `GET /v1/{app}/kv/_expose` lists all rules.

Roles: `public` | `authed` | `owner` | `deny`. Templates: `{user.id}`, `{user.role}`.
Resolution: longest literal prefix wins; ties broken by declaration order.
Conflicts (same pattern, different rule) rejected at registration time with 409 `KV_EXPOSE_CONFLICT`.
Stored as a Redis hash at `{appId}:_meta:expose` (one field per pattern).

JWT-authenticated requests CANNOT manage expose rules (always 403). Use the SDK (`kv.expose/unexpose/listRules`) or `ctx.kv` in functions.

## Testing

```bash
docker compose -f docker-compose.local.yml up -d kv-redis-1
pnpm vitest run
```

Integration tests require kv-redis-1 running on localhost:6390.

## Not in Scope

Customer-facing documentation lives at [docs.butterbase.ai](https://docs.butterbase.ai) (Plan 8). Quota enforcement and credit metering are in Plan 5. KV migration during app relocation is Plan 6.
