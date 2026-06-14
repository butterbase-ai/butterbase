---
title: Serverless Functions
description: Deploy TypeScript/JavaScript functions with HTTP triggers, cron schedules, and database access.
---

Deploy custom backend logic as serverless functions. Functions are written in TypeScript or JavaScript and run in an isolated Deno environment with database access, environment variables, and network capabilities.

Functions run in your app's [region](/core-concepts/regions/), so database calls stay fast.

## Deploying a function

```json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\n    headers: { 'Content-Type': 'application/json' }\n  });\n}",
  "description": "A simple greeting function",
  "trigger": {
    "type": "http",
    "config": {}
  }
}
```

**Required fields:**
- `name` — Unique name (1-100 characters)
- `code` — Function source code with a default export handler

**Optional fields:**
- `description` — What the function does
- `envVars` — Key-value pairs for environment variables (encrypted at rest)
- `timeoutMs` — Max execution time (default: 30000, max: 300000)
- `memoryLimitMb` — Memory limit (default: 128, range: 64-1024)
- `triggers` — Array of one or more triggers describing how the function is invoked (`trigger` singular is also accepted and normalized to a 1-element array).
- `agent_tool` — Set `true` to expose this function to agents in this app as a callable tool. See [Agents](/core-concepts/agents/).

## Trigger types

A function can have **multiple triggers** — for example an HTTP endpoint plus a daily cron — by listing them in the `triggers` array. At most one trigger of each type per function.

| Type | Description | Config |
|------|-------------|--------|
| `http` | Called via HTTP request | `{ "method"?, "path"?, "auth"?: "required" \| "optional" \| "none" }` |
| `cron` | Runs on a schedule | `{ "schedule": "*/5 * * * *", "timezone"?: "UTC" }` |
| `s3_upload` | Fires when an object lands in a bucket | `{ "bucket": "name", "prefix"?: "uploads/", "contentTypes"?: ["image/*"] }` |
| `webhook` | Generates a signed webhook URL the platform routes to your handler | `{ "secret_required"?: true, "allowed_sources"?: "github,stripe" }` |
| `websocket` | Invoked on incoming realtime WebSocket frames | `{}` |

```json
"triggers": [
  { "type": "http", "config": { "auth": "required" } },
  { "type": "cron", "config": { "schedule": "0 9 * * *" } }
]
```

## Functions as agent tools

Set `agent_tool: true` on a function to expose it as a tool any [agent](/core-concepts/agents/) in this app can call. The agent runtime reads `agent_tool_description` to decide when to call the tool, and respects `agent_tool_mode` (`read_only` runs without approval; `read_write` pauses the run for a human to approve).

