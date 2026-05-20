# Hot Quota Path Runbook

The Phase 3 hot quota path serves customer API requests entirely from the local
runtime DB. Two background processes keep the local cache fresh:

1. **state-outbox-drain** — pulls slow-field changes from platform DB into each
   region's `user_billing_state`. Runs every 1s. Lock: `cron:platform:state-outbox-drain:<sec>`.
2. **lease-reclaim** — returns expired top-up leases. Runs every 60s. Lock:
   `cron:platform:lease-reclaim:<sec>`.

## Health endpoint

```bash
curl -H "x-butterbase-internal-secret: <secret>" \
  https://control-api.<platform-region>.internal:4000/v1/internal/quota-state
```

Returns:
- `outbox.pending` — pending outbox rows (target: < 100 steady state).
- `outbox.oldestPendingSeconds` — age of the oldest pending row (target: < 5s; alert at 30s).
- `leases.activeCount` and `totalActiveUsd` — outstanding regional claims on
  global balance. Useful for reconciliation.
- `reclaim.reclaimedLast24h` and `reclaimedTotalUsd24h` — yesterday's reclaim
  activity. Spikes indicate region instability.

## Runbook: outbox lag spike

1. Check `outbox.oldestPendingSeconds`. If > 30s sustained:
   - Check the cron-scheduler logs for `state-outbox-drain error`.
   - Check Redis health (the lock requires Redis).
   - Check that at least one region's cron-scheduler is running.
2. Manually trigger a drain:
   ```bash
   curl -X POST -H "x-butterbase-internal-secret: <secret>" \
     https://control-api.<platform-region>.internal:4000/v1/internal/state-outbox/drain
   ```
3. If lag persists, inspect `user_state_outbox` directly:
   ```sql
   SELECT id, user_id, fields_changed, version, applied_to_regions, created_at
   FROM user_state_outbox WHERE done_at IS NULL ORDER BY created_at LIMIT 20;
   ```
   - Rows with empty `applied_to_regions` and stale `created_at` mean the drain
     can't reach the runtime DBs — check region connectivity.
   - Rows with partial `applied_to_regions` mean a specific region is failing —
     check that region's runtime DB.

## Runbook: lease grant 5xx

Customer reports "Top-up balance temporarily unavailable" in a region. Indicates
the region can't reach the platform region's `/v1/internal/lease/grant` endpoint.

1. Check region's control-api logs for `lease grant failed: 5xx`.
2. Test connectivity:
   ```bash
   curl -X POST -H "x-butterbase-internal-secret: <secret>" \
     -H "content-type: application/json" \
     -d '{"userId":"<id>","region":"<region>","amountUsd":0.01}' \
     https://control-api.<platform-region>.internal:4000/v1/internal/lease/grant
   ```
3. If platform region is offline (Neon outage), customer requests in the failing
   region will exhaust their current lease then 402. Auth, app data, non-AI APIs
   continue working. No action besides waiting for Neon to recover.

## Runbook: lease balance reconciliation

Periodically (monthly):
```sql
SELECT SUM(topup_balance_usd) FROM platform_users;
SELECT SUM(amount_usd) FROM topup_leases WHERE status = 'active';
-- (active lease total) should be small relative to (sum of platform balances).
-- If close to (sum of platform balances), regions are over-leasing — investigate
-- lease TTL config or stuck reclaim cron.
```

## Rolling back the cutover

If the hot path causes incidents, revert quota-enforcement.ts to its pre-Task-16
state (read from platform_users, deductTopupBalance via usage-metering.ts). The
underlying outbox + lease infrastructure is harmless if unused.
