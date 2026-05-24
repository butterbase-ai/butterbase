---
title: Key-Value Store
description: Fast, regional, per-app key-value storage for sessions, locks, idempotency keys, feature flags, and counters.
---

Butterbase KV gives every app a fast, durable key-value store co-located in the same [region](/core-concepts/regions/) as your database. It is purpose-built for data that is accessed by key, expires naturally, and does not benefit from relational joins — think session tokens, distributed locks, idempotency keys, rate-limit counters, and feature flags.

Keys are automatically scoped to your app. You never need to prefix keys with an app ID or worry about collisions with other apps.

## When to use KV

| Use case | Best fit |
|---|---|
| Sessions, auth tokens, refresh tokens | **KV** |
| Distributed locks, leader election | **KV** — use `setnx` or `cas` |
| Idempotency keys | **KV** — use `setnx` |
| Rate-limit counters, page-view counters | **KV** — use `incr` / `decr` |
| Feature flags, A/B config | **KV** |
| Short-lived cache (computed results, API responses) | **KV** — use `ephemeral: true` |
| Structured user data, relational queries | **Database** |
| Uploaded files, images, documents | **File Storage** |

KV is not designed for: message queues, pub/sub channels, sorted sets, lists, or streaming. Use Realtime or a function-to-function call for those patterns.

## Data model

KV stores values as arbitrary JSON (strings, numbers, objects, arrays) up to a per-plan size limit. Counters are a first-class type — `incr` and `decr` initialize to `0` if the key does not exist and operate atomically.

### Keys

Keys are plain strings. They may contain any characters, though `:` is the conventional namespace separator (e.g., `session:user_abc123`, `lock:checkout:order_99`). You do not need to add any prefix for app isolation — that happens automatically.

### TTL

The default TTL for every new key is **30 days**. You can override this at write time:

| TTL option | Behaviour |
|---|---|
| Omitted | 30-day default |
| `{ ttl: N }` | Expires after `N` seconds |
| `{ ttl: null }` | Never expires |

To update the TTL of an existing key without changing its value, call `expire(key, seconds)` or `expire(key, null)` (pin forever).

### Persistence

Keys are **durable by default** — they survive server restarts and are replicated. For purely cache-tier data that you are comfortable losing on a cold restart, pass `{ ephemeral: true }` at write time. Ephemeral writes are faster but not guaranteed to survive a node restart.

## Quickstart

Inside a [serverless function](/core-concepts/functions/), use `ctx.kv`:

```typescript
export default async function handler(ctx) {
  // Store a session token for 1 hour
  await ctx.kv.set('session:abc123', { userId: 'u_1', role: 'admin' }, { ttl: 3600 });

  // Read it back (returns null if missing or expired)
  const session = await ctx.kv.get<{ userId: string; role: string }>('session:abc123');

  // Atomic counter — initialises to 0 if missing, then increments
  const views = await ctx.kv.incr('counter:page:/home');

  // Acquire a lock — only succeeds if key does not exist
  const acquired = await ctx.kv.setnx('lock:checkout:order_99', 1, { ttl: 30 });

  return { session, views, acquired };
}
```

Make a counter visible to the frontend without granting writes:

```ts
// In a function handler — set up the rule once
await ctx.kv.expose('hits:home', { read: 'public', write: 'deny' });
await ctx.kv.incr('hits:home');
```

```ts
// In the frontend
const res = await fetch(`${api}/v1/${appId}/kv/hits:home`);
const { value } = await res.json();
```

## Access control

By default, **all KV keys are private** — they are only accessible from your own serverless functions using a service key. End-user clients (browser, mobile) cannot read or write KV keys at all unless you explicitly opt in.

Use `ctx.kv.expose(pattern, { read, write })` to open a key pattern to end-users. This is typically called once during app setup or in a migration function.

Per-user keyspaces use `{user.id}` templating — each end user sees only their own keys:

```ts
// Function: allow each signed-in user to read & write their own profile blob
await ctx.kv.expose('profile:{user.id}', { read: 'owner', write: 'owner' });

// User u_42 signs in. From the frontend:
//   GET  /v1/:app_id/kv/profile:u_42  → 200, value
//   GET  /v1/:app_id/kv/profile:u_99  → 403 (not their key)
```

### Roles

| Role | Who it applies to |
|---|---|
| `'deny'` | Access blocked (the default for all keys) |
| `'public'` | Anyone, including unauthenticated requests |
| `'authed'` | Any authenticated user |
| `'owner'` | Only the user whose ID is embedded in the key (see `{user.id}` below) |

### Pattern syntax

Patterns use glob-style matching:

| Token | Matches |
|---|---|
| `*` | One path segment (no `:` inside) |
| `**` | Any number of segments, including nested separators |
| `{user.id}` | The authenticated user's ID (substituted at request time) |
| `{user.role}` | The authenticated user's role |

### Examples

**Per-user keyspace** — each user can read and write only their own keys:

```typescript
// Keys like "prefs:user_abc123" are readable/writable only by user_abc123
await ctx.kv.expose('prefs:{user.id}', { read: 'owner', write: 'owner' });
```

