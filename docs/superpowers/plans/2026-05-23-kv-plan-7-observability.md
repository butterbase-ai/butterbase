# KV Plan 7 — Observability & Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `_stats` scan-on-write with an O(1) running counter, ship a per-app KV tab in the customer dashboard, and ship a read-only admin KV section for cluster health / top apps / hotspots.

**Architecture:** Three subsystems land sequentially in the same branch. 7a (counter) goes first because it makes `_stats` cheap and creates the snapshot table 7c consumes. 7b (customer tab) and 7c (admin section) consume what 7a built and can ship in either order. No new dependencies; reuses existing TanStack Query, shadcn-style components, Lucide, recharts, ioredis, pg.

**Tech Stack:** Same as Plan 6 — `ioredis` via `RedisClient` wrapper, Fastify routes, Vitest. Frontend: React + TanStack Query in `cloud/services/dashboard/` (customer) and `cloud/services/admin-dashboard/` (staff).

**Spec:** `docs/superpowers/specs/2026-05-23-kv-plan-7-design.md` (commit `8a6d530`).

**Scope NOT in this plan:**
- Admin operational actions (force-evict, pause-writes, rotate-password) — deferred to a future 7d.
- Time-series metrics / historical charts.
- Customer-facing per-credit billing breakdown (separate surface).

---

## Handoff Notes for the Next Agent (read this FIRST)

The previous agent (this one) executed Plans 6 + Plan 6's reverse-move fix end-to-end and then wrote this plan in the same session. Things they learned the hard way that you won't see in the code:

### Branch state at start of Plan 7 execution

- Branch is `feat/kv-plan-6-move-app-kv` (NOT `main`). Plan 5, Plan 6, and the reverse-move fix all live here unmerged.
- HEAD at plan-write time: `ecd72af` (this plan itself). The commit before that, `bea8af4`, is the Plan 7 spec.
- Recent commits worth knowing about, newest first:
  - `ecd72af` plan: KV plan 7 — observability + dashboards
  - `bea8af4` spec: KV plan 7 — observability + dashboards
  - `c50f78b` fix(move-app): fast-path reverse-move migrates KV back to source
  - `0fe8140` feat(kv): clearKvScope helper — SCAN+UNLINK
  - `1006936` refactor(move-app): extract restoreKvIntoRegion helper
  - `9dfa584` refactor(move-app): extract dumpKvFromRegion helper
  - `a00dce1` plan: reverse-move KV fix
  - `bea8af4` (above)
  - `503cc21` test(move-app): step-restore-data hands off to dumping_kv
  - `1d21f2a` fix(move-app): app_kv_credentials.region must be short-form
  - `8136c89` fix(move-app): step-restore-data must hand off to dumping_kv
- All KV-slice tests pass: 310 passing / 7 skipped / 0 failures.
- ~96 PRE-EXISTING test failures in non-KV files (billing-gate, partner-pools, auto-api, etc.). Plan 6 baseline. **Do not chase these.**

### "STOP using us/eu in design language"

The user explicitly pushed back when I (the previous agent) used `us` / `eu` / `us-east-1` / `eu-west-1` as region names in design discussion. The codebase happens to use those today in local docker-compose and as test fixtures, but **the design language must stay neutral** (`region-1` / `region-2`, "per-region", "each KV region"). The plan and spec are scrubbed; do NOT regress this when explaining your work to the user or writing new docs.

### Project memory (non-negotiable; same as Plan 6)

- **No `Co-Authored-By: Claude` trailer in commits.** Every commit in this plan must omit it.
- **Use `uv` for any Python.** No bare `python3`.
- **Use Exa for any web search/fetch.** `mcp__exa__web_search_exa` / `mcp__exa__web_fetch_exa` over built-in WebSearch/WebFetch.
- **No internal architecture/pricing in customer-facing docs.** Plan 7's customer dashboard surfaces (UsageStrip, RecentErrors copy) MUST NOT leak lease/markup math, internal env flags, or internal error fields.
- **Branch isolation.** Do not push or merge outside `feat/kv-plan-6-move-app-kv` without explicit user approval. Wrapper-repo edits stay on the wrapper-repo's existing branch (`feat/kv-plan-3-rest-expose`).
- **Verify with full build, not just typecheck.** Run `pnpm --filter @butterbase/control-api build` AND the dashboard builds before claiming a task done.

### Local stack — already running

`cd /Users/kenneth/Documents/butterbase_backup/butterbase && docker compose -f docker-compose.local.yml ps` to confirm. Key containers (port host→container):

| Container | Port | Notes |
|---|---|---|
| `butterbase-control-api-1` | `:4000` | Rebuild + restart after every commit touching `services/control-api/` |
| `butterbase-control-plane-db-1` | `:5433` | Hosts `app_migrations`, `app_kv_credentials`, `apps`, `platform_users`, `audit_logs`, `plans`, `usage_meters`, `kv_app_usage_snapshot` (after Task 1) |
| `butterbase-runtime-plane-db-1` | `:5437` (region-1 runtime) | |
| `butterbase-runtime-plane-db-eu-1` | `:5438` (region-2 runtime) | |
| `butterbase-kv-redis-1-1` | `:6390` (region-1 KV substrate) | password `butterbase_dev_kv` |
| `butterbase-kv-redis-2-1` | `:6391` (region-2 KV substrate) | password `butterbase_dev_kv` |
| `butterbase-redis` | `:6379` | Control-plane Redis |
| `butterbase-localstack` | `:4566` | S3 emulator |
| `butterbase-dashboard-1` | `:3000` | Customer dashboard dev/prod server |
| `butterbase-dashboard-api-1` | `:4100` | Dashboard API (proxies to control-api) |
| `butterbase-cron-scheduler` | — | Runs background workers (move-app saga driver, KV reconcile, etc.) |

Db creds: `butterbase:butterbase_dev`. Dev owner: `'11111111-1111-1111-1111-111111111111'`. Smoke app: `kv-smoke-1` (kv-credentials region `us` after Plan 6 fixes).

### Rebuild + restart cycle (do this after EVERY runtime code change)

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase
docker compose -f docker-compose.local.yml build control-api
docker compose -f docker-compose.local.yml up -d control-api
sleep 6
docker compose -f docker-compose.local.yml logs --tail=15 control-api
```

For dashboard changes, the dashboard container hot-reloads via dev server in most local setups; if not, rebuild it the same way (`build dashboard` → `up -d dashboard`).

### Wrapper repo `docker-compose.local.yml` — UNCOMMITTED Plan 6 edit

The wrapper repo (`/Users/kenneth/Documents/butterbase_backup/butterbase/`) has uncommitted changes from Plan 6's live smoke:

```
?? packages/cli/kv-smoke.config.ts
?? packages/sdk/pnpm-lock.yaml
?? services/mcp-server/pnpm-lock.yaml
 M docker-compose.local.yml   ← env vars for cron-scheduler
