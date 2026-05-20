# Local E2E Runbook (multi-region phases 1–5)

## Run

```
npm run e2e:all
```

Brings up docker-compose (control DB 5433, runtime us 5437, runtime eu 5438, data us 5435, data eu 5436, LocalStack 4566; redis 6379 is expected to be available on the host — another project's container is fine), applies all migrations to all regions, creates the LocalStack S3 bucket, then runs every scenario serially via vitest.

Required: docker, `libpq` providing `pg_dump`/`psql` (macOS: `brew install libpq`). The e2e tests prepend `/opt/homebrew/opt/libpq/bin` to PATH automatically.

## Per-scenario

```
npm run e2e:bootstrap   # once; idempotent
npx vitest run --config vitest.e2e.config.ts tests/e2e/09-move-app-happy-path.test.ts
```

## Teardown

```
npm run e2e:teardown    # docker compose down -v
```

## Scenarios → Phases

| Scenario | Phase | Status | What it asserts |
|---|---|---|---|
| 01-boot-config | 1 | green | BUTTERBASE_REGIONS / Neon project URL assertions fail boot fast |
| 02-orphan-cleanup | 2 | green | Cross-tier orphan detection (usage_meters) |
| 03-outbox-drain | 3 | green | user_state_outbox (control) drains to runtime user_billing_state |
| 04-lease-pattern | 3 | green | tryClaimShortLivedJob: 1 winner per sub-second bucket |
| 05-fly-replay-routing | 4 | green | Fly-Replay header on cross-region tagged routes |
| 06-user-app-index-fanout | 4 | green | GET /apps queries only user's regions |
| 07-region-state-endpoint | 4 | green | /v1/internal/region-state + secret auth |
| 08-backfill-scripts | 4 | green | backfill-app-regions + KV backfill smoke |
| 09-move-app-happy-path | 5/6 | green | Saga runs to completed; routing flips to eu-west-1; **Phase 6 Task 10:** asserts REAL `CREATE PUBLICATION` on dest customer DB + `CREATE SUBSCRIPTION` on source customer DB |
| 10-move-app-abort | 5 | green | abort pre-cutover + reject post-cutover |
| 11-move-app-reverse | 5/6 | green | **Phase 6 Task 10:** drives the REAL forward saga to completed (real pub/sub), then POSTs /reverse against `app.moveAppCtx` with `MOVE_APP_REPLICATION_ENABLED=true`. Routing flips back; subscription dropped on source by `promoteSourceToPrimary` |
| 12-migration-guard | 5 | green | 503 + Retry-After=60 on writes, 200 on reads |
| 13-source-replica-teardown | 5 | green | list + delete + neon_tasks deprovision enqueue |
| 14-active-migrations-endpoint | 5 | green | by_step + by_region_pair counts |

## Fixed Issues / Historical Findings

**Phase 2 orphan-cleanup:** `orphan-cleanup.ts` was querying `subscriptions.app_id` and `billing_events.app_id` — neither column exists. Fixed during scenario 2 implementation.

**Phase 5 — five saga bugs in `services/control-api/src/services/move-app/` (fixed in `dd0cc01` + `3f8271a`; test-side workarounds removed):**

1. **`step-reserve-dest.ts` inserts the dest apps row on the dest pool by selecting from the local apps table** — but the source row only exists on the source pool. Result: dest apps row never created → `app_db_connections` FK violation. Fixed in `dd0cc01`: pull source row via `runtimePoolFor(m.source_region)`, then insert into dest pool.

2. **`step-copy-runtime.ts` assumes every MOVE_APP_RUNTIME_TABLES entry has an `id` column**, but `app_db_connections.PK = app_id`. Fixed in `dd0cc01`: removed `app_db_connections` from `MOVE_APP_RUNTIME_TABLES` (it is recreated by `provisionAppDb` anyway).

3. **`moveAppCtx.listCustomDomains` (in `services/control-api/src/index.ts`) queries the control DB**, but `app_custom_domains` lives on runtime. Fixed in `dd0cc01`: routes through `runtimePoolFor(region)`.

4. **`app_db_connections.connection_string` (runtime schema) vs `connection_uri` (some readers).** Fixed in `dd0cc01`: standardized cron-scheduler sagaCtx to use `connection_string`.

5. **`step-reverse-replication.ts` calls `setSourceReplicaState(controlPool, ...)` on a fresh pool client while the saga executor still holds the row under `SELECT … FOR UPDATE`.** The UPDATE blocks forever. Fixed in `3f8271a`: state write moved to after the executor releases its lock.

**pg_dump/psql version drift:** Local libpq ships PG18 client; data-plane container is PG16 server. pg_dump emits `SET transaction_timeout = 0;` which PG16 rejects. Workaround: scenario 9 injects a custom `runPsql` that strips that statement. Production is PG17+ on both sides so this is a local-only issue.

## Production deploy notes

- **`BUTTERBASE_E2E`** MUST be unset in production. `buildApp()` throws and the process exits non-zero at boot if `NODE_ENV=production && BUTTERBASE_E2E=1`. This flag enables the `x-test-user-id` auth bypass — it must never reach a production environment file or k8s manifest.
- **`KV_LOCAL_FILE`** MUST be unset in production. Same boot-time guard fires if `NODE_ENV=production && KV_LOCAL_FILE` is set. This flag short-circuits Cloudflare KV writes to a local JSON file.
- **`MOVE_APP_REPLICATION_ENABLED`** should NOT be set in production until Phase 6 wires real Neon logical replication. When unset (the prod default), the saga completes correctly with `source_replica_state='none'` (truthful); the reverse-move fast path correctly returns 409 with a clear message. Only set this flag in local E2E or integration environments.

## Common breakage

- **`pg_dump: command not found`** — `brew install libpq`. The scenarios add `/opt/homebrew/opt/libpq/bin` to PATH automatically; if you're on Linux, set PATH yourself.
- **`ECONNREFUSED 127.0.0.1:5438`** — eu-west-1 runtime DB not up. `docker compose -f docker-compose.local.yml up -d runtime-plane-db-eu`.
- **Port 6379 in use** — another project's redis is on 6379. Fine; .env.e2e uses it. If you don't want that, change `REDIS_URL` in .env.e2e.
- **`KV_LOCAL_FILE` stale** — `rm /tmp/butterbase-e2e-kv.json`.
- **`pg_dump` emits `transaction_timeout` rejection** — see Known Issues above; production Postgres versions don't have this.
- **afterAll timeout** — your scenario didn't mirror the teardown pattern from `02-orphan-cleanup.test.ts` (clear background intervals + SseDispatcher.stop before app.close). Copy that block verbatim.

## Adding a scenario

1. Create `tests/e2e/N-name.test.ts` following one of the existing scenarios as a template.
2. Use the `bootE2E` / `seedApp` / `cleanupAll` / `pollUntil` helpers.
3. ALWAYS copy the `afterAll` teardown block from `02-orphan-cleanup.test.ts`.
4. For routes requiring auth, set `BUTTERBASE_E2E=1` (already in .env.e2e) and pass `x-test-user-id: <userId>` header.
5. For admin routes, pass `x-butterbase-internal-secret: $BUTTERBASE_INTERNAL_SECRET`.
