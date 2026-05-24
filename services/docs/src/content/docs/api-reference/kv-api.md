---
title: KV API
description: Complete reference for the Butterbase KV REST endpoints — get, set, delete, atomic operations, batch, scan, expose rules, and audit log.
sidebar:
  order: 10
---

Butterbase KV is a per-app key-value store accessible over HTTP. Every operation targets a single app and is authenticated at the request level. All endpoints share a common base path and the same `{ error, message }` error shape.

## Base URL

```
https://api.butterbase.ai/v1/{app_id}/kv/...
```

Replace `{app_id}` with your app's ID (e.g. `app_abc123`). The `kv/` prefix is fixed; everything after it is either a user key or one of the reserved `_`-prefixed paths described below.

For auth details see [Authentication](/core-concepts/authentication).

---

## Authentication

Every request must carry an `Authorization: Bearer <token>` header, or it is treated as an anonymous request (no header). Three token shapes are accepted.

### Function key

```http
Authorization: Bearer <function_key>
```

Used by server-side code running inside a Butterbase function handler. The function key is injected automatically by the runtime; you do not manage it directly. Function keys have full read/write access to all keys and can manage expose rules.

### End-user JWT

```http
Authorization: Bearer <jwt>
```

A JWT issued by the app's auth providers (configured via `auth_config`). Sent from frontend code after a user signs in. Access is limited to keys covered by an active `expose()` rule; keys with no matching rule return `401` or `403`. The JWT must have exactly three `.`-separated segments (`header.payload.signature`).

### Platform JWT (owner / dashboard)

```http
Authorization: Bearer <platform_jwt>
```

A JWT issued by Butterbase for the platform account that owns the app. Used by the Butterbase dashboard and owner-level tooling. Grants the same permissions as a function key, including expose-rule management. Most application code should use a function key instead.

---

## Endpoints

### GET /v1/:app_id/kv/:key

Read the value stored at `key`. Keys may contain slashes (e.g. `session/abc-123`).

**Auth:** Any (function key, platform JWT, end-user JWT if key is covered by a `read`-permissive expose rule, or anonymous if the rule allows `public` reads).

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `touch` | `boolean` | When `true`, refreshes the TTL on durable keys to their original value (sliding expiry). Default `false`. |

**Response `200`**

```json
{ "value": <any JSON value> }
```

**Response `404`**

```json
{ "error": "not_found", "message": "not_found" }
```

**Example**

```bash
GET /v1/app_abc123/kv/session/user-42
Authorization: Bearer <function_key>
```

```json
{ "value": { "userId": "user-42", "role": "admin" } }
```

---

### GET /v1/:app_id/kv/:key/ttl

Return the remaining TTL of `key` in seconds.

**Auth:** Same as GET `:key`.

**Response `200`**

```json
{ "ttl": 86312 }
```

`ttl` is `null` when the key has no expiry, or a positive integer in seconds when it does. Returns `404` if the key does not exist.

---

### GET /v1/:app_id/kv/:key/exists

Check whether `key` exists without fetching its value.

**Auth:** Same as GET `:key`.

**Response `200`**

```json
{ "exists": true }
```

Always `200`; `exists` is `true` or `false`.

---

### PUT /v1/:app_id/kv/:key

Create or overwrite `key`. The previous value, if any, is replaced atomically.

**Auth:** Function key, platform JWT, or end-user JWT if key is covered by a `write`-permissive expose rule.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `value` | any JSON | Yes | The value to store. Any JSON-serialisable type is accepted. |
| `ttl` | integer or `null` | No | Time-to-live in seconds. `null` removes the expiry. Omit to use the default (30 days). Must be a positive integer if provided. |
| `ephemeral` | boolean | No | When `true`, the key is stored in the ephemeral tier (shorter-lived, lower cost). Default `false` (durable). |

**Response `204`** — No body.

**Example**

```bash
PUT /v1/app_abc123/kv/session/user-42
Authorization: Bearer <function_key>
Content-Type: application/json

{
  "value": { "userId": "user-42", "role": "admin" },
  "ttl": 3600
}
```

---

### DELETE /v1/:app_id/kv/:key

Delete `key`. If the key existed in both the durable and ephemeral tiers, both copies are removed.

**Auth:** Function key, platform JWT, or end-user JWT if key is covered by a `write`-permissive expose rule.

**Response `200`**

```json
{ "deleted": 1 }
```

