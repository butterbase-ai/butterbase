# do-invoker

Platform-owned CF Worker that lets non-CF services (deno-runtime on Fly)
reach user Durable Objects without going through the public edge.

## What it does

Accepts POST /invoke from platform callers, authenticates via a shared
bearer (`DO_INVOKER_TOKEN`), and translates the request into a WfP
dispatch-namespace call to the target `${appId}_do` Worker.

## Deploy

    wrangler deploy

## Rotate the bearer

Bearer must be identical on this Worker AND on the deno-runtime Fly
container. Rotate with `scripts/rotate-do-invoker-token.sh`, which hits
both places atomically. Never rotate one side by hand.
