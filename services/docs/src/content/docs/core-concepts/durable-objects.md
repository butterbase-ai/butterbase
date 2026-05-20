---
title: Durable Objects
description: Stateful per-key actors for chat rooms, multiplayer games, AI agents, and other coordination patterns.
---

Durable Objects (DOs) are Butterbase's stateful compute primitive. Each DO is an actor identified by a class + instance ID; the actor lives in memory across requests, persists state via built-in transactional storage, and can hold WebSocket connections. They are the natural fit for **anything where state is per room/per user/per agent**: chat rooms, multiplayer games, real-time collaboration, leaderboards, rate limiters, long-running AI agents.

For stateless work, use [Functions](/core-concepts/functions/) instead.

## Quick start

Write a single TypeScript file that exports one class:

```ts
// chat-room.ts
export class ChatRoom {
  constructor(public state: DurableObjectState, public env: any) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);

      // Bootstrap the new client with current state. Without this, late
      // joiners see nothing until the next message arrives.
      const messages: any[] = (await this.state.storage.get('messages')) ?? [];
      pair[1].send(JSON.stringify({ type: 'init', messages }));

      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (req.method === 'POST') {
      const msg = await req.json();
      const messages: any[] = (await this.state.storage.get('messages')) ?? [];
      messages.push(msg);
      await this.state.storage.put('messages', messages.slice(-100));
      this.broadcast(JSON.stringify(msg));
      return Response.json({ ok: true });
    }
    const messages = (await this.state.storage.get('messages')) ?? [];
    return Response.json(messages);
  }

  // The runtime delivers either a string or an ArrayBuffer. Guard before
  // treating the payload as text — JSON.parse on an ArrayBuffer crashes the DO.
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== 'string') return;
    this.broadcast(msg);
  }

  broadcast(msg: string) {
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* dead conn */ }
    }
  }
}
```

:::tip[Co-locating DO source with a Next.js app]
If you keep your DO file in the same repo as a Next.js / Edge SSR app, exclude the directory from the Next.js `tsconfig.json` — DO source uses Cloudflare globals (`DurableObjectState`, `WebSocketPair`) that aren't in the Next.js type environment, and TypeScript will complain.

```json
{ "exclude": ["node_modules", "durable-objects"] }
```
:::

Deploy with the CLI:

```bash
butterbase do deploy chat-room.ts --name chat-room
```

Or with the MCP tool: `deploy_durable_object`.

## URL pattern

After deploy, every instance is reachable at:

```
https://<your-subdomain>.butterbase.dev/_do/<name>/<instance-id>
```

The same URL accepts both HTTP and WebSocket upgrade. Different instance IDs (`/lobby`, `/general`, `/team-1`) are completely isolated — separate state, separate connections.

```js
// Browser
const ws = new WebSocket('wss://my-app.butterbase.dev/_do/chat-room/lobby');
ws.onmessage = (e) => console.log('msg:', e.data);
ws.send(JSON.stringify({ user: 'alice', text: 'hello' }));
```

## Constraints