```json
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

Agents must still list the function name in their graph spec's `tools.functions` array. The dashboard agent editor warns you when a referenced function does not exist or does not have `agent_tool: true`.

## Writing functions

Functions receive a Request and must return a Response:

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const body = await req.json();

  return new Response(JSON.stringify({ result: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

**Available inside a function:**
- Standard Web APIs (fetch, Request, Response, Headers, URL, etc.)
- Environment variables via `ctx.env.VAR_NAME`
- Database access via `ctx.db.query(sql)`
- User info via `ctx.user` (populated for end-user JWTs, or for service-key callers that pass `X-Butterbase-As-User` — see "Server-to-server function calls" below)
- Caller identity via `ctx.caller` — type, key id, scope, propagated user id (see "Server-to-server function calls" below)
- Sibling-function calls via `ctx.invoke('fn-name', body)` — no manual auth, identity propagates automatically
- App metadata via `ctx.app` and per-request data via `ctx.request` — see "Platform context" below
- Console output (`console.log`, `console.info`, `console.warn`, `console.error`, `console.debug`) — captured and visible in invocation logs
- Network access
- Webhook idempotency via `ctx.idempotency.claim(key)` — see "Idempotent webhook handlers" below
- Background work via `ctx.waitUntil(promise)` — see "Background work" below

:::note
Use `ctx.env`, not `Deno.env.get()` for function-specific environment variables.
:::

## Platform context

The runtime auto-injects platform-known values so you don't have to set them as env vars yourself. Two surfaces, same source of truth:

**Flat (`ctx.env.BUTTERBASE_*`)** — always present unless noted:

| Key | Value |
|-----|-------|
| `BUTTERBASE_APP_ID` | App ID (e.g. `app_abc123`) |
| `BUTTERBASE_API_URL` | Public API base URL |
| `BUTTERBASE_APP_NAME` | App display name |
| `BUTTERBASE_REGION` | Primary region (e.g. `sjc`) |
| `BUTTERBASE_ANON_KEY` | App's public anon key (safe to expose to browsers) |
| `BUTTERBASE_FRONTEND_URL` | Deployed frontend URL — **absent when no frontend is deployed** |
| `BUTTERBASE_SUBDOMAIN` | Platform-assigned subdomain — absent if unset |
| `BUTTERBASE_STRIPE_ACCOUNT_ID` | Connected Stripe account — absent if billing not configured |
| `BUTTERBASE_AI_DEFAULT_MODEL` | Default model from `manage_ai` — absent if unset |

Optional keys are **omitted** rather than empty-stringed. Branch on `typeof ctx.env.BUTTERBASE_FRONTEND_URL === "string"`.

**Structured (`ctx.app`)** — same values, typed access, optional sub-objects are `null` when absent:

```ts
ctx.app = {
  id, name, ownerId, region, subdomain, anonKey, allowedOrigins,
  substrateUserId,                    // substrate user the app is linked to, or null if not linked. ctx.substrate is also null in that case.
  frontend: { url } | null,           // null when no frontend deployed
  auth:     { accessTokenTtl, refreshTokenTtlDays, hookFunction },
  ai:       { defaultModel } | null,  // null when AI config empty
  billing:  { stripeAccountId } | null, // null when billing not connected
}
```

**Per-request (`ctx.request`)** — derived from incoming headers:

```ts
ctx.request = { id, ip, country, functionName }
```

Platform keys are injected **after** your function-specific env vars, so a user-set `BUTTERBASE_APP_ID` will not shadow the real one.

## Server-to-server function calls

A common pattern is a cron-triggered function that fans out to sibling
functions on the same app — e.g. `auto-sync-google` calls `ingest-gmail` and
`ingest-calendar`. The platform gives you three tools for this:

### `ctx.invoke('fn-name', body)` — the easy path

Use this for any same-app function call. No bearer ceremony, no env-var keys.

```typescript
export async function handler(req, ctx) {
  // Identity propagates automatically: if this fn was invoked with an
  // end-user JWT, the callee sees the same ctx.user.id.
  const r = await ctx.invoke('ingest-gmail', { workspace_id: 'ws_abc' });
  const data = await r.json();
  return new Response(JSON.stringify({ enqueued: data.queued }), { status: 200 });
}
```

Behavior:
- Authenticated with the per-app internal function key (auto-injected, never
  exposed via `ctx.env`).
- `ctx.user.id` propagates: the callee sees the same user the caller saw.
- `ctx.caller.type === 'loopback'` in the callee.
- Cycle guard: `ctx.invoke` chains are capped at depth 4; the 5th hop throws
  `ctx.invoke loop limit exceeded` synchronously.
- Returns a standard `Response` (just like `fetch`).

### `ctx.caller` — who called this function

Populated on every invocation. Use it for audit logging or to make policy
decisions in user code without parsing `req.headers.authorization` by hand.

```ts
ctx.caller = {
  type: 'service_key' | 'end_user_jwt' | 'loopback' | 'anonymous',
  keyId: string | null,  // present iff type === 'service_key'
  scope: string | null,  // first app- or gateway-scope on the key
  userId: string | null, // user this request is acting on behalf of
}
```

| Caller | type | userId | keyId |
|--------|------|--------|-------|
| Browser with end-user JWT | `end_user_jwt` | JWT `sub` | `null` |
| Cron / external service with `bb_sk_*` | `service_key` | `null` (unless impersonating) | api key row id |
| Sibling function via `ctx.invoke` | `loopback` | propagated | `null` |
| No bearer / invalid bearer | `anonymous` | `null` | `null` |

### `X-Butterbase-As-User` — when you have to call from outside

For callers that can't use `ctx.invoke` (cron jobs running outside the
runtime, external services, scripts), send the header alongside an
app-scoped `bb_sk_*`:

```http
POST /v1/app_abc/fn/ingest-gmail
Authorization: Bearer bb_sk_…
X-Butterbase-As-User: 11111111-2222-3333-4444-555555555555
Content-Type: application/json