**Public read, admin write** — a feature-flag namespace any client can read:

```typescript
// Any authenticated user can read flags; only service keys can write
await ctx.kv.expose('flags:**', { read: 'authed', write: 'deny' });
```

**Global public read** — useful for anonymous counters or config:

```typescript
await ctx.kv.expose('public:**', { read: 'public', write: 'deny' });
```

**Remove a rule** when you no longer need it:

```typescript
await ctx.kv.unexpose('prefs:{user.id}');
```

**Inspect active rules** at any time:

```typescript
const rules = await ctx.kv.listRules();
// [{ pattern: 'prefs:{user.id}', read: 'owner', write: 'owner', order: 0 }, ...]
```

The most-specific pattern wins (longest literal prefix). Adding a rule with the same pattern but different roles returns a `409 KV_EXPOSE_CONFLICT` — call `unexpose` first.

## TTL & persistence

```typescript
// 30-day default
await ctx.kv.set('key', 'value');

// Explicit TTL in seconds
await ctx.kv.setex('key', 'value', 3600);           // 1 hour
await ctx.kv.set('key', 'value', { ttl: 3600 });    // same

// Never expires
await ctx.kv.set('key', 'value', { ttl: null });

// Update TTL of an existing key
await ctx.kv.expire('key', 7200);     // 2 hours from now
await ctx.kv.expire('key', null);     // pin forever

// Read remaining TTL in seconds (null = no expiry, null if key missing)
const remaining = await ctx.kv.ttl('key');

// Touch-on-read: resets TTL to the default each time the key is read
const value = await ctx.kv.get('key', { touch: true });

// Ephemeral write — fast cache tier, not guaranteed durable
await ctx.kv.set('cache:heavy-query', result, { ephemeral: true, ttl: 300 });
```

## Atomic operations

These operations are useful for building correct distributed logic without additional coordination.

| Method | Signature | Use case |
|---|---|---|
| `setnx` | `(key, value, opts?) → boolean` | Acquire a lock or write once. Returns `true` if the key was created, `false` if it already existed. |
| `setex` | `(key, value, ttl, opts?) → void` | Shorthand for `set` with a required TTL. |
| `cas` | `(key, expected, next) → boolean` | Compare-and-swap. Only updates if the current value equals `expected`. Returns `true` if the swap happened. |
| `incr` | `(key, by?) → number` | Increment by `by` (default 1). Initialises key to `0` first if missing. |
| `decr` | `(key, by?) → number` | Decrement by `by` (default 1). Initialises key to `0` first if missing. |
| `exists` | `(key) → boolean` | Check presence without loading the value. |

### Distributed lock pattern

```typescript
// Try to acquire lock (TTL is the lock lease time)
const acquired = await ctx.kv.setnx('lock:job:42', ctx.requestId, { ttl: 30 });
if (!acquired) {
  return { status: 'already_running' };
}
try {
  // ... do exclusive work ...
} finally {
  // Only release if we still own it
  await ctx.kv.cas('lock:job:42', ctx.requestId, null);
  await ctx.kv.del('lock:job:42');
}
```

### Idempotency key pattern

```typescript
// Prevent duplicate charge on retry
const created = await ctx.kv.setnx(`idem:charge:${requestId}`, true, { ttl: 86400 });
if (!created) {
  return { status: 'duplicate' };
}
// proceed with charge
```

## Bulk operations

```typescript
// Read multiple keys in one call
const [session, prefs] = await ctx.kv.mget<unknown>(['session:abc', 'prefs:abc']);

// Write multiple keys (parallel PUTs; all share the same TTL option)
await ctx.kv.mset(
  { 'flag:dark-mode': true, 'flag:beta-ui': false },
  { ttl: null },
);
```

## Error handling

| Error class | HTTP status | Meaning |
|---|---|---|
| `KvNotFoundError` | — | `get` returns `null`; no exception thrown |
| `KvForbiddenError` | 403 | End-user request blocked by access-control rules |
| `KvCasMismatchError` | 409 | `cas` expected value did not match (caller should retry) |
| `KvValueTooLargeError` | 413 | Value exceeds the per-key size limit |
| `KvRateLimitedError` | 429 | Too many ops/sec — back off and retry |
| `KvStorageFullError` | 507 | App has reached its total storage cap |
| `KvKeysExhaustedError` | 507 | App has reached its key count cap |

A `429` means your app is sending too many requests too quickly — add a short back-off. A `413` means the value is too large — consider storing it in [File Storage](/core-concepts/storage/) instead.

## Limits

Per-app caps apply to operations per second, maximum value size, total key count, and total storage. Exact numbers depend on your plan. See [KV API Reference](/api-reference/kv-api/) for current limits.

## Where next

- REST API reference: [/api-reference/kv-api/](/api-reference/kv-api/)
- CLI: [/sdks-and-tools/cli/](/sdks-and-tools/cli/)
- MCP tool: [manage\_kv](/api-reference/mcp-tools/#manage_kv)