```

The `docker-compose.local.yml` modification added env vars to the cron-scheduler service so the saga driver can talk to KV / S3 (`MOVE_APP_DRIVER_ENABLED`, `BUTTERBASE_INTERNAL_SECRET`, `KV_REDIS_URL_US_EAST_1`, `KV_REDIS_URL_EU_WEST_1`, `MOVE_APP_DUMP_BUCKET`, `MOVE_APP_DUMP_BUCKET_REGION`, `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). The wrapper repo is on `feat/kv-plan-3-rest-expose` (not Plan 6's branch). Per project memory, do NOT commit cross-branch without user approval.

**For Plan 7 Task 3:** you will need to ADD `--notify-keyspace-events Ex` to both `kv-redis-1` and `kv-redis-2` services in this same file. Same constraint applies: surface the diff in your task report and let the user decide whether to commit.

### Pre-existing test failures — do not chase

Running the full control-api suite ends with:
```
Test Files  27 failed | <N> passed (139)
      Tests  96 failed | <N> passed (988)
```

The 96 failures are pre-existing across 27 files (billing-gate FK errors, partner-pools missing `BUTTERBASE_REGIONS`, schema, auto-api, etc.). The KV slice is clean — verify Plan 7 work against `pnpm --filter @butterbase/control-api test kv keys move-app` and confirm 0 failures in that filter. Plan 6 + reverse-move-fix ended with **310 passing / 0 failing** on the KV slice; Plan 7 should leave both higher (new tests added) and not regress the rest.

### Cron-scheduler image is a separate container with its own build

The cron-scheduler runs in a SEPARATE container from control-api but shares the same `services/control-api/` source. Rebuilding `control-api` does NOT automatically rebuild `cron-scheduler`. When you change worker code (e.g., adding the new keys-expiry-worker in Task 3), rebuild BOTH:

```
docker compose -f docker-compose.local.yml build control-api cron-scheduler
docker compose -f docker-compose.local.yml up -d control-api cron-scheduler
```

The cron-scheduler's logger renders structured log args as `[object Object]` (cosmetic, not a functional bug — Plan 6 smoke flagged this). Read the message field for content.

### API shape gotchas (carried over from Plan 5 + 6 smoke)

- **`platform_users` column is `credits_usd`, not `topup_usd`.** `topup_usd` is an API response field name; the DB column is `credits_usd`. SQL like `UPDATE platform_users SET topup_usd=0` will fail.
- **`_batch` body shape is `{ops: [{op: 'set'|'del'|'get', key, value?}]}`** — NOT `{type: 'put'|'delete'}`. See `services/control-api/src/routes/v1/kv-data.ts` `_batch` handler.
- **DELETE returns 200 with `{deleted: N}`**, not 204. By design — don't "fix" it.
- **Region naming inconsistency is real.** `apps.region` and `app_kv_credentials.region` store short form (`us`, `eu`); `app_migrations.source_region`/`dest_region` and `user_app_index.region` store long form (`us-east-1`, `eu-west-1`); `kvRedisFor()` builds env keys by `region.toUpperCase().replace(/-/g, '_')`. Plan 6's `toKvRegion()` helper (in `step-restore-kv.ts`) is the canonical long→short mapper. **For Plan 7's customer dashboard and admin endpoints**: when displaying region to users, show whatever `apps.region` has. For `kvRedisFor()` calls in admin endpoints, derive from `BUTTERBASE_REGIONS` env (long form), iterate that list, build env keys with the existing transform.

### Subagent quirks (observed across Plans 5–6)

- Implementer subagents (especially sonnet) sometimes run a test in the background and return BEFORE committing. Always `git status` after a subagent returns DONE — if there are uncommitted files, either commit them yourself or re-dispatch with explicit instructions.
- The `RedisClient.del` API takes an ARRAY: `del([key1, key2])`, not varargs. Plan 5 / 6 / reverse-move-fix all use this form. Match it.
- Implementer agents sometimes assert "build clean" without running the build. Re-verify with `pnpm --filter @butterbase/control-api build` before approving a task.
- When a `vi.mock(...)` at module scope conflicts with a same-file integration test that needs the real module, the previous agent's standard fix is to SPLIT the integration test into a separate file (e.g., `*-integration.test.ts`). See `step-block-writes-integration.test.ts` for the pattern.

### Model selection per task (recommendation, not gospel)

- Tasks 1, 2, 5, 6, 8, 9, 10, 11 (mechanical, well-specified backend / well-specified component): **haiku**.
- Tasks 3, 4, 12, 13, 14 (multi-file integration, subscriber wiring, snapshot+counter coupling, admin endpoints with several SQL aggregations): **sonnet**.
- Tasks 7, 15 (dashboard route wiring — needs codebase exploration to find the routes file): **sonnet**.
- Task 16 (admin tables — once Task 15 located the routes file, mechanical): **haiku**.
- Task 17 (verification + smoke — coordination): **sonnet**.

### Use TaskCreate / TaskUpdate from the start

The harness has `TaskCreate` / `TaskUpdate` / `TaskList` tools (deferred — load via `ToolSearch` with `query "select:TaskCreate,TaskUpdate,TaskList"`). Create one task per task in this plan up front; mark in_progress when dispatching, completed when the subagent returns DONE. The system nags otherwise.

### Spec for this plan

`docs/superpowers/specs/2026-05-23-kv-plan-7-design.md` (commit `bea8af4`). Read it once before starting.

---

## Pre-Execution Context

**Repo layout:**
- OSS code: `/Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss/`
- Wrapper (docker-compose): `/Users/kenneth/Documents/butterbase_backup/butterbase/`
- All work continues on branch `feat/kv-plan-6-move-app-kv`. Per project memory, do NOT push or merge outside this branch without explicit approval.

**Existing wiring you will integrate with:**

- `services/control-api/src/services/kv/storage-counter.ts` — has `getStorageBytes`, `incBytes`, `decBytes`, `resetCounter`, `reconcileFromScan(client, appId, baseOpts) → {actual, previous}`. The `withDb(baseOpts, db, fn)` helper opens fresh `RedisClient.connect({...baseOpts, db})` per-DB. **Plan 7's keys counter mirrors this file's shape exactly.** Plan 6 verified the per-DB connect-and-close discipline.
- `services/control-api/src/services/kv/admin.ts` — has `appStats(baseOpts, appId)` returning `{keys_total, bytes_used, ops_per_sec}`. `countKeysFromScan(baseOpts, appId)` is the scan we're killing.
- `services/control-api/src/services/kv/limits.ts` — has `getKvLimitsForApp(controlDb, appId)` returning `{maxKeysTotal, maxStorageBytes, maxOpsPerSec, maxValueBytes}`. Cached 60s. Used to populate the `_stats` inline limits.
- `services/control-api/src/services/kv/reconcile-worker.ts` — starts at boot, runs every 24h, calls `reconcileFromScan` per app. This worker is also the one we extend to write `kv_app_usage_snapshot` rows.
- `services/control-api/src/services/kv/redis-registry.ts` — `kvRedisFor(region) → Redis` (shared, long-lived ioredis). Do NOT use this for the expiry subscriber — `subscribe()` puts the connection in subscribe mode and blocks normal commands. Use a fresh `new Redis(url)` per region.
- `services/control-api/src/routes/v1/kv-data.ts` — line ~227 has `type AccountFn = (sizeDelta: number) => void;`. Line ~695 has `if ((fastify as any).kvAccount) { ... }`. Plan 7a extends both: `type AccountFn = (sizeDelta: number, keyDelta: number) => void;` and the fastify decorator accepts the same second argument.
- `services/control-api/src/plugins/kv-quota.ts` — `kvAccount` decorator at line ~267 takes `(request, sizeDelta=0)`. Extend to `(request, sizeDelta=0, keyDelta=0)`. The `FastifyInstance` augmentation at line ~37 needs the new param.
- `services/control-api/src/index.ts` — worker startup ladder. The "KV reconcile worker started" log line is where we add "KV expiry-subscriber started". Search for it; the file is long.
- `services/control-api/src/routes/admin.ts` — the user-facing admin dashboard's auth pattern: `{ config: { public: true } }` on the route, then manual `Authorization: Bearer <jwt>` parsing inside the handler, then `SELECT is_admin FROM platform_users WHERE cognito_sub = $1`. Plan 7c follows the same pattern. Look at the existing `/admin/overview` handler in this file (~line 52) for the boilerplate.
- `services/control-api/src/plugins/internal-auth.ts` — `/v1/internal/*` machine-to-machine auth. Plan 7's admin endpoints DO NOT use this; they're user-facing admin (different audience).
- `services/control-api/src/routes/admin-auth.ts` — `adminAuthRoutes` is where the JWT-verification + `is_admin` lookup lives. Reuse `authProvider` from there.
- `db/control-plane/` — existing migrations go up to 075 (per Plan 6's note). New migration is 076.
- `db/control-plane/migrate.ts` — the migration runner. It tracks applied migrations in the `_migrations` table; any new SQL file in `db/control-plane/` is picked up on next boot.

**Customer dashboard wiring:**
- `cloud/services/dashboard/src/layouts/AppLayout.tsx` — has `getSubNav(appId)` returning the tab list (Overview, Schema, Data, Users, OAuth, RLS, Functions, Deployments, Realtime, AI, Storage, Monetization, Integrations, Audit, App settings). Plan 7b inserts a KV tab between Storage and Monetization.
- Route registration: search for where routes like `/apps/:appId/storage` are declared. Likely in `App.tsx` or a `routes.tsx` file.
- TanStack Query patterns: existing `src/lib/queries/` shows the convention — one hook per endpoint, keyed by `[scope, ...params]`. Plan 7b follows this.
- Components: existing pages mostly compose shadcn-style cards/tables/buttons from `src/components/ui/`. Reuse, don't invent.

**Admin dashboard wiring:**
- `cloud/services/admin-dashboard/src/pages/` — top-level pages. Plan 7c adds `KvPage.tsx`.
- `cloud/services/admin-dashboard/src/components/charts/` — recharts is already a dep. We don't use it in 7c (snapshot tables only) but it's there if needed.
- Nav: search for where existing pages are linked in the layout. Add the KV entry alongside.

**Critical traps:**
- **`notify-keyspace-events Ex` MUST be on the test Redises** for expiry-subscriber integration tests. The plan adds `--notify-keyspace-events Ex` to `docker-compose.local.yml`. Production Redis needs the same change as a deploy prerequisite — flagged but NOT part of this plan's commits.
- **DO NOT use `kvRedisFor(region)` for the subscriber.** That client is shared with the main control-api request handling. `subscribe()` would lock it into subscribe mode. Use a dedicated `new Redis(url)` per region in the expiry worker.
- **Per-DB scan in reconcile**: keys live on both DB 0 (`u:*`) AND DB 1 (`u:*` ephemeral). `reconcileFromScan` already does this for bytes; extend to also count keys in the same pass.
- **`_meta:keys` is on DB 0 only.** Same as `_meta:bytes`. The expiry subscriber listens on both DB 0 AND DB 1 expirations, but the counter it updates is always on DB 0. Open a separate `RedisClient.connect({...opts, db: 0})` for the decrement; don't try to `.select(0)` on the subscribed connection.
- **kvAccount idempotency on errors.** If the user-facing op succeeds but the counter incr fails, swallow the error and log warn. The user's PUT must not 5xx because of accounting. Reconcile catches drift.
- **`_audit_recent` returns the LAST 50.** Pull from `audit_logs` table with `ORDER BY at DESC LIMIT $1`. The existing `query_audit_logs` function may not have a "recent + status filter" shape — write the SQL inline in the route handler; it's a simple query.
- **Migration 076 must land in Task 1.** Otherwise Task 4's reconcile extension writes to a nonexistent table. The migration runner picks up `076_kv_app_usage_snapshot.sql` on next control-api boot.

**Verification rule (per `feedback_verify_with_build.md`):** full `pnpm -r build` and `docker build` cycles before pushing. Final task does both.

---

## File Structure

**Created (control-api):**
- `db/control-plane/076_kv_app_usage_snapshot.sql` — admin snapshot table.
- `services/control-api/src/services/kv/keys-counter.ts` — `incKeys`, `decKeys`, `getKeys`, `resetKeysCounter`. Mirrors `storage-counter.ts` shape.
- `services/control-api/src/services/kv/keys-counter.test.ts`
- `services/control-api/src/services/kv/keys-expiry-worker.ts` — `startKeysExpiryWorker(opts) → { stop }`. One ioredis subscriber per region, listens to keyspace expiry events.
- `services/control-api/src/services/kv/keys-expiry-worker.test.ts`
- `services/control-api/src/routes/v1/kv-audit-recent.ts` — `GET /v1/:app_id/kv/_audit_recent` route plugin.
- `services/control-api/src/routes/v1/kv-audit-recent.test.ts`
- `services/control-api/src/routes/admin/kv-admin-stats.ts` — three new admin endpoints (cluster-health, top-apps, hotspots).
- `services/control-api/src/routes/admin/kv-admin-stats.test.ts`
- `services/control-api/src/lib/admin-guard.ts` — small `requireAdmin(req, reply, controlDb)` helper used by 7c endpoints. Returns `{user}` on success or null after sending 401/403.
- `services/control-api/src/lib/admin-guard.test.ts`

**Created (customer dashboard):**
- `cloud/services/dashboard/src/pages/app/kv/KvPage.tsx`
- `cloud/services/dashboard/src/pages/app/kv/UsageStrip.tsx`
- `cloud/services/dashboard/src/pages/app/kv/ExposeRulesTable.tsx`
- `cloud/services/dashboard/src/pages/app/kv/KeyBrowser.tsx`
- `cloud/services/dashboard/src/pages/app/kv/RecentErrors.tsx`
- `cloud/services/dashboard/src/lib/queries/kv.ts` — TanStack Query hooks for `_stats`, `_scan`, `_expose`, `_audit_recent`, per-key CRUD.

**Created (admin dashboard):**
- `cloud/services/admin-dashboard/src/pages/KvPage.tsx`
- `cloud/services/admin-dashboard/src/components/kv/ClusterHealthTable.tsx`
- `cloud/services/admin-dashboard/src/components/kv/TopAppsTable.tsx`
- `cloud/services/admin-dashboard/src/components/kv/HotspotsTable.tsx`
- `cloud/services/admin-dashboard/src/lib/queries/kv-admin.ts` — TanStack Query hooks.

**Modified:**
- `services/control-api/src/routes/v1/kv-data.ts` — extend `AccountFn` to `(sizeDelta, keyDelta) => void`; compute `keyDelta` from `oldRaw === null && newRaw !== null` (writes) or `oldRaw !== null && deletion` (dels); sum batch deltas.
- `services/control-api/src/plugins/kv-quota.ts` — `kvAccount` decorator accepts `keyDelta`; calls `incKeys` / `decKeys` when nonzero; FastifyInstance augmentation updated.
- `services/control-api/src/services/kv/storage-counter.ts` — `reconcileFromScan` also counts `{appId}:u:*` keys, writes `_meta:keys`, and inserts/updates a row in `kv_app_usage_snapshot`.
- `services/control-api/src/services/kv/storage-counter.test.ts` — additional assertions for keys + snapshot.
- `services/control-api/src/services/kv/admin.ts` — `appStats` reads `_meta:keys` (O(1)); deletes `countKeysFromScan`; returned shape adds `max_keys`, `max_storage_bytes`, `max_ops_per_sec`, `max_value_bytes`.
- `services/control-api/src/services/kv/admin.test.ts` (if exists) — adjust shape expectations.
- `services/control-api/src/routes/v1/kv-admin.ts` — `_stats` route response type widened; route handler itself unchanged.
- `services/control-api/src/index.ts` — register `kv-audit-recent` and `kv-admin-stats` route plugins; start `keysExpiryWorker` on boot.
- `cloud/services/dashboard/src/layouts/AppLayout.tsx` — add KV entry to `getSubNav`.
- `cloud/services/dashboard/src/App.tsx` (or routes file — locate during Task 7) — register `/apps/:appId/kv` route.
- `cloud/services/admin-dashboard/src/App.tsx` (or routes file — locate during Task 15) — register `/kv` route + nav link.
- `docker-compose.local.yml` (wrapper repo) — add `--notify-keyspace-events Ex` to both kv-redis services. **Do NOT commit this change in the OSS submodule branch.** It's a wrapper-repo edit; flag in the task and leave uncommitted unless user approves the wrapper-repo edit separately.

**Deleted:**
- `countKeysFromScan` helper inside `services/control-api/src/services/kv/admin.ts` (replaced by O(1) GET).

---

## Tasks

### Task 1: `kv_app_usage_snapshot` migration + `keys-counter.ts` helpers

**Files:**
- Create: `db/control-plane/076_kv_app_usage_snapshot.sql`
- Create: `services/control-api/src/services/kv/keys-counter.ts`
- Create: `services/control-api/src/services/kv/keys-counter.test.ts`

- [ ] **Step 1: Write the migration SQL**

```sql
-- db/control-plane/076_kv_app_usage_snapshot.sql
-- Snapshot table for the admin KV dashboard. Populated by the daily reconcile
-- worker; values may be up to 24h stale.
CREATE TABLE IF NOT EXISTS kv_app_usage_snapshot (
  app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  region        TEXT NOT NULL,
  bytes_used    BIGINT NOT NULL DEFAULT 0,
  keys_total    BIGINT NOT NULL DEFAULT 0,
  snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kv_app_usage_snapshot_bytes ON kv_app_usage_snapshot (bytes_used DESC);
CREATE INDEX IF NOT EXISTS idx_kv_app_usage_snapshot_keys  ON kv_app_usage_snapshot (keys_total DESC);
```

- [ ] **Step 2: Apply the migration locally**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
docker exec butterbase-control-plane-db-1 psql -U butterbase -d butterbase_control \
  -c "$(cat db/control-plane/076_kv_app_usage_snapshot.sql)"
# Then record in _migrations so the runner doesn't try to re-apply:
docker exec butterbase-control-plane-db-1 psql -U butterbase -d butterbase_control -c \
  "INSERT INTO _migrations (filename) VALUES ('076_kv_app_usage_snapshot.sql') ON CONFLICT DO NOTHING;"
```

Verify:
```
docker exec butterbase-control-plane-db-1 psql -U butterbase -d butterbase_control -c \
  "\d kv_app_usage_snapshot"
```
Expected: table with 5 columns, both indexes present.

- [ ] **Step 3: Write the failing helper tests**

Create `services/control-api/src/services/kv/keys-counter.test.ts`. Mirror `storage-counter.test.ts` for harness setup (read it first). Tests:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { incKeys, decKeys, getKeys, resetKeysCounter } from './keys-counter.js';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

function baseOptsFromEnv() {
  const u = new URL(process.env.KV_REDIS_URL_US!);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

describeKv('keys-counter', () => {
  let client: RedisClient;
  let appId: string;

  beforeEach(async () => {
    appId = `keys-counter-test-${randomUUID()}`;
    client = await RedisClient.connect({ ...baseOptsFromEnv(), db: 0 });
  });

  afterEach(async () => {
    await resetKeysCounter(client, appId);
    await client.close();
  });

  it('getKeys returns 0 when the counter is absent', async () => {
    expect(await getKeys(client, appId)).toBe(0);
  });

  it('incKeys increments and returns the new value', async () => {
    expect(await incKeys(client, appId, 3)).toBe(3);
    expect(await incKeys(client, appId, 2)).toBe(5);
    expect(await getKeys(client, appId)).toBe(5);
  });

  it('decKeys decrements and clamps the input but allows negative results', async () => {
    await incKeys(client, appId, 5);
    expect(await decKeys(client, appId, 2)).toBe(3);
    expect(await decKeys(client, appId, 10)).toBe(-7);
    expect(await getKeys(client, appId)).toBe(-7);
  });

  it('incKeys clamps a negative delta to 0 (defensive)', async () => {
    expect(await incKeys(client, appId, -5)).toBe(0);
    expect(await getKeys(client, appId)).toBe(0);
  });

  it('decKeys clamps a negative delta to 0 (defensive)', async () => {
    await incKeys(client, appId, 3);
    expect(await decKeys(client, appId, -5)).toBe(3);
    expect(await getKeys(client, appId)).toBe(3);
  });

  it('resetKeysCounter deletes the counter', async () => {
    await incKeys(client, appId, 7);
    await resetKeysCounter(client, appId);
    expect(await getKeys(client, appId)).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```
KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test keys-counter
```

Expected: FAIL with `Cannot find module './keys-counter.js'`.

- [ ] **Step 5: Implement the helpers**

Create `services/control-api/src/services/kv/keys-counter.ts`:

```ts
// services/control-api/src/services/kv/keys-counter.ts
// Per-app key-count counter on KV Redis (DB 0).
//
// Maintains a running count at `{appId}:_meta:keys` for the total number of
// user keys in this app across DB 0 (durable) + DB 1 (ephemeral). Updated by
// kvAccount on writes/deletes and by the keys-expiry-worker on TTL expiries.
// Reconciled daily by the cron job to recover from drift.
//
// exported API:
//   getKeys(client, appId)             → Promise<number>
//   incKeys(client, appId, delta)      → Promise<number>
//   decKeys(client, appId, delta)      → Promise<number>
//   resetKeysCounter(client, appId)    → Promise<void>

import type { RedisClient } from './redis-client.js';

const metaKey = (appId: string) => `{${appId}}:_meta:keys`;

/** Current key count for the app. Returns 0 when the counter is absent. */
export async function getKeys(client: RedisClient, appId: string): Promise<number> {
  const v = await client.get(metaKey(appId));
  return v ? parseInt(v, 10) : 0;
}

/** Increment by delta (clamped to >= 0). Returns the new counter value. */
export async function incKeys(client: RedisClient, appId: string, delta: number): Promise<number> {
  return client.incrBy(metaKey(appId), Math.max(0, delta));
}

/** Decrement by delta (clamped to >= 0). Returns the new counter value. */
export async function decKeys(client: RedisClient, appId: string, delta: number): Promise<number> {
  return client.decrBy(metaKey(appId), Math.max(0, delta));
}

/** Delete the counter (test cleanup, manual reset). */
export async function resetKeysCounter(client: RedisClient, appId: string): Promise<void> {
  await client.del([metaKey(appId)]);
}
```

- [ ] **Step 6: Run the tests**

```
KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test keys-counter
```

Expected: 6 passed.

- [ ] **Step 7: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 8: Commit**

```
git add db/control-plane/076_kv_app_usage_snapshot.sql \
        services/control-api/src/services/kv/keys-counter.ts \
        services/control-api/src/services/kv/keys-counter.test.ts
git commit -m "feat(kv): keys-counter helpers + kv_app_usage_snapshot migration"
```

No `Co-Authored-By` trailer.

---

### Task 2: Wire `keyDelta` through `kv-data.ts` + `kvAccount`

**Files:**
- Modify: `services/control-api/src/routes/v1/kv-data.ts`
- Modify: `services/control-api/src/plugins/kv-quota.ts`
- Modify: `services/control-api/src/plugins/kv-quota.test.ts`

- [ ] **Step 1: Read the current `kv-data.ts` accounting paths**

The relevant lines (per Plan 7 spec):
- Line ~227: `type AccountFn = (sizeDelta: number) => void;`
- Lines ~375, ~443, ~475, ~514, ~559: `account(sizeDeltaBytes(oldRaw, encoded));` (writes)
- Line ~678 (inside `_batch`): `batchStorageDelta += sizeDeltaBytes(oldRaw, encoded);`
- Line ~695: `if ((fastify as any).kvAccount) { (fastify as any).kvAccount(request, batchStorageDelta); }`

Identify each PUT/SETNX/CAS/INCR/DECR/MSET/DEL path. There are 5–6 single-op call sites and 1 batch site.

- [ ] **Step 2: Add a keyDelta helper next to sizeDeltaBytes**

Append after `sizeDeltaBytes` (around line ~47):

```ts
/**
 * +1 when a write inserts a new key (oldRaw was null and newRaw is set),
 * -1 when a delete removes an existing key, 0 otherwise (overwrite or
 * delete-of-missing). Used to maintain the keys_total counter via kvAccount.
 */
function keyDeltaForWrite(oldRaw: string | null, newRaw: string | null): number {
  if (oldRaw === null && newRaw !== null) return 1;
  if (oldRaw !== null && newRaw === null) return -1;
  return 0;
}
```

- [ ] **Step 3: Extend `AccountFn` and every account() call site**

Change the type and the wrapper at the top of the file:

```ts
type AccountFn = (sizeDelta: number, keyDelta: number) => void;
```

Update every call site that currently does `account(sizeDeltaBytes(oldRaw, ...))`:

```ts
// Was:
account(sizeDeltaBytes(oldRaw, encoded));
// Becomes:
account(sizeDeltaBytes(oldRaw, encoded), keyDeltaForWrite(oldRaw, encoded));
```

Specifically, update all 5–6 call sites identified in Step 1. For the read path (`sizeDelta=0`), pass `0` for keyDelta too:

```ts
// Read paths:
account(0, 0);
```

For the explicit delete path (e.g., line ~559 where it does `account(sizeDeltaBytes(oldRaw, nextArg))` for `nextArg=null`), the `keyDeltaForWrite(oldRaw, null)` returns `-1` when `oldRaw !== null`, which is correct.

- [ ] **Step 4: Extend the batch accumulator**

In the `_batch` handler (around line ~660–700):

```ts
let batchStorageDelta = 0;
let batchKeyDelta = 0;  // NEW

for (const op of ops) {
  // ... existing per-op logic ...
  if (op.op === 'set' || op.op === 'setnx') {
    // ... existing ...
    batchStorageDelta += sizeDeltaBytes(oldRaw, encoded);
    batchKeyDelta    += keyDeltaForWrite(oldRaw, encoded);  // NEW
  } else if (op.op === 'del') {
    // ... existing ...
    batchStorageDelta += sizeDeltaBytes(oldRaw, null);
    batchKeyDelta    += keyDeltaForWrite(oldRaw, null);     // NEW
  }
}

if ((fastify as any).kvAccount) {
  (fastify as any).kvAccount(request, batchStorageDelta, batchKeyDelta);  // NEW arg
}
```

The exact lines may differ — adapt to the file's current shape.

- [ ] **Step 5: Extend `kvAccount` in `kv-quota.ts`**

Update the `FastifyInstance` augmentation (around line ~36):

```ts
declare module 'fastify' {
  interface FastifyInstance {
    kvAccount(request: FastifyRequest, sizeDelta?: number, keyDelta?: number): void;
  }
}
```

Update the decorator (around line ~267):

```ts
fastify.decorate('kvAccount', (request: FastifyRequest, sizeDelta = 0, keyDelta = 0) => {
  const op = (request as any).kvOp as KvOp | undefined;
  const ownerId = (request as any).kvOwnerId as string | undefined;
  const region = (request as any).kvRegion as string | undefined;
  const appId = ((request.params as any)?.app_id) as string | undefined;

  if (!op || !ownerId || !appId) return;

  // Non-blocking credit accounting
  const cost = creditCostForOp(op);
  void incrementUsage(ownerId, 'kv_ops', cost, appId);

  if (sizeDelta !== 0) {
    void incrementUsage(ownerId, 'kv_storage_bytes', Math.abs(sizeDelta), appId);

    if (region) {
      const kvR = wrap(kvRedisFor(region));
      if (sizeDelta > 0) {
        void incBytes(kvR, appId, sizeDelta);
      } else {
        void decBytes(kvR, appId, -sizeDelta);
      }
    }
  }

  // NEW: keys-counter maintenance. Swallow errors — drift recovered by reconcile.
  if (keyDelta !== 0 && region) {
    const kvR = wrap(kvRedisFor(region));
    if (keyDelta > 0) {
      void incKeys(kvR, appId, keyDelta).catch(() => { /* reconcile catches drift */ });
    } else {
      void decKeys(kvR, appId, -keyDelta).catch(() => { /* reconcile catches drift */ });
    }
  }
});
```

Add the import at the top:
```ts
import { incKeys, decKeys } from '../services/kv/keys-counter.js';
```

- [ ] **Step 6: Add a test for the keyDelta path in `kv-quota.test.ts`**

Find the existing kvAccount-related tests. Add:

```ts
it('kvAccount increments the keys counter when keyDelta > 0', async () => {
  // (uses the existing test harness — same setup as the storage-counter tests in this file)
  // Set up a request with kvOp/ownerId/region stashed, then call fastify.kvAccount(req, 0, 1).
  // Assert getKeys(kvClient, appId) === 1 afterward.
  // Wait briefly for the void promise to land — same pattern existing tests use for storage.
});

it('kvAccount decrements the keys counter when keyDelta < 0', async () => {
  // Pre-seed counter to 5; call kvAccount(req, 0, -2); assert getKeys === 3.
});

it('kvAccount handles batch deltas (sizeDelta and keyDelta together)', async () => {
  // Pre-seed counter to 0; call kvAccount(req, 100, 2); assert getStorageBytes === 100 AND getKeys === 2.
});
```

Use the existing `setKvBlock`/`getKvAccountState`/etc. helpers in the file. Read the existing `kvAccount` tests in `kv-quota.test.ts` for the exact harness shape.

- [ ] **Step 7: Run the tests**

```
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv-quota kv-data keys-counter
```

Expected: all green (existing tests + new keyDelta tests).

- [ ] **Step 8: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 9: Commit**

```
git add services/control-api/src/routes/v1/kv-data.ts \
        services/control-api/src/plugins/kv-quota.ts \
        services/control-api/src/plugins/kv-quota.test.ts
git commit -m "feat(kv): wire keyDelta through kv-data write/del paths via kvAccount"
```

No `Co-Authored-By` trailer.

---

### Task 3: KV expiry-subscriber worker

**Files:**
- Create: `services/control-api/src/services/kv/keys-expiry-worker.ts`
- Create: `services/control-api/src/services/kv/keys-expiry-worker.test.ts`
- Modify: `docker-compose.local.yml` (wrapper repo) — add `--notify-keyspace-events Ex` to both kv-redis services. Discuss with user before committing to the wrapper repo.

- [ ] **Step 1: Confirm `notify-keyspace-events` is enabled on the test Redises**

```
docker exec butterbase-kv-redis-1-1 redis-cli -a butterbase_dev_kv CONFIG GET notify-keyspace-events
```

Expected if Plan 7 hasn't been deployed yet: `""` (empty — disabled). The integration test will fail until we set it.

Set it temporarily for the local test session:
```
docker exec butterbase-kv-redis-1-1 redis-cli -a butterbase_dev_kv CONFIG SET notify-keyspace-events Ex
docker exec butterbase-kv-redis-2-1 redis-cli -a butterbase_dev_kv CONFIG SET notify-keyspace-events Ex
```

For persistence, add to `docker-compose.local.yml` (wrapper repo). **Hold this edit; flag to user before committing.**

- [ ] **Step 2: Write the failing test**

Create `services/control-api/src/services/kv/keys-expiry-worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisClient } from './redis-client.js';
import { startKeysExpiryWorker, type KeysExpiryWorker } from './keys-expiry-worker.js';
import { incKeys, getKeys, resetKeysCounter } from './keys-counter.js';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

describeKv('keys-expiry-worker', () => {
  let appId: string;
  let writer: Redis;
  let worker: KeysExpiryWorker;
  let counterClient: RedisClient;

  beforeEach(async () => {
    appId = `expiry-test-${randomUUID()}`;
    writer = new Redis(process.env.KV_REDIS_URL_US!);
    counterClient = await RedisClient.connect({
      host: new URL(process.env.KV_REDIS_URL_US!).hostname,
      port: Number(new URL(process.env.KV_REDIS_URL_US!).port) || 6379,
      password: decodeURIComponent(new URL(process.env.KV_REDIS_URL_US!).password),
      db: 0,
    });
    await incKeys(counterClient, appId, 2);
    // Verify notify-keyspace-events is set; skip rest of test if not.
    const [, val] = await writer.config('GET', 'notify-keyspace-events');
    if (!val || !val.includes('E') || !val.includes('x')) {
      throw new Error('Test prereq: redis must have notify-keyspace-events Ex set');
    }
    worker = startKeysExpiryWorker({
      regions: ['us-test'],
      urlForRegion: () => process.env.KV_REDIS_URL_US!,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    // Wait briefly for subscriber to be ready
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    await worker.stop();
    await resetKeysCounter(counterClient, appId);
    await counterClient.close();
    await writer.quit();
  });

  it('decrements the counter when a user key expires', async () => {
    await writer.set(`{${appId}}:u:ephemeral`, 'v', 'PX', 200);
    // Wait for TTL + propagation
    await new Promise((r) => setTimeout(r, 800));
    expect(await getKeys(counterClient, appId)).toBe(1);
  });

  it('ignores non-user-key expiries (_meta:rate:* etc.)', async () => {
    await writer.set(`{${appId}}:_meta:rate:9999`, '5', 'PX', 200);
    await new Promise((r) => setTimeout(r, 800));
    // Counter unchanged (still 2 from beforeEach incKeys)
    expect(await getKeys(counterClient, appId)).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```
KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test keys-expiry-worker
```

Expected: FAIL with `Cannot find module './keys-expiry-worker.js'`.

- [ ] **Step 4: Implement the worker**

Create `services/control-api/src/services/kv/keys-expiry-worker.ts`:

```ts
// services/control-api/src/services/kv/keys-expiry-worker.ts
// Per-region ioredis subscriber that listens to keyspace expiry events and
// decrements the per-app keys counter. Required Redis config:
//   notify-keyspace-events Ex   (E = keyevent, x = expired)
//
// Each subscriber connection is dedicated — do NOT share with the main
// kvRedisFor() pool. SUBSCRIBE puts the connection in subscribe mode.
//
// The worker subscribes to BOTH DB 0 and DB 1 expiry channels per region.
// Counter writes always target DB 0 (where {appId}:_meta:keys lives) on a
// separate non-subscribed client.

import { Redis } from 'ioredis';
import { decKeys } from './keys-counter.js';
import { RedisClient, type RedisClientOptions } from './redis-client.js';

const USER_KEY_RE = /^\{([^}]+)\}:u:/;

export interface KeysExpiryWorker {
  stop(): Promise<void>;
}

export interface StartKeysExpiryWorkerOpts {
  /** Region identifiers passed to urlForRegion. */
  regions: string[];
  /** Map region → Redis URL. */
  urlForRegion: (region: string) => string;
  log: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
}

function parseOpts(url: string): Omit<RedisClientOptions, 'db'> {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

export function startKeysExpiryWorker(opts: StartKeysExpiryWorkerOpts): KeysExpiryWorker {
  const subs: Redis[] = [];
  const writers = new Map<string, RedisClient>();   // region → DB 0 writer
  const writerInflight = new Map<string, Promise<RedisClient>>();

  async function getWriter(region: string): Promise<RedisClient> {
    let w = writers.get(region);
    if (w) return w;
    let pending = writerInflight.get(region);
    if (pending) return pending;
    pending = (async () => {
      const c = await RedisClient.connect({ ...parseOpts(opts.urlForRegion(region)), db: 0 });
      writers.set(region, c);
      writerInflight.delete(region);
      return c;
    })();
    writerInflight.set(region, pending);
    return pending;
  }

  for (const region of opts.regions) {
    const url = opts.urlForRegion(region);
    const sub = new Redis(url);

    sub.on('error', (err) => {
      opts.log.warn({ region, err: (err as Error).message }, '[keys-expiry] subscriber error');
    });

    sub.on('ready', () => {
      // Subscribe to BOTH DB 0 and DB 1 expirations.
      sub.subscribe('__keyevent@0__:expired', '__keyevent@1__:expired').catch((err) => {
        opts.log.error({ region, err: (err as Error).message }, '[keys-expiry] subscribe failed');
      });
      opts.log.info({ region }, '[keys-expiry] subscribed');
    });

    sub.on('message', async (_channel, key) => {
      const m = USER_KEY_RE.exec(key);
      if (!m) return;
      const appId = m[1];
      try {
        const writer = await getWriter(region);
        await decKeys(writer, appId, 1);
      } catch (err) {
        opts.log.warn({ region, key, err: (err as Error).message }, '[keys-expiry] decrement failed');
      }
    });

    subs.push(sub);
  }

  return {
    async stop() {
      await Promise.all(subs.map((s) => s.quit().catch(() => {})));
      for (const w of writers.values()) await w.close().catch(() => {});
      writers.clear();
    },
  };
}
```

- [ ] **Step 5: Run the tests**

```
KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test keys-expiry-worker
```

Expected: 2 passed.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add services/control-api/src/services/kv/keys-expiry-worker.ts \
        services/control-api/src/services/kv/keys-expiry-worker.test.ts
git commit -m "feat(kv): keys-expiry-worker — decrement counter on TTL expiry events"
```

No `Co-Authored-By` trailer.

- [ ] **Step 8: Flag the docker-compose change to the user**

The wrapper repo `docker-compose.local.yml` needs `--notify-keyspace-events Ex` on both kv-redis services for the worker to function locally on container restart. The change looks like:

```yaml
  kv-redis-1:
    image: redis:7-alpine
    command: redis-server --requirepass butterbase_dev_kv --notify-keyspace-events Ex
    # ...
  kv-redis-2:
    image: redis:7-alpine
    command: redis-server --requirepass butterbase_dev_kv --notify-keyspace-events Ex
    # ...
```

Hold this edit. Surface it in the Task 3 report so the user can choose whether to commit it on the wrapper repo's branch.

---

### Task 4: Extend reconcile worker for keys + snapshot row

**Files:**
- Modify: `services/control-api/src/services/kv/storage-counter.ts`
- Modify: `services/control-api/src/services/kv/storage-counter.test.ts`

- [ ] **Step 1: Read the current `reconcileFromScan`**

The function at `storage-counter.ts:86–119` (line numbers from Plan 6 reading) does:
1. Read current `_meta:bytes` (the `previous`).
2. SCAN both DB 0 and DB 1 for `{appId}:u:*`.
3. Sum `MEMORY USAGE` of each.
4. Write `_meta:bytes = actual`.
5. Return `{actual, previous}`.

Plan 7 extends this to also count keys and write a snapshot row.

- [ ] **Step 2: Add a test for the new behavior**

Append to `storage-counter.test.ts`:

```ts
it('reconcileFromScan also updates _meta:keys with the actual count', async () => {
  const appId = `recon-keys-${randomUUID()}`;
  const base = baseOptsFromEnv();
  const c0 = await RedisClient.connect({ ...base, db: 0 });
  const c1 = await RedisClient.connect({ ...base, db: 1 });
  try {
    await c0.set(`{${appId}}:u:a`, 'va');
    await c0.set(`{${appId}}:u:b`, 'vb');
    await c1.set(`{${appId}}:u:eph`, 've');
    // Pre-seed wrong counter
    await c0.set(`{${appId}}:_meta:keys`, '99');

    await reconcileFromScan(c0, appId, base);

    const got = await c0.get(`{${appId}}:_meta:keys`);
    expect(parseInt(got!, 10)).toBe(3);
  } finally {
    await c0.del([`{${appId}}:u:a`, `{${appId}}:u:b`, `{${appId}}:_meta:bytes`, `{${appId}}:_meta:keys`]);
    await c1.del([`{${appId}}:u:eph`]);
    await c0.close();
    await c1.close();
  }
});

it('reconcileFromScan inserts/updates a kv_app_usage_snapshot row', async () => {
  const appId = `recon-snap-${randomUUID()}`;
  const base = baseOptsFromEnv();
  const c0 = await RedisClient.connect({ ...base, db: 0 });
  // Insert an apps row so the FK passes
  const pool = makeControlPool();
  await pool.query(
    "INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, 'recon-snap', $2, $1, 'us') ON CONFLICT DO NOTHING",
    [appId, '11111111-1111-1111-1111-111111111111'],
  );
  try {
    await c0.set(`{${appId}}:u:x`, 'vx');
    await reconcileFromScan(c0, appId, base, { controlPool: pool, region: 'us' });
    const r = await pool.query(
      'SELECT bytes_used, keys_total, region FROM kv_app_usage_snapshot WHERE app_id = $1',
      [appId],
    );
    expect(r.rows[0].keys_total).toBe('1');
    expect(parseInt(r.rows[0].bytes_used, 10)).toBeGreaterThan(0);
    expect(r.rows[0].region).toBe('us');
  } finally {
    await pool.query('DELETE FROM kv_app_usage_snapshot WHERE app_id = $1', [appId]);
    await pool.query('DELETE FROM apps WHERE id = $1', [appId]);
    await c0.del([`{${appId}}:u:x`, `{${appId}}:_meta:bytes`, `{${appId}}:_meta:keys`]);
    await c0.close();
    await pool.end();
  }
});
```

(`makeControlPool` and `baseOptsFromEnv` may already exist in the test file; if not, add minimal helpers gated on `NEON_PLATFORM_PRIMARY_URL` and `KV_REDIS_URL_US`.)

- [ ] **Step 3: Run the test to verify it fails**

```
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test storage-counter
```

Expected: FAIL — counter not updated to 3, snapshot row not inserted.

- [ ] **Step 4: Extend `reconcileFromScan`**

In `storage-counter.ts`, change the signature:

```ts
import type { Pool } from 'pg';

export interface ReconcileOpts {
  controlPool?: Pool;
  region?: string;
}

export async function reconcileFromScan(
  client: RedisClient,
  appId: string,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  opts: ReconcileOpts = {},
): Promise<{ actual: number; previous: number; keysActual: number }> {
  const previous = await getStorageBytes(client, appId);
  const match = `{${appId}}:u:*`;
  let actual = 0;
  let keysActual = 0;

  async function collectDb(db: number) {
    await withDb(baseOpts, db, async (c) => {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, match, 500);
        cursor = next;
        for (const k of keys) {
          const used = await c.memoryUsage(k);
          if (used !== null) actual += used;
          keysActual++;
        }
      } while (cursor !== '0');
    });
  }
  await collectDb(0);
  await collectDb(1);

  await client.set(metaKey(appId), String(actual));
  await client.set(`{${appId}}:_meta:keys`, String(keysActual));

  // Snapshot row for admin dashboard (best-effort)
  if (opts.controlPool && opts.region) {
    try {
      await opts.controlPool.query(
        `INSERT INTO kv_app_usage_snapshot (app_id, region, bytes_used, keys_total, snapshot_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (app_id) DO UPDATE
           SET region = EXCLUDED.region,
               bytes_used = EXCLUDED.bytes_used,
               keys_total = EXCLUDED.keys_total,
               snapshot_at = now()`,
        [appId, opts.region, actual, keysActual],
      );
    } catch {
      // Snapshot write is best-effort; counter writes already succeeded.
    }
  }

  return { actual, previous, keysActual };
}
```

- [ ] **Step 5: Update the reconcile worker caller**

In `services/control-api/src/services/kv/reconcile-worker.ts` (find it), pass the new opts when calling `reconcileFromScan`:

```ts
await reconcileFromScan(client, appId, baseOpts, {
  controlPool: ctx.controlPool,
  region: app.region,
});
```

Find the loop that iterates apps in the reconcile worker. The exact shape depends on the existing worker code — read it first and adapt.

- [ ] **Step 6: Run the tests**

```
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test storage-counter reconcile-worker
```

Expected: all green.

- [ ] **Step 7: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 8: Commit**

```
git add services/control-api/src/services/kv/storage-counter.ts \
        services/control-api/src/services/kv/storage-counter.test.ts \
        services/control-api/src/services/kv/reconcile-worker.ts
git commit -m "feat(kv): reconcileFromScan also writes _meta:keys + kv_app_usage_snapshot"
```

No `Co-Authored-By` trailer.

---

### Task 5: O(1) `_stats` + inline plan limits + worker boot

**Files:**
- Modify: `services/control-api/src/services/kv/admin.ts`
- Modify: `services/control-api/src/services/kv/admin.test.ts` (if exists; if not, the route-level test covers it)
- Modify: `services/control-api/src/routes/v1/kv-admin.ts`
- Modify: `services/control-api/src/routes/v1/kv-admin.test.ts`
- Modify: `services/control-api/src/index.ts`

- [ ] **Step 1: Update the failing test**

In `kv-admin.test.ts` (the `_stats` route test), assert the new response shape:

```ts
it('_stats returns keys_total from the counter (no scan) and includes plan limits', async () => {
  // Pre-seed the counter directly
  await kvClient.set(`{${APP_ID}}:_meta:keys`, '42');
  await kvClient.set(`{${APP_ID}}:_meta:bytes`, '1024');

  // Spy on c.scan to ensure it is NOT called for the keys-count path.
  // (Existing harness should expose the underlying client; if not, just assert response shape.)

  const resp = await app.inject({
    method: 'GET',
    url: `/v1/${APP_ID}/kv/_stats`,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  expect(resp.statusCode).toBe(200);
  const body = JSON.parse(resp.body);
  expect(body).toMatchObject({
    keys_total: 42,
    bytes_used: 1024,
    max_keys: expect.any(Number),
    max_storage_bytes: expect.any(Number),
    max_ops_per_sec: expect.any(Number),
    max_value_bytes: expect.any(Number),
  });
});
```

- [ ] **Step 2: Update `appStats` in `admin.ts`**

Replace the existing `appStats` function:

```ts
import { getKeys } from './keys-counter.js';
import type { KvPlanLimits } from './limits.js';

export interface StatsResult {
  keys_total: number;
  bytes_used: number;
  ops_per_sec: number | null;
  max_keys: number;
  max_storage_bytes: number;
  max_ops_per_sec: number;
  max_value_bytes: number;
}

export async function appStats(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  appId: string,
  limits: KvPlanLimits,
): Promise<StatsResult> {
  const metaClient = await RedisClient.connect({ ...baseOpts, db: 0 });
  let bytesUsed = 0;
  let keysTotal = 0;
  let opsPerSec = 0;
  try {
    bytesUsed = await getStorageBytes(metaClient, appId);
    keysTotal = await getKeys(metaClient, appId);
    const bucket = Math.floor(Date.now() / 1000);
    const opsRaw = await metaClient.get(`{${appId}}:_meta:rate:${bucket}`);
    opsPerSec = opsRaw ? parseInt(opsRaw, 10) : 0;
  } finally {
    await metaClient.close();
  }
  return {
    keys_total: keysTotal,
    bytes_used: bytesUsed,
    ops_per_sec: opsPerSec,
    max_keys: limits.maxKeysTotal,
    max_storage_bytes: limits.maxStorageBytes,
    max_ops_per_sec: limits.maxOpsPerSec,
    max_value_bytes: limits.maxValueBytes,
  };
}
```

DELETE `countKeysFromScan` and its caller path entirely.

- [ ] **Step 3: Update the `_stats` route handler**

In `kv-admin.ts`, the `/v1/:app_id/kv/_stats` handler currently calls `appStats(baseOpts, appId)`. Change to pass the limits:

```ts
const limits = await getKvLimitsForApp(fastify.controlDb, appId);
const stats = await appStats(baseOpts, appId, limits);
return stats;
```

Add the import at the top of `kv-admin.ts`:
```ts
import { getKvLimitsForApp } from '../../services/kv/limits.js';
```

- [ ] **Step 4: Start the expiry worker on boot**

In `services/control-api/src/index.ts`, find the line that logs `KV reconcile worker started` (search the file). Adjacent to it, add:

```ts
import { startKeysExpiryWorker } from './services/kv/keys-expiry-worker.js';
// ...

// Start the KV expiry-subscriber per region.
const regionsRaw = process.env.BUTTERBASE_REGIONS ?? '';
const kvRegions = regionsRaw.split(',').map((r) => r.trim()).filter(Boolean);
if (kvRegions.length === 0) {
  app.log.warn('BUTTERBASE_REGIONS empty — KV expiry-subscriber not started');
} else {
  const keysExpiry = startKeysExpiryWorker({
    regions: kvRegions,
    urlForRegion: (region) => {
      const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
      const url = process.env[envKey];
      if (!url) throw new Error(`Missing ${envKey}`);
      return url;
    },
    log: app.log,
  });
  app.log.info({ regions: kvRegions }, 'KV expiry-subscriber started');
  app.addHook('onClose', async () => { await keysExpiry.stop(); });
}
```

- [ ] **Step 5: Run the tests**

```
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv-admin admin
```

Expected: all green.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add services/control-api/src/services/kv/admin.ts \
        services/control-api/src/routes/v1/kv-admin.ts \
        services/control-api/src/routes/v1/kv-admin.test.ts \
        services/control-api/src/index.ts
git commit -m "feat(kv): _stats reads counter (O(1)) + returns plan limits inline; expiry worker boots"
```

No `Co-Authored-By` trailer.

---

### Task 6: `GET /v1/:app_id/kv/_audit_recent` endpoint

**Files:**
- Create: `services/control-api/src/routes/v1/kv-audit-recent.ts`
- Create: `services/control-api/src/routes/v1/kv-audit-recent.test.ts`
- Modify: `services/control-api/src/index.ts` — register the new route plugin.

- [ ] **Step 1: Inspect the audit_logs table shape**

```
docker exec butterbase-control-plane-db-1 psql -U butterbase -d butterbase_control -c "\d audit_logs"
```

Expected columns (verify): `id`, `at`, `actor_id`, `app_id`, `method`, `path`, `status_code`, `error_code`, `error_message`. Adapt the query below to match the actual schema.

- [ ] **Step 2: Write the failing test**

Create `services/control-api/src/routes/v1/kv-audit-recent.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { buildAppWithDevKey, cleanupFixture, type AppFixture } from '../../services/kv/__test-utils__/kv-test-harness.js';
import kvAuditRecentRoutes from './kv-audit-recent.js';
import { databasePlugin } from '../../plugins/database.js';

const RUN = !!process.env.RUN_DB_TESTS && !!process.env.NEON_PLATFORM_PRIMARY_URL;
const describeDb = RUN ? describe : describe.skip;

describeDb('GET /v1/:app_id/kv/_audit_recent', () => {
  let pool: pg.Pool;
  let fixture: AppFixture;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.NEON_PLATFORM_PRIMARY_URL });
    fixture = await buildAppWithDevKey(pool);
  });

  afterAll(async () => {
    await cleanupFixture(pool, fixture);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM audit_logs WHERE app_id = $1", [fixture.appId]);
  });

  async function build() {
    const app = Fastify({ logger: false });
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => { i.decorate('controlDb', pool); }, { name: 'database' }));
    await app.register(kvAuditRecentRoutes);
    await app.ready();
    return app;
  }

  it('returns empty array when no errors recorded', async () => {
    const app = await build();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${fixture.appId}/kv/_audit_recent`,
      headers: { authorization: `Bearer ${fixture.devKey}` },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ entries: [] });
    await app.close();
  });

  it('returns only KV-path entries with status >= 400, newest first, capped at limit', async () => {
    // Seed 3 audit rows: one 200 (filtered out), one 413, one 429
    await pool.query(
      `INSERT INTO audit_logs (app_id, method, path, status_code, error_code, at)
       VALUES ($1, 'PUT', $2, 200, NULL, now() - interval '5 minutes'),
              ($1, 'PUT', $3, 413, 'value_too_large', now() - interval '3 minutes'),
              ($1, 'PUT', $4, 429, 'kv_rate_limited', now() - interval '1 minute')`,
      [fixture.appId,
       `/v1/${fixture.appId}/kv/ok`,
       `/v1/${fixture.appId}/kv/too_big`,
       `/v1/${fixture.appId}/kv/spammed`],
    );

    const app = await build();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${fixture.appId}/kv/_audit_recent?limit=10`,
      headers: { authorization: `Bearer ${fixture.devKey}` },
    });
    const body = JSON.parse(r.body);
    expect(body.entries.length).toBe(2);
    expect(body.entries[0].status_code).toBe(429);  // newest first
    expect(body.entries[1].status_code).toBe(413);
    await app.close();
  });

  it('caps limit at 200', async () => {
    const app = await build();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${fixture.appId}/kv/_audit_recent?limit=9999`,
      headers: { authorization: `Bearer ${fixture.devKey}` },
    });
    expect(r.statusCode).toBe(200);
    // No way to inspect the LIMIT used from outside; the cap-check is a code review item.
    await app.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```
RUN_DB_TESTS=1 NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv-audit-recent
```

Expected: FAIL with `Cannot find module './kv-audit-recent.js'`.

- [ ] **Step 4: Implement the route**

Create `services/control-api/src/routes/v1/kv-audit-recent.ts`:

```ts
// services/control-api/src/routes/v1/kv-audit-recent.ts
// GET /v1/:app_id/kv/_audit_recent
//
// Returns the last N audit_log rows for KV paths on this app with status >= 400.
// Used by the customer dashboard's "Recent errors" section.

import type { FastifyPluginAsync } from 'fastify';
import { resolveKvAuth } from '../../services/kv/auth.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AuditEntry {
  at: string;
  method: string;
  path: string;
  status_code: number;
  error_code: string | null;
  key: string | null;
}

const kvAuditRecentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { app_id: string };
    Querystring: { limit?: string };
  }>('/v1/:app_id/kv/_audit_recent', async (req, reply) => {
    const { app_id: appId } = req.params;
    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.statusCode ?? 401).send({ error: auth.error });

    const rawLimit = parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIMIT, rawLimit)) : DEFAULT_LIMIT;

    const r = await fastify.controlDb.query<{
      at: Date;
      method: string;
      path: string;
      status_code: number;
      error_code: string | null;
    }>(
      `SELECT at, method, path, status_code, error_code
         FROM audit_logs
        WHERE app_id = $1
          AND path LIKE $2
          AND status_code >= 400
        ORDER BY at DESC
        LIMIT $3`,
      [appId, `/v1/${appId}/kv/%`, limit],
    );

    const entries: AuditEntry[] = r.rows.map((row) => {
      // Extract the key suffix if the path is /v1/<appId>/kv/<key>
      const prefix = `/v1/${appId}/kv/`;
      const tail = row.path.startsWith(prefix) ? row.path.slice(prefix.length) : null;
      // For wildcard ops or empty tail, key is null
      const key = tail && !tail.startsWith('_') ? tail.split('/')[0] || null : null;
      return {
        at: row.at.toISOString(),
        method: row.method,
        path: row.path,
        status_code: row.status_code,
        error_code: row.error_code,
        key,
      };
    });

    return { entries };
  });
};

export default kvAuditRecentRoutes;
```

- [ ] **Step 5: Register the route in `index.ts`**

In `services/control-api/src/index.ts`, alongside `kv-admin` and `kv-data` registrations:

```ts
import kvAuditRecentRoutes from './routes/v1/kv-audit-recent.js';
// ...
await app.register(kvAuditRecentRoutes);
```

- [ ] **Step 6: Run the test**

```
RUN_DB_TESTS=1 NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv-audit-recent
```

Expected: 3 passed.

- [ ] **Step 7: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 8: Commit**

```
git add services/control-api/src/routes/v1/kv-audit-recent.ts \
        services/control-api/src/routes/v1/kv-audit-recent.test.ts \
        services/control-api/src/index.ts
git commit -m "feat(kv): GET /v1/:app_id/kv/_audit_recent — recent KV errors for dashboard"
```

No `Co-Authored-By` trailer.

---

### Task 7: Customer dashboard KV tab — shell, queries, route

**Files:**
- Create: `cloud/services/dashboard/src/pages/app/kv/KvPage.tsx`
- Create: `cloud/services/dashboard/src/lib/queries/kv.ts`
- Modify: `cloud/services/dashboard/src/layouts/AppLayout.tsx`
- Modify: `cloud/services/dashboard/src/App.tsx` (or routes file — locate this step's first action)

- [ ] **Step 1: Locate the routes file**

```
grep -rn "/apps/:appId/storage\|app/storage" cloud/services/dashboard/src --include='*.tsx' | head -5
```

The match identifies where existing per-app routes are declared. Note this file path.

- [ ] **Step 2: Add the nav entry**

In `cloud/services/dashboard/src/layouts/AppLayout.tsx`, find `getSubNav(appId)`. Add the KV entry between Storage and Monetization:

```ts
{ to: `${base}/storage`, label: 'Storage', icon: FolderOpen },
{ to: `${base}/kv`, label: 'KV', icon: KeyRound },              // NEW
{ to: `${base}/monetization`, label: 'Monetization', icon: CreditCard },
```

Import `KeyRound` from `lucide-react` at the top.

- [ ] **Step 3: Add the route**

In whichever file declares the per-app routes (likely `App.tsx` or a route map):

```tsx
import { KvPage } from './pages/app/kv/KvPage';
// ...
<Route path="kv" element={<KvPage />} />
```

Match the existing routing style (React Router v6 nested routes are typical).

- [ ] **Step 4: Implement the query hooks**

Create `cloud/services/dashboard/src/lib/queries/kv.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api';   // existing dashboard helper; locate via existing query files

export interface KvStats {
  keys_total: number;
  bytes_used: number;
  ops_per_sec: number | null;
  max_keys: number;
  max_storage_bytes: number;
  max_ops_per_sec: number;
  max_value_bytes: number;
}

export function useKvStats(appId: string) {
  return useQuery({
    queryKey: ['kv', appId, 'stats'],
    queryFn: () => apiFetch<KvStats>(`/v1/${appId}/kv/_stats`),
    refetchInterval: 5000,
  });
}

export interface KvScanPage { keys: string[]; cursor: string }

export function useKvScan(appId: string, match: string, cursor: string) {
  return useQuery({
    queryKey: ['kv', appId, 'scan', match, cursor],
    queryFn: () =>
      apiFetch<KvScanPage>(
        `/v1/${appId}/kv/_scan?cursor=${encodeURIComponent(cursor)}&match=${encodeURIComponent(match)}&limit=100`,
      ),
    keepPreviousData: true,
  });
}

export interface KvExposeRule {
  pattern: string;
  read: boolean;
  write: boolean;
  conditions?: string | null;
}

export function useKvExpose(appId: string) {
  return useQuery({
    queryKey: ['kv', appId, 'expose'],
    queryFn: () => apiFetch<{ rules: KvExposeRule[] }>(`/v1/${appId}/kv/_expose`),
  });
}

export function useSetKvExpose(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: KvExposeRule[]) =>
      apiFetch(`/v1/${appId}/kv/_expose`, { method: 'PUT', body: JSON.stringify({ rules }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kv', appId, 'expose'] }),
  });
}

export interface KvAuditEntry {
  at: string;
  method: string;
  path: string;
  status_code: number;
  error_code: string | null;
  key: string | null;
}

export function useKvAuditRecent(appId: string, limit = 50) {
  return useQuery({
    queryKey: ['kv', appId, 'audit-recent', limit],
    queryFn: () =>
      apiFetch<{ entries: KvAuditEntry[] }>(
        `/v1/${appId}/kv/_audit_recent?limit=${limit}`,
      ),
    refetchInterval: 30_000,
  });
}

export function useKvGet(appId: string, key: string | null) {
  return useQuery({
    queryKey: ['kv', appId, 'value', key],
    enabled: !!key,
    queryFn: () =>
      apiFetch<{ value: unknown; ttl: number | null }>(
        `/v1/${appId}/kv/${encodeURIComponent(key!)}`,
      ),
  });
}

export function useKvPut(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value, ttl }: { key: string; value: unknown; ttl?: number | null }) =>
      apiFetch(`/v1/${appId}/kv/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value, ttl }),
      }),
    onSuccess: (_data, { key }) => {
      qc.invalidateQueries({ queryKey: ['kv', appId, 'stats'] });
      qc.invalidateQueries({ queryKey: ['kv', appId, 'value', key] });
    },
  });
}

