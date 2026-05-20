---
name: build-app
description: Use when building a new Butterbase app from scratch, creating a full-stack application, or when the user asks to set up a complete backend with database, auth, and deployment
---

# Build a Complete Butterbase App

This skill walks through all seven phases of building a production-ready Butterbase application — from provisioning a backend to deploying a live frontend. Follow each phase in order; later phases depend on artifacts (app_id, schema, RLS policies) produced by earlier ones.

---

## Phase 1: Create the App

Use `init_app` to provision an isolated backend with its own database and auto-generated REST API.

**Tool:** `init_app`

```json
{
  "name": "my-blog"
}
```

**Returns:**
```json
{
  "app_id": "app_abc123",
  "api_base": "https://api.butterbase.ai/v1/app_abc123"
}
```

**Important:** Save `app_id` and `api_base` — every subsequent tool call requires `app_id`.

### Optional: Generate a Service API Key

If the user needs programmatic access (CI/CD pipelines, server-to-server calls, admin scripts), generate a service key now.

**Tool:** `manage_auth_config` (action: "generate_service_key")

```json
{
  "action": "generate_service_key",
  "name": "Production Deploy Key"
}
```

> ⚠️ The full key (`bb_sk_...`) is shown **only once**. Store it securely — it cannot be retrieved again.

---

## Phase 2: Design & Apply Schema

Work with the user to understand their data model before writing any SQL. Ask:

- What are the primary entities (users, posts, products, orders)?
- Which tables are user-owned vs. shared/public?
- What relationships exist between tables (foreign keys)?
- Are there any boolean flags for public visibility (e.g. `published`, `is_public`)?

### Preview First with dry_run_schema

Always preview schema changes before applying them.

**Tool:** `dry_run_schema`

```json
{
  "app_id": "app_abc123",
  "schema": {
    "tables": {
      "posts": {
        "columns": {
          "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
          "author_id": { "type": "uuid", "nullable": false },
          "title": { "type": "text", "nullable": false }
        }
      }
    }
  }
}
```

Review the generated SQL — make sure it matches intent before applying.

### Apply the Schema

**Tool:** `apply_schema`

Below is a complete example for a **blog app** with posts and comments:

```json
{
  "app_id": "app_abc123",
  "schema": {
    "tables": {
      "posts": {
        "columns": {
          "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
          "author_id": { "type": "uuid", "nullable": false },
          "title": { "type": "text", "nullable": false },
          "body": { "type": "text" },
          "published": { "type": "boolean", "default": "false" },
          "created_at": { "type": "timestamptz", "default": "now()" }
        }
      },
      "comments": {
        "columns": {
          "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
          "post_id": { "type": "uuid", "nullable": false, "references": "posts.id" },
          "author_id": { "type": "uuid", "nullable": false },
          "body": { "type": "text", "nullable": false },
          "created_at": { "type": "timestamptz", "default": "now()" }
        }
      }
    }
  }
}
```

### Verify the Schema Was Applied

**Tool:** `get_schema`

```json
{
  "app_id": "app_abc123"
}
```

Confirm every table and column is present before moving to Phase 3.

### Schema Tips

- Always include `id` as UUID with `gen_random_uuid()` default
- Always include `created_at` with `now()` default
- Use `author_id` / `user_id` UUID columns on user-owned tables — RLS will reference these
- Use `references: "table.column"` for foreign keys (cascades must be set carefully)
- `apply_schema` is idempotent — safe to call again if schema is unchanged

---

## Phase 3: Secure Data with RLS

Row-Level Security (RLS) ensures users can only access their own data. This phase is **not optional** for any table that holds user-generated content.

### Enable User Isolation

Call `create_user_isolation_policy` for each user-owned table. This single call:
1. Enables RLS on the table
2. Creates a policy so users only see their own rows
3. Installs a BEFORE INSERT trigger to auto-populate the user column
4. Creates a service bypass policy for admin access

