# Platform DB Failover Runbook

**Purpose:** Recover from a platform DB primary outage by promoting the standby to active.

**Estimated RTO (practiced):** ~10 minutes.

## Pre-flight checks

1. **Confirm primary is actually down.**
   - Check Neon status page for the primary's region.
   - Try to connect manually: `psql "$NEON_PLATFORM_PRIMARY_URL" -c "SELECT 1"`.
   - Check if it's just a network blip from your location: connect from a different region (e.g., a Fly machine in EU).
   - Look for transient symptoms (error rate spike that's already recovering).
   - **Do NOT failover for a 30-second blip.** Wait at least 3 minutes of confirmed unavailability.

2. **Run `status` to see the current state.**
   ```bash
   tsx scripts/failover-platform-db.ts status
   ```

3. **Communicate.**
   - Post in your team incident channel: "Initiating platform DB failover; expected ~10 min impact on dashboard/billing/management API. Customer apps unaffected."
   - Update status page.

## Failover

```bash
tsx scripts/failover-platform-db.ts promote
```

The script will prompt for confirmation. Type `yes`. It will:
1. Check replication lag (warn if > 30s).
2. Promote the Neon standby.
3. Stage `PLATFORM_DB_ACTIVE_SIDE=standby` on each Fly app.
4. Restart each Fly app.
5. Verify writes succeed.

If a step fails, the script exits with a clear error. Do not re-run blindly — diagnose what failed first.

## Post-failover verification

1. `tsx scripts/failover-platform-db.ts status` — confirm `Active side: standby` and the standby URL is reachable + not in recovery.
2. Open the dashboard — verify login works.
3. Spot-check a recent customer's plan: `psql "$NEON_PLATFORM_STANDBY_URL" -c "SELECT id, plan_id FROM platform_users LIMIT 5"`.
4. Update status page.

## When the original primary recovers

The original primary needs to be re-set-up as a fresh replica of the now-active standby. Neon's UI walks you through this for read-replica project types. Once replication lag on the original primary is < 5s, run:

```bash
tsx scripts/failover-platform-db.ts failback
```

## Rollback if failover itself goes wrong

If `promote` failed partway:
- If Neon promotion succeeded but Fly secret update failed: manually run `flyctl secrets set --app <app> --stage PLATFORM_DB_ACTIVE_SIDE=standby` then `flyctl apps restart <app>`.
- If Fly secret update succeeded but the new primary isn't writable: check Neon status; if the standby is healthy, you may have set the wrong active side — re-run `status` and verify.
- **Never run `promote` again** without first verifying state via `status`.

---

## Phase 1 smoke test (2026-05-10)

Verified locally:
- `failover-platform-db.ts status` against local Postgres returns Primary reachable, in_recovery=false, server 16.13.
- `loadRegionConfig` derives `instanceRegion='eu-west-1'` from `FLY_REGION=lhr` + `BUTTERBASE_FLY_REGION_MAP=iad:us-east-1,lhr:eu-west-1`.
- Fail-fast confirmed: missing `BUTTERBASE_REGIONS` throws `BUTTERBASE_REGIONS env var is not set`.
- All Phase 1 unit tests pass: 23 in `packages/shared`, 14 across `scripts/`.

Phase 1 is shippable.