export function useKvDel(appId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch(`/v1/${appId}/kv/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kv', appId, 'stats'] });
      qc.invalidateQueries({ queryKey: ['kv', appId, 'scan'] });
    },
  });
}
```

If `apiFetch` is named differently in the dashboard codebase, adjust the import. Check `src/lib/api.ts` or similar.

- [ ] **Step 5: Create the KvPage shell**

Create `cloud/services/dashboard/src/pages/app/kv/KvPage.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { UsageStrip } from './UsageStrip';
import { ExposeRulesTable } from './ExposeRulesTable';
import { KeyBrowser } from './KeyBrowser';
import { RecentErrors } from './RecentErrors';

export function KvPage() {
  const { appId } = useParams<{ appId: string }>();
  if (!appId) return null;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">KV</h1>
      <UsageStrip appId={appId} />
      <ExposeRulesTable appId={appId} />
      <KeyBrowser appId={appId} />
      <RecentErrors appId={appId} />
    </div>
  );
}
```

(The four child components are created in Tasks 8–11. For now stub them as named exports that render a card with their title — replace in subsequent tasks.)

Stub file at the bottom of `KvPage.tsx` is OK, OR create empty placeholder files:

```tsx
// UsageStrip.tsx
import type { FC } from 'react';
export const UsageStrip: FC<{ appId: string }> = () => <div className="rounded-lg border p-4">UsageStrip (Task 8)</div>;
```

Repeat for ExposeRulesTable / KeyBrowser / RecentErrors. Tasks 8–11 replace each.

- [ ] **Step 6: Build the dashboard**

```
cd cloud/services/dashboard
pnpm install   # if dependencies look stale
pnpm build 2>&1 | tail -10
```

Expected: clean. (If the dashboard has no `build` script, use `tsc --noEmit` or whatever the existing build target is — check `package.json`.)

- [ ] **Step 7: Manual smoke**

If the dashboard dev server is running (or can be started locally), navigate to `/apps/<some-app>/kv` and verify:
- The new KV tab appears in the sidebar.
- The page renders with the four stub cards.

If you can't start the dev server in this session, skip — Task 17 final smoke will exercise.

- [ ] **Step 8: Commit**

```
git add cloud/services/dashboard/src/lib/queries/kv.ts \
        cloud/services/dashboard/src/pages/app/kv/KvPage.tsx \
        cloud/services/dashboard/src/pages/app/kv/UsageStrip.tsx \
        cloud/services/dashboard/src/pages/app/kv/ExposeRulesTable.tsx \
        cloud/services/dashboard/src/pages/app/kv/KeyBrowser.tsx \
        cloud/services/dashboard/src/pages/app/kv/RecentErrors.tsx \
        cloud/services/dashboard/src/layouts/AppLayout.tsx \
        cloud/services/dashboard/src/App.tsx       # or the actual routes file
git commit -m "feat(dashboard): KV tab shell + queries + nav entry"
```

No `Co-Authored-By` trailer.

---

### Task 8: UsageStrip component

**Files:**
- Modify: `cloud/services/dashboard/src/pages/app/kv/UsageStrip.tsx`

- [ ] **Step 1: Replace the stub with the real component**

```tsx
// cloud/services/dashboard/src/pages/app/kv/UsageStrip.tsx
import type { FC } from 'react';
import { useKvStats } from '../../../lib/queries/kv';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

interface CardProps { label: string; value: string; sub?: string; pct?: number }
const Card: FC<CardProps> = ({ label, value, sub, pct }) => (
  <div className="rounded-lg border p-4 flex flex-col gap-1 min-w-[180px]">
    <div className="text-xs uppercase text-muted-foreground">{label}</div>
    <div className="text-2xl font-semibold">{value}</div>
    {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    {typeof pct === 'number' && (
      <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-2">
        <div
          className={pct > 90 ? 'h-full bg-red-500' : pct > 70 ? 'h-full bg-amber-500' : 'h-full bg-emerald-500'}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    )}
  </div>
);

export const UsageStrip: FC<{ appId: string }> = ({ appId }) => {
  const { data, isLoading, error } = useKvStats(appId);

  if (isLoading) return <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading usage…</div>;
  if (error || !data) return <div className="rounded-lg border p-4 text-sm text-red-600">Couldn't load usage</div>;

  const storagePct = (data.bytes_used / Math.max(1, data.max_storage_bytes)) * 100;
  const opsPct = data.ops_per_sec != null ? (data.ops_per_sec / Math.max(1, data.max_ops_per_sec)) * 100 : 0;
  const keysPct = (data.keys_total / Math.max(1, data.max_keys)) * 100;

  return (
    <div className="flex flex-wrap gap-3">
      <Card
        label="Keys"
        value={data.keys_total.toLocaleString()}
        sub={`max ${data.max_keys.toLocaleString()}`}
        pct={keysPct}
      />
      <Card
        label="Storage"
        value={formatBytes(data.bytes_used)}
        sub={`max ${formatBytes(data.max_storage_bytes)}`}
        pct={storagePct}
      />
      <Card
        label="Ops/sec"
        value={String(data.ops_per_sec ?? 0)}
        sub={`max ${data.max_ops_per_sec}`}
        pct={opsPct}
      />
      <Card label="Max value size" value={formatBytes(data.max_value_bytes)} />
    </div>
  );
};
```

(Credit-burn card deferred — requires a usage_meters aggregation. Add as a placeholder card or omit; the spec listed it but it's optional. Plan picks: omit, document in Task 17 as a deferred polish item.)

- [ ] **Step 2: Build**

```
cd cloud/services/dashboard
pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add cloud/services/dashboard/src/pages/app/kv/UsageStrip.tsx
git commit -m "feat(dashboard): KV UsageStrip — keys/storage/ops/value-size cards with progress"
```

No `Co-Authored-By` trailer.

---

### Task 9: ExposeRulesTable component

**Files:**
- Modify: `cloud/services/dashboard/src/pages/app/kv/ExposeRulesTable.tsx`

- [ ] **Step 1: Implement**

```tsx
// cloud/services/dashboard/src/pages/app/kv/ExposeRulesTable.tsx
import { type FC, useState } from 'react';
import { useKvExpose, useSetKvExpose, type KvExposeRule } from '../../../lib/queries/kv';

export const ExposeRulesTable: FC<{ appId: string }> = ({ appId }) => {
  const { data, isLoading, error } = useKvExpose(appId);
  const setExpose = useSetKvExpose(appId);
  const [draft, setDraft] = useState<KvExposeRule | null>(null);

  if (isLoading) return <Section title="Expose rules"><div className="text-sm text-muted-foreground">Loading…</div></Section>;
  if (error || !data) return <Section title="Expose rules"><div className="text-sm text-red-600">Couldn't load rules</div></Section>;

  const rules = data.rules;

  function commit(next: KvExposeRule[]) {
    setExpose.mutate(next);
  }

  function removeAt(i: number) {
    const next = rules.slice();
    next.splice(i, 1);
    commit(next);
  }

  function addDraft() {
    if (!draft || !draft.pattern) return;
    commit([...rules, draft]);
    setDraft(null);
  }

  return (
    <Section title="Expose rules">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="text-left">Pattern</th><th>Read</th><th>Write</th><th className="text-left">Conditions</th><th /></tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="py-2 font-mono">{r.pattern}</td>
              <td className="text-center">{r.read ? '✓' : ''}</td>
              <td className="text-center">{r.write ? '✓' : ''}</td>
              <td className="font-mono text-xs">{r.conditions ?? '—'}</td>
              <td className="text-right">
                <button onClick={() => removeAt(i)} className="text-xs text-red-600 hover:underline">remove</button>
              </td>
            </tr>
          ))}
          {draft && (
            <tr className="border-t">
              <td><input className="w-full px-2 py-1 border rounded" placeholder="u:profile:{user.id}" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} /></td>
              <td className="text-center"><input type="checkbox" checked={draft.read} onChange={(e) => setDraft({ ...draft, read: e.target.checked })} /></td>
              <td className="text-center"><input type="checkbox" checked={draft.write} onChange={(e) => setDraft({ ...draft, write: e.target.checked })} /></td>
              <td><input className="w-full px-2 py-1 border rounded font-mono text-xs" placeholder="(optional)" value={draft.conditions ?? ''} onChange={(e) => setDraft({ ...draft, conditions: e.target.value || null })} /></td>
              <td className="text-right"><button onClick={addDraft} className="text-xs hover:underline">save</button></td>
            </tr>
          )}
        </tbody>
      </table>
      {!draft && (
        <button onClick={() => setDraft({ pattern: '', read: true, write: false })} className="text-sm hover:underline mt-2">
          + add rule
        </button>
      )}
      {setExpose.isPending && <div className="text-xs text-muted-foreground mt-2">Saving…</div>}
      {setExpose.error && <div className="text-xs text-red-600 mt-2">Save failed</div>}
    </Section>
  );
};

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-lg border p-4">
    <h2 className="text-lg font-semibold mb-3">{title}</h2>
    {children}
  </div>
);
```

- [ ] **Step 2: Build**

```
cd cloud/services/dashboard && pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add cloud/services/dashboard/src/pages/app/kv/ExposeRulesTable.tsx
git commit -m "feat(dashboard): KV ExposeRulesTable — list/add/remove rules"
```

No `Co-Authored-By` trailer.

---

### Task 10: KeyBrowser component

**Files:**
- Modify: `cloud/services/dashboard/src/pages/app/kv/KeyBrowser.tsx`

- [ ] **Step 1: Implement**

```tsx
// cloud/services/dashboard/src/pages/app/kv/KeyBrowser.tsx
import { type FC, useState } from 'react';
import { useKvScan, useKvGet, useKvDel, useKvPut } from '../../../lib/queries/kv';

export const KeyBrowser: FC<{ appId: string }> = ({ appId }) => {
  const [prefix, setPrefix] = useState('');
  const [cursors, setCursors] = useState<string[]>(['0']);
  const cursor = cursors[cursors.length - 1];
  const match = prefix ? `{${appId}}:u:${prefix}*` : `{${appId}}:u:*`;
  const { data, isLoading } = useKvScan(appId, match, cursor);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Keys</h2>
        <div className="flex gap-2">
          <input
            className="px-2 py-1 border rounded text-sm font-mono"
            placeholder="prefix filter (e.g. profile:)"
            value={prefix}
            onChange={(e) => { setPrefix(e.target.value); setCursors(['0']); }}
          />
        </div>
      </div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {data && (
        <>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="text-left">Key</th><th /></tr>
            </thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k} className="border-t hover:bg-muted/40">
                  <td className="py-2 font-mono">{strip(appId, k)}</td>
                  <td className="text-right">
                    <button className="text-xs hover:underline mr-2" onClick={() => setSelected(strip(appId, k))}>view</button>
                  </td>
                </tr>
              ))}
              {data.keys.length === 0 && (
                <tr><td colSpan={2} className="py-4 text-center text-muted-foreground text-sm">No keys</td></tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center gap-2 mt-3">
            {data.cursor !== '0' && (
              <button className="text-sm hover:underline" onClick={() => setCursors([...cursors, data.cursor])}>load more →</button>
            )}
            {cursors.length > 1 && (
              <button className="text-sm hover:underline" onClick={() => setCursors(cursors.slice(0, -1))}>← back</button>
            )}
          </div>
        </>
      )}
      {selected && <KeyDetail appId={appId} keyName={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

function strip(appId: string, fullKey: string): string {
  const prefix = `{${appId}}:u:`;
  return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

const KeyDetail: FC<{ appId: string; keyName: string; onClose: () => void }> = ({ appId, keyName, onClose }) => {
  const { data, isLoading } = useKvGet(appId, keyName);
  const del = useKvDel(appId);
  const put = useKvPut(appId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  return (
    <div className="mt-4 border-t pt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-sm">{keyName}</div>
        <button onClick={onClose} className="text-xs hover:underline">close</button>
      </div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {data && !editing && (
        <>
          <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-64">{JSON.stringify(data.value, null, 2)}</pre>
          <div className="text-xs text-muted-foreground mt-1">TTL: {data.ttl ?? '∞'}</div>
          <div className="flex gap-2 mt-2">
            <button onClick={() => { setDraft(JSON.stringify(data.value, null, 2)); setEditing(true); }} className="text-sm hover:underline">edit</button>
            <button onClick={() => del.mutate(keyName, { onSuccess: onClose })} className="text-sm text-red-600 hover:underline">delete</button>
          </div>
        </>
      )}
      {editing && (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full h-40 p-2 font-mono text-xs border rounded" />
          <div className="flex gap-2 mt-2">
            <button onClick={() => {
              try { const parsed = JSON.parse(draft); put.mutate({ key: keyName, value: parsed }, { onSuccess: () => setEditing(false) }); }
              catch { alert('Invalid JSON'); }
            }} className="text-sm hover:underline">save</button>
            <button onClick={() => setEditing(false)} className="text-sm hover:underline">cancel</button>
          </div>
        </>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Build**

```
cd cloud/services/dashboard && pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add cloud/services/dashboard/src/pages/app/kv/KeyBrowser.tsx
git commit -m "feat(dashboard): KV KeyBrowser — cursor scan, view/edit/delete"
```

No `Co-Authored-By` trailer.

---

### Task 11: RecentErrors component

**Files:**
- Modify: `cloud/services/dashboard/src/pages/app/kv/RecentErrors.tsx`

- [ ] **Step 1: Implement**

```tsx
// cloud/services/dashboard/src/pages/app/kv/RecentErrors.tsx
import { type FC } from 'react';
import { useKvAuditRecent } from '../../../lib/queries/kv';

export const RecentErrors: FC<{ appId: string }> = ({ appId }) => {
  const { data, isLoading, error } = useKvAuditRecent(appId, 50);

  return (
    <div className="rounded-lg border p-4">
      <h2 className="text-lg font-semibold mb-3">Recent errors</h2>
      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {error && <div className="text-sm text-red-600">Couldn't load</div>}
      {data && data.entries.length === 0 && <div className="text-sm text-muted-foreground">No recent errors. 🎉</div>}
      {data && data.entries.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr><th className="text-left">Time</th><th className="text-left">Key</th><th>Status</th><th className="text-left">Error</th></tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={i} className="border-t">
                <td className="py-2 text-xs">{new Date(e.at).toLocaleTimeString()}</td>
                <td className="font-mono text-xs">{e.key ?? '—'}</td>
                <td className="text-center"><span className={badgeClass(e.status_code)}>{e.status_code}</span></td>
                <td className="text-xs">{e.error_code ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

function badgeClass(status: number): string {
  if (status >= 500) return 'inline-block px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-700';
  if (status === 429) return 'inline-block px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700';
  return 'inline-block px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700';
}
```

- [ ] **Step 2: Build**

```
cd cloud/services/dashboard && pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add cloud/services/dashboard/src/pages/app/kv/RecentErrors.tsx
git commit -m "feat(dashboard): KV RecentErrors — list of last 50 KV audit errors"
```

No `Co-Authored-By` trailer.

---

### Task 12: Admin-guard helper

**Files:**
- Create: `services/control-api/src/lib/admin-guard.ts`
- Create: `services/control-api/src/lib/admin-guard.test.ts`

- [ ] **Step 1: Read the existing admin auth pattern**

Open `services/control-api/src/routes/admin.ts` and find the `/admin/overview` handler (around line ~52). Note the boilerplate: parse `Authorization: Bearer <jwt>`, call `authProvider.verifyJwt`, look up `platform_users.is_admin`. We extract this into a helper.

Open `services/control-api/src/routes/admin-auth.ts` to find how `authProvider` is constructed (CognitoAuthProvider or LocalAuthProvider). Plan 7c reuses the same pattern.

- [ ] **Step 2: Write the failing test**

```ts
// services/control-api/src/lib/admin-guard.test.ts
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { requireAdmin } from './admin-guard.js';

describe('requireAdmin', () => {
  it('returns 401 when authorization header is missing', async () => {
    const app = Fastify();
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, { query: vi.fn() } as any, mockAuthProvider());
      if (!u) return;
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/test' });
    expect(r.statusCode).toBe(401);
  });

  it('returns 401 when JWT verify throws', async () => {
    const app = Fastify();
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, { query: vi.fn() } as any, mockAuthProvider({ throws: true }));
      if (!u) return;
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/test', headers: { authorization: 'Bearer bad' } });
    expect(r.statusCode).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    const app = Fastify();
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u1', email: 'x@x', is_admin: false }] }) };
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, ctrl as any, mockAuthProvider({ sub: 'sub-1' }));
      if (!u) return;
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/test', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(403);
  });

  it('returns the user when authorized', async () => {
    const app = Fastify();
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u1', email: 'a@b', is_admin: true }] }) };
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, ctrl as any, mockAuthProvider({ sub: 'sub-1' }));
      if (!u) return;
      return { user: u };
    });
    const r = await app.inject({ method: 'GET', url: '/test', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).user.id).toBe('u1');
  });
});

function mockAuthProvider(opts: { sub?: string; throws?: boolean } = {}) {
  return {
    async verifyJwt(_token: string) {
      if (opts.throws) throw new Error('bad jwt');
      return { sub: opts.sub ?? 'sub-1' };
    },
  } as any;
}
```

- [ ] **Step 3: Run the test to verify it fails**

```
pnpm --filter @butterbase/control-api test admin-guard
```

Expected: FAIL with `Cannot find module './admin-guard.js'`.

- [ ] **Step 4: Implement**

```ts
// services/control-api/src/lib/admin-guard.ts
// Centralized admin authorization for /admin/* routes.
//
// Returns the platform_user row when the caller has a valid JWT AND is_admin = true.
// Returns null AND sends an appropriate 401/403 response when not authorized.
// Mirrors the inline pattern in routes/admin.ts.

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { AuthProvider } from '../services/auth-provider.js';

export interface AdminUser {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  controlDb: Pool,
  authProvider: AuthProvider,
): Promise<AdminUser | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_authorization' });
    return null;
  }
  let claims: { sub: string };
  try {
    claims = await authProvider.verifyJwt(authHeader.substring(7));
  } catch {
    reply.code(401).send({ error: 'invalid_token' });
    return null;
  }
  const r = await controlDb.query<AdminUser>(
    'SELECT id, email, display_name, is_admin FROM platform_users WHERE cognito_sub = $1',
    [claims.sub],
  );
  const user = r.rows[0];
  if (!user) {
    reply.code(403).send({ error: 'unknown_user' });
    return null;
  }
  if (!user.is_admin) {
    reply.code(403).send({ error: 'not_admin' });
    return null;
  }
  return user;
}
```

- [ ] **Step 5: Run the tests**

```
pnpm --filter @butterbase/control-api test admin-guard
```

Expected: 4 passed.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add services/control-api/src/lib/admin-guard.ts \
        services/control-api/src/lib/admin-guard.test.ts
git commit -m "feat(admin): requireAdmin helper for /admin/* routes"
```

