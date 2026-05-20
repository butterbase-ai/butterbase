# Runtime-Tier Cutover Runbook

**Purpose:** Execute the Phase 2 data migration from a unified control DB to per-region runtime DBs, then drop the now-redundant tables from control.

**Estimated downtime:** 30–60 minutes per region depending on data size.

## Prerequisites

- Phase 2 Tasks 1–13 are deployed (code reads from runtime DB).
- For each region, `NEON_RUNTIME_PROJECT_ID_<REGION>` is set on the Fly app.
- The runtime DB project has been created in Neon and `db/runtime-plane/migrate.ts` has been run successfully against it (so the `_runtime_migrations` table + the 39 schema tables exist).
- `scripts/migrate-runtime-data.ts --region <r> --dry-run` has been run and the source/destination row counts confirmed reasonable.

## Step 1: Pre-cutover dry-run (no downtime)

For each region:

```bash
NEON_PLATFORM_PRIMARY_URL='postgresql://...' \
  NEON_RUNTIME_PROJECT_ID_US_EAST_1='postgresql://...' \
  tsx scripts/migrate-runtime-data.ts --region us-east-1 --dry-run
```

Confirm row counts. If destination already has data (re-run scenario), the script will INSERT … ON CONFLICT DO NOTHING — so re-runs are idempotent.

## Step 2: Announce maintenance window

- 24h advance notice in your team incident channel and on status page.
- Window: 60 minutes. Customer-app traffic returns 503 during this window.

## Step 3: Pause writes

Set Fly secret on each butterbase-platform machine:

```bash
flyctl secrets set --app butterbase-platform --stage MAINTENANCE_MODE=true
flyctl apps restart butterbase-platform
```

The control-api maintenance-mode middleware (TBD — currently not implemented; for Phase 2 cutover, assume operator-driven by stopping the Fly app):

```bash
flyctl scale count 0 --app butterbase-platform
```

(After cutover, scale back up.)

## Step 4: Run the data copy

For each region:

```bash
tsx scripts/migrate-runtime-data.ts --region us-east-1 --verify
```

Wait for "Total rows copied: N" + every table OK.

## Step 5: Restart control-api

```bash
flyctl scale count 1 --app butterbase-platform   # or original count
```

Verify:
- Dashboard loads.
- A test customer's app responds normally.
- New writes go to runtime DB (spot check).

## Step 6: Bake-in period (24h+)

Monitor for issues. If anything's wrong, the source data is still intact in control DB — restore by reverting code to read from control.

## Step 7: Apply the drop migration

After bake-in:

```bash
npm run migrate:control
```

This applies `061_post_cutover_drop_runtime_tables.sql`, dropping the runtime tables from control DB. **IRREVERSIBLE without DB restore.**

## Rollback

Before Step 7: revert the code change to read from control DB; runtime DB rows become orphaned but harmless.

After Step 7: full DB restore from backup. Have a recent point-in-time recovery snapshot ready before Step 7.