**Tool:** `create_user_isolation_policy`

```json
{
  "app_id": "app_abc123",
  "table_name": "posts",
  "user_column": "author_id"
}
```

### Allow Public Reads (Optional)

For tables where some rows should be publicly visible (e.g. published blog posts), add `public_read_column`. This creates extra SELECT policies for both authenticated and anonymous users.

```json
{
  "app_id": "app_abc123",
  "table_name": "posts",
  "user_column": "author_id",
  "public_read_column": "published"
}
```

Repeat for every user-owned table. For the blog example:

```json
{
  "app_id": "app_abc123",
  "table_name": "comments",
  "user_column": "author_id"
}
```

### Test RLS Isolation

After applying policies, verify they work correctly by simulating user requests.

**Test SELECT as a specific user** — should only see that user's rows:

**Tool:** `select_rows`

```json
{
  "app_id": "app_abc123",
  "table": "posts",
  "as_role": "user",
  "as_user": "11111111-1111-1111-1111-111111111111"
}
```

**Test SELECT as anonymous** — should only see published/public rows (or nothing if no public policy):

```json
{
  "app_id": "app_abc123",
  "table": "posts",
  "as_role": "anon"
}
```

**Test INSERT as a specific user** — `author_id` should be auto-populated by the trigger (do not include it in `data`):

**Tool:** `insert_row`

```json
{
  "app_id": "app_abc123",
  "table": "posts",
  "data": {
    "title": "My First Post",
    "body": "Hello world!",
    "published": false
  },
  "as_role": "user",
  "as_user": "11111111-1111-1111-1111-111111111111"
}
```

Confirm the returned row has `author_id` set to `11111111-1111-1111-1111-111111111111` automatically.

### Verify All Policies

**Tool:** `get_rls_policies`

```json
{
  "app_id": "app_abc123"
}
```

Review the policy list and confirm every user-data table has at least one policy.

---

## Phase 4: Authentication

Butterbase uses OAuth 2.0 for end-user authentication. Users sign in via a provider (Google, GitHub, Discord, etc.) and receive a JWT to authenticate subsequent API calls.

### Configure an OAuth Provider

Built-in providers (google, github, discord, facebook, linkedin, microsoft, apple, x) only require three fields — URLs and scopes are auto-filled.

**Tool:** `configure_oauth_provider`

**Google example:**
```json
{
  "app_id": "app_abc123",
  "provider": "google",
  "client_id": "123456789.apps.googleusercontent.com",
  "client_secret": "GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx",
  "redirect_uris": ["https://api.butterbase.ai/auth/app_abc123/oauth/google/callback"]
}
```

**GitHub example:**
```json
{
  "app_id": "app_abc123",
  "provider": "github",
  "client_id": "Iv1.xxxxxxxxxxxxxxxx",
  "client_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "redirect_uris": ["https://api.butterbase.ai/auth/app_abc123/oauth/github/callback"]
}
```

**Redirect URI format:**
```
https://api.butterbase.ai/auth/{app_id}/oauth/{provider}/callback
```

Replace `{app_id}` and `{provider}` with real values. Register this exact URI in the OAuth provider's developer console.

### Setup Steps (per provider)

1. Go to the provider's developer console (Google Cloud Console, GitHub Settings → Developer applications, etc.)
2. Create a new OAuth app / client
3. Set the redirect URI to the Butterbase callback URL above
4. Copy the `client_id` and `client_secret`
5. Call `configure_oauth_provider` with those credentials

### Frontend Authentication Flow

Install the Butterbase SDK in the frontend:

```bash
npm install @butterbase/sdk
```

Initialize the client and trigger OAuth sign-in:

```typescript
import { createClient } from '@butterbase/sdk'

const client = createClient({
  appId: 'app_abc123',
  apiBase: 'https://api.butterbase.ai/v1/app_abc123'
})

// Initiate OAuth sign-in (redirects to provider)
await client.auth.signInWithOAuth({ provider: 'google' })

// After redirect back, get the current session
const { user, accessToken } = await client.auth.getSession()

// Use the access token in API calls — the SDK handles this automatically
const posts = await client.from('posts').select('*')
```

### Adjust JWT Token Lifetimes (Optional)

**Tool:** `manage_auth_config` (action: "update_jwt")

```json
{
  "action": "update_jwt",
  "app_id": "app_abc123",
  "accessTokenTtl": "15m",
  "refreshTokenTtlDays": 30
}
```

Short access tokens (15m) with longer refresh tokens (30 days) balance security and user experience.

---

## Phase 5: Backend Logic (Optional)

Deploy serverless functions for business logic that cannot run in the browser: sending emails, processing payments, calling third-party APIs with secrets, scheduled jobs, and more.

### Deploy a Function

**Tool:** `deploy_function`

**Critical rules:**
- Handler **must** be exported as `export async function handler`
- Handler **must** return a `new Response()` object — **never** return a plain object
- Context provides `db` (Postgres), `env` (encrypted env vars), `user` (authenticated user or null)

**HTTP function example:**
```json
{
  "app_id": "app_abc123",
  "name": "create-post",
  "description": "Create a new blog post and notify subscribers",
  "trigger": {
    "type": "http",
    "config": {
      "method": "POST",
      "path": "/create-post",
      "auth": "required"
    }
  },
  "code": "export async function handler(request, ctx) {\n  const { title, body } = await request.json();\n  if (!title) {\n    return new Response(JSON.stringify({ error: 'title is required' }), {\n      status: 400,\n      headers: { 'Content-Type': 'application/json' }\n    });\n  }\n  const result = await ctx.db.query(\n    'INSERT INTO posts (title, body, author_id) VALUES ($1, $2, $3) RETURNING *',\n    [title, body, ctx.user.id]\n  );\n  return new Response(JSON.stringify(result.rows[0]), {\n    status: 201,\n    headers: { 'Content-Type': 'application/json' }\n  });\n}"
}
```

**Cron function example** (runs daily at 9 AM UTC):
```json
{
  "app_id": "app_abc123",
  "name": "daily-digest",
  "description": "Send a daily digest email to subscribers",
  "trigger": {
    "type": "cron",
    "config": {
      "schedule": "0 9 * * *",
      "timezone": "UTC"
    }
  },
  "code": "export async function handler(request, ctx) {\n  const result = await ctx.db.query(\n    'SELECT * FROM posts WHERE created_at > NOW() - INTERVAL \\'24 hours\\''\n  );\n  // send digest email with result.rows...\n  return new Response(JSON.stringify({ sent: result.rows.length }), {\n    status: 200,\n    headers: { 'Content-Type': 'application/json' }\n  });\n}"
}
```

### Pass Secrets via Environment Variables

Never hardcode API keys. Pass them as `envVars`:

```json
{
  "app_id": "app_abc123",
  "name": "send-email",
  "envVars": {
    "SENDGRID_API_KEY": "SG.xxxxxxxxxxxxxxxx",
    "FROM_EMAIL": "noreply@example.com"
  },
  "trigger": { "type": "http", "config": { "method": "POST", "auth": "required" } },
  "code": "export async function handler(request, ctx) {\n  const apiKey = ctx.env.SENDGRID_API_KEY;\n  // use apiKey...\n  return new Response('ok', { status: 200 });\n}"
}
```

To rotate secrets without redeploying code, use `manage_function` (action: "update_env").

### Test a Function

**Tool:** `invoke_function`

```json
{
  "app_id": "app_abc123",
  "function_name": "create-post",
  "method": "POST",
  "body": {
    "title": "Hello World",
    "body": "This is a test post."
  }
}
```

### Debug with Logs

If a function returns an unexpected response or error, check logs immediately.