No `Co-Authored-By` trailer.

---

### Task 13: `/admin/kv/cluster-health` endpoint

**Files:**
- Create: `services/control-api/src/routes/admin/kv-admin-stats.ts`
- Create: `services/control-api/src/routes/admin/kv-admin-stats.test.ts`
- Modify: `services/control-api/src/index.ts` — register the new route plugin.

- [ ] **Step 1: Write the failing test**

```ts
// services/control-api/src/routes/admin/kv-admin-stats.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import kvAdminStatsRoutes from './kv-admin-stats.js';

describe('GET /admin/kv/cluster-health', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns per-region INFO snapshots', async () => {
    process.env.BUTTERBASE_REGIONS = 'region-1,region-2';
    process.env.KV_REDIS_URL_REGION_1 = 'redis://x:y@host-1:6379';
    process.env.KV_REDIS_URL_REGION_2 = 'redis://x:y@host-2:6379';

    const app = Fastify({ logger: false });
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u', email: 'a', display_name: null, is_admin: true }] }) };
    const authProvider = { async verifyJwt() { return { sub: 'sub-1' }; } };
    const fakeInfo = (region: string) => ({
      mem_used:   region === 'region-1' ? 412_000_000 : 198_000_000,
      mem_max:    4_096_000_000,
      hit_ratio:  region === 'region-1' ? 0.984 : 0.971,
      evicted_keys: 0,
      clients:    region === 'region-1' ? 124 : 47,
      slowlog_len: 0,
    });

    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', authProvider);
      i.decorate('kvRedisInfo', async (region: string) => fakeInfo(region));
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);

    const r = await app.inject({
      method: 'GET',
      url: '/admin/kv/cluster-health',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.regions).toHaveLength(2);
    expect(body.regions[0].region).toBe('region-1');
    expect(body.regions[0].mem_used).toBe(412_000_000);
  });

  it('returns 403 for non-admin users', async () => {
    const app = Fastify({ logger: false });
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u', email: 'a', display_name: null, is_admin: false }] }) };
    const authProvider = { async verifyJwt() { return { sub: 'sub-1' }; } };
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', authProvider);
      i.decorate('kvRedisInfo', async () => ({ mem_used: 0, mem_max: 0, hit_ratio: 0, evicted_keys: 0, clients: 0, slowlog_len: 0 }));
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);
    const r = await app.inject({ method: 'GET', url: '/admin/kv/cluster-health', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
pnpm --filter @butterbase/control-api test kv-admin-stats
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route + INFO collector**

```ts
// services/control-api/src/routes/admin/kv-admin-stats.ts
import type { FastifyPluginAsync } from 'fastify';
import { Redis } from 'ioredis';
import { requireAdmin } from '../../lib/admin-guard.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Optional injection seam for tests; defaults to live INFO collection. */
    kvRedisInfo?(region: string): Promise<RegionInfo>;
  }
}

