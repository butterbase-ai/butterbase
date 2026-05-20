# Data DB Regionalization Runbook

Phase 4 routes every customer API request to the Fly machine in the app's region.
Two state stores must agree on the app's region: the regional runtime DB
(`apps.region`, authoritative) and the global Cloudflare KV (`sub:*` /
`domain:*` values, denormalized).

## Adding a New Region

1. Provision a Neon **runtime** project in the target region. Run Phase 2's
   runtime migrations against it:
   ```bash
   BUTTERBASE_REGIONS=<existing,new-region> \
     NEON_RUNTIME_PROJECT_ID_<NEW_REGION>=postgresql://... \
     npx tsx db/runtime-plane/migrate.ts
   ```
   Then run Phase 4 Task 2's region-backfill — for the new region, this is a
   no-op (no apps yet), but it normalizes the column default.

2. Provision a Neon **data** project in the same region. No migrations to apply
   yet (Phase 4 ships zero data-tier migrations); the runner just needs the
   project ID configured.

3. Add the env vars to every Fly app's secret bundle:
   ```
   BUTTERBASE_REGIONS=us-east-1,eu-west-1
   NEON_RUNTIME_PROJECT_ID_EU_WEST_1=postgresql://...
   NEON_DATA_PROJECT_ID_EU_WEST_1=neon-project-id
   ```
   The boot assertion (`assertNeonProjectsConfig`) will fail fast if anything
   is missing.

4. Deploy a Fly machine in the new region with `BUTTERBASE_REGION=eu-west-1`.

5. App creation in the new region is now possible. Existing apps stay where they
   are (move-app saga in Phase 5 is the migration path).

## KV ↔ runtime DB drift

The dispatch-worker reads region from KV. If KV says `us-east-1` but
`apps.region` says `eu-west-1`, the worker will Fly-Replay to us-east-1 — and
the receiving us-east-1 control-api will Fly-Replay back to eu-west-1, creating
an infinite ping-pong (Fly's proxy detects this and fails after a few hops).

Detection:
```bash
curl -H "x-butterbase-internal-secret: <secret>" \
  https://control-api.<platform-region>.internal:4000/v1/internal/region-state
```
The `unknownRegions` array surfaces apps in the index whose region isn't in
`BUTTERBASE_REGIONS` — usually a stale row from a removed region.

Remediation:
1. Re-run the backfill: `tsx scripts/backfill-kv-region.ts`. This rewrites every
   KV value from authoritative `apps.region`.
2. If `apps.region` itself is wrong (e.g. the runtime DB was restored from a
   different region's snapshot), run `tsx scripts/backfill-app-regions.ts --fix`
   to normalize.

## Fly-Replay debugging

Symptom: a request that should succeed returns 200 with an empty body and a
`Fly-Replay` header.

That's the plugin doing its job — Fly's edge proxy should re-issue the request
to the named region. If you see this in logs as a customer-facing 200-empty,
either:
- The Fly proxy isn't honoring the header (check Fly platform status).
- The request bypassed Fly (e.g. internal Kubernetes call hitting a Fly machine
  directly). For service-to-service calls inside the platform region, prefer
  a platform-region-only URL and skip Fly-Replay by not setting
  `routeOptions.config.requiresAppRegion`.

To verify: `curl -v` the suspect URL and look for the `Fly-Replay` header in
the response. If present, that's the plugin telling Fly to re-route.

## Adding a new app in a non-default region

Customers can specify `region` in the create-app POST body:
```json
{
  "name": "my-app",
  "region": "eu-west-1"
}
```
Validation: must be in `BUTTERBASE_REGIONS`. Must have a Neon project
configured (`assertNeonProjectsConfig` already proved this at boot).

If the region is rejected with a 400, the customer's body specified an
unsupported region. If 500, env vars are missing on the receiving Fly machine
— the boot assertion should have caught this; the only way to land in this
state is if env vars were removed without a restart.