**Tool:** `manage_function` (action: "get_logs")

```json
{
  "action": "get_logs",
  "app_id": "app_abc123",
  "function_name": "create-post",
  "level": "error",
  "limit": 20
}
```

Logs include stack traces, duration, memory used, and status codes. Logs are retained for 7 days.

### RLS Behavior in Functions

| Invoked with | Role assigned | RLS enforced? |
|---|---|---|
| End-user JWT | `butterbase_user` | Yes — sees only user's data |
| Platform API key | `butterbase_service` | No — sees all data |
| Cron trigger | `butterbase_service` | No — sees all data |

---

## Phase 6: Deploy Frontend

Deploy the frontend as a static site. Butterbase hosts it on a CDN with SPA routing support.

### Step 1: Configure CORS

Allow the frontend domain to call the API.

**Tool:** `manage_app` (action: "update_cors")

```json
{
  "action": "update_cors",
  "app_id": "app_abc123",
  "allowed_origins": [
    "http://localhost:3000",
    "https://my-app.pages.dev"
  ]
}
```

Add both local dev and production URLs. Update again after you know the final deployment URL.

### Step 2: Set Frontend Environment Variables

**Tool:** `manage_frontend` (action: "set_env")

```json
{
  "action": "set_env",
  "app_id": "app_abc123",
  "vars": {
    "VITE_API_BASE": "https://api.butterbase.ai/v1/app_abc123",
    "VITE_APP_ID": "app_abc123"
  }
}
```

Prefix variables for your framework:
- Vite: `VITE_`
- Next.js: `NEXT_PUBLIC_`
- Create React App: `REACT_APP_`

### Step 3: Build the Frontend

```bash
npm run build
```

This produces a `dist/` (Vite) or `out/` (Next.js static) folder.

### Step 4: Create Deployment & Get Upload URL

**Tool:** `create_frontend_deployment`

```json
{
  "app_id": "app_abc123",
  "framework": "react-vite"
}
```

**Returns:**
```json
{
  "deployment_id": "dep_xyz789",
  "uploadUrl": "https://s3.amazonaws.com/...",
  "expiresIn": 900
}
```

Save `deployment_id` and `uploadUrl`.

### Step 5: Zip and Upload

> ⚠️ **Windows warning:** Use Git Bash or WSL to create the zip. Windows built-in zip uses backslashes, which breaks MIME types and causes JS/CSS to be served as `text/html`.

```bash
# From the project root — use Git Bash on Windows
cd dist && zip -r ../frontend.zip . && cd ..
```

Upload the zip:

```bash
curl -X PUT "https://s3.amazonaws.com/..." \
  -H "Content-Type: application/zip" \
  --data-binary @frontend.zip
```

Replace the URL with the `uploadUrl` returned in the previous step.

### Step 6: Start the Deployment

**Tool:** `manage_frontend` (action: "start_deployment")

```json
{
  "action": "start_deployment",
  "app_id": "app_abc123",
  "deployment_id": "dep_xyz789"
}
```

This polls until the deployment reaches `READY` status (up to 5 minutes) and returns the live URL.

```json
{
  "deployment_id": "dep_xyz789",
  "url": "https://my-app.pages.dev",
  "status": "READY"
}
```

Visit the URL to verify the frontend is live.

### Step 7: Update CORS with Final URL

Once you have the live deployment URL, add it to CORS if it wasn't already included:

```json
{
  "app_id": "app_abc123",
  "allowed_origins": [
    "http://localhost:3000",
    "https://my-app.pages.dev"
  ]
}
```

### Framework Reference

| Framework | Build command | Zip folder | `framework` param |
|---|---|---|---|
| React + Vite | `npm run build` | `dist/` | `react-vite` |
| Next.js (static) | `next build && next export` | `out/` | `nextjs-static` |
| Plain HTML/CSS/JS | n/a | root | `static` |
| Other | varies | build output | `other` |