interface RegionInfo {
  mem_used: number;
  mem_max: number;
  hit_ratio: number;
  evicted_keys: number;
  clients: number;
  slowlog_len: number;
}

async function collectRegionInfo(region: string): Promise<RegionInfo> {
  const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
  const url = process.env[envKey];
  if (!url) throw new Error(`Missing ${envKey}`);
  const r = new Redis(url, { maxRetriesPerRequest: 2 });
  try {
    const [memRaw, statsRaw, clientsListRaw, slowLenRaw] = await Promise.all([
      r.info('memory'),
      r.info('stats'),
      r.call('CLIENT', 'LIST') as Promise<string>,
      r.call('SLOWLOG', 'LEN') as Promise<number>,
    ]);
    const memUsed = parseInfoInt(memRaw, 'used_memory');
    const memMax  = parseInfoInt(memRaw, 'maxmemory') || 0;
    const hits    = parseInfoInt(statsRaw, 'keyspace_hits');
    const misses  = parseInfoInt(statsRaw, 'keyspace_misses');
    const evicted = parseInfoInt(statsRaw, 'evicted_keys');
    const hitRatio = hits + misses > 0 ? hits / (hits + misses) : 1;
    const clientCount = (clientsListRaw || '').split('\n').filter(Boolean).length;
    return {
      mem_used: memUsed,
      mem_max: memMax,
      hit_ratio: hitRatio,
      evicted_keys: evicted,
      clients: clientCount,
      slowlog_len: Number(slowLenRaw) || 0,
    };
  } finally {
    await r.quit().catch(() => {});
  }
}

