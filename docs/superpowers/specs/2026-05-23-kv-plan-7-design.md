# KV Plan 7 — Observability & Dashboards

**Date:** 2026-05-23
**Branch base:** `feat/kv-plan-6-move-app-kv`
**Related:** `docs/superpowers/specs/2026-05-22-user-facing-kv-design.md` ("Observability" section). Plan 5 self-review carry-over: `keys_total` scan-on-write.

## Problem

Three observability gaps sit between Plan 6 and a polished KV product:

1. **`keys_total` is computed by full SCAN on every `_stats` call.** Plan 5 left this as a known issue. Small apps fine; large apps make `_stats` expensive enough that customers won't poll it.
2. **No customer-facing KV dashboard tab.** Customers see KV exists (CLI, SDK, REST) but cannot inspect usage, edit expose rules, browse keys, or see recent errors from the dashboard. Storage / DB / Functions all have tabs; KV does not.
3. **No admin-facing KV health view.** Staff cannot see per-region cluster health, top apps by storage/ops/errors, or hotspots (apps near caps, sustained 429s). Capacity planning and incident triage rely on shelling into Redis containers.

## Goals

- `_stats.keys_total` becomes O(1) via a running counter, with daily reconcile and TTL-expiry coverage.
- Customers get a per-app KV tab: usage strip, expose-rules editor, paginated key browser, recent errors.
- Staff get a read-only admin KV section: cluster health, top apps, hotspots.

## Non-goals

- **Admin operational actions** (force-evict, pause-writes, rotate-password). Deferred to a future Plan 7d. Those need a dedicated audit-trail design and confirmation flows.
- **Time-series metrics.** No memory-over-7-days charts, no evictions trendline. Requires a metrics store (Prometheus or histogram tables). Cluster health is snapshot-only in this plan.
- **Customer-facing dashboard for billing / credit usage.** That's a separate dashboard surface; KV credit burn is shown as a single number (last 24h) without breakdown.
- **Live data in admin top-apps / hotspots.** Backed by a 24h-stale snapshot table populated by the reconcile worker. UI labels clearly. Live data deferred.

## Architecture