`deleted` is the count of underlying store entries removed (`0` if the key did not exist, `1` or `2` if it existed in one or both tiers).

---

### POST /v1/:app_id/kv/:key/incr

Atomically increment a numeric counter stored at `key`. If the key does not exist it is initialised to `0` before incrementing.

**Auth:** Function key, platform JWT, or end-user JWT (write expose rule required).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `by` | integer | No | Amount to increment by. Default `1`. Must be a whole number. |

**Response `200`**

```json
{ "value": 42 }
```

`value` is the new integer value after the operation.

---

### POST /v1/:app_id/kv/:key/decr

Atomically decrement a numeric counter. Same rules as `incr` except the counter is reduced.

**Auth:** Function key, platform JWT, or end-user JWT (write expose rule required).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `by` | integer | No | Amount to decrement by. Default `1`. Must be a whole number. |

**Response `200`**

```json
{ "value": 7 }
```

---

### POST /v1/:app_id/kv/:key/setnx

Set `key` only if it does **not** already exist ("set if not exists").

**Auth:** Function key, platform JWT, or end-user JWT (write expose rule required).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `value` | any JSON | Yes | The value to store if the key is absent. |
| `ttl` | integer or `null` | No | TTL in seconds. Same rules as PUT. |
| `ephemeral` | boolean | No | Store in the ephemeral tier. Default `false`. |

**Response**

| Code | Body | Meaning |
|------|------|---------|
| `201` | `{ "wrote": true }` | Key was absent; value was written. |
| `200` | `{ "wrote": false }` | Key already existed; no change made. |

---

### POST /v1/:app_id/kv/:key/cas

Compare-and-swap: atomically replace the value of `key` only when the current value equals `expected`.

**Auth:** Function key, platform JWT, or end-user JWT (write expose rule required).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `expected` | any JSON or `null` | Yes | The value the key must currently hold. Pass `null` to match an absent key. |
| `next` | any JSON | Yes | The new value to write on a match. |

**Response `200`**

```json
{ "swapped": true }
```

`swapped` is `true` if the swap succeeded, `false` if the current value did not match `expected`.

**Note:** A value that is itself the JSON string `"__NULL__"` cannot be distinguished from the absent-key sentinel in the CAS comparison. To use literal key names ending in an action word (e.g. `session/cas`), URL-encode the separator (`session%2Fcas`).

---

### POST /v1/:app_id/kv/:key/expire

Update (or remove) the TTL on an existing key without changing its value.