---

## Phase 7: Production Checklist

Before announcing the app as production-ready, verify each item:

- [ ] **1. CORS configured for production domain** — `manage_app` (action: "update_cors") includes the live frontend URL (not just localhost)
- [ ] **2. RLS enabled on all user-data tables** — `get_rls_policies` shows policies for every table holding user-generated content; no table is accidentally wide-open
- [ ] **3. OAuth redirect URIs point to production** — Provider developer consoles have the Butterbase callback URL registered; no localhost URIs are the only option in production
- [ ] **4. Frontend env vars set for production API URL** — `VITE_API_BASE` (or equivalent) points to `https://api.butterbase.ai/v1/{app_id}`, not a localhost URL
- [ ] **5. Error handling in all functions** — Every `deploy_function` handler returns appropriate HTTP status codes (400 for bad input, 401 for auth failures, 500 for unexpected errors) rather than throwing unhandled exceptions
- [ ] **6. JWT config reviewed** — `manage_auth_config` (action: "update_jwt") has been called with intentional token lifetimes; access token TTL is appropriate for the security sensitivity of the app (default 15m is reasonable)
- [ ] **7. Storage quotas checked** — `get_storage_objects` and app config reviewed; storage usage is within plan limits and `allowedContentTypes` are restricted to what the app actually needs
- [ ] **8. Functions tested with invoke_function** — Every HTTP function has been invoked with realistic payloads and edge cases (missing fields, invalid auth, large inputs) and returned correct responses
- [ ] **9. Frontend deployed and verified** — `manage_frontend` (action: "list_deployments") shows a `READY` deployment; the live URL loads correctly in a browser and all API calls succeed
- [ ] **10. Monitoring and audit logs reviewed** — `query_audit_logs` shows no unexpected login failures or suspicious activity; `manage_function` (action: "get_logs") shows no recurring errors in production traffic

---

## Quick Reference: Tool → Phase Mapping

| Phase | Tools Used |
|---|---|
| 1 — Create App | `init_app`, `manage_auth_config` (action: "generate_service_key") |
| 2 — Schema | `dry_run_schema`, `apply_schema`, `get_schema` |
| 3 — RLS | `create_user_isolation_policy`, `create_policy`, `enable_rls`, `get_rls_policies`, `select_rows`, `insert_row` |
| 4 — Auth | `configure_oauth_provider`, `manage_auth_config` (action: "update_jwt") |
| 5 — Functions | `deploy_function`, `manage_function` (action: "update_env"), `invoke_function`, `manage_function` (action: "get_logs") |
| 6 — Frontend | `manage_app` (action: "update_cors"), `manage_frontend` (action: "set_env"), `create_frontend_deployment`, `manage_frontend` (action: "start_deployment"), `manage_frontend` (action: "list_deployments") |
| 7 — Production | `get_rls_policies`, `query_audit_logs`, `manage_function` (action: "get_logs"), `get_storage_objects` |

---

## Common Mistakes to Avoid

**Schema**
- Do not drop and recreate tables to rename a column — use `apply_schema` with the new column name and migrate data separately
- Do not skip `dry_run_schema` — always preview before applying

**RLS**
- Do not forget to call `create_user_isolation_policy` — a table without RLS is readable by all authenticated users
- Do not include `author_id` / `user_id` in INSERT bodies when a trigger is installed — it will be set automatically

**Functions**
- Do not return plain objects from handlers (`return { status: 200 }`) — always `return new Response(...)`
- Do not hardcode secrets in function code — use `envVars` and access via `ctx.env`

**Frontend**
- Do not create zips on Windows with the built-in tool — use Git Bash or WSL
- Do not forget to update CORS after deploying to the final URL

**Auth**
- Do not register `localhost` redirect URIs in the production OAuth app — keep dev and prod OAuth apps separate, or add both URIs to the same app