- **Single file source.** No npm imports. Only `import { ... } from 'cloudflare:workers'` is permitted.
- **One class per file.** The class must be `export`-ed and the filename serves as a default URL name (you can override with `--name`).
- **5 DO classes per app maximum** for v1.
- **Bundle (sum of all DO classes for an app) max 10 MB compressed.**
- **Storage: built-in.** Use `state.storage` (Cloudflare's transactional KV). Do not try to use Postgres for per-DO state — that defeats the point of co-location.
- **No service bindings yet.** Functions and Edge SSR Workers must reach DOs over HTTP, not via env binding. (Service bindings are a future enhancement.)

## Access modes

Each DO declares an access mode at deploy time:

- `public` — anyone can call.
- `authenticated` (default) — requires a valid end-user JWT (`Authorization: Bearer ...`).
- `service_key` — requires a Butterbase service key (`Authorization: Bearer bb_sk_...`).

:::caution
**v1 limitation:** The DO worker only checks the *shape* of the Authorization header (e.g. that it starts with `Bearer bb_sk_`). It does NOT verify that the key is valid, unrevoked, or belongs to your app. For now, the dispatcher in front of WfP terminates traffic from the public internet but does not perform fine-grained auth on `/_do/*` paths.

If you need strong authentication, validate the bearer token inside your DO's `fetch` handler. Two options:

- **Round-trip:** call `GET https://api.butterbase.ai/auth/<app_id>/me` with `Authorization: Bearer <user-token>`. A 200 response confirms the token is valid and returns the user.
- **Offline crypto verify:** fetch the per-app JWKS from `https://api.butterbase.ai/auth/<app_id>/.well-known/jwks.json` (cached 5 min) and verify the JWT signature locally with the Web Crypto API.

Real authentication enforcement at the dispatcher is on the v2 roadmap.
:::

:::caution[WebSocket auth gotcha]
Browsers cannot send custom headers on the `WebSocket` upgrade request, so `access_mode: 'authenticated'` will reject every browser WebSocket connection at the dispatcher with 401 — the upgrade never reaches your `fetch` handler.

If your DO accepts WebSocket connections from the browser, set `access_mode: 'public'` and validate the token *inside* `fetch()`, reading it from the URL query string or the `Sec-WebSocket-Protocol` header:

```ts
async fetch(req: Request): Promise<Response> {
  if (req.headers.get('Upgrade') === 'websocket') {
    const token = new URL(req.url).searchParams.get('token');
    if (!await verifyToken(token, this.env)) {
      return new Response('unauthorized', { status: 401 });
    }
    // ... accept upgrade
  }
}
```
:::

## Environment variables

DOs can read app-level config from `env.KEY` (alongside the DO namespace bindings). Manage them with the CLI:

```bash
butterbase do env set APP_ID app_abc123
butterbase do env set API_BASE_URL https://api.example.com
butterbase do env list
butterbase do env unset OLD_KEY
```

- Keys must match `^[A-Z_][A-Z0-9_]*$` (UPPER_SNAKE).
- Setting or removing a value triggers an automatic redeploy of the DO Worker if any classes are active, so the change is live immediately.
- Values are write-only via the API: `list` returns keys only, never plaintext.
- Env values are visible to **every** DO class deployed for the app — they share one Worker script.
- A key cannot collide with a DO class binding (the UPPER_SNAKE form of a class URL name, e.g. `chat-room` → `CHAT_ROOM`). The deploy will fail with a clear error if it does.

```ts
export class ChatRoom {
  constructor(public state: DurableObjectState, public env: { APP_ID: string; API_BASE_URL: string }) {}

  async authorize(token: string) {
    const res = await fetch(`${this.env.API_BASE_URL}/auth/${this.env.APP_ID}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  }
}
```

## Lifecycle

- **Add or update a class:** `butterbase do deploy file.ts --name X` — re-bundles all the app's DOs and redeploys the WfP script. Existing in-memory instances are evicted and reload with the new code on the next request.
- **Delete a class:** `butterbase do delete X` — Cloudflare immediately deletes all instances and storage for that class. **This cannot be undone.**
- **Delete the app:** all DO classes and instances are torn down with the app.
- **Class renaming** is not yet supported — register the new name, copy data over, delete the old.

## Usage and billing

Cloudflare reports per-script metrics (request count, CPU duration). A 15-minute cron pulls these into Butterbase's usage meters:

- `do_requests` — total HTTP + WebSocket invocations
- `do_cpu_ms` — CPU time in milliseconds

Storage GB·s: not yet implemented (v2).

In v1, these meters are recorded but not enforced. Inspect with `butterbase do usage <name>` or the `get_do_usage` MCP tool. Note that the v1 reporter returns app-wide DO totals across all classes — per-class breakdown is on the v2 roadmap.

## When NOT to use a DO

- **Stateless API endpoint:** use a [Function](/core-concepts/functions/).
- **Static frontend:** use [Frontend Deployment](/core-concepts/frontend-deployment/).
- **Server-rendered Next.js:** use [Edge SSR](/core-concepts/edge-ssr-deployment/).
- **Database-style queries across keys:** use Postgres + the [Auto-API](/core-concepts/database/).
- **Real-time fan-out from DB changes:** use [Postgres Realtime](/core-concepts/realtime/).

## Troubleshooting

**"Source must export exactly one class"** — Your file must `export class X { ... }`. No interfaces, no functions, no extra exports.

**"Import 'X' is not allowed"** — Only `cloudflare:*` imports are permitted. v1 has no npm bundling.

**"Too many DO classes for one app"** — Hard cap of 5 in v1. Delete unused ones to make room.

**WebSocket connection drops immediately** — Check the access mode. Authenticated mode rejects upgrade requests without a valid bearer token.

**Storage limit** — Cloudflare DO storage is ~unlimited per instance, but each key/value is capped at 128 KB. For larger blobs, use [Storage](/core-concepts/storage/).