function parseInfoInt(raw: string, field: string): number {
  const m = raw.match(new RegExp(`^${field}:(\\d+)`, 'm'));
  return m ? parseInt(m[1], 10) : 0;
}

const kvAdminStatsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/kv/cluster-health', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const regionsRaw = process.env.BUTTERBASE_REGIONS ?? '';
    const regions = regionsRaw.split(',').map((r) => r.trim()).filter(Boolean);
    const infoFn = (fastify as any).kvRedisInfo ?? collectRegionInfo;

    const results = await Promise.all(regions.map(async (region) => {
      try {
        const info = await infoFn(region);
        return { region, ...info, status: deriveStatus(info), reachable: true };
      } catch (err) {
        return {
          region,
          mem_used: 0, mem_max: 0, hit_ratio: 0, evicted_keys: 0, clients: 0, slowlog_len: 0,
          status: 'red', reachable: false, error: (err as Error).message,
        };
      }
    }));

    return { regions: results };
  });
};

function deriveStatus(i: { mem_used: number; mem_max: number; evicted_keys: number; slowlog_len: number }): 'green' | 'amber' | 'red' {
  if (i.evicted_keys > 0 || (i.mem_max > 0 && i.mem_used > 0.85 * i.mem_max) || i.slowlog_len > 100) return 'red';
  if (i.mem_max > 0 && i.mem_used > 0.7 * i.mem_max) return 'amber';
  return 'green';
}

