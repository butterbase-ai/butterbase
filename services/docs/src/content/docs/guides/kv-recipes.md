---
title: KV Recipes
description: Copy-pasteable patterns for sessions, locks, rate limiting, idempotency, and feature flags.
---

KV is a natural fit for data that is short-lived, accessed by key, and does not need relational queries. Each recipe below is self-contained — pick the one that matches your use case, paste it into a [serverless function](/core-concepts/functions/), and adjust the key names and TTLs for your app.

All examples use `ctx.kv` inside a function handler. See [Key-Value Store](/core-concepts/kv/) for a full method reference.

## Session store

When you need per-user state that lives for a bounded time — auth sessions, shopping carts, wizard progress — KV is the simplest choice. Values are stored as JSON, scoped to your app, and expire automatically so you do not need a cleanup job.

```typescript
export default async function handler(req, ctx) {
  // Read an existing session
  const sessionId = req.headers.get('x-session-id');
  const session = await ctx.kv.get<{ userId: string; role: string }>(
    `session:${sessionId}`,
  );
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  // session.userId and session.role are available here
  return Response.json({ userId: session.userId });
}

// On login — write a session with a 24-hour TTL
async function createSession(ctx, sessionId: string, userId: string, role: string) {
  await ctx.kv.set(
    `session:${sessionId}`,
    { userId, role },
    { ttl: 60 * 60 * 24 },
  );
}

// On logout — delete immediately rather than waiting for expiry
async function destroySession(ctx, sessionId: string) {
  await ctx.kv.del(`session:${sessionId}`);
}
```

TTL is fixed at write time and does not slide automatically. If you want sliding sessions (i.e., reset the clock on every request), call `ctx.kv.expire(key, seconds)` after a successful `get` to push the expiry forward. Keep session blobs small — store a user ID and role, not the full user record. For large payloads consider [File Storage](/core-concepts/storage/).

## Distributed lock

Use a distributed lock when two workers must not run the same job simultaneously — for example, processing a webhook, sending an email, or charging a card. `setnx` sets the key only if it does not already exist and returns `true` when the lock is acquired.

```typescript
export default async function handler(req, ctx) {
  const { orderId } = await req.json();
  const lockKey = `lock:order:${orderId}`;

  // Attempt to acquire — lock expires in 30 s if the worker crashes
  const acquired = await ctx.kv.setnx(lockKey, ctx.requestId, { ttl: 30 });
  if (!acquired) {
    return Response.json({ error: 'already_processing' }, { status: 409 });
  }

  try {
    // ... do the exclusive work here ...
    return Response.json({ status: 'done' });
  } finally {
    // Release only if we still own the lock (guards against TTL expiry race)
    const swapped = await ctx.kv.cas(lockKey, ctx.requestId, null);
    if (swapped) {
      await ctx.kv.del(lockKey);
    }
  }
}
```

The TTL is a safety net, not a hard deadline — if your worker crashes before the `finally` block, the lock releases automatically when the TTL elapses. Keep your work duration well under the TTL. If work could legitimately take longer than 30 seconds, increase the TTL or implement lock renewal with `ctx.kv.expire`. Do not use this pattern for human-facing critical sections where the user needs immediate feedback on contention — design around idempotency (see below) instead.

## Rate limiter

A fixed-window counter is the simplest way to cap actions per user per time period. The key includes a timestamp bucket so it resets automatically when the window rolls over.

```typescript
export default async function handler(req, ctx) {
  const userId = req.headers.get('x-user-id') ?? 'anonymous';
  const windowMinute = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:${userId}:${windowMinute}`;

  const count = await ctx.kv.incr(key);
  // Set the TTL on the first increment so the key expires after the window
  if (count === 1) {
    await ctx.kv.expire(key, 60);
  }
  if (count > 100) {
    return new Response('Rate limit exceeded', { status: 429 });
  }

  // ... handle the request ...
  return Response.json({ remaining: 100 - count });
}
```

If you want frontend code to call a rate-limiter endpoint directly, you can open the keyspace with `expose()`:

```typescript
// Call once during app setup or in a migration function
await ctx.kv.expose('ratelimit:{user.id}:*', { read: 'owner', write: 'owner' });
```

`expose()` is the only KV method that controls client-side access. See [Access control](/core-concepts/kv/#access-control) for the full role model and pattern syntax rather than repeating it here.

Fixed-window counters are simple but allow a burst of up to 2× the limit at window boundaries (requests at the tail of one window plus the head of the next). For most APIs this is acceptable. If you need smoother enforcement, use a sliding-window approach with a sorted-set or store a small list of timestamps — or just halve your limit.

## Idempotency keys

When a client retries a request (network timeout, duplicate submit), you need to ensure the work happens exactly once and the second call returns the same result as the first. `setnx` claims ownership of a request ID atomically, so only one execution proceeds.

```typescript
export default async function handler(req, ctx) {
  const requestId = req.headers.get('x-idempotency-key');
  if (!requestId) {
    return new Response('Missing X-Idempotency-Key header', { status: 400 });
  }

  const idemKey = `idempotent:${requestId}`;

  // Try to claim this request ID
  const claimed = await ctx.kv.setnx(idemKey, 'pending', { ttl: 60 * 60 * 24 });

  if (!claimed) {
    // Already processed (or in progress) — return cached result
    const cached = await ctx.kv.get<string>(idemKey);
    if (cached && cached !== 'pending') {
      return new Response(cached, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Still pending — tell client to retry shortly
    return new Response('Request in progress', { status: 409 });
  }

  // We own it — do the work
  const result = await doTheWork();

  // Store the serialised result so duplicates can return it
  await ctx.kv.set(idemKey, JSON.stringify(result), { ttl: 60 * 60 * 24 });

  return Response.json(result);
}

async function doTheWork() {
  // your business logic here
  return { charged: true, amount: 4900 };
}
```

The TTL controls how long duplicate detection lasts — make it longer than your client's retry window. If your work function throws, the key stays set to `'pending'` indefinitely; add error handling that either stores the error response or deletes the key so the client can retry cleanly.

## Feature flags

Store a flag value in KV and read it at request time. Changes take effect on the next request without a redeployment.

```typescript
export default async function handler(req, ctx) {
  // Read flag — default to 'off' if key is missing
  const flagValue = await ctx.kv.get<string>('feature:new-checkout');
  const newCheckoutEnabled = flagValue === 'on';

  if (newCheckoutEnabled) {
    // new checkout path
    return Response.json({ checkout: 'v2' });
  } else {
    // legacy path
    return Response.json({ checkout: 'v1' });
  }
}
```

Flip the flag without touching code:

```bash
# CLI
butterbase kv set feature:new-checkout on
butterbase kv set feature:new-checkout off
```

Or via MCP (`manage_kv` with `action: 'set'`), or directly in the Butterbase dashboard under **KV** → your app.

For a percentage rollout, store a threshold (e.g., `'30'` for 30 %) and check it against a deterministic hash of the user ID:

```typescript
const threshold = parseInt((await ctx.kv.get<string>('rollout:new-checkout')) ?? '0', 10);
const bucket = hashUserId(userId) % 100; // your own stable hash function
const enabled = bucket < threshold;
```

This gives a stable assignment per user — the same user always sees the same variant — and you can gradually raise the threshold to roll out to a wider audience.
