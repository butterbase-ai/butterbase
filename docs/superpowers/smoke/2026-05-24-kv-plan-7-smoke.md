# KV Plan 7 Smoke Note — 2026-05-24

## Counter wiring (Tasks 1–5)

All five counter-wiring commits landed on `feat/kv-plan-6-move-app-kv` (OSS submodule):

| SHA | Description |
|-----|-------------|
| `f7a1f31` | keys-counter helpers + kv_app_usage_snapshot migration |
| `488879c` | wire keyDelta through kv-data write/del paths via kvAccount |
| `beff10a` | keys-expiry-worker — decrement counter on TTL expiry events |
| `f282bb5` | reconcileFromScan also writes _meta:keys + kv_app_usage_snapshot |
| `2c974f3` | _stats reads counter (O(1)) + returns plan limits inline; expiry worker boots |

Expected: keys/bytes counters wired end-to-end, O(1) `_stats`, daily reconcile, expiry subscriber.
Actual: all five commits merged; focused KV test suite 335 passed / 0 failed.

## Customer dashboard (Tasks 7–11)

Commits in wrapper repo (`cloud/services/dashboard`):

| SHA | Description |
|-----|-------------|
| `9deed27` | KV tab shell + queries + nav entry |
| `931f6ee` | KV UsageStrip — keys/storage/ops/value-size cards with progress |
| `6adfec1` | KV ExposeRulesTable — list/add/remove rules |
| `0776f9a` | KV KeyBrowser — cursor scan, view/edit/delete |
| `c707d01` | KV RecentErrors — list of last 50 KV audit errors |

Manual in-browser smoke not run in-session. Dashboard build: clean (`✓ built in 1.23s`, chunk-size warnings only).

## Admin dashboard (Tasks 12–16)

Backend + frontend commits in OSS submodule and wrapper repo:

| SHA | Repo | Description |
|-----|------|-------------|
| `9b2967b` | OSS | requireAdmin helper for /admin/* routes |
| `a2cc69e` | OSS | GET /admin/kv/cluster-health — per-region INFO snapshots |
| `d00bf1c` | OSS | GET /admin/kv/top-apps + /admin/kv/hotspots |
| `9116e11` | OSS | GET /v1/:app_id/kv/_audit_recent — recent KV errors for dashboard |
| `725bb2c` | wrapper | admin-dashboard KV page shell + cluster health table |
| `c4ffe76` | wrapper | admin-dashboard TopAppsTable + HotspotsTable |

Manual in-browser smoke not run in-session. Admin dashboard build: clean (`✓ built in 1.11s`, chunk-size warnings only).

## Final test counts

**KV-focused suite** (kv + keys + move-app + admin-guard filters):
- 335 passed, 0 failed, 7 skipped — KV slice fully green

**Full control-api suite**:
- 27 failed | 115 passed | 2 skipped (144 files)
- 96 failed | 816 passed | 97 skipped (1013 tests)
- Non-KV failure count (96) matches Plan 6 baseline. One test fixed this session: `reconcile-worker.test.ts` assertion updated from `calledTimes(1)` to `calledTimes(2)` — the snapshot INSERT added in Task 4 meant two DB calls per reconcile tick.

## Build status

| Subproject | Result |
|-----------|--------|
| `@butterbase/control-api` (OSS) | clean (`tsc -b`) |
| `@butterbase/sdk` (OSS) | clean (`tsc -b`) |
| `dashboard` (wrapper) | clean (`✓ built in 1.23s`) |
| `admin-dashboard` (wrapper) | clean (`✓ built in 1.11s`) |
| Docker image `butterbase-control-api` | rebuilt successfully |

## Docker / expiry-subscriber status

Control-api started and listening:
```
KV reconcile worker started (24h interval)
Server listening at http://127.0.0.1:4000
```

Expiry-subscriber did NOT start. Error: `Missing KV_REDIS_URL_US_EAST_1`. Root cause: `BUTTERBASE_REGIONS` resolves to `us-east-1,eu-west-1` (long-form), so the worker looks for `KV_REDIS_URL_US_EAST_1`, but `docker-compose.local.yml` only sets `KV_REDIS_URL_US` and `KV_REDIS_URL_EU` for the control-api service block. The server is otherwise healthy.

## Open items

1. **`notify-keyspace-events Ex` on kv-redis-1/2**: Required for TTL expiry events to fire. Must be added to `docker-compose.local.yml` command blocks for `kv-redis-1` and `kv-redis-2`. Held for user approval (wrapper-repo change). Production Redis also needs this as a deploy prerequisite.

2. **`KV_REDIS_URL_US_EAST_1` / `KV_REDIS_URL_EU_WEST_1` in control-api env block**: The expiry worker reads `BUTTERBASE_REGIONS` (which yields long-form region names `us-east-1`, `eu-west-1`) but `docker-compose.local.yml` only wires `KV_REDIS_URL_US` / `KV_REDIS_URL_EU` to the control-api service. Fix options: (a) add `KV_REDIS_URL_US_EAST_1` and `KV_REDIS_URL_EU_WEST_1` to the control-api env block, or (b) normalize region short-form in the expiry worker. Held for user approval.

3. **Credit-burn card in UsageStrip**: Omitted from `931f6ee`. Deferred polish — no ops_used counter tracked yet.

4. **Symlink workaround** (`cloud/packages/shared/hackathon-renderers → submodules/butterbase-oss/...`): Created as local-dev workaround during Task 11 to resolve dashboard build import. Uncommitted; not in version control.