export default kvAdminStatsRoutes;
```

- [ ] **Step 4: Register the route in `index.ts`**

```ts
import kvAdminStatsRoutes from './routes/admin/kv-admin-stats.js';
// ...
await app.register(kvAdminStatsRoutes);

// Decorate fastify with authProvider so requireAdmin can use it.
// (Confirm whether this already exists; if so skip.)
```

If `authProvider` isn't already decorated on the fastify instance, add a small bootstrap snippet next to `adminAuthRoutes` registration that decorates it:

```ts
import { CognitoAuthProvider } from './services/cognito-auth-provider.js';
import { LocalAuthProvider } from './services/local-auth-provider.js';
import { config } from './config.js';

const authProvider = config.cognito.userPoolId
  ? new CognitoAuthProvider(config.cognito.userPoolId, config.cognito.clientId, config.cognito.region)
  : new LocalAuthProvider(config.auth.jwtSecret);
app.decorate('authProvider', authProvider);
```

(Check if this already exists — the inline pattern in `admin.ts` instantiates per-file. Decorate once globally to avoid duplicate work.)

- [ ] **Step 5: Run the tests**

```
pnpm --filter @butterbase/control-api test kv-admin-stats
```

Expected: 2 passed.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add services/control-api/src/routes/admin/kv-admin-stats.ts \
        services/control-api/src/routes/admin/kv-admin-stats.test.ts \
        services/control-api/src/index.ts
git commit -m "feat(admin): GET /admin/kv/cluster-health — per-region INFO snapshots"
```

No `Co-Authored-By` trailer.

---

### Task 14: `/admin/kv/top-apps` and `/admin/kv/hotspots` endpoints

**Files:**
- Modify: `services/control-api/src/routes/admin/kv-admin-stats.ts`
- Modify: `services/control-api/src/routes/admin/kv-admin-stats.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `kv-admin-stats.test.ts`:

```ts
describe('GET /admin/kv/top-apps', () => {
  // Test fixture pattern: seed kv_app_usage_snapshot rows + a fake controlDb that
  // returns them. We exercise the `metric=storage` path here; ops/errors paths
  // use the same helper structure.

  it('returns the top N by bytes_used desc', async () => {
    const rows = [
      { app_id: 'a1', owner_id: 'u1', owner_email: 'a@a', region: 'region-1', bytes_used: 5_000_000_000, keys_total: 10_000 },
      { app_id: 'a2', owner_id: 'u2', owner_email: 'b@b', region: 'region-2', bytes_used: 4_000_000_000, keys_total: 8_000 },
      { app_id: 'a3', owner_id: 'u3', owner_email: 'c@c', region: 'region-1', bytes_used: 1_000_000,     keys_total: 500   },
    ];
    const app = Fastify({ logger: false });
    const ctrl = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM platform_users')) return { rows: [{ id: 'u', email: 'admin', display_name: null, is_admin: true }] };
        if (sql.includes('FROM kv_app_usage_snapshot')) return { rows };
        return { rows: [] };
      }),
    };
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', { async verifyJwt() { return { sub: 's' }; } });
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/kv/top-apps?metric=storage&limit=10',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.apps).toHaveLength(3);
    expect(body.apps[0].app_id).toBe('a1');
  });
});

describe('GET /admin/kv/hotspots', () => {
  it('returns apps near caps and apps with high 429 rates', async () => {
    const app = Fastify({ logger: false });
    const ctrl = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM platform_users')) return { rows: [{ id: 'u', email: 'admin', display_name: null, is_admin: true }] };
        if (sql.includes('FROM kv_app_usage_snapshot s')) {
          // storage hotspots query
          return { rows: [{ app_id: 'cap1', region: 'region-1', bytes_used: 6_400_000_000, max_storage_bytes: 6_710_886_400, snapshot_at: new Date() }] };
        }
        if (sql.includes('FROM audit_logs')) {
          // 429-rate hotspots query
          return { rows: [{ app_id: 'spam1', region: 'region-2', total_ops: 1000, rate_limited: 80, first_seen: new Date() }] };
        }
        return { rows: [] };
      }),
    };
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', { async verifyJwt() { return { sub: 's' }; } });
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);
    const r = await app.inject({ method: 'GET', url: '/admin/kv/hotspots', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.hotspots.length).toBeGreaterThanOrEqual(2);
    expect(body.hotspots.some((h: any) => h.app_id === 'cap1')).toBe(true);
    expect(body.hotspots.some((h: any) => h.app_id === 'spam1')).toBe(true);
  });
});
```

- [ ] **Step 2: Implement the two new endpoints**

Append to `kv-admin-stats.ts` (inside the plugin function):

```ts
fastify.get<{ Querystring: { metric?: string; limit?: string } }>(
  '/admin/kv/top-apps',
  { config: { public: true } },
  async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const metric = req.query.metric === 'ops' || req.query.metric === 'errors' ? req.query.metric : 'storage';
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit ?? '20', 10) || 20));
    const ctrl = (fastify as any).controlDb;

    if (metric === 'storage') {
      const r = await ctrl.query(
        `SELECT s.app_id, a.owner_id, u.email AS owner_email, s.region, s.bytes_used, s.keys_total, s.snapshot_at
           FROM kv_app_usage_snapshot s
           JOIN apps a ON a.id = s.app_id
           JOIN platform_users u ON u.id = a.owner_id
          ORDER BY s.bytes_used DESC
          LIMIT $1`, [limit]);
      return { metric, apps: r.rows };
    }

    if (metric === 'ops') {
      // Aggregate from usage_meters (last hour).
      const r = await ctrl.query(
        `SELECT m.app_id, a.owner_id, u.email AS owner_email, a.region, SUM(m.delta)::bigint AS value
           FROM usage_meters m
           JOIN apps a ON a.id = m.app_id
           JOIN platform_users u ON u.id = a.owner_id
          WHERE m.meter = 'kv_ops' AND m.at > now() - interval '1 hour'
          GROUP BY m.app_id, a.owner_id, u.email, a.region
          ORDER BY value DESC
          LIMIT $1`, [limit]);
      return { metric, apps: r.rows };
    }

    // errors
    const r = await ctrl.query(
      `SELECT al.app_id, a.owner_id, u.email AS owner_email, a.region, COUNT(*)::bigint AS value
         FROM audit_logs al
         JOIN apps a ON a.id = al.app_id
         JOIN platform_users u ON u.id = a.owner_id
        WHERE al.path LIKE '/v1/%/kv/%'
          AND al.status_code >= 400
          AND al.at > now() - interval '24 hours'
        GROUP BY al.app_id, a.owner_id, u.email, a.region
        ORDER BY value DESC
        LIMIT $1`, [limit]);
    return { metric, apps: r.rows };
  },
);

fastify.get('/admin/kv/hotspots', { config: { public: true } }, async (req, reply) => {
  const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
  if (!user) return;
  const ctrl = (fastify as any).controlDb;

  // Storage hotspots: snapshot bytes_used >= 90% of plan.max_storage_bytes
  const storage = await ctrl.query(
    `SELECT s.app_id, s.region, s.bytes_used, p.kv_max_storage_bytes AS max_storage_bytes, s.snapshot_at
       FROM kv_app_usage_snapshot s
       JOIN apps a ON a.id = s.app_id
       JOIN platform_users u ON u.id = a.owner_id
       LEFT JOIN plans p ON p.id = u.plan_id
      WHERE p.kv_max_storage_bytes IS NOT NULL
        AND s.bytes_used >= 0.9 * p.kv_max_storage_bytes`,
  );

  // 429-rate hotspots: status 429 ≥ 5% of total KV ops over last 24h
  const rate = await ctrl.query(
    `SELECT al.app_id, a.region,
            COUNT(*) FILTER (WHERE al.status_code = 429) AS rate_limited,
            COUNT(*) AS total_ops,
            MIN(al.at) FILTER (WHERE al.status_code = 429) AS first_seen
       FROM audit_logs al
       JOIN apps a ON a.id = al.app_id
      WHERE al.path LIKE '/v1/%/kv/%' AND al.at > now() - interval '24 hours'
      GROUP BY al.app_id, a.region
     HAVING COUNT(*) FILTER (WHERE al.status_code = 429)::float / NULLIF(COUNT(*), 0) >= 0.05`,
  );

  const hotspots: any[] = [];
  for (const r of storage.rows) {
    const pct = Math.round((r.bytes_used / r.max_storage_bytes) * 100);
    hotspots.push({
      app_id: r.app_id, region: r.region,
      condition: `storage ${pct}% (${r.bytes_used} / ${r.max_storage_bytes} bytes)`,
      first_seen: r.snapshot_at,
    });
  }
  for (const r of rate.rows) {
    const pct = Math.round((Number(r.rate_limited) / Math.max(1, Number(r.total_ops))) * 100);
    hotspots.push({
      app_id: r.app_id, region: r.region,
      condition: `sustained 429s (${pct}% of ops, 24h)`,
      first_seen: r.first_seen,
    });
  }

  return { hotspots };
});
```

- [ ] **Step 3: Run the tests**

```
pnpm --filter @butterbase/control-api test kv-admin-stats
```

Expected: 4 passed total (the 2 from Task 13 + 2 new ones).

- [ ] **Step 4: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add services/control-api/src/routes/admin/kv-admin-stats.ts \
        services/control-api/src/routes/admin/kv-admin-stats.test.ts
git commit -m "feat(admin): GET /admin/kv/top-apps + /admin/kv/hotspots"
```

