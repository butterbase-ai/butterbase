# Move-App Runbook

Phase 5 ships the move-app saga: planned-downtime migration of one customer app
between regions, with a retained source replica for fast rollback.

> **Customer-facing docs:** see [`docs/move-app.md`](../move-app.md) for the
> user-facing guide covering initiation, abort, reverse-move, source-replica
> retention, and client-side 503 handling.

## Initiating a move

Customer-facing: dashboard "Move app" button OR the `move_app` MCP tool.
Internal/manual:
```bash
curl -X POST -H "Authorization: Bearer <user-jwt>" \
  -d '{"dest_region":"eu-west-1"}' \
  https://api.butterbase.ai/v1/apps/<app_id>/move
```
Returns `{migration_id, status: 'queued'}`. The saga driver picks it up within
5 seconds.

## Monitoring

```bash
curl -H "x-butterbase-internal-secret: <secret>" \
  https://control-api.<platform-region>.internal:4000/v1/internal/active-migrations
```

Per-customer:
```bash
curl -H "Authorization: Bearer <user-jwt>" \
  https://api.butterbase.ai/v1/apps/<app_id>/migrations/<migration_id>
```

Returns `current_step`, `last_error`, `retry_count`, and `progress` (the
`dest_resources` JSONB — includes `dump_object_key`, `dump_bytes`, `copied_tables`, etc.).

## Common failures

| Step | Likely cause | Action |
|---|---|---|
| `reserving_dest` | Neon API rate-limited or 5xx | wait; will auto-retry up to 5x |
| `dumping_data` | source DB OOM, network blip | check pg_dump stderr (in saga driver logs); may need temp Fly machine resize |
| `restoring_data` | schema drift, missing extension on dest | check `psql` exit code in logs; for extension drift, run extension migrations on the dest data project |
| `copying_runtime` | a runtime table doesn't exist on dest (Phase 2 migrations not run for that region) | run `npx tsx db/runtime-plane/migrate.ts` against dest region |
| `flipping_routing` | CF API 5xx | will retry; KV writes are idempotent |
| `setting_up_reverse_replication` | Neon replication setup failed | migration completes anyway with `source_replica_state='none'`; reverse-move fast path unavailable |

If `retry_count` reaches 5 on any step, the migration is marked `failed` and
needs manual intervention.

## Aborting before cutover

Pre-`flipping_routing` only:
```bash
curl -X POST -H "Authorization: Bearer <user-jwt>" \
  https://api.butterbase.ai/v1/apps/<app_id>/migrations/<migration_id>/abort
```
Cleans up dest resources; returns the source apps row to `'ready'`.

## Reverse-move (after cutover)

```bash
curl -X POST -H "Authorization: Bearer <user-jwt>" \
  https://api.butterbase.ai/v1/apps/<app_id>/migrations/<migration_id>/reverse
```

Returns HTTP 202 with `{ migrationId, path }`. The `path` field indicates which
code path was taken:

### Fast path vs slow path

| `path` | Condition | Duration | Mechanism |
|--------|-----------|----------|-----------|
| `"fast"` | `source_replica_state = 'replicating'` | Minutes | Runs inline: waits replication lag, promotes source to primary, flips routing, restores archived runtime tables. |
| `"slow"` | `source_replica_state` is anything else (e.g. `'none'`, `'torn_down'`) | 5–30 min (same as a forward move) | Creates a new migration row with source/dest swapped and enqueues it for the saga driver. The driver runs the full saga (dump → restore → copy → flip routing). |

**Fast path** is used when the source replica is still actively replicating from
the new primary (the replica set up during `setting_up_reverse_replication`).
The operation is fast because it leverages the live replication link.

**Slow path** is used when the source replica is unavailable — either because
`setting_up_reverse_replication` failed (`source_replica_state='none'`), or
because the user tore down the replica (`source_replica_state='torn_down'`)
and then changed their mind. The slow path runs the full saga in the reverse
direction: it dumps from the current primary (former dest) and restores to the
original source region. This is equivalent to initiating a fresh move.

Pre-existing archive tags on the original source (`archived_after_move` set by
the forward move) are cleared before the slow-path saga starts, so that
post-cutover writes from the live primary are not silently dropped by
`ON CONFLICT DO NOTHING` during `copying_runtime`.

## Source replica retention

After cutover, the source data DB is kept as a live replica. Ongoing cost
appears on the user's bill. The user explicitly tears it down via dashboard.

List active replicas:
```bash
curl -H "Authorization: Bearer <user-jwt>" \
  https://api.butterbase.ai/v1/source-replicas
```

Teardown:
```bash
curl -X DELETE -H "Authorization: Bearer <user-jwt>" \
  https://api.butterbase.ai/v1/source-replicas/<migration_id>
```

## Manual rollback (everything failed)

If the saga is wedged AND reverse-move can't run (e.g. both the fast and slow
paths have failed, or the migration row itself is corrupted):

1. Manually flip KV back: `tsx scripts/backfill-kv-region.ts` (Phase 4 backfill — picks up authoritative `apps.region`).
2. Manually update `apps.region` on source: `UPDATE apps SET region='<original>' WHERE id='<app_id>'` in the source runtime DB.
3. Restore archived runtime rows: `UPDATE app_users SET archived_after_move = NULL WHERE archived_after_move = '<migration_id>'` for each affected table.
4. Set the migration row to `aborted`: `UPDATE app_migrations SET current_step = 'aborted', completed_at = now() WHERE id = '<migration_id>'`.

This is a manual operation — there is no automated full-disaster recovery script in v1.

## Handling migration in progress (downstream HTTP clients)

While a migration is running (`blocking_writes` through `unblocking_writes`), any write
request routed to the app's auto-API will be rejected with:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 60
Content-Type: application/json

{"error":"app_migrating","message":"This app is being moved to a different region. Writes are temporarily blocked."}
```

**Contract for downstream clients:**

- Check `response.status === 503` AND `body.error === 'app_migrating'`.
- Read the `Retry-After` header (seconds) and wait before retrying.
- Read-only requests are unaffected and continue to succeed.

**Dashboard behaviour:**

- The `AppMigratingError` class (exported from `services/dashboard/src/lib/api-client.ts`
  and re-exported from `services/dashboard/src/lib/move-app-api.ts`) is thrown by both
  API client wrappers when a 503 + `app_migrating` response is received.
- The `MigrationBanner` component polls `GET /v1/apps/:id/migrations/active` every 10 s
  and displays a top-of-layout banner with a deep-link to the migration progress page
  (`/apps/:appId/move/:migrationId`).

**Active migration endpoint:**

```
GET /v1/apps/:app_id/migrations/active
Authorization: Bearer <user-jwt>
```

Returns `{ migration: { id, current_step, source_region, dest_region, source_replica_state, step_started_at } }`
or `{ migration: null }` when no migration is in flight.