**Auth:** Function key, platform JWT, or end-user JWT (write expose rule required).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ttl` | integer or `null` | Yes | New TTL in seconds (non-negative integer), or `null` to persist the key indefinitely. |

**Response `200`**

```json
{ "applied": true }
```

`applied` is `true` when the key existed and the TTL was updated, `false` when the key did not exist.

---

### POST /v1/:app_id/kv/_batch

Execute up to 100 `get`, `set`, or `del` operations in a single round-trip.

**Auth:** Any (function key, platform JWT, or end-user JWT). Per-operation access checks against expose rules apply for JWT/anonymous callers.

**Request body**

```json
{
  "ops": [
    { "op": "get", "key": "counter/daily" },
    { "op": "set", "key": "counter/daily", "value": 0 },
    { "op": "del", "key": "temp/scratch" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ops` | array | Yes | Array of operation objects. Maximum 100 items. |
| `ops[].op` | `"get"` \| `"set"` \| `"del"` | Yes | The operation type. |
| `ops[].key` | string | Yes | The key to operate on. |
| `ops[].value` | any JSON | Required for `set` | The value to write. |

**Response `200`**

```json
{
  "results": [
    { "value": 17 },
    { "ok": true },
    { "deleted": 1 }
  ]
}
```

Results are returned in the same order as the input `ops`. Failing items carry an `error` field rather than causing the entire batch to fail:

| Result shape | Meaning |
|---|---|
| `{ "value": <v> }` | `get` succeeded (`value` is `null` if the key was absent) |
| `{ "ok": true }` | `set` succeeded |
| `{ "deleted": N }` | `del` completed (`N` is `0` or `1`) |
| `{ "error": "key_invalid" }` | Key failed validation |
| `{ "error": "KV_VALUE_TOO_LARGE" }` | Value exceeds 256 KB |
| `{ "error": "KV_FORBIDDEN" }` | Expose rule denied access for this key |
| `{ "error": "invalid op" }` | `op` is not `get`, `set`, or `del` |
| `{ "error": "missing value" }` | `set` operation missing `value` field |
| `{ "error": "redis_error", "message": "..." }` | Transient storage error |

---

### GET /v1/:app_id/kv/_scan

Scan all keys belonging to the app, with optional prefix filtering. Intended for tooling and administrative scripts.

**Auth:** Function key or platform JWT only. End-user JWTs and anonymous requests receive `403`.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `prefix` | string | Only return keys that begin with this string. |
| `limit` | integer | Maximum number of keys to return per page. |
| `cursor` | string | Opaque cursor returned by a previous scan; pass to fetch the next page. |

**Response `200`**

```json
{
  "keys": ["counter/daily", "session/user-1", "session/user-2"],
  "cursor": "eyJwYWdlIjoxfQ"
}
```

`cursor` is `null` (or absent) when there are no more pages.

---

### GET /v1/:app_id/kv/_stats

Return storage statistics for the app.

**Auth:** Function key or platform JWT only. End-user JWTs and anonymous requests receive `403`.

**Response `200`**

```json
{
  "keys_total": 4821,
  "bytes_used": 1048576,
  "ops_per_sec": null,
  "limit": {
    "max_ops_per_sec": 50,
    "max_storage_bytes": 10485760,
    "max_keys_total": 100000,
    "max_value_bytes": 262144
  }
}
```

`ops_per_sec` reflects live traffic and may be `null` when no recent ops are recorded. The `limit` block shows the caps in effect for the app's current plan tier.

---

### POST /v1/:app_id/kv/_flush

Delete all keys belonging to the app. Irreversible.

**Auth:** Function key or platform JWT only. End-user JWTs and anonymous requests receive `403`.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confirm` | `true` | Yes | Must be the boolean `true`. Omitting this field or passing any other value returns a `400 confirm_required` error. |
| `include_config` | boolean | No | When `true`, expose rules and other per-app KV configuration are also deleted. Default `false`. |

**Response `200`**

```json
{ "deleted": 4821 }
```

`deleted` is the total number of keys removed.

---

### GET /v1/:app_id/kv/_expose

List all expose rules defined for the app. Expose rules control which keys, and at what permission level, end-user JWTs and anonymous callers can access.

**Auth:** Function key or platform JWT only.

**Response `200`**

```json
{
  "rules": [
    { "pattern": "session/{user.id}/*", "read": "owner", "write": "owner", "order": 0 },
    { "pattern": "public/*",            "read": "public", "write": "deny",  "order": 1 }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pattern` | string | Glob-style key pattern. `{user.id}` and `{user.role}` are substituted from the caller's JWT claims for `owner` checks. |
| `read` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | Required level for read operations. |
| `write` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | Required level for write operations. |
| `order` | integer | Declaration order; lower numbers take priority on conflict. |

Role meanings:

| Role | Meaning |
|------|---------|
| `public` | Any caller, including anonymous requests. |
| `authed` | Any caller with a valid end-user JWT. |
| `owner` | The authenticated user whose `user.id` (or `user.role`) matches the pattern substitution. |
| `deny` | Always denied for the matched access type. |

---

### PUT /v1/:app_id/kv/_expose/:pattern

Create or update an expose rule. The `:pattern` segment must be URL-encoded (e.g. `session%2F%7Buser.id%7D%2F*`).

**Auth:** Function key or platform JWT only.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `read` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | Yes | Read permission for this pattern. |
| `write` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | Yes | Write permission for this pattern. |

**Response `204`** — Rule saved. No body.

**Response `409`**

```json
{
  "error": "KV_EXPOSE_CONFLICT",
  "message": "pattern conflicts with existing rule",
  "existing": { "pattern": "session/*", "read": "authed", "write": "deny" }
}
```

Returned when the new pattern would be ambiguous with an existing rule (same key space, overlapping permission).

**Example**

```bash
PUT /v1/app_abc123/kv/_expose/session%2F%7Buser.id%7D%2F*
Authorization: Bearer <function_key>
Content-Type: application/json

{ "read": "owner", "write": "owner" }
```

---

### DELETE /v1/:app_id/kv/_expose/:pattern

Remove an expose rule. The `:pattern` segment must be URL-encoded.

**Auth:** Function key or platform JWT only.

**Response `200`**

```json
{ "deleted": 1 }
```

`deleted` is `1` if the rule existed and was removed, `0` if no matching rule was found.

---

### GET /v1/:app_id/kv/_audit_recent

Return recent KV error events for the app (HTTP 4xx/5xx responses). Useful for debugging access-denied patterns and identifying misconfigured expose rules.

**Auth:** Any authenticated caller (function key, platform JWT, or end-user JWT). Anonymous callers receive `401`.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Number of entries to return. Default `50`, maximum `200`. |

**Response `200`**

```json
{
  "entries": [
    {
      "at": "2026-05-24T10:31:02.000Z",
      "method": "PUT",
      "path": "/v1/app_abc123/kv/session/user-42",
      "status_code": 403,
      "error_code": "forbidden",
      "key": "session/user-42"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `at` | ISO 8601 string | When the request occurred. |
| `method` | string | HTTP method. |
| `path` | string | Full request path. |
| `status_code` | integer | HTTP status returned. |
| `error_code` | string or `null` | The `error` field from the response body, if any. |
| `key` | string or `null` | The user key involved, extracted from the path (absent for `_`-prefixed admin paths). |

---

## Limits

These are the default limits applied to every new app. Higher caps are available on paid plans.

| Limit | Default |
|-------|---------|
| Max operations per second | 50 ops/sec |
| Max total storage | 10 MB per app |
| Max total keys | 100,000 keys |
| Max value size | 256 KB per key |
| Max batch size | 100 ops per `_batch` request |
| Default TTL (no `ttl` supplied on PUT) | 30 days |

When a limit is exceeded the response carries the corresponding error code (see [Error codes](#error-codes) below).

---

## Error codes

All error responses use the shape `{ "error": "<code>", "message": "<human-readable description>" }`.

| Code | HTTP status | Meaning | How to handle |
|------|-------------|---------|---------------|
| `auth_failed` | 401 / 403 / 404 | Authentication could not be completed. Emitted as a wrapper; the `error` field in the body will be one of the more specific codes below. | Check the specific nested error code. |
| `bad_request` | 400 | A required field is missing or has an invalid type (e.g. `ttl` is not a positive integer, `by` is not a whole number, `read`/`write` role is unrecognised, `ops` is not an array, batch exceeds 100 items). | Fix the request body or query parameters. |
| `confirm_required` | 400 | `POST _flush` was called without `{ "confirm": true }`. | Add `"confirm": true` to the request body. |
| `forbidden` | 403 | The caller is authenticated but does not have permission for this operation — either no expose rule matches, the matching rule's role is `deny`, or the operation requires a function/platform key (e.g. `_scan`, `_stats`, `_flush`, `_expose` writes). | Check expose rules (`GET _expose`). Upgrade to a function key for admin operations. |
| `invalid_key` | 400 | The key portion of the URL is empty (no key segment provided). | Provide a non-empty key after `/kv/`. |
| `invalid_jwt` | 401 | The `Authorization` header contains a three-segment token that failed signature verification. | Re-issue a fresh user session token. |
| `key_invalid` | 400 | The key string contains characters or patterns not permitted by the key format rules. | Use printable ASCII; avoid control characters and reserved prefixes. |
| `KV_EXPOSE_CONFLICT` | 409 | `PUT _expose/:pattern` was rejected because the new pattern overlaps ambiguously with an existing rule. The response body includes an `existing` field showing the conflicting rule. | Update the conflicting rule first, or choose a non-overlapping pattern. |
| `KV_FORBIDDEN` | — (batch item error) | A single operation inside a `_batch` request was denied by an expose rule. The batch itself still returns `200`; this code appears only inside `results[].error`. | Check expose rules for the affected key. |
| `KV_VALUE_TOO_LARGE` | 413 (or batch item error) | The serialised value exceeds the 256 KB per-key limit. | Reduce the value size, or split data across multiple keys. |
| `no_kv_credential` | 404 | KV is not provisioned for this app, or the app does not exist. | Ensure the app is initialised and KV is enabled. |
| `not_found` | 404 | The requested key does not exist. | Check for typos in the key name or verify the key was written first. |
| `redis_error` | — (batch item error) | A transient storage error occurred during a batch operation. The item failed but other items in the batch may have succeeded. | Retry the failed operation individually. |
| `unauthorized` | 401 | The request requires authentication (an expose rule requires at least `authed` or `owner`), but no valid credential was supplied. | Sign the user in and attach the resulting JWT. |