No `Co-Authored-By` trailer.

---

### Task 15: Admin dashboard KvPage shell + ClusterHealthTable

**Files:**
- Create: `cloud/services/admin-dashboard/src/pages/KvPage.tsx`
- Create: `cloud/services/admin-dashboard/src/lib/queries/kv-admin.ts`
- Create: `cloud/services/admin-dashboard/src/components/kv/ClusterHealthTable.tsx`
- Modify: admin-dashboard's nav + routes file (locate in Step 1)

- [ ] **Step 1: Locate the admin nav + routes**

```
grep -rn "Hackathons\|Users\|Billing" cloud/services/admin-dashboard/src --include='*.tsx' | grep -i "to:\|path" | head -10
```

Match identifies the nav + routes file. Note paths.

- [ ] **Step 2: Add the query hooks**

```ts
// cloud/services/admin-dashboard/src/lib/queries/kv-admin.ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api';  // admin-dashboard's API helper

export interface RegionHealth {
  region: string;
  mem_used: number;
  mem_max: number;
  hit_ratio: number;
  evicted_keys: number;
  clients: number;
  slowlog_len: number;
  status: 'green' | 'amber' | 'red';
  reachable: boolean;
  error?: string;
}

export function useKvClusterHealth() {
  return useQuery({
    queryKey: ['admin', 'kv', 'cluster-health'],
    queryFn: () => apiFetch<{ regions: RegionHealth[] }>('/admin/kv/cluster-health'),
    refetchInterval: 30_000,
  });
}

export interface TopApp {
  app_id: string;
  owner_id: string;
  owner_email: string;
  region: string;
  bytes_used?: number;
  keys_total?: number;
  value?: number;
  snapshot_at?: string;
}

export function useKvTopApps(metric: 'storage' | 'ops' | 'errors', limit = 20) {
  return useQuery({
    queryKey: ['admin', 'kv', 'top-apps', metric, limit],
    queryFn: () => apiFetch<{ metric: string; apps: TopApp[] }>(`/admin/kv/top-apps?metric=${metric}&limit=${limit}`),
  });
}

export interface Hotspot {
  app_id: string;
  region: string;
  condition: string;
  first_seen: string;
}

export function useKvHotspots() {
  return useQuery({
    queryKey: ['admin', 'kv', 'hotspots'],
    queryFn: () => apiFetch<{ hotspots: Hotspot[] }>('/admin/kv/hotspots'),
  });
}
```

- [ ] **Step 3: Add ClusterHealthTable**

```tsx
// cloud/services/admin-dashboard/src/components/kv/ClusterHealthTable.tsx
import { type FC } from 'react';
import { useKvClusterHealth } from '../../lib/queries/kv-admin';

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const dot = (s: 'green' | 'amber' | 'red') =>
  s === 'green' ? 'bg-emerald-500' : s === 'amber' ? 'bg-amber-500' : 'bg-red-500';

export const ClusterHealthTable: FC = () => {
  const { data, isLoading, error } = useKvClusterHealth();
  if (isLoading) return <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data) return <div className="rounded-lg border p-4 text-sm text-red-600">Couldn't load cluster health</div>;
  return (
    <div className="rounded-lg border p-4">
      <h2 className="text-lg font-semibold mb-3">Cluster health</h2>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="text-left">Region</th><th className="text-left">Memory</th><th>Hit ratio</th><th>Evictions</th><th>Clients</th><th>Slow log</th><th>Status</th></tr>
        </thead>
        <tbody>
          {data.regions.map((r) => (
            <tr key={r.region} className="border-t">
              <td className="py-2 font-mono">{r.region}</td>
              <td>{formatBytes(r.mem_used)} / {r.mem_max ? formatBytes(r.mem_max) : '—'}</td>
              <td className="text-center">{(r.hit_ratio * 100).toFixed(1)}%</td>
              <td className="text-center">{r.evicted_keys}</td>
              <td className="text-center">{r.clients}</td>
              <td className="text-center">{r.slowlog_len}</td>
              <td className="text-center"><span className={`inline-block w-2 h-2 rounded-full ${dot(r.status)}`} /> {r.reachable ? r.status : 'unreachable'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

- [ ] **Step 4: Add KvPage shell**

```tsx
// cloud/services/admin-dashboard/src/pages/KvPage.tsx
import { ClusterHealthTable } from '../components/kv/ClusterHealthTable';
import { TopAppsTable } from '../components/kv/TopAppsTable';
import { HotspotsTable } from '../components/kv/HotspotsTable';

export function KvPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">KV</h1>
      <ClusterHealthTable />
      <TopAppsTable />
      <HotspotsTable />
    </div>
  );
}
```

(Stub TopAppsTable + HotspotsTable as in Task 7 — they're filled in Task 16.)

- [ ] **Step 5: Wire route + nav**

Add the KV route to admin routes file and a nav entry. Match existing pattern.

- [ ] **Step 6: Build the admin dashboard**

```
cd cloud/services/admin-dashboard && pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add cloud/services/admin-dashboard/src/lib/queries/kv-admin.ts \
        cloud/services/admin-dashboard/src/pages/KvPage.tsx \
        cloud/services/admin-dashboard/src/components/kv/ClusterHealthTable.tsx \
        cloud/services/admin-dashboard/src/components/kv/TopAppsTable.tsx \
        cloud/services/admin-dashboard/src/components/kv/HotspotsTable.tsx \
        cloud/services/admin-dashboard/src/App.tsx     # or actual routes file
git commit -m "feat(admin-dashboard): KV page shell + cluster health table"
```

No `Co-Authored-By` trailer.

---

### Task 16: TopAppsTable + HotspotsTable

**Files:**
- Modify: `cloud/services/admin-dashboard/src/components/kv/TopAppsTable.tsx`
- Modify: `cloud/services/admin-dashboard/src/components/kv/HotspotsTable.tsx`

- [ ] **Step 1: Implement TopAppsTable**

```tsx
// cloud/services/admin-dashboard/src/components/kv/TopAppsTable.tsx
import { type FC, useState } from 'react';
import { useKvTopApps } from '../../lib/queries/kv-admin';

type Metric = 'storage' | 'ops' | 'errors';

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export const TopAppsTable: FC = () => {
  const [metric, setMetric] = useState<Metric>('storage');
  const { data, isLoading } = useKvTopApps(metric, 20);

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Top apps</h2>
        <select className="text-sm border rounded px-2 py-1" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          <option value="storage">Storage</option>
          <option value="ops">Ops (1h)</option>
          <option value="errors">Errors (24h)</option>
        </select>
      </div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {data && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr><th className="text-left">App</th><th className="text-left">Owner</th><th className="text-left">Region</th><th className="text-right">Value</th></tr>
          </thead>
          <tbody>
            {data.apps.map((a) => (
              <tr key={a.app_id} className="border-t">
                <td className="py-2 font-mono">{a.app_id}</td>
                <td>{a.owner_email}</td>
                <td className="font-mono text-xs">{a.region}</td>
                <td className="text-right">
                  {metric === 'storage'
                    ? formatBytes(Number(a.bytes_used ?? 0))
                    : Number(a.value ?? 0).toLocaleString()}
                </td>
              </tr>
            ))}
            {data.apps.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">No data</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Implement HotspotsTable**

```tsx
// cloud/services/admin-dashboard/src/components/kv/HotspotsTable.tsx
import { type FC } from 'react';
import { useKvHotspots } from '../../lib/queries/kv-admin';

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export const HotspotsTable: FC = () => {
  const { data, isLoading } = useKvHotspots();
  return (
    <div className="rounded-lg border p-4">
      <h2 className="text-lg font-semibold mb-3">Hotspots</h2>
      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {data && data.hotspots.length === 0 && <div className="text-sm text-muted-foreground">No hotspots. 🎉</div>}
      {data && data.hotspots.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr><th className="text-left">App</th><th className="text-left">Region</th><th className="text-left">Condition</th><th className="text-left">First seen</th></tr>
          </thead>
          <tbody>
            {data.hotspots.map((h, i) => (
              <tr key={`${h.app_id}-${i}`} className="border-t">
                <td className="py-2 font-mono">{h.app_id}</td>
                <td className="font-mono text-xs">{h.region}</td>
                <td>{h.condition}</td>
                <td className="text-xs text-muted-foreground">{timeAgo(h.first_seen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
```

- [ ] **Step 3: Build**

```
cd cloud/services/admin-dashboard && pnpm build 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 4: Commit**

```
git add cloud/services/admin-dashboard/src/components/kv/TopAppsTable.tsx \
        cloud/services/admin-dashboard/src/components/kv/HotspotsTable.tsx
git commit -m "feat(admin-dashboard): TopAppsTable + HotspotsTable"
```

No `Co-Authored-By` trailer.

---

### Task 17: Final verification

- [ ] **Step 1: Full control-api test suite**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
RUN_DB_TESTS=1 \
  KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test 2>&1 | tail -8
```

Expected: KV + move-app slice green. Pre-existing non-KV failures unchanged vs Plan 6 baseline (96 across 27 files).

- [ ] **Step 2: Full builds**

```
pnpm --filter @butterbase/control-api build
pnpm --filter @butterbase/sdk build
cd cloud/services/dashboard && pnpm build
cd ../admin-dashboard && pnpm build
```

Expected: all clean.

- [ ] **Step 3: Docker rebuild + restart**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase
docker compose -f docker-compose.local.yml build control-api
docker compose -f docker-compose.local.yml up -d control-api
sleep 6
docker compose -f docker-compose.local.yml logs --tail=20 control-api | grep -i "keys.expiry\|reconcile\|listening"
```

Expected:
- `KV expiry-subscriber started` log line.
- `Server listening at http://...:4000`.

If the expiry subscriber log says it can't subscribe (Redis returned an error), check `notify-keyspace-events` config on the local Redises and on `docker-compose.local.yml`.

- [ ] **Step 4: Live manual smoke (customer dashboard)**

If a dashboard dev server runs locally:
- Navigate to `/apps/kv-smoke-1/kv`.
- Verify usage strip shows current keys / storage with progress bars.
- Add an expose rule, refresh, verify it persists.
- Browse keys, click view on one, edit JSON, save, verify counter incremented in usage strip.
- Delete a key, verify counter decremented.

- [ ] **Step 5: Live manual smoke (admin dashboard)**

- Navigate to admin `/kv`.
- Cluster health shows both region rows with sensible values.
- Top apps populates if `kv_app_usage_snapshot` has rows; otherwise empty (run reconcile manually via `kvReconcileOnce` or wait for the daily run).
- Hotspots empty unless thresholds tripped.

- [ ] **Step 6: Write a brief smoke note**

Create `docs/superpowers/smoke/2026-05-24-kv-plan-7-smoke.md` (~½ page). For each section (counter, customer dashboard, admin dashboard), document expected vs actual with any deviations.

- [ ] **Step 7: Commit smoke + any verification fixups**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
git add docs/superpowers/smoke/2026-05-24-kv-plan-7-smoke.md
git commit -m "test(kv): plan 7 smoke harness — counter + customer/admin dashboards"
```

No `Co-Authored-By` trailer.

- [ ] **Step 8: Surface the deferred polish items**

Document in a final report (not a commit):
- Credit-burn card omitted from UsageStrip — requires `usage_meters` aggregation. Defer to follow-up.
- `notify-keyspace-events Ex` change to wrapper `docker-compose.local.yml` is uncommitted — flag for user approval since it's a different branch.
- Production Redis `notify-keyspace-events Ex` is a deploy prerequisite.

---

## Self-Review Checklist

1. **Migration 076 lands first** — Task 1. The reconcile extension (Task 4) writes to it. ✅
2. **`keys-counter.ts` helpers mirror `storage-counter.ts`** — same shape, same defensive clamping. ✅
3. **`AccountFn` extended in `kv-data.ts`** — every call site updated (Task 2). ✅
4. **`kvAccount` decorator accepts `keyDelta`** and calls incKeys/decKeys with swallow-on-error. ✅
5. **Expiry-subscriber per region, dedicated connection, on both DB 0 and DB 1 channels** — Task 3. ✅
6. **`reconcileFromScan` writes _meta:keys AND snapshot row** — Task 4. ✅
7. **`appStats` reads counter, no scan; returns plan limits inline** — Task 5. ✅
8. **`/_audit_recent` filters by path+status, orders desc, capped at 200** — Task 6. ✅
9. **Customer dashboard tab in nav between Storage and Monetization** — Task 7. ✅
10. **UsageStrip / ExposeRulesTable / KeyBrowser / RecentErrors all use TanStack Query** — Tasks 8–11. ✅
11. **`requireAdmin` helper** centralizes admin auth — Task 12. ✅
12. **`/admin/kv/*` endpoints iterate `BUTTERBASE_REGIONS`, no region names hardcoded** — Tasks 13–14. ✅
13. **Admin dashboard read-only — no operational actions** — Tasks 15–16. ✅
14. **Final verification covers test + build + docker + smoke** — Task 17. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-kv-plan-7-observability.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review.
2. **Inline Execution** — batch with checkpoints via `superpowers:executing-plans`.

Which approach?
