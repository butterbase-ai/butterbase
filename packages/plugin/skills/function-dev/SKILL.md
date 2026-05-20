---
name: function-dev
description: Use when developing, deploying, or debugging Butterbase serverless functions, or when the user needs to add backend logic like webhooks, scheduled jobs, or custom API endpoints
---

# Serverless Function Development on Butterbase

Guide for developing and deploying serverless functions on Butterbase's Deno runtime. Covers handler signatures, trigger types, database access, environment variables, and testing.

---

## 1. Handler Signature

Every function exports a single `handler` function with this signature:

```typescript
export async function handler(
  request: Request,
  context: {
    db: PostgresClient,    // Query your app database
    env: Record<string, string>,  // Access environment variables
    user: { id: string } | null   // Current user (if auth: required)
  }
): Promise<Response>
```

**CRITICAL**: The handler MUST return `new Response()` (Web API standard). Do NOT return plain objects.

**Correct:**
```typescript
return new Response(JSON.stringify({ message: "ok" }), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});
```

**Wrong (will fail):**
```typescript
return { status: 200, body: "ok" };  // NOT a Response object!
```

---

## 2. Trigger Types

### HTTP Trigger

Invoke the function via an HTTP request.

```json
{
  "trigger": {
    "type": "http",
    "config": { "method": "POST", "path": "/my-endpoint", "auth": "required" }
  }
}
```

**Auth options:**
- `"required"` — request must include a valid JWT; `ctx.user` is always set
- `"optional"` — JWT is parsed if present; `ctx.user` may be `null`
- `"none"` — public endpoint; no auth needed; `ctx.user` is always `null`

---

### Cron Trigger

Execute the function on a schedule.

```json
{
  "trigger": {
    "type": "cron",
    "config": { "schedule": "0 9 * * *", "timezone": "UTC" }
  }
}
```

Uses standard 5-field cron expressions:
- `"*/5 * * * *"` — every 5 minutes
- `"0 0 * * 0"` — weekly, Sunday at midnight
- `"0 3 * * *"` — daily at 3am UTC
- `"0 9 * * 1-5"` — weekdays at 9am

Cron functions run as `butterbase_service` (RLS bypassed). `ctx.user` is always `null`.

---

### WebSocket Trigger

Fire when a connected client sends a matching event over the realtime WebSocket.

```json
{
  "trigger": {
    "type": "websocket",
    "config": { "event": "chat-message" }
  }
}
```

Fires when client sends matching event via realtime WebSocket connection. The `request` body contains the event payload sent by the client.

---

### S3 Upload Trigger _(placeholder — not yet implemented)_

```json
{
  "trigger": {
    "type": "s3_upload",
    "config": { "prefix": "uploads/", "contentTypes": ["image/*"] }
  }
}
```

---

## 3. Database Access

Use `ctx.db.query(sql, params)` for all database queries. Always use parameterized queries to prevent SQL injection — NEVER use string interpolation.

```typescript
// Always use $1, $2 placeholders — never string interpolation
const { rows } = await ctx.db.query(
  'SELECT * FROM posts WHERE author_id = $1',
  [ctx.user.id]  // params array
);
```

### SELECT

```typescript
const { rows } = await ctx.db.query(
  'SELECT * FROM posts WHERE author_id = $1 AND published = true',
  [ctx.user.id]
);
```

### INSERT

```typescript
await ctx.db.query(
  'INSERT INTO logs (event, user_id) VALUES ($1, $2)',
  ['page_view', ctx.user.id]
);
```

### UPDATE

```typescript
await ctx.db.query(
  'UPDATE posts SET title = $1, updated_at = now() WHERE id = $2 AND author_id = $3',
  [newTitle, postId, ctx.user.id]
);
```

### RLS Behavior by Invocation Type

| Invocation | Role | RLS |
|------------|------|-----|
| End-user JWT | `butterbase_user` | Enforced — `ctx.db` queries filtered by policies |
| API key (`bb_sk_`) | `butterbase_service` | Bypassed — sees all data |
| Cron trigger | `butterbase_service` | Bypassed — sees all data |

---

## 4. Environment Variables

- **Set at deploy time**: pass `envVars` parameter to `deploy_function`
- **Update without redeploying**: use `manage_function` (action: "update_env")
- **Merge behavior**: `manage_function` (action: "update_env") merges new values with existing env vars. Set a value to `null` to delete a key. Existing keys not included in the update are preserved.
- **Access in handler**: `ctx.env.VARIABLE_NAME`
- **Encrypted at rest**: values are never exposed in logs or API responses

Common uses: API keys, webhook secrets, external service URLs.

```typescript
const apiKey = ctx.env.OPENAI_API_KEY;
const webhookSecret = ctx.env.WEBHOOK_SECRET;
const serviceUrl = ctx.env.EXTERNAL_SERVICE_URL;
```

---

## 5. Complete Working Examples

