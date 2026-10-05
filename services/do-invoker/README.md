# do-invoker

Platform-owned CF Worker that lets non-CF services (deno-runtime on Fly)
reach user Durable Objects without going through the public edge.

## What it does

Accepts requests (any path/method) from platform callers, authenticates via a
shared bearer (`DO_INVOKER_TOKEN`), reads the target from the
`x-butterbase-app`, `x-butterbase-class` and `x-butterbase-instance` headers,
and translates the request into a WfP dispatch-namespace call to the target
`${appId}_do` Worker.

## Deploy

    wrangler deploy

Set the bearer once with `wrangler secret put DO_INVOKER_TOKEN`. For local dev,
`docker-compose.local.yml` runs it via `wrangler dev` on port 8787.

## Rotate the bearer

Bearer must be identical on this Worker, the control-api Fly app
(`butterbase-platform`), and the deno-runtime Fly app (`butterbase-runtime`).
Rotate with `scripts/rotate-do-invoker-token.sh` (requires
`CLOUDFLARE_ACCOUNT_ID`), which updates all three. Never rotate one side by hand.
