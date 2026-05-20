# Multi-Region Deployment

Butterbase uses Fly's single-app multi-region model: one Fly app per service, deployed to N regions. There are NO per-region toml files. Region identity is provided by Fly's `FLY_REGION` env var and resolved to a Butterbase region via `BUTTERBASE_FLY_REGION_MAP`.

## Setting the global env vars (one-time, then on region changes)

For each Fly app (`butterbase-platform`, the deno-runtime app, etc.):

```bash
flyctl secrets set --app <app> \
  BUTTERBASE_REGIONS=us-east-1,eu-west-1 \
  BUTTERBASE_FLY_REGION_MAP=iad:us-east-1,lhr:eu-west-1 \
  NEON_PLATFORM_PRIMARY_URL='postgresql://...' \
  NEON_PLATFORM_STANDBY_URL='postgresql://...' \
  PLATFORM_DB_ACTIVE_SIDE=primary \
  NEON_API_KEY='...'
```

Note that `BUTTERBASE_REGION` is intentionally NOT set on the Fly app — every machine derives it from its own `FLY_REGION` at startup.

## Adding a region (e.g., LHR for eu-west-1)

For each Fly app:

```bash
flyctl regions add lhr --app <app>
flyctl scale count 1 --region lhr --app <app>
```

Then update the env-var maps to include the new region (these are global to the Fly app):

```bash
flyctl secrets set --app <app> \
  BUTTERBASE_REGIONS=us-east-1,eu-west-1 \
  BUTTERBASE_FLY_REGION_MAP=iad:us-east-1,lhr:eu-west-1
```

Setting secrets triggers a rolling restart, so the existing US machines pick up the new map at the same time the new LHR machine boots.

## Adding a future region (e.g., APAC syd for ap-southeast-1)

Pure operational — no PRs needed:

```bash
flyctl regions add syd --app butterbase-platform
flyctl scale count 1 --region syd --app butterbase-platform
flyctl secrets set --app butterbase-platform \
  BUTTERBASE_REGIONS=us-east-1,eu-west-1,ap-southeast-1 \
  BUTTERBASE_FLY_REGION_MAP=iad:us-east-1,lhr:eu-west-1,syd:ap-southeast-1
```

Repeat for `butterbase-runtime` and any other Fly apps.

## Routine deploys

One deploy command per Fly app deploys to all its regions:

```bash
flyctl deploy --config services/platform/fly.toml
flyctl deploy --config services/deno-runtime/fly.toml
```

## Verifying per-region identity

After deploy, every machine logs its resolved region on startup. Filter by Fly region:

```bash
flyctl logs --app butterbase-platform --region lhr | grep "Starting in region"
```

Expected: `Starting in region eu-west-1 (allowed: us-east-1,eu-west-1)`.

## Local dev

Local dev does NOT have `FLY_REGION`. Set `BUTTERBASE_REGION` explicitly in your `.env`:

```bash
BUTTERBASE_REGIONS=us-east-1
BUTTERBASE_REGION=us-east-1
```