{ "workspace_id": "ws_abc" }
```

The runtime populates `ctx.user.id` with the asserted id before invoking the
function — no in-function bearer comparison required.

**Per-function gate.** Functions can opt out of impersonation with
`allow_service_key_impersonation: false` at deploy time (or via
`manage_function action: "update_settings"`). The platform 403s any
`X-Butterbase-As-User` header on those functions at the edge. Use this for
admin-only or billing-webhook handlers that must never act on behalf of an
end user.

### Anti-pattern: bearer-equality checks

Some older templates compared the incoming bearer to their own
`ctx.env.BUTTERBASE_API_KEY` to decide whether to trust an `as_user_id` body
field:

```ts
// ❌ Don't do this — fragile under key rotation, multi-key environments,
//    or cloned apps where every function gets a different key.
const expected = `Bearer ${ctx.env.BUTTERBASE_API_KEY}`;
if (req.headers.get('authorization') === expected) {
  userId = body.as_user_id;
}
```

Replace with `ctx.user.id` (impersonation is now a platform concern) or
`ctx.invoke` (no bearer involved at all).

## RLS in functions

Functions respect RLS policies based on how they're invoked:

| Invocation | Role | RLS |
|-----------|------|-----|
| End-user JWT | butterbase_user | Enforced — sees only user's data |
| Platform API key | butterbase_service | Bypassed — sees all data |
| Cron trigger | butterbase_service | Bypassed — sees all data |

### User-scoped function

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  if (!ctx.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Automatically filtered to current user's orders (RLS enforced)
  const orders = await ctx.db.query('SELECT * FROM orders');

  return new Response(JSON.stringify(orders.rows), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### Testing RLS from service functions

Use `ctx.db.asUser()` and `ctx.db.asAnon()` to run queries under a specific role:

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const userId = 'some-user-uuid';

  // Runs as butterbase_user with RLS enforced
  const userPosts = await ctx.db.asUser(userId, async (db) => {
    const result = await db.query('SELECT * FROM posts');
    return result.rows;
  });

  // Runs as butterbase_anon with RLS enforced
  const publicProducts = await ctx.db.asAnon(async (db) => {
    const result = await db.query('SELECT * FROM products');
    return result.rows;
  });

  return new Response(JSON.stringify({ userPosts, publicProducts }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

## Using environment variables

```typescript
// Deploy with: envVars: { "API_KEY": "secret123", "BASE_URL": "https://api.example.com" }

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const apiKey = ctx.env.API_KEY;
  const baseUrl = ctx.env.BASE_URL;

  const response = await fetch(`${baseUrl}/data`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  return new Response(await response.text());
}
```

### Updating environment variables

Use `PATCH /v1/{app_id}/functions/{name}/env` to update env vars without redeploying:

```json
PATCH /v1/{app_id}/functions/{name}/env
{
  "envVars": {
    "API_KEY": "new-value",
    "OLD_KEY": null
  }
}
```

New values are **merged** with existing env vars (not replaced). Set a value to `null` to delete a key.

## Idempotent webhook handlers with ctx.idempotency.claim()

Third-party webhook providers (Stripe, Telegram, GitHub, Slack, Twilio, Discord) retry delivery on non-2xx responses with the **same event id**. Without dedup, that means processing the same webhook twice (sending the same email twice, charging the same card twice, posting the same Slack message twice).

`ctx.idempotency.claim(key)` is an atomic primitive that returns `true` the first time a key is seen and `false` on every retry, so your handler can safely ack duplicate deliveries:

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const event = await req.json();

  // Returns true the first time, false on every retry of the same event.
  if (!(await ctx.idempotency.claim(event.id, { scope: 'stripe' }))) {
    // Already processed — ack the retry without re-running side effects.
    return new Response('duplicate', { status: 200 });
  }

  await processEvent(event);
  return new Response('ok', { status: 200 });
}
```

**Options:**

| Option | Type | Default | Purpose |
|---|---|---|---|
| `scope` | `string` | `"default"` | Namespace claims per provider so keys can never collide (e.g. `"stripe"`, `"telegram"`, `"github"`). |
| `ttlSeconds` | `number` | none | Mark the claim with an expiry so you know which keys are safe to clean up. |

**Storage and cleanup.** Claims live in a per-app system table `_idempotency_keys` in your data-plane DB. The runtime never deletes them automatically — schedule a cleanup yourself, e.g. from a daily cron function:

```typescript
export default async function handler(_req: Request, ctx: any): Promise<Response> {
  await ctx.db.query("DELETE FROM _idempotency_keys WHERE expires_at < now()");
  return new Response("ok");
}
```

**Behavior:**
- The claim runs as `butterbase_service` regardless of who invoked the function (anon webhook, end-user, cron) so RLS never blocks it.
- Keys are limited to 255 characters; longer keys throw.
- The claim is atomic via `INSERT ... ON CONFLICT DO NOTHING` — concurrent invocations with the same key are safe.

## Background work with ctx.waitUntil()

Use `ctx.waitUntil(promise)` to keep a function alive after the response is sent. The response is returned to the caller immediately while the background work continues.

This is useful for fire-and-forget tasks like sending emails, logging to external services, or syncing data to third-party APIs.

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const body = await req.json();

  // Schedule background work — continues after response is sent
  ctx.waitUntil(
    fetch("https://api.email.com/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: body.email, subject: "Welcome!" }),
    })
  );

  // You can register multiple waitUntil promises
  ctx.waitUntil(
    ctx.db.query("INSERT INTO activity_log (event) VALUES ($1)", ["user_signup"])
  );

  // Response is returned immediately — background work continues
  return new Response(JSON.stringify({ status: "accepted" }), {
    headers: { "Content-Type": "application/json" }
  });
}
```

**Behavior:**
- Background work has a **30-second timeout** after the response is sent. Promises that take longer are cancelled.
- `ctx.db` is available inside waitUntil promises.
- Failures in background work are silently swallowed — they do not affect the response.
- Use `Promise.allSettled` semantics: all registered promises run regardless of individual failures.

## Calling functions from your frontend

HTTP-triggered functions are available at:

```
ANY /v1/{app_id}/fn/{function_name}
```

Any HTTP method is supported. End-user tokens are forwarded to the function.

```javascript
const response = await fetch(`${API_BASE}/v1/${appId}/fn/hello-world`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${userAccessToken}`
  },
  body: JSON.stringify({ input: 'data' })
});
```

## Cron functions

Use standard cron expressions:

| Expression | Schedule |
|-----------|----------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9 AM |
| `0 0 * * 1` | Every Monday at midnight |

## Function metrics

Each function tracks: total invocation count, error count and rate, average execution duration, and last invocation time.

## Invocation logs

Logs include: HTTP method and path, status code, execution duration, memory usage, error messages with stack traces, and console output (`consoleLogs`) from `console.log/info/warn/error/debug` calls.

### Reading logs for a deleted function (forensics)

By default, `get_function_logs` returns 404 for soft-deleted functions — the logs are still in the database but hidden so the function looks gone. For post-incident forensics, pass `include_deleted=true`:

```bash
butterbase functions logs my-fn --include-deleted
```

```typescript
await admin.functions.logs('my-fn', { includeDeleted: true });
```

```http
GET /v1/{app_id}/functions/{name}/logs?include_deleted=true
```

This is owner-scoped (same auth as the default path) — only the app owner can read forensic logs.

## Pausing an app (kill-switch)

`pause_app` is a single API call that halts **all data-plane traffic** for an app — useful when a buggy webhook is spamming end users, a runaway cron is burning external API quotas, or you want to take an app offline for maintenance.

While paused:
- Function invocations (HTTP and cron) return **503** with code `APP_PAUSED`.
- Data-plane CRUD (`select_rows`, `insert_row`, REST) returns 503.
- Storage uploads / downloads return 503.
- Realtime websockets close with code `1013` ("Try again later").

What stays available so you can recover:
- All control-plane endpoints (`list_apps`, `get_app_config`, schema, RLS, env vars, the `pause_app` toggle itself).
- Auth (login / signup) — operators may need to re-authenticate while paused.

**MCP:**

```json
{ "app_id": "app_abc123", "paused": true, "reason": "investigating outbound spam" }
```

**CLI:**

```bash
butterbase apps pause app_abc123 --reason "investigating outbound spam"
butterbase apps resume app_abc123
```

**SDK:**

```typescript
await admin.config.pause('investigating outbound spam');
await admin.config.resume();
```

The pause is durable (a column on `apps`) — restarts of the control-API don't clear it. Owner-only, audited as `app.config.paused`.