### Example 1 — Protected API Endpoint (auth: required)

Returns the authenticated user's posts.

```typescript
export async function handler(req, ctx) {
  const { rows } = await ctx.db.query(
    'SELECT id, title, created_at FROM posts WHERE author_id = $1 ORDER BY created_at DESC',
    [ctx.user.id]
  );
  return new Response(JSON.stringify(rows), {
    headers: { "Content-Type": "application/json" }
  });
}
```

Deploy:
```
deploy_function(
  app_id,
  name: "my-posts",
  code: ...,
  trigger: {
    type: "http",
    config: { method: "GET", path: "/my-posts", auth: "required" }
  }
)
```

---

### Example 2 — Webhook Receiver (auth: none)

Accepts an incoming webhook, validates the signature, and stores the event.

```typescript
export async function handler(req, ctx) {
  const body = await req.json();
  const signature = req.headers.get("x-webhook-signature");
  // Validate signature against ctx.env.WEBHOOK_SECRET
  await ctx.db.query(
    'INSERT INTO webhook_events (event_type, payload) VALUES ($1, $2)',
    [body.type, JSON.stringify(body)]
  );
  return new Response("ok", { status: 200 });
}
```

Deploy with: `trigger: { type: "http", config: { method: "POST", path: "/webhook", auth: "none" } }`

---

### Example 3 — Cron Cleanup Job

Deletes expired sessions on a nightly schedule.

```typescript
export async function handler(req, ctx) {
  const result = await ctx.db.query(
    "DELETE FROM sessions WHERE expires_at < now() RETURNING id"
  );
  return new Response(JSON.stringify({ deleted: result.rowCount }), {
    headers: { "Content-Type": "application/json" }
  });
}
```

Deploy with: `trigger: { type: "cron", config: { schedule: "0 3 * * *" } }`

---

### Example 4 — External API Call

Proxies a request to an external AI service using a stored API key.

```typescript
export async function handler(req, ctx) {
  const { prompt } = await req.json();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ctx.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
}
```

Deploy with `envVars: { OPENAI_API_KEY: "sk-..." }` and `trigger: { type: "http", config: { method: "POST", auth: "required" } }`

---

### Example 5 — Error Handling Pattern

Always wrap handler logic in try/catch and return a proper error Response.

```typescript
export async function handler(req, ctx) {
  try {
    const { id } = await req.json();
    const { rows } = await ctx.db.query(
      'SELECT * FROM items WHERE id = $1',
      [id]
    );
    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify(rows[0]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
```

---

## 6. Testing & Debugging

### Invoke a Function

```
invoke_function(app_id, function_name, method: "POST", body: { key: "value" })
```

Returns the full HTTP response including status, headers, and body. Use this immediately after deploying to verify behavior.

### View Error Logs

```
manage_function(app_id, function_name, action: "get_logs", level: "error")
```

Returns recent invocations that resulted in errors, with stack traces.

### View All Logs

```
manage_function(app_id, function_name, action: "get_logs")
```

Returns all recent invocations with timestamps, status codes, and durations.

### Console Output in Logs

`console.log()`, `console.info()`, `console.warn()`, `console.error()`, and `console.debug()` calls inside your handler are captured and returned in the `consoleLogs` field of each log entry. Each entry contains `{ level, message, timestamp }`. Max 100 entries per invocation, 10KB per message.

### View Metrics

```
manage_function(app_id, action: "list")
```

Shows per-function metrics: invocation count, error rate, average duration.

---

## 7. Common Mistakes

| Mistake | Fix |
|---------|-----|
| Returning plain object instead of `Response` | Always use `new Response(JSON.stringify(data), { headers: {...} })` |
| SQL injection via string interpolation | Use parameterized queries: `$1, $2` placeholders |
| Not wrapping in try/catch | Always catch errors and return a Response with error status |
| Forgetting `async` on handler | Handler must be `async function handler(...)` |
| Exceeding timeout (30s default) | Increase `timeoutMs` in `deploy_function` or optimize the function |
| Not setting Content-Type header | Always include `"Content-Type": "application/json"` for JSON responses |

---

## 8. Quick Reference

### Deploy a Function

```
deploy_function(
  app_id: "app_abc123",
  name: "my-function",
  code: "export async function handler(req, ctx) { ... }",
  trigger: { type: "http", config: { method: "POST", auth: "required" } },
  envVars: { MY_SECRET: "value" },
  timeoutMs: 30000,       // default: 30s, max: 300s
  memoryLimitMb: 128      // default: 128MB
)
```

### Update Env Vars (without redeploying)

```
manage_function(app_id, function_name, action: "update_env", envVars: { MY_SECRET: "new-value" })
```

### Delete a Function

```
manage_function(app_id, function_name, action: "delete")
```

### Invocation URL Pattern

```
https://api.butterbase.ai/v1/{app_id}/fn/{function-name}
```

For HTTP triggers, this is the URL clients call directly.