Three independent subsystems delivered in one plan. Each is independently testable. 7a (counter) lands first because it makes `_stats` cheap; 7b and 7c consume it.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ 7a — Backend: keys_total running counter                                      │
│                                                                               │
│   {appId}:_meta:keys   ← maintained by kv-data.ts handlers (kvAccount path)   │
│                                                                               │
│   write/del helpers:                                                          │
│     incOnNewKey(appId, was, now)  → +1 only when was===null && now!==null     │
│     decOnDel(appId, count)        → -count                                    │
│                                                                               │
│   New worker:  KV expiry-subscriber                                           │
│     - subscribes to __keyevent@<db>__:expired on each KV region's Redis       │
│     - parses {appId} from expired key; if `u:*`, decrements counter           │
│     - requires `notify-keyspace-events Ex` in redis.conf                      │
│                                                                               │
│   Extends:    storage-counter.ts reconcile worker                             │
│     - daily backstop: full scan resets {appId}:_meta:keys = actual count      │
│     - also writes a snapshot row to kv_app_usage_snapshot (control DB)        │
│                                                                               │
│   /_stats handler — replace countKeysFromScan with O(1) GET                   │
├───────────────────────────────────────────────────────────────────────────────┤
│ 7b — Customer dashboard: per-app KV tab                                       │
│                                                                               │
│   New route: /apps/:appId/kv (added to AppLayout sub-nav)                     │
│   Sections (single page, vertical layout):                                    │
│     1. Usage strip   — keys_total, bytes_used, ops/sec, credit burn (24h)     │
│     2. Expose rules  — table; edit via existing kv-expose.ts REST             │
│     3. Key browser   — cursor SCAN; prefix filter; view/edit/delete           │
│     4. Recent errors — last 50 KV audit-log entries with non-2xx outcomes     │
│                                                                               │
│   Frontend talks to existing REST plus one new endpoint for audit recents.    │
├───────────────────────────────────────────────────────────────────────────────┤
│ 7c — Admin dashboard: read-only KV section                                    │
│                                                                               │
│   New route in admin-dashboard: /kv                                           │
│   Sections:                                                                   │
│     1. Cluster health — per-region INFO snapshots (iterates BUTTERBASE_REGIONS)│
│     2. Top apps       — 24h-stale snapshot, ranked by storage/ops/errors      │
│     3. Hotspots       — derived: ≥90% storage, sustained 429s, conn errors    │
│                                                                               │
│   New internal control-api endpoints under /admin/kv/*. No operational actions.│
└───────────────────────────────────────────────────────────────────────────────┘
```

The design uses neutral region naming throughout (`region`, `BUTTERBASE_REGIONS`). No region name is hardcoded in the design or in any new code paths.

---

## 7a — `keys_total` running counter

### Counter key

`{appId}:_meta:keys` — single integer on DB 0 (alongside `_meta:bytes`, `_meta:expose`). Default value `0` (treat absent as `0`).

### Maintenance paths

**Writes (`PUT /v1/:app_id/kv/:key`, `setnx`, `_batch` set ops).** The existing handler does a read-before-write to compute the byte delta (`prev = await client.get(key)`). Extend that read to also surface "was this key new?" → `prev === null`. Pass a `keyDelta: -1 | 0 | 1` to `kvAccount` alongside the existing `sizeDelta`. `kvAccount` calls a new `incCount(client, appId, 1)` only when `keyDelta === 1`.

`setnx` semantics: if the write actually inserted (Redis returned 1), `keyDelta = 1`. If it didn't (key existed), `keyDelta = 0`.

**Deletes (`DELETE /v1/:app_id/kv/:key`, `_batch` del ops).** Handler already does `GET` first for byte-counter purposes. If existed, pass `keyDelta: -1`. If missing, `0`.

**`_batch`.** Sum positive and negative deltas across the batch into a single net `keyDelta`, pass once to `kvAccount`. Avoids N round-trips on the counter.

**TTL expiries.** Handled by the new **KV expiry-subscriber worker** (one ioredis subscriber per region):

```
bootstrap (control-api startup):
  for each region in BUTTERBASE_REGIONS:
    sub = new Redis(KV_REDIS_URL_<region>)
    sub.subscribe(__keyevent@0__:expired)
    sub.subscribe(__keyevent@1__:expired)
    sub.on('message', (channel, key) => {
      const m = key.match(/^\{([^}]+)\}:u:/)
      if (m) decCount(region, appId=m[1], 1)
    })
```

Lives in `services/control-api/src/services/kv/keys-expiry-worker.ts`. Started by `index.ts` next to the existing `KV reconcile worker started` log. Survives Redis hiccups via ioredis auto-reconnect; on reconnect we re-subscribe (no replay — reconcile catches drift).

### Redis config

`notify-keyspace-events Ex` required (E = keyevent, x = expired). Add `--notify-keyspace-events Ex` to both kv-redis containers in `docker-compose.local.yml`. Production Redis manifests need the same change; flag as a deploy dep on this plan.

### Reconcile (daily backstop)

`storage-counter.ts:reconcileFromScan` already scans both DBs and writes `_meta:bytes`. Extend to ALSO count `{appId}:u:*` keys and write `_meta:keys`. Same scan pass — no extra Redis cost. Catches drift from missed expiry events (worker restart, network partition, etc.).

The reconcile worker ALSO writes a `kv_app_usage_snapshot` row to control DB (`app_id, bytes_used, keys_total, snapshot_at`) for the admin top-apps view. New migration adds this table.

### `_stats` handler change

`appStats()` currently calls `countKeysFromScan(...)`. Replace with `await metaClient.get(\`{${appId}}:_meta:keys\`) → parseInt() || 0`. Delete the scan helper.

### `_stats` inline limits

Extend the returned shape to include the app's plan limits — saves a second round-trip from the dashboard:

```ts
export interface StatsResult {
  keys_total: number;
  bytes_used: number;
  ops_per_sec: number | null;
  // NEW: plan limits inline
  max_keys: number;
  max_storage_bytes: number;
  max_ops_per_sec: number;
  max_value_bytes: number;
}
```

Limits come from the existing `getKvLimitsForApp(controlDb, appId)` (cached 60s in Redis). Hot path safe.

---

## 7b — Customer dashboard tab

### Route and nav

Add `{ to: \`${base}/kv\`, label: 'KV', icon: KeyRound }` to `AppLayout.tsx` sub-nav, between Storage and Monetization. New route file `cloud/services/dashboard/src/pages/app/kv/KvPage.tsx`.

### Page layout

Single scrollable page, four sections top-down:

**1. Usage strip** — four cards in a row: Keys (count + delta vs last 24h), Storage (used/max + progress bar), Ops/sec (current/max + progress bar), Credits (last 24h burn, USD). Data: single `GET /v1/<app>/kv/_stats` call (post-7a, O(1) and includes limits).

**2. Expose rules** — table view of current rules with read/write/conditions columns. Inline add/edit/delete. Data: `GET/PUT /v1/<app>/kv/_expose` (existing).

**3. Key browser** — prefix filter input + key list. Each row: key, size, TTL, action menu (view, edit, delete). "Load more" button at the bottom triggers next-cursor fetch. Cursor lives in component state (not URL — opaque cursors get ugly in search params). Data: `GET /v1/<app>/kv/_scan?cursor=&match=&limit=100` (existing). Per-key: `GET/PUT/DELETE /v1/<app>/kv/:key` (existing).

**4. Recent errors** — last 50 audit-log rows for this app's KV paths with status ≥ 400. Columns: time, key (or "—" for non-key ops), status, error message. Data: **new endpoint** `GET /v1/<app>/kv/_audit_recent?limit=50`.

### New REST endpoint

`GET /v1/:app_id/kv/_audit_recent?limit=50`

Thin wrapper over the existing `query_audit_logs` function. Filters:
- `path LIKE '/v1/<app_id>/kv/%'`
- `status_code >= 400`
- `ORDER BY at DESC LIMIT <limit>` (capped at 200)

Auth: same as other `_admin`-class endpoints under `kv-admin.ts` (resolveKvAuth, owner-only). The audit log already enforces ownership at the data level.

### Frontend libraries

Dashboard already uses TanStack Query (per `src/lib/queries/`), shadcn-style components (per `src/components/ui/`), Lucide icons. No new deps. Usage strip uses progress bars only — no chart library needed for 7b.

---

## 7c — Admin dashboard read-only section

### Where it lives

`cloud/services/admin-dashboard/`. New top-level `src/pages/KvPage.tsx` and a nav entry. Uses recharts (already a dep — `src/components/charts/` confirms).

### Three sections

**1. Cluster health (per region).** Table: region, mem used / max, hit ratio (computed from `keyspace_hits`/`keyspace_misses`), evicted_keys, connected_clients, slowlog length, status badge. Status logic: red if `evicted_keys > 0` OR `mem_used > 0.85 * mem_max` OR `slowlog_len > 100`; amber if `mem_used > 0.7 * mem_max`; green otherwise.

**2. Top apps.** Sort dropdown (storage / ops/sec / error rate), time range dropdown (24h / 7d — only relevant for error rate; storage/ops use latest snapshot). Columns: app, owner, region, value, link to customer dashboard. Limit 20. Backed by `kv_app_usage_snapshot` (storage, keys) and `usage_meters` (ops, credit burn) and `query_audit_logs` aggregations (error rate).

**3. Hotspots.** Derived view of apps matching any of:
- Storage ≥ 90% of `max_storage_bytes` (snapshot + limits join).
- Sustained 429 rate ≥ 5% of all KV ops over last 24h (audit-log aggregation).
- `KvConnectionError` count ≥ 10 over last 1h (audit-log aggregation).

Each row: app, region, condition (human-readable), first-seen timestamp.

### New admin endpoints

All under `services/control-api/src/routes/admin/kv-admin-stats.ts`. Auth via the existing admin middleware (find pattern in `routes/admin/*` — likely a JWT or shared-secret check; reuse, do not invent).

- `GET /admin/kv/cluster-health` → `{ regions: [{ region, mem_used, mem_max, hit_ratio, evicted_keys, clients, slowlog_len }] }`. Iterates `BUTTERBASE_REGIONS`. Per region: one `INFO memory`, one `INFO stats`, one `CLIENT LIST`, one `SLOWLOG LEN`. `Promise.all` across regions.
- `GET /admin/kv/top-apps?metric=storage|ops|errors&limit=20` → `{ apps: [{ app_id, owner_id, owner_email, region, value }] }`. Queries the 24h-stale snapshot table for `storage`. Queries `usage_meters` for `ops`. Queries `query_audit_logs` group-by-app for `errors`. Default limit 20, max 100.
- `GET /admin/kv/hotspots` → `{ hotspots: [{ app_id, region, condition, first_seen }] }`. Server-side composition of the three sub-queries above plus the limits join.

### New control-plane table

```sql
-- db/control-plane/076_kv_app_usage_snapshot.sql
CREATE TABLE kv_app_usage_snapshot (
  app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  region        TEXT NOT NULL,
  bytes_used    BIGINT NOT NULL DEFAULT 0,
  keys_total    BIGINT NOT NULL DEFAULT 0,
  snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kv_app_usage_snapshot_bytes ON kv_app_usage_snapshot (bytes_used DESC);
CREATE INDEX idx_kv_app_usage_snapshot_keys  ON kv_app_usage_snapshot (keys_total DESC);
```

Migration starts at 076 per Plan 6's note ("Migration number — start at 076").

### Freshness messaging

Top apps and hotspots sections include a "snapshot from {time}" subtitle. If `now() - snapshot_at > 26h`, render the badge red ("snapshot stale").

---

## Error handling

| Component | Failure mode | Behavior |
|---|---|---|
| Counter incr/decr (kvAccount path) | Redis error during accounting | Log warn, swallow. Counter drifts; reconcile catches it. Do NOT fail the user's write. |
| Expiry-subscriber | Redis disconnect | ioredis auto-reconnect → re-subscribe on `ready`. Missed expiries → reconcile catches them. |
| Expiry-subscriber | Malformed key (no `{appId}` tag) | Skip silently. Internal hash-tagged keys all follow the convention; non-tagged keys aren't ours. |
| Reconcile worker | Cannot reach a region's Redis | Log error, continue with other regions. Snapshot for that region is stale; admin UI shows the stale badge. |
| `/_stats` | Counter key missing | Treat as `0`. (New apps won't have written yet — correct semantics.) |
| `/_audit_recent` | Query timeout | Return 503. UI shows "could not load recent errors — try again" placeholder. |
| `/admin/kv/cluster-health` | One region times out | Other regions still rendered. Failed region row shows red status with "unreachable" tooltip. |

---

## Testing

### 7a
- Unit: `incOnNewKey` / `decOnDel` / batch summing — pure helpers, deterministic.
- Integration (gated on KV Redis env vars): seed N keys → counter === N. Overwrite → unchanged. Delete-missing → unchanged. `_batch` mixed ops → reflects net delta.
- Expiry-subscriber integration: `SET k EX 1`, wait 1.5s, counter === N-1. Test Redis container has `--notify-keyspace-events Ex`.
- Reconcile-worker test: pre-set counter to wrong value, run `reconcileFromScan`, assert corrected. Also assert `kv_app_usage_snapshot` row was written.
- `_stats` test: counter at N → `keys_total === N` with NO scan call (monkey-patch `c.scan` and assert not called for the keys path).

### 7b
- Component tests (Vitest + RTL): one per section. Dashboard test setup is checked at plan time — if vitest config doesn't exist in `cloud/services/dashboard/`, plan adds a minimal one. Mock TanStack Query responses for `_stats`, `_scan`, `_expose`, `_audit_recent`.
- Backend tests for `/_audit_recent`: filters by app, by status range, capped limit.
- E2E (manual smoke): seed ~50 keys, hit each section, edit/delete a few, verify usage strip + counter update.

### 7c
- Backend tests for `/admin/kv/cluster-health`, `top-apps`, `hotspots`. Mock Redis `INFO` and `SLOWLOG LEN` responses. Fixture rows in `kv_app_usage_snapshot` for top-apps and hotspots.
- Component tests for the three sections.
- Live smoke (manual): start local stack, hit `/admin/kv`, verify cluster health populates from both region Redises, top-apps reflects the seeded test app, hotspots empty until thresholds tripped.

---

## Rollout

- **7a lands first.** It's independent and low risk. Once deployed, `/_stats` is O(1) and the dashboards can rely on it.
- **Deploy dep:** production Redis manifests need `notify-keyspace-events Ex` BEFORE 7a's worker starts (otherwise the subscriber is silent and the counter drifts by ~24h until reconcile). Local docker-compose change is in this plan; prod infra change is flagged as a prerequisite commit.
- **7b and 7c can ship in any order after 7a.** No feature flag — both add new routes; existing routes are untouched.
- **Migration 076 lands with 7c.** Empty table is harmless. Snapshot worker (extended in 7a) starts populating immediately on next reconcile run.

---

## File summary

**Created:**
- `services/control-api/src/services/kv/keys-counter.ts` — `incCount`, `decCount`, `getCount` helpers; key constant.
- `services/control-api/src/services/kv/keys-counter.test.ts` — unit + integration tests.
- `services/control-api/src/services/kv/keys-expiry-worker.ts` — keyspace-notification subscriber per region.
- `services/control-api/src/services/kv/keys-expiry-worker.test.ts` — integration test against real Redis with notify-keyspace-events.
- `services/control-api/src/routes/v1/kv-audit-recent.ts` — `GET /v1/:app_id/kv/_audit_recent` endpoint.
- `services/control-api/src/routes/v1/kv-audit-recent.test.ts` — endpoint test.
- `services/control-api/src/routes/admin/kv-admin-stats.ts` — three new admin endpoints.
- `services/control-api/src/routes/admin/kv-admin-stats.test.ts` — endpoint tests.
- `db/control-plane/076_kv_app_usage_snapshot.sql` — new table.
- `cloud/services/dashboard/src/pages/app/kv/KvPage.tsx` — customer KV tab.
- `cloud/services/dashboard/src/pages/app/kv/UsageStrip.tsx`
- `cloud/services/dashboard/src/pages/app/kv/ExposeRulesTable.tsx`
- `cloud/services/dashboard/src/pages/app/kv/KeyBrowser.tsx`
- `cloud/services/dashboard/src/pages/app/kv/RecentErrors.tsx`
- Plus component tests for each (Vitest + RTL).
- `cloud/services/admin-dashboard/src/pages/KvPage.tsx` — admin KV section.
- `cloud/services/admin-dashboard/src/components/kv/ClusterHealthTable.tsx`
- `cloud/services/admin-dashboard/src/components/kv/TopAppsTable.tsx`
- `cloud/services/admin-dashboard/src/components/kv/HotspotsTable.tsx`
- Plus component tests for each.

**Modified:**
- `services/control-api/src/routes/v1/kv-data.ts` — extend read-before-write to derive `keyDelta`; pass through to `kvAccount`.
- `services/control-api/src/plugins/kv-quota.ts` — `kvAccount` accepts `keyDelta` and calls counter helpers.
- `services/control-api/src/services/kv/storage-counter.ts` — `reconcileFromScan` also counts user keys and writes `_meta:keys` + `kv_app_usage_snapshot` row.
- `services/control-api/src/services/kv/admin.ts` — `appStats()` reads counter instead of scanning; returned shape includes plan limits.
- `services/control-api/src/routes/v1/kv-admin.ts` — `_stats` response shape updated; route otherwise unchanged.
- `services/control-api/src/index.ts` — start keys-expiry-worker alongside reconcile worker.
- `cloud/services/dashboard/src/layouts/AppLayout.tsx` — add KV nav entry.
- `cloud/services/dashboard/src/App.tsx` (or wherever routes are declared) — register `/apps/:appId/kv` route.
- `cloud/services/admin-dashboard/src/App.tsx` (or equivalent) — register `/kv` route + nav entry.
- `docker-compose.local.yml` (wrapper repo) — add `--notify-keyspace-events Ex` to both kv-redis services.

**Deleted:**
- `countKeysFromScan` helper in `services/control-api/src/services/kv/admin.ts` (replaced by O(1) GET).

---

## Self-Review Checklist

1. **Counter mechanics cover all paths** — writes (new vs overwrite), deletes (exist vs missing), batch (net delta), TTL expiries (subscriber), drift recovery (reconcile). ✅
2. **No region names hardcoded** — design uses `BUTTERBASE_REGIONS`, "region", "per-region substrate". ✅
3. **Inline `_stats` limits** — agreed in Section 3; documented in 7a. ✅
4. **Cursor-based key browser** — `_scan` endpoint reused; cursor in component state. ✅
5. **Admin scope: read-only** — no force-evict, no pause-writes, no rotate-password. Deferred to Plan 7d. ✅
6. **Snapshot table for admin top-apps** — `kv_app_usage_snapshot`, populated by daily reconcile, freshness badge in UI. ✅
7. **Deploy dep flagged** — `notify-keyspace-events Ex` in prod Redis manifests is a prereq for 7a. ✅
8. **Auth model preserved** — `/_audit_recent` reuses kv-quota's `resolveKvAuth` owner-only path; `/admin/kv/*` reuses existing admin middleware. ✅
9. **No new dependencies** — TanStack Query, shadcn, Lucide, recharts all already in tree. ✅
10. **Migration starts at 076** — per Plan 6's note. ✅
