/**
 * User-facing documentation only — product behavior and public surfaces,
 * not internal implementation.
 */

export const DOC_TOPICS = [
  'all',
  'overview',
  'mcp',
  'rest',
  'auth',
  'storage',
  'functions',
  'frontend',
  'ai',
  'meetings',
  'billing',
  'platform',
  'regions',
  'schema',
  'sdk',
  'cli',
  'realtime',
  'rag',
  'integrations',
  'substrate',
] as const;

export type DocTopic = (typeof DOC_TOPICS)[number];

const SECTIONS: Record<Exclude<DocTopic, 'all'>, string> = {
  overview: `## Butterbase

Butterbase is a backend platform built for developers who build products with AI assistants. You describe what you need in natural language; your assistant can provision apps, evolve your database schema safely, configure sign-in for your end users, manage file storage, deploy serverless functions, and expose data through automatic HTTP APIs.

### What you get

- **Apps** — Each project is an isolated backend with its own database, identifier, and API base URL. Creating an app gives you everything your client code needs to get started.
- **Regions** — Choose where your app's data and compute live. Move between regions as your audience grows. One API URL works from anywhere.
- **Declarative schema** — You describe tables and columns in a JSON format; the platform diffs your desired state against the current database and applies only the necessary changes. You can preview changes before they run.
- **Automatic data API** — Once tables exist, full CRUD operations are available over HTTP with filtering, sorting, and pagination. No code generation or manual route setup required.
- **Sign-in for your users** — Email/password registration, login, email verification, password reset, and social sign-in (OAuth with any provider) can be configured per app.
- **Per-user data rules (RLS)** — You can restrict rows so each signed-in user only accesses their own data. One tool call to enable on any table.
- **File storage** — Upload and download files through presigned URLs. Files are organized per-app and per-user with configurable size limits and content-type restrictions.
- **Serverless functions** — Deploy TypeScript/JavaScript functions that run on demand (HTTP triggers) or on a schedule (cron). Functions can access your app's database, use environment variables, and return custom responses.
- **Frontend deployment** — Deploy static frontends (React, Next.js, plain HTML) to a live URL with a single tool call. Global delivery and HTTPS included.
- **AI model gateway** — Call large language models (Claude, GPT-4, Llama, and more) through an OpenAI-compatible API. Bring your own key or use the platform's shared key with usage tracking.
- **Billing & usage tracking** — Free, Pro, and Enterprise plans with usage-based metering for AI credits, storage, function invocations, and bandwidth.
- **Monetize your app** — Optional Stripe Connect flows so your end users can subscribe to plans you define (separate from your own Butterbase subscription).
- **Audit logs** — All authentication events are logged and queryable for security monitoring.
- **App configuration** — CORS origins, JWT token lifetimes, and storage quotas are all configurable per app.

### Typical workflow

1. Create an app and note its \`app_id\` and API base URL.
2. Define your schema (tables, columns, types, constraints).
3. Preview with dry-run, then apply your schema.
4. Set row-level rules on tables that store user-owned data.
5. Configure how your end users sign in (email/password and/or OAuth providers).
6. Optionally configure CORS origins for your frontend domain.
7. Optionally deploy serverless functions for custom backend logic.
8. Optionally add AI capabilities using the model gateway.
9. Deploy your frontend for a live URL, or call the data API from your own frontend.
10. Monitor usage through the billing dashboard.
`,

  mcp: `## Model Context Protocol (MCP)

Your AI assistant connects to Butterbase through MCP. That connection lets the assistant manage your entire backend — creating apps, evolving schemas, configuring authentication, managing storage, deploying functions, and more — using structured tools instead of manual work.

### App Management

| Tool | What it does |
|------|--------------|
| **init_app** | Create a new backend app. You supply a name (and optionally a region); you receive the app id and API base URL. |
| **list_regions** | List the regions an app can be created or moved to. Reads the live set, so it stays accurate as regions are added. |
| **manage_app** (action: "move") | Move an existing app to another region. Pass \`dest_region\`; returns a \`migration_id\`. The app stays available for reads during the move. |
| **manage_app** (action: "move_status") | Check the progress of a move in flight. Pass \`migration_id\` (returned by action: "move"). |
| **manage_app** (action: "teardown_source_replica") | After a completed move, decommission the retained source-region replica. Pass \`migration_id\`. |
| **manage_app** (action: "list") | List all apps you have access to with their metadata. |
| **manage_app** (action: "delete") | Permanently delete an app and its database. This is irreversible. |
| **manage_app** (action: "get_config") | Read an app's current configuration (CORS origins, JWT settings, storage limits). |
| **manage_app** (action: "update_cors") | Set the list of allowed origins for browser requests to your app's API. |
| **manage_auth_config** (action: "update_jwt") | Configure access token lifetime and refresh token lifetime for your app's end-user auth. |
| **manage_auth_config** (action: "generate_service_key") | Generate a platform API key for programmatic access. Returns a \`bb_sk_\` prefixed key that can be used to authenticate with the Control API and MCP tools. The key is shown only once at creation. |

### Schema & Migrations

| Tool | What it does |
|------|--------------|
| **manage_schema** | All schema operations in one tool (action: "get" \| "apply" \| "dry_run" \| "list_migrations"). Read schema, apply declarative changes, preview SQL without executing, and audit migration history. |

### Data Operations

| Tool | What it does |
|------|--------------|
| **select_rows** | Query table rows directly via MCP. Supports filtering, sorting, pagination, and column selection. Alternative to calling the REST API when working within MCP context. |
| **insert_row** | Insert a row into a table via MCP. Provide the table name and column values. Alternative to calling the REST API when working within MCP context. |

### Authentication & Security

| Tool | What it does |
|------|--------------|
| **manage_oauth** | Configure, get, update, and delete OAuth providers (action: "configure" \| "get" \| "update" \| "delete"). Built-in support for google, github, discord, facebook, linkedin, microsoft, apple, and x — only client_id, client_secret, and redirect_uris required. Custom providers need full URLs. |
| **manage_rls** | All RLS operations in one tool (action: "enable" \| "create_policy" \| "update_policy" \| "create_user_isolation" \| "list" \| "delete"). Enable RLS on tables, write custom policies, one-shot user isolation setup, list/delete policies. |
| **query_audit_logs** | Search authentication audit logs (logins, signups, password resets, etc.) with optional filters. |

### Storage

| Tool | What it does |
|------|--------------|
| **manage_storage** | All storage operations in one tool (action: "upload_url" \| "download_url" \| "list" \| "delete" \| "update_config"). Generate presigned upload/download URLs, list/delete objects, and toggle app-wide public read access. |

### Serverless Functions

| Tool | What it does |
|------|--------------|
| **deploy_function** | Deploy a TypeScript/JavaScript function. You provide the code, a name, optional environment variables, and a trigger type (HTTP or cron schedule). The function runs in an isolated environment with database access. |
| **manage_function** (action: "list") | List all deployed functions for an app with their status and metrics. |
| **invoke_function** | Test-invoke a deployed function and see its response. |
| **manage_function** (action: "delete") | Delete a deployed function. Removes the function code and stops it from being invoked. |
| **manage_function** (action: "update_env") | Update environment variables for a deployed function without redeploying the code. Merges with existing vars (does not replace). Set a value to null to delete a key. |
| **manage_function** (action: "get_logs") | View recent invocation logs for a function, including status codes, duration, and any errors. |

### Frontend Deployment

| Tool | What it does |
|------|--------------|
| **create_frontend_deployment** | Create a deployment and get an upload URL. Upload your built frontend as a zip, then call manage_frontend (action: "start_deployment"). On free plan, automatically replaces the existing deployment. |
| **manage_frontend** (action: "start_deployment") | Start a deployment after uploading your zip file. Polls until the site is live or fails. SPA routing is auto-configured for supported frameworks. |
| **manage_frontend** (action: "list_deployments") | View deployment history for an app's frontend, including status and URLs. |
| **manage_frontend** (action: "set_env") | Configure environment variables for frontend builds. These are encrypted and available during deployment. |

### Feedback & Support

| Tool | What it does |
|------|--------------|
| **submit_suggestion** | Submit feedback, bug reports, or feature requests to the Butterbase team. Helps improve the platform. |

### Documentation

| Tool | What it does |
|------|--------------|
| **butterbase_docs** | Read this documentation. Use the \`topic\` parameter to get a specific section: overview, mcp, rest, auth, storage, functions, frontend, ai, rag, billing, platform, or schema. |

### Connecting over HTTP

If your environment connects to a hosted MCP endpoint, include your API key as a Bearer token in the Authorization header on each request. The MCP endpoint URL and your API key are provided when you set up your connection.

You can generate API keys using \`manage_auth_config\` (action: "generate_service_key") or through the dashboard. Keys are prefixed with \`bb_sk_\` and provide full access to your apps and data.

### Claude Code Plugin

If you are using Claude Code, install Butterbase Skills for guided skills and auto-configured MCP:

\`\`\`bash
# Add the Butterbase marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase
\`\`\`

Set your API key:

\`\`\`bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
\`\`\`

The plugin includes:
- **Auto-configured MCP server** — 43 tools and 1 prompt available immediately
- **Always-on context** — environment variables, workflows, and patterns
- **6 guided skills** (slash commands):

| Skill | Slash command | Description |
|-------|--------------|-------------|
| Build App | \`/butterbase-skills:build-app\` | End-to-end guide: create app, design schema, set up RLS, configure auth, deploy functions, deploy frontend |
| Schema Design | \`/butterbase-skills:schema\` | Database schema DSL reference with column types, indexes, and data model patterns |
| Deploy Frontend | \`/butterbase-skills:deploy\` | Deployment workflow for React, Next.js, and static HTML frontends |
| Debug RLS | \`/butterbase-skills:debug-rls\` | Systematic Row-Level Security debugging with role simulation |
| Function Dev | \`/butterbase-skills:function\` | Serverless function development with handler signatures, triggers, and examples |
| Contributing | \`/butterbase-skills:contributing\` | Contributor guide for the Butterbase monorepo |
`,

  rest: `## HTTP Data API

Once you create tables through the schema tools, a full REST API is automatically available. No code generation or route setup needed.

All paths use these placeholders:
- **{app_id}** — Your app's identifier (returned when you create the app)
- **{table}** — A table name in your schema
- **{id}** — A row's primary key value

The base URL depends on your environment. In local development it is typically \`http://localhost:4000\`.

### App Management

| Method | Path | Purpose |
|--------|------|---------|
| GET | /apps | List your apps. |
| POST | /init | Create a new app. Send \`{"name": "my-app"}\`. Names must be lowercase alphanumeric with hyphens/underscores, 1-63 characters. |
| DELETE | /apps/{app_id} | Delete an app and its database permanently. |

### Schema

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/{app_id}/schema | Read the current schema (tables, columns, types, constraints, indexes). |
| POST | /v1/{app_id}/schema/apply | Apply a schema update. Set \`dry_run: true\` to preview SQL without executing. |
| GET | /v1/{app_id}/migrations | List all applied schema migrations. |

### Data API (your tables)

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/{app_id}/{table} | List rows. Supports filtering, sorting, column selection, and pagination. |
| GET | /v1/{app_id}/{table}/{id} | Read a single row by its primary key. |
| POST | /v1/{app_id}/{table} | Create a row. Send a JSON object with column values. If the table has a WITH CHECK RLS policy (e.g. \`user_id = current_user_id()\`), include that column in the body — or use \`create_user_isolation_policy\` / \`create_policy\` with \`user_column\` to auto-populate it. |
| PATCH | /v1/{app_id}/{table}/{id} | Update a row. Send only the columns you want to change. |
| DELETE | /v1/{app_id}/{table}/{id} | Delete a row. |

#### Filtering rows

Add query parameters to filter results. The format is \`column=operator.value\`:

| Operator | Example | Meaning |
|----------|---------|---------|
| eq | \`status=eq.published\` | Equals |
| neq | \`status=neq.draft\` | Not equals |
| gt | \`age=gt.18\` | Greater than |
| gte | \`age=gte.18\` | Greater than or equal |
| lt | \`price=lt.100\` | Less than |
| lte | \`price=lte.100\` | Less than or equal |
| like | \`title=like.%hello%\` | Pattern match (case-sensitive) |
| ilike | \`title=ilike.%hello%\` | Pattern match (case-insensitive) |
| is | \`deleted_at=is.null\` | IS NULL, IS TRUE, IS FALSE |
| in | \`id=in.(1,2,3)\` | In a list of values |
| fts | \`title=fts.hello world\` | Full-text search (English, with stemming) |

#### Sorting

Use the \`order\` parameter: \`order=created_at.desc\` or \`order=name.asc,created_at.desc\` for multiple columns.

#### Pagination

Use \`limit\` and \`offset\`: \`?limit=20&offset=40\` returns rows 41-60.

#### Column selection

Use the \`select\` parameter: \`?select=id,title,created_at\` returns only those columns.

#### Example

\`\`\`
GET /v1/{app_id}/posts?select=id,title,author_id&status=eq.published&order=created_at.desc&limit=20
\`\`\`

#### Authentication with the Data API

Butterbase has three built-in roles that are **automatically determined** by how a request is authenticated. You do not create, configure, or manage these roles — the platform assigns the correct role on every request based on the Authorization header:

| Request type | Authorization header | Role assigned automatically |
|---|---|---|
| No auth header | (none) | butterbase_anon |
| End-user JWT | \`Bearer {end_user_jwt}\` | butterbase_user |
| Platform API key | \`Bearer {platform_api_key}\` | butterbase_service |

**1. Anonymous (butterbase_anon)**
- Assigned automatically when no Authorization header is sent
- Access to public data only (based on RLS policies you write)
- Use case: Product catalogs, marketing content, public profiles

**2. End-User (butterbase_user)**
- Assigned automatically when a valid end-user JWT is sent
- Access to user-specific data (based on RLS policies you write)
- \`current_user_id()\` returns the authenticated user's ID for use in policies
- Use case: User dashboards, personal data, user-owned resources

**3. Service (butterbase_service)**
- Assigned automatically when a platform API key is sent
- Full access to all data (bypasses RLS)
- A service bypass policy is auto-created on every RLS-enabled table — no setup needed
- Use case: Admin operations, background jobs, data migrations

### Row-Level Security (RLS) Role Model

The three roles (butterbase_anon, butterbase_user, butterbase_service) are built into the platform — you never create them. When you enable RLS on a table, Butterbase automatically creates a service bypass policy so platform API keys always have full access. You only need to write policies that define what **anonymous** and **end-user** requests can see or modify.

#### Three Tools for RLS

Butterbase provides three tools for managing RLS, from simple to advanced:

**1. enable_rls** - Enable RLS on a table (foundation)
- Use this first to enable RLS on any table
- The service bypass policy is auto-created at this point
- Example: enable_rls with app_id and table_name

**2. create_policy** - Create custom policies (power user)
- Full control over USING and WITH CHECK expressions
- Use the \`role\` parameter to scope policies: \`"anon"\` for butterbase_anon, \`"user"\` for butterbase_user
- Supports all commands (SELECT, INSERT, UPDATE, DELETE, ALL)
- Expression rules by command:
  - SELECT, DELETE: only \`using_expression\` (WITH CHECK not supported by PostgreSQL)
  - INSERT: only \`with_check_expression\` (USING not supported by PostgreSQL)
  - UPDATE, ALL: both \`using_expression\` and \`with_check_expression\` supported
- Example: create_policy with policy_name, command, role, and using_expression or with_check_expression

**3. create_user_isolation_policy** - Quick user isolation setup (simple)
- Convenience wrapper for the common case: users see only their own data
- Automatically enables RLS, creates user isolation policy (scoped to butterbase_user), adds a trigger to auto-populate user_column on INSERT, and creates a service bypass policy for butterbase_service
- The isolation policy includes both USING and WITH CHECK to enforce row ownership on reads AND writes
- Example: create_user_isolation_policy with table_name and user_column

Key difference: create_user_isolation_policy auto-populates user_column on INSERT (clients don't need to send it). create_policy does NOT auto-populate by default — pass user_column to enable it, or clients must include the column in POST bodies.

#### How It Works

1. **Enable RLS** on a table using enable_rls or create_user_isolation_policy
2. **Service bypass is automatic** — platform API keys always have full access (no action needed)
3. **Write policies** for anonymous and end-user access patterns using create_policy

#### Policy Examples

**Public read access (anonymous users):**
Use create_policy tool with:
- policy_name: "public_read_products"
- command: "SELECT"
- role: "anon"
- using_expression: "active = true AND published = true"

**User-specific access (authenticated users):**
Use create_user_isolation_policy tool (simpler) with table_name and user_column.

Or use create_policy for custom logic:
- policy_name: "users_own_orders"
- command: "ALL"
- role: "user"
- using_expression: "user_id = current_user_id()"

**INSERT policy (user can only insert their own rows):**
Use create_policy tool with:
- policy_name: "users_insert_own"
- command: "INSERT"
- role: "user"
- with_check_expression: "user_id = current_user_id()::uuid"

Note: INSERT policies use \`with_check_expression\`, not \`using_expression\`. PostgreSQL only supports WITH CHECK for INSERT commands.

Important: When using create_policy with a WITH CHECK on a user column (e.g. \`user_id = current_user_id()\`), the client must include that column in POST request bodies. To auto-populate it instead, either use \`create_user_isolation_policy\`, or pass \`user_column\` to \`create_policy\`.

**Mixed access (public read, user write):**
Step 1: Enable RLS with enable_rls
Step 2: Create public read policy with create_policy (command: SELECT, role: "anon", using_expression: "active = true")
Step 3: Create authenticated write policy with create_policy (command: INSERT, role: "user", with_check_expression: "user_id = current_user_id()")

#### Role Scoping

Always use the \`role\` parameter when creating custom policies to prevent cross-role policy leaks:
- \`role: "anon"\` — Policy applies only to unauthenticated requests (butterbase_anon)
- \`role: "user"\` — Policy applies only to authenticated end-users (butterbase_user)

Without role scoping, a policy applies to ALL roles. This means a "public read" policy intended for anonymous users would also apply to authenticated users, OR-ing with their isolation policy and potentially exposing other users' rows.

#### Helper Functions

- **current_user_id()** - Returns the current authenticated user's ID as TEXT. If your column is UUID, cast it: \`current_user_id()::uuid\`. Returns NULL for anonymous users.

#### Important Notes

- All three roles are built-in — you never create or configure them
- The role is assigned automatically based on the request's Authorization header
- Service access is automatic — enable_rls and create_user_isolation_policy both auto-create a service bypass policy
- You only write policies for butterbase_anon and butterbase_user access patterns
- Always use the \`role\` parameter in create_policy to scope policies to the intended role
- **Auto-populate trigger:** Only \`create_user_isolation_policy\` and \`create_policy\` with the \`user_column\` parameter create a BEFORE INSERT trigger that auto-fills the user column. Without the trigger, clients must include the user column in POST bodies or the insert will be rejected.

#### Common Pitfall: Cross-Table Subqueries in RESTRICTIVE Policies

When a RESTRICTIVE policy contains a subquery that reads another table (e.g., \`EXISTS(SELECT 1 FROM other_table WHERE ...)\`), that subquery runs under the same user's RLS context. If the other table has user_isolation, the subquery can only see the current user's rows.

**Example:** User B tries to comment on User A's public post. The RESTRICTIVE policy on comments checks \`EXISTS(SELECT 1 FROM posts WHERE id = post_id AND is_public = true)\`. But posts has user_isolation, so User B's subquery cannot see User A's posts — the insert is blocked even though the post is public.

**Solution:** Add a permissive SELECT policy on the referenced table that allows all authenticated users to read rows matching the subquery condition. For posts: \`create_policy\` with command: SELECT, role: user, using_expression: "is_public = true". Or use \`create_user_isolation_policy\` with \`public_read_column: "is_public"\` to set this up in one call.

### Row-Level Security API

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/rls/enable | Enable RLS on a table. Send \`{"table_name": "products"}\`. Use before creating policies. |
| POST | /v1/{app_id}/rls/policies | Create a custom RLS policy. Send \`{"table_name": "products", "policy_name": "public_read", "command": "SELECT", "role": "anon", "using_expression": "published = true"}\`. For INSERT policies, use \`with_check_expression\` instead of \`using_expression\`. |
| POST | /v1/{app_id}/rls | Quick user isolation setup. Send \`{"table_name": "posts", "user_column": "author_id"}\`. Enables RLS, creates policy, and adds trigger. |
| GET | /v1/{app_id}/rls | List all active row-level security policies. |
| DELETE | /v1/{app_id}/rls/{table} | Remove row-level security from a table. |

### OAuth Configuration

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/auth/oauth-config | Register a social sign-in provider. |
| GET | /v1/{app_id}/auth/oauth-config | List all configured providers. |
| GET | /v1/{app_id}/auth/oauth-config/{provider} | Read one provider's configuration. |
| PATCH | /v1/{app_id}/auth/oauth-config/{provider} | Update a provider. |
| DELETE | /v1/{app_id}/auth/oauth-config/{provider} | Remove a provider. |

**POST body:** \`provider\`, \`client_id\`, \`client_secret\`, \`redirect_uris\` (non-empty array of URLs), optional \`scopes\`, optional \`authorization_url\`, \`token_url\`, \`userinfo_url\`, and optional \`provider_metadata\` (JSON object for provider-specific config).

**Built-in providers:** For the following providers, URLs and default scopes are auto-filled — you only need \`provider\`, \`client_id\`, \`client_secret\`, and \`redirect_uris\`:
- **google** — scopes: openid, email, profile
- **github** — scopes: user:email
- **discord** — scopes: identify, email
- **facebook** — scopes: email, public_profile
- **linkedin** — scopes: openid, profile, email
- **microsoft** — scopes: openid, email, profile, User.Read
- **apple** — scopes: name, email (requires \`provider_metadata\`, see below)
- **x** — scopes: tweet.read, users.read (no email provided; synthetic email used)

For any other provider name, you must supply \`authorization_url\`, \`token_url\`, and \`userinfo_url\` manually.

If you supply URLs for a built-in provider, your values override the defaults.

**Redirect URI in your provider console** must match one of the configured \`redirect_uris\`. Use: \`{api_base}/auth/{app_id}/oauth/{provider}/callback\`.

**Google example (simplified):**

\`\`\`json
{
  "provider": "google",
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/google/callback"]
}
\`\`\`

**Apple example (requires provider_metadata):**

\`\`\`json
{
  "provider": "apple",
  "client_id": "com.example.app",
  "client_secret": "placeholder",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/apple/callback"],
  "provider_metadata": {
    "teamId": "ABCDE12345",
    "keyId": "KEY123",
    "privateKey": "-----BEGIN PRIVATE KEY-----\\n..."
  }
}
\`\`\`

Apple uses a JWT client_secret generated from the teamId, keyId, and privateKey. The \`client_secret\` field can be any placeholder value. Apple only provides the user's name on the first authorization; subsequent logins return only email and sub.

**Custom provider example:**

\`\`\`json
{
  "provider": "my-idp",
  "client_id": "...",
  "client_secret": "...",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/my-idp/callback"],
  "authorization_url": "https://my-idp.com/authorize",
  "token_url": "https://my-idp.com/token",
  "userinfo_url": "https://my-idp.com/userinfo"
}
\`\`\`

### App Configuration

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/{app_id}/config | Read the full app configuration (CORS, JWT settings, storage limits). |
| PATCH | /v1/{app_id}/config/cors | Update allowed CORS origins. Send \`{"allowed_origins": ["https://myapp.com"]}\`. |
| PATCH | /v1/{app_id}/config/jwt | Update token lifetimes. Send \`{"accessTokenTtl": "15m", "refreshTokenTtlDays": 7}\`. |

### Audit Logs

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/{app_id}/audit-logs | Query authentication events. Optional filters: \`user_id\`, \`event_type\`, \`limit\`, \`offset\`. |

### Serverless Functions

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/functions | Deploy or update a function. |
| GET | /v1/{app_id}/functions | List all functions. |
| GET | /v1/{app_id}/functions/{name} | Get function details and metrics. |
| DELETE | /v1/{app_id}/functions/{name} | Delete a function. |
| POST | /v1/{app_id}/functions/{name}/invoke | Test-invoke a function. |
| GET | /v1/{app_id}/functions/{name}/logs | View invocation logs. |

Functions can also be called directly by your frontend or end-users:

| Method | Path | Purpose |
|--------|------|---------|
| ANY | /v1/{app_id}/fn/{function_name} | Call a deployed function. Supports any HTTP method. End-user tokens are forwarded to the function. |

### Health Checks

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Liveness check. |
| GET | /health/ready | Readiness check (verifies database connectivity). |
`,

  auth: `## Authentication (for your end users)

These routes are for **people using your product** — your app's end users. They are scoped by **{app_id}** so each app has its own independent user accounts and tokens.

The auth service base URL depends on your environment. Through the default routing, all auth routes are available under \`/auth/\`.

### Signup

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/{app_id}/signup | 5 requests per 15 minutes |

Register a new user account.

**Request body:**
\`\`\`json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
\`\`\`

\`display_name\` is optional.

**Password requirements:** At least 8 characters, must include uppercase, lowercase, a number, and a special character.

**Response (201):** Returns the created user profile. A verification email is sent automatically with a 6-digit code.

### Login

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/{app_id}/login | 10 requests per 15 minutes |

Sign in with email and password.

**Request body:**
\`\`\`json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!"
}
\`\`\`

**Response (200):**
\`\`\`json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "email_verified": true,
    "display_name": "Jane Doe",
    "avatar_url": null
  }
}
\`\`\`

The **access token** is what your frontend sends with API requests. The **refresh token** is used to get a new access token when the current one expires.

### Token Refresh

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/{app_id}/refresh | 20 requests per 15 minutes |

Exchange a refresh token for a new access token. The old refresh token is invalidated and a new one is returned (token rotation for security).

**Request body:**
\`\`\`json
{
  "refresh_token": "your-refresh-token"
}
\`\`\`

**Response (200):** Same format as login — new \`access_token\` and \`refresh_token\`.

### Logout

| Method | Path | Auth Required |
|--------|------|---------------|
| POST | /auth/{app_id}/logout | Yes (Bearer token) |

Ends the user's session by revoking all their refresh tokens. The user must log in again to get new tokens.

**Headers:** \`Authorization: Bearer {access_token}\`

### Email Verification

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/{app_id}/verify-email | 10 requests per 15 minutes |

Complete email verification using the 6-digit code sent during signup.

**Request body:**
\`\`\`json
{
  "email": "user@example.com",
  "code": "123456"
}
\`\`\`

The code expires after **24 hours**.

### Password Reset

**Step 1: Request a reset code**

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/{app_id}/forgot-password | 3 requests per 15 minutes |

\`\`\`json
{
  "email": "user@example.com"
}
\`\`\`

Always returns a success response regardless of whether the email exists (to prevent user enumeration). If the account exists, a 6-digit code is sent via email.

**Step 2: Reset the password**

| Method | Path | Rate Limit |
|--------|------|------------|
| POST | /auth/{app_id}/reset-password | 5 requests per 15 minutes |

\`\`\`json
{
  "email": "user@example.com",
  "code": "123456",
  "new_password": "NewP@ssw0rd!"
}
\`\`\`

The reset code expires after **1 hour**. After resetting, all existing sessions are invalidated — the user must log in again.

### Social Sign-In (OAuth)

Before using OAuth, configure a provider using the \`manage_oauth\` MCP tool (action: "configure") or the OAuth configuration API.

**Built-in providers** (google, github, discord, facebook, linkedin, microsoft, apple, x) only need \`client_id\`, \`client_secret\`, and \`redirect_uris\` — URLs and default scopes are auto-filled. Custom providers require all URLs to be supplied manually.

| Method | Path | Purpose |
|--------|------|---------|
| GET | /auth/{app_id}/oauth/{provider}?redirect_to={url} | Start the OAuth flow. Redirects the user's browser to the provider's sign-in page. Optional \`redirect_to\` parameter specifies where to redirect after successful authentication. |
| GET | /auth/{app_id}/oauth/{provider}/callback | The provider redirects back here after sign-in. Returns access and refresh tokens as JSON, or redirects to \`redirect_to\` URL with tokens as query parameters. |
| POST | /auth/{app_id}/oauth/{provider}/callback | POST callback for providers that use form_post response mode (Apple). Handled automatically. |

**Flow for your frontend:**
1. Direct the user's browser to \`/auth/{app_id}/oauth/{provider}?redirect_to=https://yourapp.com/auth/callback\`
2. The user signs in with the provider (Google, GitHub, etc.)
3. The provider redirects to the callback URL
4. If \`redirect_to\` was provided, the callback redirects to that URL with tokens: \`https://yourapp.com/auth/callback?access_token=...&refresh_token=...&expires_in=900&token_type=Bearer\`
5. If \`redirect_to\` was not provided, the callback returns tokens and user profile as JSON in the same format as login

OAuth users are automatically marked as email-verified. If a user signs in with a new OAuth provider, a new account is created. Subsequent logins with the same provider update the profile.

**Provider-specific notes:**
- **Google, LinkedIn, Apple:** User info is extracted from the ID token via JWKS verification (no separate userinfo call needed).
- **GitHub:** If the user's email is not public, it is fetched from the /user/emails endpoint automatically.
- **Apple:** Uses POST callback (form_post). Requires \`provider_metadata\` with teamId, keyId, and privateKey. Only provides user's name on first authorization.
- **X (Twitter):** Uses PKCE (S256) automatically. Does not provide email — a synthetic email ({username}@users.noreply.x.local) is generated.
- **Facebook:** Scopes are comma-separated internally. Avatar is extracted from the nested picture.data.url response.
- **Discord:** Avatar URL is constructed from the Discord CDN.

### User Profile

| Method | Path | Auth Required |
|--------|------|---------------|
| GET | /auth/{app_id}/me | Yes (Bearer token) |

Returns the authenticated user's profile (id, email, display name, avatar, etc.).

### Token Verification (JWKS)

| Method | Path | Cache |
|--------|------|-------|
| GET | /auth/{app_id}/.well-known/jwks.json | 5 minutes |

Returns public keys for verifying access tokens issued for this app. Use this if you need to verify tokens in your own backend.

### Using tokens with the Data API

After your user logs in, include their access token when calling the data API:

\`\`\`
GET /v1/{app_id}/posts
Authorization: Bearer {access_token}
\`\`\`

If you have RLS enabled on the \`posts\` table, the user will only see their own rows automatically.

### Token Lifetimes

Token lifetimes are configurable per app using \`manage_auth_config\` (action: "update_jwt"):
- **Access token:** Default 1 hour (configurable: "15m", "30m", "1h", "2h", "1d")
- **Refresh token:** Default 7 days (configurable in days)
`,

  storage: `## File Storage

Butterbase provides file storage with presigned URLs. Files are organized per-app and per-user. Your frontend uploads and downloads files directly — file data never flows through your backend code.

### How it works

1. **Request an upload URL** — Your app asks Butterbase for a presigned upload URL, providing the filename, content type, and size.
2. **Upload directly** — Your frontend uses the presigned URL to upload the file directly to storage.
3. **Reference the file** — Store the returned \`objectId\` in your database (e.g., as an \`image_url\` column in your table).
4. **Download when needed** — Request a presigned download URL using the object ID.

### Object ID, object key, and URLs

Three different values appear in the upload response. Only two belong in your app logic long-term:

| Value | What it is | What to do with it |
|--------|------------|---------------------|
| **\`objectId\`** | A stable UUID for this file in Butterbase | **Persist this** in your database. Use it with \`GET /storage/{app_id}/download/{object_id}\`, \`DELETE /storage/{app_id}/{object_id}\`, and \`manage_storage\` (action: "download_url"). |
| **\`objectKey\`** | The path inside the bucket (e.g. \`app_id/user_id/uuid_filename.jpg\`) | **Not a URL.** The browser cannot load it as \`href\` or \`img src\`. It is metadata; you do not need to store it for display. |
| **\`uploadUrl\` / \`downloadUrl\`** | Temporary presigned HTTPS URLs | Use only for **immediate** \`fetch\` PUT (upload) or GET (download). They **expire**; do not treat them as permanent links. The durable reference is always \`objectId\`. |

Butterbase does not provide permanent public URLs for private files. Images and downloads work by **minting a fresh presigned download URL** when you need to show or fetch a file.

### Common mistakes

- **Saving \`objectKey\` in a column named \`storage_url\`, \`image_url\`, or similar** — That value is a path, not a usable URL. The UI will show broken images or failed loads.
- **Using \`objectKey\` as \`img src\` or a link** — Use \`objectId\` with the download endpoint (or SDK \`getDownloadUrl\`) to obtain a \`downloadUrl\`, then set \`src\` to that.
- **Storing only a presigned URL in the database** — Presigned URLs expire (see below). Store **\`objectId\`** as the source of truth; generate a new download URL whenever you render or serve the asset.

### Showing images and files in the UI

After you load rows from your database that reference stored files (by \`objectId\`):

1. For each file you need to display, call the download API (REST or MCP \`manage_storage\` action: "download_url", or SDK \`getDownloadUrl(objectId)\`).
2. Use the returned \`downloadUrl\` in an \`<img src>\`, video source, or download link until it expires.
3. For **lists** (many thumbnails), resolve download URLs **in parallel** (e.g. \`Promise.all\`) so the page stays fast.

Do not assume a single permanent URL per file unless you have built a separate public-asset pipeline.

### If presigned URLs fail (operators)

If uploads fail from the browser after CORS errors, or if generated URLs point at the wrong host (e.g. \`s3.auto.amazonaws.com\` instead of your object storage endpoint), the deployment must configure the Control API and bucket correctly. See **DEPLOYMENT_PLAN.md** (Cloudflare R2 / S3-compatible storage): \`S3_PUBLIC_ENDPOINT\`, \`S3_ENDPOINT\`, \`S3_FORCE_PATH_STYLE\`, and **R2 bucket CORS** for browser \`PUT\`/\`GET\`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /storage/{app_id}/upload | Request a presigned upload URL. |
| GET | /storage/{app_id}/objects | List all files for the app. |
| GET | /storage/{app_id}/download/{object_id} | Request a presigned download URL. |
| DELETE | /storage/{app_id}/{object_id} | Delete a file. |

### Uploading a file

**Step 1:** Request the upload URL.

\`\`\`json
POST /storage/{app_id}/upload
Authorization: Bearer {token}

{
  "filename": "profile.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 102400
}
\`\`\`

**Response:**
\`\`\`json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
\`\`\`

**Step 2:** Upload the file using the presigned URL.

\`\`\`javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
\`\`\`

**Step 3:** Save the \`objectId\` in your database for later reference.

### Downloading a file

Request a download URL, then use it in your frontend (e.g., as an image \`src\` or a download link).

\`\`\`json
GET /storage/{app_id}/download/{object_id}
Authorization: Bearer {token}
\`\`\`

**Response:**
\`\`\`json
{
  "downloadUrl": "https://storage.example.com/...",
  "filename": "profile.jpg",
  "expiresIn": 3600
}
\`\`\`

### Listing files

\`\`\`json
GET /storage/{app_id}/objects
Authorization: Bearer {token}
\`\`\`

Returns an array of objects with \`id\`, \`filename\`, \`content_type\`, \`size_bytes\`, and \`created_at\`.

### Storage limits

Each app has configurable storage limits:
- **Max file size:** 10 MB per file (default)
- **Total storage:** 1 GB per app (default)
- **Allowed content types:** All types by default (can be restricted to e.g., \`image/*\`)

If a limit is exceeded, the upload request returns an error explaining what was exceeded.

### Who can access files

- **App owner / service key** (using API key or platform token): Can upload, list, download, and delete all files in the app. Uploads via service key store the file without a user association (\`user_id\` is null).
- **End-users** (using their access token): Can only see and manage their own files. Uploads are automatically associated with the authenticated user.

### Public read access

Butterbase provides two levels of public file access:

**App-wide: \`publicReadEnabled\`**

Enable this to make all files in the app downloadable by any authenticated user:

\`\`\`
manage_storage({ app_id: "app_abc123", action: "update_config", publicReadEnabled: true })
\`\`\`

**Per-object: \`public\` flag**

Mark individual files as publicly downloadable when uploading:

\`\`\`
manage_storage({ app_id: "app_abc123", action: "upload_url", filename: "avatar.jpg", content_type: "image/jpeg", size_bytes: 1024, public: true })
\`\`\`

**Download authorization (checked in order — first match wins):**
1. Platform auth (API key) → access any object
2. App-wide \`publicReadEnabled: true\` → access any object
3. Per-object \`public: true\` → access this specific object
4. \`user_id\` match → access own objects

When \`publicReadEnabled\` is **false** (default) and the object is **not public**:
- Users can only generate download URLs for files they uploaded

**Uploads and deletes always remain user-scoped** — neither \`publicReadEnabled\` nor per-object \`public\` affects who can upload or delete files.

### URL expiration

- Upload URLs expire after **5 minutes**
- Download URLs expire after **1 hour**
`,

  functions: `## Serverless Functions

Deploy custom backend logic as serverless functions. Functions are written in TypeScript or JavaScript and run in an isolated environment. They can handle HTTP requests, run on a cron schedule, access your app's database, and use environment variables.

### Deploying a function

Use the \`deploy_function\` MCP tool or the HTTP API:

\`\`\`json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\\n    headers: { 'Content-Type': 'application/json' }\\n  });\\n}",
  "description": "A simple greeting function",
  "trigger": {
    "type": "http",
    "config": {}
  }
}
\`\`\`

**Required fields:**
- \`name\` — Unique name for the function (1-100 characters)
- \`code\` — The function source code. Must export a default handler function.

**Optional fields:**
- \`description\` — What the function does
- \`envVars\` — Key-value pairs for environment variables (encrypted at rest, accessible via \`ctx.env\`)
- \`timeoutMs\` — Max execution time in milliseconds (default: 30000, max: 300000)
- \`memoryLimitMb\` — Memory limit in MB (default: 128, range: 64-1024)
- \`trigger\` — How the function is invoked

### Trigger types

| Type | Description | Config |
|------|-------------|--------|
| \`http\` | Called via HTTP requests (default) | \`{}\` |
| \`cron\` | Runs on a schedule | \`{"schedule": "*/5 * * * *"}\` (cron expression) |

### Writing functions

Functions receive a Request object and must return a Response:

\`\`\`typescript
export default async function handler(req: Request): Promise<Response> {
  const body = await req.json();

  // Your logic here

  return new Response(JSON.stringify({ result: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

**What's available inside a function:**
- Standard Web APIs (fetch, Request, Response, Headers, URL, etc.)
- Environment variables via \`ctx.env.VAR_NAME\` (passed as second parameter to handler)
- Network access to your app's database
- Console output (console.log/info/warn/error/debug) — captured and stored with invocation logs
- The \`x-user-id\` header is set when an end-user's token was provided in the request

**Environment variables:**
Function-specific environment variables (set via \`envVars\` when deploying) are available through the \`ctx\` parameter passed to your handler function. Access them as \`ctx.env.VAR_NAME\`.

**Important:** Use \`ctx.env\`, not \`Deno.env.get()\`. System environment variables (like database credentials) are available via \`Deno.env.get()\`, but function-specific env vars are isolated in \`ctx.env\` to prevent conflicts.

### Row-Level Security in Functions

Functions respect RLS policies based on how they're invoked:

**Invoked with end-user JWT:**
- Function runs with \`butterbase_user\` role
- Database queries see only the user's data (RLS enforced)
- \`ctx.user.id\` contains the authenticated user's ID
- Use case: User-facing operations, personalized responses

**Invoked with platform API key:**
- Function runs with \`butterbase_service\` role
- Database queries see all data (RLS bypassed)
- \`ctx.user\` is null
- Use case: Admin operations, background jobs, data processing

**Invoked by cron trigger:**
- Function runs with \`butterbase_service\` role
- Database queries see all data (RLS bypassed)
- \`ctx.user\` is null
- Use case: Scheduled tasks, cleanup jobs, reports

**Example - User-scoped function:**
\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  if (!ctx.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // This query automatically filters to current user's orders (RLS enforced)
  const orders = await ctx.db.query('SELECT * FROM orders');

  return new Response(JSON.stringify(orders.rows), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

**Example - Service function:**
\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  // This query sees all orders (RLS bypassed - service role)
  const allOrders = await ctx.db.query('SELECT * FROM orders');

  return new Response(JSON.stringify(allOrders.rows), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

#### Testing RLS from Service Functions: ctx.db.asUser() and ctx.db.asAnon()

When a function runs as service (invoked via API key or cron), \`ctx.db.query()\` bypasses RLS. To test RLS from within a service function, use \`ctx.db.asUser(userId, callback)\` or \`ctx.db.asAnon(callback)\`. These run all queries inside the callback within a single transaction under the specified role, with RLS enforced.

**ctx.db.asUser(userId, callback):**
\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const userId = 'some-user-uuid';

  // All queries in the callback run as butterbase_user with RLS enforced
  const userPosts = await ctx.db.asUser(userId, async (db) => {
    const result = await db.query('SELECT * FROM posts');
    return result.rows;
  });

  // This query still runs as service (sees all data)
  const allPosts = await ctx.db.query('SELECT * FROM posts');

  return new Response(JSON.stringify({
    userSees: userPosts.length,
    serviceSeesAll: allPosts.rows.length,
  }), { headers: { 'Content-Type': 'application/json' } });
}
\`\`\`

**ctx.db.asAnon(callback):**
\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  // All queries in the callback run as butterbase_anon with RLS enforced
  const publicProducts = await ctx.db.asAnon(async (db) => {
    const result = await db.query('SELECT * FROM products');
    return result.rows;
  });

  return new Response(JSON.stringify(publicProducts), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

**Important:** Multiple \`db.query()\` calls inside the same \`asUser\`/\`asAnon\` callback share a single transaction and role context. This is different from \`ctx.db.query()\` where each call is an independent transaction.

#### Idempotency for Webhooks: ctx.idempotency.claim()

Third-party webhook providers (Stripe, Telegram, GitHub, Slack, Twilio, Discord) retry delivery on non-2xx responses with the **same event id**. Use \`ctx.idempotency.claim(key)\` to atomically dedupe — it returns \`true\` if you're the first to see this key, and \`false\` if another invocation has already claimed it.

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const event = await req.json();

  // Returns true the first time, false on every retry of the same event.
  if (!(await ctx.idempotency.claim(event.id, { scope: 'stripe' }))) {
    // Already processed — ack the retry without re-running side effects.
    return new Response('duplicate', { status: 200 });
  }

  // ...do the actual work
  return new Response('ok', { status: 200 });
}
\`\`\`

**Options:**
- \`scope\` (default \`"default"\`): namespace claims per provider so keys can never collide.
- \`ttlSeconds\`: mark the claim with an expiry so you know which keys are safe to clean up.

**Cleanup:** Claims live in a per-app system table \`_idempotency_keys\`. The runtime never deletes them automatically — run a periodic cleanup yourself (e.g. from a cron function): \`DELETE FROM _idempotency_keys WHERE expires_at < now();\`

**Example using environment variables:**
\`\`\`typescript
// Deploy with: envVars: { "API_KEY": "secret123", "BASE_URL": "https://api.example.com" }

export default async function handler(req: Request, ctx: any): Promise<Response> {
  // Access function env vars via ctx.env
  const apiKey = ctx.env.API_KEY;
  const baseUrl = ctx.env.BASE_URL;

  const response = await fetch(\`\${baseUrl}/data\`, {
    headers: { 'Authorization': \`Bearer \${apiKey}\` }
  });

  return new Response(await response.text());
}
\`\`\`

### Calling functions from your frontend

HTTP-triggered functions are available at:

\`\`\`
ANY /v1/{app_id}/fn/{function_name}
\`\`\`

This supports any HTTP method (GET, POST, PUT, DELETE, etc.). If your end-user is authenticated, include their access token — it will be forwarded to the function.

\`\`\`javascript
const response = await fetch(\`\${API_BASE}/v1/\${appId}/fn/hello-world\`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': \`Bearer \${userAccessToken}\`
  },
  body: JSON.stringify({ input: 'data' })
});
\`\`\`

### Cron functions

Cron functions run automatically on a schedule. Use standard cron expressions:

| Expression | Schedule |
|-----------|----------|
| \`* * * * *\` | Every minute |
| \`*/5 * * * *\` | Every 5 minutes |
| \`0 * * * *\` | Every hour |
| \`0 9 * * *\` | Daily at 9 AM |
| \`0 0 * * 1\` | Every Monday at midnight |

### manage_function (action: "delete")

Delete a deployed function permanently.

Example:
\`\`\`typescript
Input: {
  app_id: "app_abc123",
  function_name: "send-welcome-email"
}
Output: {
  message: "Function deleted successfully",
  app_id: "app_abc123",
  function_name: "send-welcome-email"
}
\`\`\`

Use this to:
- Clean up test functions
- Remove deprecated functions
- Free up function name for redeployment

**Warning:** This permanently deletes the function. It will stop being invoked immediately.

Common errors:
- RESOURCE_NOT_FOUND: Function doesn't exist, use manage_function (action: "list") to verify

Idempotency: Safe to call multiple times (no-op if already deleted).

Note: This is a soft delete (sets deleted_at timestamp). The function record remains in the database for audit purposes.

### Managing functions

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/functions | Deploy or update a function |
| GET | /v1/{app_id}/functions | List all functions with metrics |
| GET | /v1/{app_id}/functions/{name} | Get function details, code, and metrics |
| DELETE | /v1/{app_id}/functions/{name} | Delete a function |
| POST | /v1/{app_id}/functions/{name}/invoke | Test-invoke a function |
| GET | /v1/{app_id}/functions/{name}/logs | View invocation logs |

### Function metrics

Each function tracks:
- Total invocation count
- Error count and error rate
- Average execution duration
- Last invocation time

### Invocation logs

Logs include:
- HTTP method and path
- Status code
- Execution duration
- Memory usage
- Error messages and stack traces (if any)
- Console output (consoleLogs) — captured console.log/info/warn/error/debug calls with level, message, and timestamp

Use \`manage_function\` (action: "get_logs") or the logs endpoint with optional filters: \`limit\`, \`since\` (ISO date), \`level\`.
`,

  schema: `## Schema DSL Reference

Butterbase uses a declarative JSON format to define your database schema. You describe the desired state; the platform figures out what changes are needed and applies them safely.

### Basic structure

\`\`\`json
{
  "schema": {
    "tables": {
      "table_name": {
        "columns": {
          "column_name": {
            "type": "text",
            "primary": true,
            "nullable": false,
            "unique": true,
            "default": "gen_random_uuid()",
            "references": { "table": "other_table", "column": "id" }
          }
        },
        "indexes": {
          "idx_name": {
            "columns": ["col1", "col2"],
            "unique": false
          }
        }
      }
    }
  },
  "dry_run": false,
  "name": "descriptive migration name"
}
\`\`\`

### Column properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| \`type\` | string | Yes | The column data type (see supported types below) |
| \`primary\` | boolean | No | Makes this column the primary key |
| \`nullable\` | boolean | No | Whether NULL values are allowed (default: true) |
| \`unique\` | boolean | No | Adds a unique constraint |
| \`default\` | string | No | Default value expression (e.g., \`"now()"\`, \`"gen_random_uuid()"\`) |
| \`references\` | object | No | Foreign key: \`{"table": "other_table", "column": "id"}\` |

### Supported column types

| Category | Types |
|----------|-------|
| **Text** | \`text\`, \`varchar\`, \`varchar(N)\`, \`char\`, \`char(N)\` |
| **Numbers** | \`integer\`, \`bigint\`, \`smallint\`, \`real\`, \`float4\`, \`float8\`, \`decimal\`, \`numeric\`, \`numeric(P,S)\` |
| **Boolean** | \`boolean\`, \`bool\` |
| **UUID** | \`uuid\` |
| **Date/Time** | \`timestamp\`, \`timestamptz\`, \`date\`, \`time\`, \`timetz\`, \`interval\` |
| **JSON** | \`json\`, \`jsonb\` |
| **Binary** | \`bytea\` |
| **Vectors** | \`vector(N)\` where N is the dimension (for AI embeddings) |
| **Arrays** | \`text[]\`, \`integer[]\`, etc. |

### Common patterns

**Basic table with auto-generated ID:**
\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

**Table with foreign key and user ownership (for RLS):**
\`\`\`json
{
  "tables": {
    "comments": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "post_id": { "type": "uuid", "nullable": false, "references": { "table": "posts", "column": "id" } },
        "user_id": { "type": "uuid", "nullable": false },
        "body": { "type": "text", "nullable": false },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "indexes": {
        "idx_comments_post": { "columns": ["post_id"] },
        "idx_comments_user": { "columns": ["user_id"] }
      }
    }
  }
}
\`\`\`

After creating this table, run \`create_rls_policy\` with \`table_name: "comments"\` and \`user_column: "user_id"\` so each user can only access their own comments.

**Table with vector column (for AI embeddings):**
\`\`\`json
{
  "tables": {
    "documents": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "content": { "type": "text" },
        "embedding": { "type": "vector(1536)" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

### Adding columns to existing tables

Include the existing table with both existing and new columns. The platform diffs and only applies the changes:

\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "image_url": { "type": "text" },
        "view_count": { "type": "integer", "default": "0" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

This adds \`image_url\` and \`view_count\` without touching existing columns.

### Dropping columns

To remove columns, explicitly list them in \`_dropColumns\`:

\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "_dropColumns": ["published", "image_url"]
    }
  }
}
\`\`\`

### Dropping tables

To remove an entire table, set \`_drop: true\`:

\`\`\`json
{
  "tables": {
    "old_table": {
      "_drop": true
    }
  }
}
\`\`\`

### Dry run (preview changes)

Always preview before applying destructive changes:

\`\`\`json
{
  "schema": { "tables": { ... } },
  "dry_run": true
}
\`\`\`

The response includes the SQL statements that would run, without actually executing them. Review the output, then apply with \`dry_run: false\` (or omit it).

### Safety

- **Destructive operations are blocked by default.** You must explicitly use \`_drop\` or \`_dropColumns\` to remove tables or columns. If you forget, the platform returns an error explaining what to add.
- **Schema limit:** Maximum 50 tables per schema definition.
- **Idempotent:** Applying the same schema twice does nothing — only differences are applied.
`,

  frontend: `## Frontend Deployment

Deploy your frontend directly from Butterbase. Build your app locally, zip the output, upload it, and deploy to a live URL.

### How it works

1. Call \`create_frontend_deployment\` to get a deployment ID and upload URL
2. Upload your built frontend as a zip file to the returned URL — the zip **must** use forward slashes inside entry paths (see **Creating the zip file correctly**). **Never** use Windows Explorer "Send to → Compressed folder" or PowerShell \`Compress-Archive\` for this zip.
3. Call \`manage_frontend\` (action: "start_deployment") to trigger the deployment
4. When the API reports \`READY\` with a URL, the deployment is accepted on the platform — **Cloudflare Pages can still take several minutes** for new HTML and assets to appear at the edge for everyone. **Do not tell an end user the new site is fully live until you have verified it** (e.g. HTTP GET the live URL and, if needed, a known asset URL; retry with backoff until responses match the expected deployment). Poll the site the same way you would verify any CDN update; only then say it is OK to check or refresh.

### Deployment statuses

| Status | Meaning |
|--------|---------|
| \`WAITING\` | Deployment created, awaiting zip upload |
| \`UPLOADING\` | Files are being processed |
| \`BUILDING\` | Your deployment is being built |
| \`READY\` | Deployment succeeded and URL is assigned; Cloudflare edge may need minutes to serve the new build everywhere — verify with HTTP requests before telling users to rely on it |
| \`ERROR\` | Deployment failed — check the error message |
| \`CANCELED\` | Deployment was canceled |

### Supported frameworks

| Framework | Value | Notes |
|-----------|-------|-------|
| React (Vite) | \`react-vite\` | Output from \`npm run build\` (typically the \`dist/\` folder) |
| Next.js (static export) | \`nextjs-static\` | Output from \`next build && next export\` (the \`out/\` folder) |
| Static HTML | \`static\` | Any plain HTML/CSS/JS files |
| Other | \`other\` | Any framework that produces static output |

### Deploying via MCP

**Step 1: Create deployment**

Call \`create_frontend_deployment\`:
\`\`\`json
{
  "app_id": "app_abc123",
  "framework": "react-vite"
}
\`\`\`

Response:
\`\`\`json
{
  "deployment_id": "uuid-1234",
  "uploadUrl": "https://...",
  "expiresIn": 900,
  "maxSizeBytes": 104857600
}
\`\`\`

**Step 2: Upload your zip**

Upload your built frontend as a zip file to the returned URL:
\`\`\`bash
curl -X PUT "{uploadUrl}" \\
  -H "Content-Type: application/zip" \\
  --data-binary @frontend.zip
\`\`\`

**Step 3: Start deployment**

Call \`manage_frontend\` (action: "start_deployment"):
\`\`\`json
{
  "app_id": "app_abc123",
  "deployment_id": "uuid-1234"
}
\`\`\`

Response:
\`\`\`json
{
  "deployment_id": "uuid-1234",
  "url": "https://your-app.pages.dev",
  "status": "READY"
}
\`\`\`

**Propagation:** \`READY\` does not mean every edge PoP has the new files yet. Wait, re-fetch the URL (and key static assets if you need certainty), then confirm before messaging users.

### Deploying via REST API

**Step 1: Create deployment**
\`\`\`
POST /v1/{app_id}/frontend/deployments
Authorization: Bearer {token}

{
  "framework": "react-vite"
}
\`\`\`

Response:
\`\`\`json
{
  "id": "deployment-uuid",
  "uploadUrl": "https://...",
  "expiresIn": 900,
  "maxSizeBytes": 104857600
}
\`\`\`

**Step 2: Upload your zip file:**
\`\`\`bash
curl -X PUT "{uploadUrl}" \\
  -H "Content-Type: application/zip" \\
  --data-binary @frontend.zip
\`\`\`

**Step 3: Start deployment**
\`\`\`
POST /v1/{app_id}/frontend/deployments/{deployment_id}/start
Authorization: Bearer {token}
\`\`\`

Response:
\`\`\`json
{
  "id": "deployment-uuid",
  "status": "BUILDING",
  "url": "https://your-app.pages.dev"
}
\`\`\`

**Propagation:** After status reaches \`READY\`, allow time for Cloudflare to serve the new build globally; verify by requesting the live URL (poll until content matches expectations) before telling anyone the update is visible.

**Step 4: Check deployment status:**
\`\`\`
GET /v1/{app_id}/frontend/deployments/{deployment_id}
Authorization: Bearer {token}
\`\`\`

#### Additional Operations

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/{app_id}/frontend/deployments | List deployment history (up to 50) |
| GET | /v1/{app_id}/frontend/deployments/{id} | Get deployment details and status |
| POST | /v1/{app_id}/frontend/deployments/{id}/sync | Force-sync deployment status |
| POST | /v1/{app_id}/frontend/deployments/{id}/cancel | Cancel an in-progress deployment |
| DELETE | /v1/{app_id}/frontend/deployments/{id} | Delete a deployment |
| PUT | /v1/{app_id}/frontend/env | Set environment variables |
| GET | /v1/{app_id}/frontend/env | List environment variable keys |

### Environment variables

Set environment variables for your frontend builds using \`manage_frontend\` (action: "set_env") or the REST API. These are encrypted at rest.

\`\`\`json
PUT /v1/{app_id}/frontend/env
{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "VITE_APP_NAME": "My App",
  "NEXT_PUBLIC_API_KEY": "pk_test_123"
}
\`\`\`

**Important:** Environment variables are stored but NOT automatically injected during deployment. Your AI assistant or build process must read these variables and inject them into your build.

Framework-specific prefixes:
- **Vite:** \`VITE_\` prefix (e.g., \`VITE_API_URL\`)
- **Next.js:** \`NEXT_PUBLIC_\` prefix (e.g., \`NEXT_PUBLIC_API_URL\`)
- **Create React App:** \`REACT_APP_\` prefix (e.g., \`REACT_APP_API_URL\`)

Only variable keys are returned when listing — values are never exposed after being set.

### Redeployment

On the **free plan**, deploying again automatically replaces your existing deployment — no need to delete first. Just run through the same create → upload → start flow and the old deployment is cleaned up for you.

On **Pro and above**, each deployment is kept independently (unlimited deployments per app). Use \`DELETE /v1/{app_id}/frontend/deployments/{id}\` to remove old deployments manually.

### SPA routing

For single-page app frameworks (\`react-vite\`, \`nextjs-static\`, \`other\`), a \`_redirects\` file is automatically injected so that all routes serve \`index.html\`. This means client-side routing (React Router, Next.js, etc.) works out of the box.

If your zip already includes a custom \`_redirects\` file, it is preserved and the automatic one is not added.

### Limits

- **Maximum deployment size:** 100 MB (compressed zip)
- **Upload URL expiration:** 15 minutes
- **Free plan:** 1 active deployment per app (auto-replaced on redeploy)
- **Pro plan and above:** Unlimited deployments

### Creating the zip file correctly (Windows and AI assistants)

**Hard rule — do not use these for Butterbase frontend upload zips.** They store zip entry names with backslashes (\`assets\\\\index.js\`). Cloudflare Pages then cannot match paths, serves JS/CSS as \`text/html\`, and the site breaks. **Do not use them even if a user asks, even for a quick test:**

- Windows **File Explorer** → **Send to** → **Compressed (zipped) folder**
- PowerShell **\`Compress-Archive\`**
- **\`ZipFile.CreateFromDirectory\`** (or similar) **unless** every entry name is rewritten to use \`/\`

**AI / automation:** When generating scripts or instructions for zipping a \`dist\` (or \`out\`) folder for upload, **default to the Node \`archiver\` script below** on all operating systems. Do not substitute Explorer, \`Compress-Archive\`, or other native Windows zip shortcuts.

**Why:** The zip format uses forward slashes in internal paths. **\`archiver\`** (and the \`zip\` CLI in Git Bash/WSL) emit \`assets/index.js\` on every platform. Native Windows UI and \`Compress-Archive\` often do not.

#### Recommended: Node.js \`archiver\` (forward slashes on Windows and everywhere)

\`\`\`bash
cd your-project
npm install archiver --save-dev
\`\`\`

Add \`zip-dist.js\` at the project root (change \`dist/\` to match your build output, e.g. \`out/\` for Next static export):

\`\`\`javascript
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const output = fs.createWriteStream(path.join(__dirname, 'frontend.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(\`frontend.zip created (\${archive.pointer()} bytes)\`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

// Zip contents of dist/; \`false\` = do not add a top-level "dist" folder inside the zip
archive.directory('dist/', false);

archive.finalize();
\`\`\`

Optional \`package.json\` script:

\`\`\`json
"scripts": {
  "zip": "node zip-dist.js"
}
\`\`\`

Workflow: \`npm run build\`, then \`npm run zip\`, then upload \`frontend.zip\`.

#### Other approved methods (if not using Node)

- **Git Bash or WSL:** from inside the output folder, paths are correct: \`cd dist && zip -r ../frontend.zip .\`
- **PowerShell** — only with explicit \`/\` entry names (do **not** use \`Compress-Archive\`):

\`\`\`powershell
cd dist
$zip = [System.IO.Compression.ZipFile]::Open('../frontend.zip', 'Create')
Get-ChildItem -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring((Get-Location).Path.Length + 1).Replace('\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
}
$zip.Dispose()
\`\`\`

### Preparing your build

Zip the **contents** of the output directory — not the folder name as a single root segment — so \`index.html\` sits at the root of the archive.

**React (Vite):**
\`\`\`bash
npm run build
npm run zip
\`\`\`
(Use \`zip-dist.js\` targeting \`dist/\`, or \`cd dist && zip -r ../frontend.zip .\` from Git Bash/WSL.)

**Next.js (static):**
\`\`\`bash
next build && next export
\`\`\`
Then zip the \`out/\` contents the same way (point \`archiver\` at \`out/\` or \`cd out && zip ...\`).

**Static HTML:**
\`\`\`bash
zip -r frontend.zip index.html styles/ scripts/
\`\`\`
(Or \`archiver\` over your static root.)

### Troubleshooting

**Assets return wrong MIME type (\`text/html\` instead of \`application/javascript\` or \`text/css\`):** The zip almost always has backslash paths inside entries. **Rebuild with \`archiver\` or another approved method above.** If you used Explorer or \`Compress-Archive\`, that is the cause — **switch tooling, do not retry the same approach.**

**User says the site did not update after \`READY\`:** Normal CDN delay. Poll the live URL (and optionally a versioned asset URL) until content matches the new build; then tell the user to refresh.

### Custom Domains (Pro plan and above)

Connect your own domain (e.g., \`app.example.com\`) to your frontend deployment. Butterbase handles SSL certificate issuance and renewal via Cloudflare automatically.

**Requirements:**
- Pro plan or above (\`custom_domain\` feature)
- App must use the WfP deployment backend

#### Adding a custom domain

**Via MCP:**
\`\`\`
manage_frontend({ app_id: "app_abc123", action: "configure_custom_domain", domain_action: "add", hostname: "app.example.com" })
\`\`\`

**Via REST API:**
\`\`\`
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{ "hostname": "app.example.com" }
\`\`\`

Response includes a \`cname_target\` and setup instructions.

#### Verification flow

1. Add your domain via the API, MCP tool, CLI, or dashboard
2. Add a CNAME record at your DNS provider: \`app.example.com \u2192 butterbase.dev\`
   - **If your DNS is on Cloudflare:** set the record to **DNS-only (grey cloud)**. Proxied (orange cloud) CNAMEs between different Cloudflare accounts produce Error 1014 and will not work.
3. Cloudflare validates ownership and issues an SSL certificate automatically
4. Check progress via the status endpoint (typically 5\u201315 minutes)
5. Once \`status\` is \`"active"\` and \`ssl_status\` is \`"active"\`, the domain is live

#### Managing domains

| Method | Path / MCP Action | Purpose |
|--------|-------------------|---------|
| POST | /v1/{app_id}/custom-domains | Add a custom domain |
| GET | /v1/{app_id}/custom-domains | List all custom domains |
| GET | /v1/{app_id}/custom-domains/{id}/status | Check verification/SSL status |
| POST | /v1/{app_id}/custom-domains/{id}/verify | Re-trigger verification |
| DELETE | /v1/{app_id}/custom-domains/{id} | Remove a custom domain |

**Apex domains:** For \`example.com\` (no subdomain), your DNS provider must support CNAME flattening (e.g., Cloudflare DNS). Otherwise, use \`www.example.com\` and set up a redirect from the apex.
`,

  ai: `## AI Model Gateway

Butterbase includes a built-in AI model gateway that lets your app call large language models through an OpenAI-compatible API.

### How it works

Your app sends chat completion or embedding requests to Butterbase. Usage cost is tracked automatically and counted against your plan's AI credits allowance.

### Chat Completions

Send an OpenAI-compatible chat completion request:

\`\`\`json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is Butterbase?" }
  ],
  "max_tokens": 500,
  "temperature": 0.7
}
\`\`\`

**Response:** Standard OpenAI-compatible chat completion response with usage data.

**Streaming:** Set \`"stream": true\` to receive server-sent events as the model generates tokens.

### Multimodal input (images and video)

Vision-capable models can accept images and videos alongside text. Instead of a plain string, pass \`content\` as an array of content parts:

**Image from URL:**

\`\`\`json
{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "https://..." } }
      ]
    }
  ]
}
\`\`\`

**Image from Butterbase Storage:**

Upload the image to Butterbase Storage first, get a presigned download URL, then pass it as the \`image_url\`:

\`\`\`typescript
// 1. Get a presigned download URL for the stored object
const { data, error } = await bb.storage.getDownloadUrl(objectId);

// 2. Pass the URL to the AI gateway
const response = await fetch(\`\${BUTTERBASE_API_URL}/v1/\${BUTTERBASE_APP_ID}/chat/completions\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${apiKey}\` },
  body: JSON.stringify({
    model: 'anthropic/claude-3.5-sonnet',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: data.url } }
        ]
      }
    ],
    max_tokens: 500
  })
});
\`\`\`

**Video from URL:**

\`\`\`json
{
  "model": "google/gemini-pro-vision",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Summarise this video." },
        { "type": "video_url", "video_url": { "url": "https://..." } }
      ]
    }
  ]
}
\`\`\`

**Content part types:**

| Type | Field | Description |
|------|-------|-------------|
| \`text\` | \`text\` | Plain text |
| \`image_url\` | \`image_url.url\` | HTTPS URL or base64 data URI. Optional \`detail\`: \`"low"\` \| \`"high"\` \| \`"auto"\` |
| \`video_url\` | \`video_url.url\` | HTTPS URL to a video file (model-dependent support) |

You can mix text and media parts freely in a single message. Text-only messages still accept a plain string for \`content\` — no migration needed.

**Model support:** Not all models support vision. Common vision models: \`anthropic/claude-3.5-sonnet\`, \`openai/gpt-4o\`, \`google/gemini-pro-vision\`. Browse the full catalog on the **AI models** page in the dashboard.

### Embeddings

Generate vector embeddings for semantic search, clustering, and other ML tasks:

\`\`\`json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
\`\`\`

**Response:** Standard OpenAI-compatible embedding response with usage data.

\`\`\`json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0023, -0.0091, ...]
    }
  ],
  "model": "openai/text-embedding-3-small",
  "usage": {
    "prompt_tokens": 5,
    "total_tokens": 5
  }
}
\`\`\`

**Batch input:** Pass an array of strings to embed multiple inputs in one request:

\`\`\`json
{
  "model": "openai/text-embedding-3-small",
  "input": ["first text", "second text", "third text"]
}
\`\`\`

| Parameter | Description |
|-----------|-------------|
| \`model\` | The embedding model to use (required) |
| \`input\` | Text string or array of strings to embed (required) |
| \`encoding_format\` | Output format: \`"float"\` (default) or \`"base64"\` |

**Available embedding models:**

| Model | ID | Dimensions |
|-------|-----|------------|
| Text Embedding 3 Small | \`openai/text-embedding-3-small\` | 1536 |
| Text Embedding 3 Large | \`openai/text-embedding-3-large\` | 3072 |
| Text Embedding Ada 002 | \`openai/text-embedding-ada-002\` | 1536 |

Embedding usage costs count against the same AI credits allowance as chat completions.

### Video generation

Some models in the catalog render **video** instead of text. Video generation is **asynchronous** — you submit a job, poll for its status, and download the result when it's ready (typically 30 seconds to several minutes per video).

**Submit a job:**

\`\`\`json
POST /v1/{app_id}/videos/completions
Authorization: Bearer {token}

{
  "model": "bytedance/seedance-2.0-fast",
  "prompt": "A golden retriever in a field of sunflowers, cinematic",
  "duration": 4,
  "resolution": "720p",
  "aspect_ratio": "16:9"
}
\`\`\`

Returns \`202 { job_id, status: "pending", polling_url }\`.

**Poll status** (every ~30s):

\`\`\`
GET /v1/{app_id}/videos/completions/{job_id}
Authorization: Bearer {token}
\`\`\`

Statuses progress \`pending → in_progress → completed\` (or \`failed\` / \`cancelled\` / \`expired\`). When \`completed\`, the response includes:

- \`content_urls\` — absolute URLs to GET the rendered MP4 (use the same Authorization header)
- \`charged_credits_usd\` — what was billed for this job (set on the first terminal poll)
- \`error\` — populated when \`status: "failed"\`

**Download:**

\`\`\`
GET /v1/{app_id}/videos/completions/{job_id}/content?index=0
Authorization: Bearer {token}
\`\`\`

Streams \`video/mp4\` bytes. The \`?index=\` parameter selects among multiple outputs when a model renders variants (defaults to 0).

**Wrong endpoint guard:** If you POST a video model to \`/chat/completions\`, you'll get \`400 USE_VIDEO_ENDPOINT\` with the right path in the message.

**Choosing a model:** Video models appear alongside chat / embedding models in \`GET /v1/{app_id}/ai/models\`. Video IDs commonly start with provider prefixes such as \`bytedance/seedance-\`, \`kwaivgi/kling-\`, \`pixverse/\`, or \`google/veo-\`.

**MCP shortcut:** Through the \`manage_ai\` MCP tool, use \`{ action: "submit_video", ... }\` and \`{ action: "poll_video", ... }\`.

### Available models

Butterbase supports a wide range of frontier and open-source models. Common models include:

| Model | ID |
|-------|-----|
| Claude 3.5 Sonnet | \`anthropic/claude-3.5-sonnet\` |
| Claude 3 Opus | \`anthropic/claude-3-opus\` |
| Claude 3 Haiku | \`anthropic/claude-3-haiku\` |
| GPT-4 Turbo | \`openai/gpt-4-turbo\` |
| GPT-4 | \`openai/gpt-4\` |
| GPT-3.5 Turbo | \`openai/gpt-3.5-turbo\` |
| Llama 3.1 70B | \`meta-llama/llama-3.1-70b-instruct\` |
| Llama 3.1 8B | \`meta-llama/llama-3.1-8b-instruct\` |

Browse the complete catalog (with current pricing) on the **AI models** page in the dashboard.

### AI Configuration

Configure AI settings per app:

**Get configuration:**
\`\`\`
GET /v1/{app_id}/ai/config
\`\`\`

**Update configuration:**
\`\`\`json
PUT /v1/{app_id}/ai/config
{
  "defaultModel": "anthropic/claude-3.5-sonnet",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-3.5-sonnet", "anthropic/claude-3-haiku"]
}
\`\`\`

| Setting | Description |
|---------|-------------|
| \`defaultModel\` | Model used when none is specified in the request |
| \`maxTokensPerRequest\` | Maximum tokens allowed per request (1 to 100,000). Requests exceeding this are capped automatically. |
| \`allowedModels\` | Restrict which models can be used. If set, requests for unlisted models are rejected. |

### Gateway mode (no app required)

In addition to the app-scoped endpoints above, Butterbase exposes several OpenAI-compatible endpoints at \`/v1/...\` (no \`app_id\` segment) for using the platform as a generic model gateway:

- \`POST /v1/chat/completions\` — authenticated
- \`POST /v1/embeddings\` — authenticated
- \`GET  /v1/models\` — authenticated (OpenAI-shape list)
- \`GET  /v1/public/models\` — **public** (no auth), returns rich catalog with pricing and context window

The request and response shapes for the authenticated endpoints are identical to the app-scoped variants — only the path differs. Drop-in compatible with the OpenAI SDK: point \`baseURL\` at \`https://api.butterbase.ai/v1\` and use a personal API key as the bearer token.

**Chat completions:**

\`\`\`json
POST /v1/chat/completions
Authorization: Bearer bb_sk_...

{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "max_tokens": 500,
  "stream": false
}
\`\`\`

**Embeddings:**

\`\`\`json
POST /v1/embeddings
Authorization: Bearer bb_sk_...

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?"
}
\`\`\`

**List models (authenticated, OpenAI-shape):**

\`\`\`
GET /v1/models
Authorization: Bearer bb_sk_...
\`\`\`

Response: \`{ "object": "list", "data": [{ "id": "...", "object": "model", "display_name": "..." }, ...] }\`

**Public model catalog (no auth):**

\`\`\`
GET /v1/public/models
\`\`\`

No authorization header required. Useful for unauthenticated documentation pages, marketing sites, and model pickers.

Response:

\`\`\`json
{
  "models": [
    {
      "id": "anthropic/claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "inputPricePerMTokens": 3.6,
      "outputPricePerMTokens": 18.0,
      "contextWindow": 200000
    }
  ]
}
\`\`\`

Prices are per 1 million tokens and reflect what your account is charged at request time. \`contextWindow\` may be \`null\` for models that don't report it.

**Authentication:** for the authenticated endpoints, use a platform JWT (for session-based clients) or a personal API key with the \`ai:gateway\` scope. See the next section.

**Errors** follow the OpenAI shape \`{ "error": { "message": "...", "type": "...", "code": "..." } }\`:

| Status | \`error.type\` | \`error.code\` | When |
|---|---|---|---|
| 401 | \`authentication_error\` | \`missing_credentials\` | No Authorization header. |
| 401 | \`authentication_error\` | \`invalid_api_key\` | Token is unknown, revoked, or expired. |
| 403 | \`permission_error\` | \`insufficient_scope\` | API key is missing the \`ai:gateway\` scope. |
| 402 | \`billing_error\` | \`insufficient_credits\` | Account balance is too low for the requested call. |
| 404 | \`invalid_request_error\` | \`model_not_found\` | Requested model id isn't available. |
| 400 | \`invalid_request_error\` | \`invalid_request\` | Request body failed validation. |
| 5xx | \`api_error\` | (varies) | Temporary upstream issue. Retry with backoff. |

### Personal API keys & the ai:gateway scope

To call the gateway endpoints from outside the dashboard, mint a personal API key with the \`ai:gateway\` scope:

\`\`\`json
POST /api-keys
Authorization: Bearer {jwt}

{
  "name": "my-cli",
  "scopes": ["ai:gateway"]
}
\`\`\`

The response contains the plaintext key once — store it immediately. Subsequent requests show only the prefix.

| Scope | Grants |
|---|---|
| \`*\` | Full access to all Butterbase APIs the user can use. |
| \`ai:gateway\` | Access to \`POST /v1/chat/completions\`, \`POST /v1/embeddings\`, and \`GET /v1/models\`. Nothing else. |

The dashboard at \`/api-keys\` lists and revokes keys; scoping a key to \`ai:gateway\` is currently done by calling \`POST /api-keys\` directly with the \`scopes\` field.

### AI Usage Tracking

View AI usage for an app:

\`\`\`
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
\`\`\`

**Response:**
\`\`\`json
{
  "totalTokens": 150000,
  "totalCost": 0.45,
  "byModel": {
    "anthropic/claude-3.5-sonnet": {
      "tokens": 120000,
      "cost": 0.40,
      "requests": 25
    },
    "anthropic/claude-3-haiku": {
      "tokens": 30000,
      "cost": 0.05,
      "requests": 10
    }
  }
}
\`\`\`

**Query parameters:**
- \`startDate\` — Start of range (ISO date, defaults to 30 days ago)
- \`endDate\` — End of range (ISO date, defaults to today)

### Using AI in serverless functions

You can call the AI gateway from within serverless functions. The runtime auto-injects \`BUTTERBASE_APP_ID\` and \`BUTTERBASE_API_URL\` into \`ctx.env\` — you only need to supply your own API key via \`envVars\`.

**Setup:** when deploying the function, add your API key:

\`\`\`json
{
  "envVars": {
    "BUTTERBASE_API_KEY": "bb_sk_..."
  }
}
\`\`\`

**Function code:**

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  // BUTTERBASE_APP_ID and BUTTERBASE_API_URL are auto-injected by the runtime.
  // BUTTERBASE_API_KEY must be set in envVars when deploying.
  const { BUTTERBASE_APP_ID, BUTTERBASE_API_URL, BUTTERBASE_API_KEY } = ctx.env;

  const aiResponse = await fetch(\`\${BUTTERBASE_API_URL}/v1/\${BUTTERBASE_APP_ID}/chat/completions\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${BUTTERBASE_API_KEY}\`
    },
    body: JSON.stringify({
      model: 'anthropic/claude-3-haiku',
      messages: [
        { role: 'user', content: 'Summarize this text: ...' }
      ],
      max_tokens: 200
    })
  });

  const result = await aiResponse.json();
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

### AI credits

AI usage cost counts against your plan's AI credits allowance when using the platform key:

| Plan | AI credits | Resets? |
|------|-----------|---------|
| Free | $0.10 | No — lifetime allowance across your account |
| Pro | $10.00/mo (then $0.10/credit overage) | Yes — resets each billing period, no rollover |
| Enterprise | Unlimited | — |

When Pro plan users exceed their included $10, they are not blocked — overage is billed at $0.10 per credit and an email notification is sent. Free plan users must upgrade to continue using AI after exhausting their $0.10 lifetime allowance.
`,

  meetings: `## AI Meetings

Spawn a meeting bot that joins a Zoom, Google Meet, Microsoft Teams, or Webex call and records + transcribes it. Billed against the same AI credits allowance as chat/embeddings.

### Spawn a bot

\`\`\`
POST /v1/{app_id}/ai/meetings
Authorization: Bearer {token}
Content-Type: application/json

{
  "meetingUrl": "https://zoom.us/j/12345...",
  "transcript": true,
  "recording": "mp4",
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" }
}
\`\`\`

Returns:

\`\`\`json
{
  "id": "c086e720-d319-44b8-82d8-3a363f2cd9f4",
  "status": "joining",
  "startedAt": "2026-06-11T17:01:29Z",
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" }
}
\`\`\`

| Field | Default | Notes |
|---|---|---|
| \`meetingUrl\` | required | Any Zoom / Meet / Teams / Webex meeting URL |
| \`transcript\` | \`true\` | When \`true\`, the call is transcribed in addition to being recorded |
| \`recording\` | \`"mp4"\` | \`"mp4"\` for video+audio, \`"audio_only"\` for audio only, \`false\` to skip |
| \`botName\` | \`"Butterbase Notetaker"\` | Display name attendees see when the bot joins. 1–64 chars |
| \`metadata\` | \`{}\` | Arbitrary string→string map. Keys may not start with \`bb_\` (reserved) |

### Get / list / stop

\`\`\`
GET    /v1/{app_id}/ai/meetings/{bot_id}     # current status + recording/transcript URLs (when ready)
GET    /v1/{app_id}/ai/meetings              # list bots (?status=&limit=&cursor=)
DELETE /v1/{app_id}/ai/meetings/{bot_id}     # force the bot to leave the call
\`\`\`

Possible \`status\` values: \`joining\`, \`waiting_room\`, \`in_call\`, \`recording\`, \`ended\`, \`done\`, \`fatal\`.

### Cost estimate

\`\`\`
GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes=30&transcript=true
\`\`\`

Returns the expected USD charge for a hypothetical session at the given duration.

### Webhooks (event-driven flow)

Configure a per-app forward URL once; Butterbase will then POST events to your URL whenever the bot's lifecycle advances or media is ready.

\`\`\`
PUT /v1/{app_id}/ai/meetings/webhook
Authorization: Bearer {token}
Content-Type: application/json

{
  "forward_url": "https://api.your-app.com/recall/events",
  "rotate_secret": true
}
\`\`\`

Returns:

\`\`\`json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://api.your-app.com/recall/events",
  "secret": "wsec_<base64url(32 random bytes)>"
}
\`\`\`

Store the \`secret\` — it's only returned on initial create and on \`rotate_secret: true\`.

**Subscribed events** (default):

| Event | Fires when |
|---|---|
| \`bot.in_call_recording\` | Bot has joined and started recording |
| \`bot.done\` | Bot has left the call cleanly; recording is finalised |
| \`bot.fatal\` | Bot failed terminally |
| \`recording.done\` | Recording artifact is ready for download |
| \`transcript.done\` | Transcript artifact is ready for download |
| \`transcript.failed\` | Transcription failed for this recording |

**Body & headers** delivered to your forward URL:

\`\`\`
POST /your/configured/path
content-type: application/json
x-bb-event: bot.done
x-bb-signature: v1,<base64 HMAC-SHA256>

{
  "event": "bot.done",
  "data": { "bot": { "id": "c086e720-...", "metadata": { ... } }, ... }
}
\`\`\`

**Verifying the signature.** Recompute \`base64(HMAC-SHA256(<your_app_secret>, <raw body>))\`, prefix with \`v1,\`, and compare to \`x-bb-signature\` in constant time. The secret is the \`wsec_...\` value Butterbase returned to you on PUT or rotate; it's unique to your app, and the platform stores it AES-256-GCM-encrypted so only your app and the platform ever see the plaintext.

### Webhooks carry IDs, not URLs

The \`recording.done\` and \`transcript.done\` event payloads contain the **recording/transcript ID**, not the download URL — by design, since the URLs are short-lived and re-minted on demand. To get the actual download URL, follow up with:

\`\`\`
GET /v1/{app_id}/ai/meetings/{bot_id}
\`\`\`

and read \`recordingUrl\` / \`transcriptUrl\` from the normalized response. Example function handler:

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const event = req.headers.get('x-bb-event');
  const body = await req.json();
  const botId = body?.data?.bot?.id;

  if (event === 'recording.done' || event === 'transcript.done' || event === 'bot.done') {
    const res = await fetch(
      \`\${ctx.env.BUTTERBASE_API_URL}/v1/\${ctx.env.BUTTERBASE_APP_ID}/ai/meetings/\${botId}\`,
      { headers: { authorization: \`Bearer \${ctx.env.BUTTERBASE_API_KEY}\` } },
    );
    const bot = await res.json();
    // bot.recordingUrl / bot.transcriptUrl are now populated.
    await ctx.db.query(
      'UPDATE meetings SET recording_url=$1, transcript_url=$2 WHERE bot_id=$3',
      [bot.recordingUrl, bot.transcriptUrl, botId],
    );
  }
  return new Response('ok');
}
\`\`\`

### Complete worked example

A minimal app that records every Zoom/Meet/Teams/Webex call and persists the resulting transcript and recording URLs.

**1. Schema** — one table to track each bot's lifecycle:

\`\`\`json
{
  "tables": {
    "meetings": {
      "columns": {
        "id":             { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "bot_id":         { "type": "text", "nullable": false, "unique": true },
        "meeting_url":    { "type": "text", "nullable": false },
        "status":         { "type": "text", "nullable": false, "default": "'pending'" },
        "last_event":     { "type": "text" },
        "events_count":   { "type": "integer", "nullable": false, "default": "0" },
        "recording_url":  { "type": "text" },
        "transcript_url": { "type": "text" },
        "created_at":     { "type": "timestamptz", "nullable": false, "default": "now()" },
        "updated_at":     { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": { "meetings_bot_id_idx": { "columns": ["bot_id"], "unique": true } }
    }
  }
}
\`\`\`

**2. Spawn function** — \`POST /fn/spawn-bot\` accepts a meeting URL, asks the meetings primitive to join, and inserts a tracking row:

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { meetingUrl } = await req.json();
  const res = await fetch(
    \`\${ctx.env.BUTTERBASE_API_URL}/v1/\${ctx.env.BUTTERBASE_APP_ID}/ai/meetings\`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: \`Bearer \${ctx.env.BUTTERBASE_API_KEY}\`,
      },
      body: JSON.stringify({ meetingUrl, transcript: true, recording: 'mp4' }),
    },
  );
  const bot = await res.json();
  if (!res.ok) return new Response(JSON.stringify(bot), { status: 502 });

  await ctx.db.query(
    'INSERT INTO meetings (bot_id, meeting_url, status, last_event) VALUES ($1, $2, $3, $4)',
    [bot.id, meetingUrl, bot.status ?? 'joining', 'spawn'],
  );
  return new Response(JSON.stringify({ bot_id: bot.id, status: bot.status }), {
    headers: { 'content-type': 'application/json' },
  });
}
\`\`\`

Deploy with \`BUTTERBASE_API_KEY\` set in \`envVars\`. \`BUTTERBASE_API_URL\` and \`BUTTERBASE_APP_ID\` are auto-injected.

**3. Configure the forward webhook** — one PUT, store the \`secret\` in your function's env:

\`\`\`bash
curl -X PUT https://api.butterbase.ai/v1/{app_id}/ai/meetings/webhook \\
  -H "authorization: Bearer bb_sk_..." \\
  -H "content-type: application/json" \\
  -d '{ "forward_url": "https://api.butterbase.ai/v1/{app_id}/fn/meetings-webhook", "rotate_secret": true }'
# → { "secret": "wsec_..." }   ← copy this once, set it on the function below
\`\`\`

**4. Webhook function** — \`POST /fn/meetings-webhook\` verifies the per-app HMAC, follows up with a GET when artifacts are ready, and updates the row:

\`\`\`typescript
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacBase64(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const rawBody = await req.text();
  const event = req.headers.get('x-bb-event') ?? '';
  const sig = req.headers.get('x-bb-signature') ?? '';

  // wsec_... returned by PUT, stored in envVars.MEETINGS_WEBHOOK_SECRET.
  const expected = \`v1,\${await hmacBase64(ctx.env.MEETINGS_WEBHOOK_SECRET, rawBody)}\`;
  if (!timingSafeEqual(expected, sig)) {
    return new Response('invalid signature', { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const botId = payload?.data?.bot?.id;
  if (!botId) return new Response('ok');

  let nextStatus: string | null = null;
  if (event === 'bot.in_call_recording') nextStatus = 'recording';
  else if (event === 'bot.done') nextStatus = 'done';
  else if (event === 'bot.fatal') nextStatus = 'fatal';

  let recordingUrl: string | null = null;
  let transcriptUrl: string | null = null;
  if (event === 'recording.done' || event === 'transcript.done' || event === 'bot.done') {
    const res = await fetch(
      \`\${ctx.env.BUTTERBASE_API_URL}/v1/\${ctx.env.BUTTERBASE_APP_ID}/ai/meetings/\${botId}\`,
      { headers: { authorization: \`Bearer \${ctx.env.BUTTERBASE_API_KEY}\` } },
    );
    if (res.ok) {
      const bot = await res.json();
      recordingUrl = bot.recordingUrl ?? null;
      transcriptUrl = bot.transcriptUrl ?? null;
    }
  }

  await ctx.db.query(
    \`UPDATE meetings
        SET status = COALESCE($2, status),
            last_event = $3,
            recording_url = COALESCE($4, recording_url),
            transcript_url = COALESCE($5, transcript_url),
            events_count = events_count + 1,
            updated_at = now()
      WHERE bot_id = $1\`,
    [botId, nextStatus, event, recordingUrl, transcriptUrl],
  );
  return new Response(JSON.stringify({ ok: true }));
}
\`\`\`

Deploy with \`envVars: { MEETINGS_WEBHOOK_SECRET: 'wsec_...', BUTTERBASE_API_KEY: 'bb_sk_...' }\` and \`trigger: { type: 'http', config: { method: 'POST', path: '/meetings-webhook', auth: 'none' } }\`. \`auth: 'none'\` is correct — the HMAC inside is what authenticates the caller.

**5. Use it**:

\`\`\`bash
curl -X POST https://{app_id}.api.butterbase.ai/fn/spawn-bot \\
  -H "content-type: application/json" \\
  -d '{ "meetingUrl": "https://zoom.us/j/12345..." }'
# → { "bot_id": "...", "status": "joining" }
\`\`\`

The bot joins the call. Events arrive on \`meetings-webhook\` as the lifecycle advances, the row is kept current, and \`recording_url\` + \`transcript_url\` populate when Recall finishes processing the artifacts (usually a minute or two after the call ends).

### Usage & billing

\`\`\`
GET /v1/{app_id}/ai/meetings/usage
\`\`\`

Returns the last 100 \`actor_usage_logs\` rows for the app — one row per dimension (\`recording\` and, when transcript was enabled, \`transcription\`) per completed session.

Meetings credits are drawn from the same AI credits pool as chat and embeddings. The cost is computed at terminal events (\`bot.done\` / \`bot.fatal\` for recording, \`transcript.done\` for transcription) from actual measured duration, not from the up-front estimate. Up-front, the platform reserves a small lease against your balance and refunds the unused portion on settle — so a failed join refunds in full.

Free / Pro / Enterprise allowances are the same as documented under the \`ai\` topic.

### Availability

\`\`\`
GET /v1/ai/meetings/_status
\`\`\`

Returns \`{ "available": true | false }\` for the deployment. Use this if you want your UI to hide the spawn button when the platform is in degraded mode.
`,

  billing: `## Billing & Plans

Butterbase offers three plan tiers. Each plan includes a set of monthly usage allowances. When you exceed a limit on the Free plan, your account is soft-locked until usage drops or you upgrade. Pro plan users can exceed limits with overage charges.

### Plans

| | Free | Pro | Enterprise |
|---|---|---|---|
| **Price** | $0/mo | $25/mo | Custom |
| **AI credits** | $0.10 (lifetime) | $10/mo (then $0.10/credit) | Unlimited |
| **MAU** | 50,000 | 100,000 (then $0.00325/MAU) | Unlimited |
| **Database size** | 500 MB | 8 GB (then $0.125/GB) | Unlimited |
| **Bandwidth** | 5 GB | 250 GB (then $0.09/GB) | Unlimited |
| **File storage** | 1 GB | 100 GB (then $0.021/GB) | Unlimited |
| **Function invocations** | 50,000/mo | 500,000/mo | Unlimited |
| **Custom domain** | — | Yes | Yes |
| **Priority support** | — | Yes | Yes |
| **SOC2** | — | — | Yes |
| **SSO** | — | — | Yes |
| **HIPAA** | — | — | Paid add-on |
| **SLA** | — | — | Yes |

Free projects are paused after 1 week of inactivity.

### Usage meters

Butterbase tracks usage across these categories per billing period:

| Meter | What it measures |
|-------|-----------------|
| **ai_credits** | AI model usage cost in USD |
| **storage_bytes** | Total file storage used across all apps |
| **lambda_invocations** | Total serverless function executions |
| **bandwidth_bytes** | Data transferred out (API responses, file downloads) |

### Checking your usage

View your current usage, plan limits, and usage percentages through the dashboard or API:

\`\`\`
GET /dashboard/billing
\`\`\`

**Response includes:**
- Current plan details and limits
- Usage totals for each meter
- Usage percentages (how close you are to each limit)
- Subscription status and billing period

### Usage history

View daily usage over a date range:

\`\`\`
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=api_calls
\`\`\`

**Query parameters:**
- \`startDate\` — Start of range (ISO date, defaults to 30 days ago)
- \`endDate\` — End of range (ISO date, defaults to today)
- \`meterType\` — Optional filter: \`storage_bytes\`, \`ai_tokens\`, \`lambda_invocations\`, or \`bandwidth_bytes\`

### Upgrading your plan

Start a checkout session to upgrade:

\`\`\`json
POST /dashboard/billing/checkout
{
  "planId": "pro"
}
\`\`\`

Returns a \`url\` to complete payment. After payment, your limits are updated immediately.

### Managing your subscription

Access the billing portal to update payment methods, view invoices, or cancel:

\`\`\`
POST /dashboard/billing/portal
\`\`\`

Returns a \`url\` to the self-service billing portal.

### Monetizing your product (Stripe Connect)

This is separate from your own Butterbase subscription. It lets **your app** sell subscriptions to **your end users** using **Stripe Connect**. You onboard a Connect account for the app, define one or more **plans** (price, billing interval, feature list), and your users subscribe through Checkout sessions managed by the platform.

**Developer (platform auth — you own the app)**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/billing/connect/onboard | Start Stripe Connect onboarding. Returns \`accountId\` and \`onboardingUrl\` for the seller to complete setup in Stripe. |
| GET | /v1/{app_id}/billing/connect/status | Whether Connect onboarding is complete and payouts are ready. |
| POST | /v1/{app_id}/billing/plans | Create a subscription plan: \`name\`, \`priceCents\`, \`interval\` (\`month\` or \`year\`), optional \`features\` (string array). |
| GET | /v1/{app_id}/billing/plans | List plans for this app (public catalog). |
| PUT | /v1/{app_id}/billing/plans/{plan_id} | Update plan fields (\`name\`, \`priceCents\`, \`active\`, \`features\`). |

**End users (app JWT — people using your product)**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/billing/subscribe | Start a subscription. Body: \`planId\` (UUID), optional \`successUrl\` and \`cancelUrl\`. Returns \`sessionId\` and \`url\` to Stripe Checkout. |
| GET | /v1/{app_id}/billing/subscription | Current subscription for the signed-in user, or \`null\`. |
| POST | /v1/{app_id}/billing/cancel | Cancel at period end (no immediate cut-off). |

**Webhooks (operators)**

Stripe sends Connect events to **POST /webhooks/stripe/connect**. Configure the endpoint and signing secret in your Stripe dashboard and set **STRIPE_CONNECT_WEBHOOK_SECRET** in the control API environment. This keeps subscription status in sync when payments succeed or fail.

If you do not need Connect, you can still build checkout flows yourself (for example in a **serverless function**) using Stripe directly and store purchase state in your app tables.

#### One-time purchases (ecommerce)

For selling digital products, physical goods, or one-time access, use **products** instead of plans.

**Developer (platform auth — you own the app)**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/billing/products | Create a product: \`name\`, \`priceCents\`, optional \`description\`, \`metadata\`. |
| GET | /v1/{app_id}/billing/products | List products for this app (public catalog). |
| PUT | /v1/{app_id}/billing/products/{product_id} | Update product fields (\`name\`, \`priceCents\`, \`active\`, \`description\`, \`metadata\`). |

**End users (app JWT — people using your product)**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/{app_id}/billing/purchase | Purchase a product. Body: \`productId\` (UUID), optional \`successUrl\` and \`cancelUrl\`. Returns \`sessionId\`, \`url\`, and \`orderId\`. |
| GET | /v1/{app_id}/billing/orders | List all orders for the signed-in user. |
| GET | /v1/{app_id}/billing/orders/{order_id} | Get details for a specific order. |



**Webhooks:** Same endpoint as subscriptions (\`POST /webhooks/stripe/connect\`). The platform handles:
- \`checkout.session.completed\` (mode: payment) — marks order as paid
- \`payment_intent.payment_failed\` — marks order as failed
- \`charge.refunded\` — marks order as refunded

**Order statuses:**
- \`pending\` — Checkout session created, payment not yet completed
- \`paid\` — Payment successful
- \`failed\` — Payment failed
- \`refunded\` — Payment was refunded

**Example flow:**
1. Developer creates product: \`POST /v1/{app_id}/billing/products\`
2. End user initiates purchase: \`POST /v1/{app_id}/billing/purchase\`
3. User completes payment in Stripe Checkout
4. Webhook fires, order status updates to \`paid\`
5. User can view order: \`GET /v1/{app_id}/billing/orders/{order_id}\`

### What happens when you exceed a limit

**Free plan:** Your account is soft-locked. You can still read data and access the dashboard, but write operations (creating apps, deploying functions, uploading files) are blocked until usage drops below the limit or you upgrade.

**Pro plan:** Usage beyond your included limits is not blocked — overage charges apply at the rates shown in the plan table above. You will receive an email notification when you exceed a limit. If payment fails, a 7-day grace period begins. After the grace period, the account is suspended until payment is resolved.

### Account statuses

| Status | Meaning |
|--------|---------|
| \`active\` | Normal operation |
| \`soft_locked\` | Free plan limits exceeded — upgrade or reduce usage |
| \`suspended\` | Payment failure past grace period — resolve payment to restore access |
`,

  platform: `## Platform endpoints & operators

Topics that complement the REST, auth, and MCP tool reference: remote MCP access, agent guidance, per-app subdomains, and product feedback.

### MCP over HTTP

The same MCP tool surface as the local server is available over HTTP on the control API:

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTP MCP session. Send **Authorization: Bearer {platform_api_key}** so requests run as your account. |

Use this when your assistant or automation cannot use stdio MCP but can call HTTPS (for example hosted agents or CI).

### Agent guidance (\`/llms.txt\`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | /llms.txt | Plain-text guidance for LLM agents: quick start, common patterns, error shape, and response metadata. Fetched from the same host as the control API. |

This is complementary to the **butterbase_docs** MCP tool (which reads the documentation embedded in the MCP server).

### Per-app subdomains

When subdomain routing is enabled in your deployment, each app has a **subdomain** (set when the app is created or derived from the app name). Traffic to **https://{subdomain}.{base_domain}** resolves the app from the **Host** header, so you omit **{app_id}** from paths.

Typical mappings (same behavior as the equivalent **/v1/{app_id}/...** and **/auth/{app_id}/...** routes):

| Subdomain path | Equivalent purpose |
|----------------|-------------------|
| /data/{table} | Data API CRUD for \`{table}\` |
| /fn/{function_name} | Invoke serverless function |
| /auth/signup, /auth/login, /auth/me, ... | End-user auth |
| /storage/upload, /storage/objects, ... | File storage |
| /schema, /schema/apply, /migrations | Schema and migrations |

The exact **base domain** depends on environment configuration. If subdomains are disabled, use paths that include **{app_id}** as documented elsewhere.

### Product suggestions

**MCP tool:** **submit_suggestion** — submit feedback without raw HTTP.

**HTTP (API key):**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /suggestions | Submit feedback. **category** (required): \`bug_report\`, \`feature_request\`, \`improvement\`, or \`documentation\`. **description** (required). Optional: **severity** (\`low\` \| \`medium\` \| \`high\` \| \`critical\`), **affected_tool**, **proposed_solution**, **source** (\`agent\` \| \`human_prompted\`), **app_id**, **agent_context**. |

Recent MCP tool calls may be attached automatically when you use a platform API key, to help reproduce issues.

### Rate limiting and errors

Sensitive routes (especially **auth**) use strict per-route rate limits documented in the auth section. Other routes may apply additional limits depending on deployment. Error responses can include structured **error** objects with **code**, **message**, and **remediation** fields — follow **remediation** before retrying.

### Error reporting

When the control API is configured with error monitoring (for example Sentry), unhandled failures may be reported to operators to improve reliability. This does not replace your own logging in apps and functions.
`,

  regions: `## Regions

When you create an app, you choose a region. The app's database, files, and serverless functions live in that region. Your client code keeps using a single API URL — \`https://api.butterbase.ai\` — and requests are routed to the right region for you.

### Discovering the supported regions

The supported list is always available at runtime. Prefer the live source over hardcoding region slugs.

**MCP**

\`\`\`
list_regions()
\`\`\`

**REST (public, no auth)**

\`\`\`
GET /v1/regions
→ { "regions": ["us-east-1", "us-west-2"] }
\`\`\`

More regions are coming soon.

### Picking a region at app creation

Region is optional. If omitted, the platform picks a sensible default.

**MCP**

\`\`\`
init_app({ name: "my-app", region: "us-west-2" })
\`\`\`

**REST**

\`\`\`
POST /init
{ "name": "my-app", "region": "us-west-2" }
\`\`\`

### What lives in a region

Stays in the app's home region:
- Database
- Serverless functions
- File storage
- End-user accounts and sessions

Global (unaffected by region choice):
- The API URL — \`https://api.butterbase.ai\` works from anywhere
- Frontend deployments — served from a global edge network
- The Butterbase dashboard, billing, and platform-level operations

### Moving an app between regions

\`\`\`
manage_app({ action: "move", app_id: "app_abc123", dest_region: "us-east-1" })
\`\`\`

While the move runs, the app stays available for reads. Writes pause briefly during the cutover and resume automatically once the move completes. Typically takes a few minutes, depending on data size.

Check progress:

\`\`\`
manage_app({ action: "move_status", app_id: "app_abc123", migration_id: "<id from move>" })
\`\`\`

You cannot start another move while one is already in progress for the same app.

### When to use a specific region

- **Where your users are** — pick the region closest to most of them. Round-trip latency dominates perceived app speed.
- **Data residency** — if you need data to stay in a specific jurisdiction, pick a region in that jurisdiction. Reach out for region requests we don't support yet.
- **You can change your mind** — apps aren't locked to their initial region.
`,

  sdk: `## SDK (@butterbase/sdk)

The official TypeScript SDK for Butterbase. Works in browser, Node.js, and Deno environments.

### Installation

\`\`\`bash
npm install @butterbase/sdk
\`\`\`

### Quick start

\`\`\`typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  anonKey: 'your-anon-key' // Optional, for public access
});
\`\`\`

### Data operations

\`\`\`typescript
// Query
const { data, error } = await butterbase
  .from('posts')
  .select('*')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(10);

// Insert
const { data, error } = await butterbase
  .from('posts')
  .insert({ title: 'Hello World', content: 'My first post' });

// Update
const { data, error } = await butterbase
  .from('posts')
  .update({ status: 'archived' })
  .eq('id', '123');

// Delete
const { data, error } = await butterbase
  .from('posts')
  .delete()
  .eq('id', '123');
\`\`\`

### Query operators

- \`eq(column, value)\` — Equal to
- \`neq(column, value)\` — Not equal to
- \`gt(column, value)\` — Greater than
- \`gte(column, value)\` — Greater than or equal to
- \`lt(column, value)\` — Less than
- \`lte(column, value)\` — Less than or equal to
- \`like(column, pattern)\` — Pattern matching (case-sensitive)
- \`ilike(column, pattern)\` — Pattern matching (case-insensitive)
- \`in(column, values)\` — Value in array
- \`is(column, value)\` — Is null/true/false

### Query modifiers

- \`select(columns)\` — Select specific columns
- \`order(column, options)\` — Order results
- \`limit(count)\` — Limit results
- \`offset(count)\` — Skip results

### Authentication

Sessions are automatically persisted to \`localStorage\` and restored on page refresh. Access tokens are automatically refreshed before they expire.

\`\`\`typescript
// Sign up
const { data, error } = await butterbase.auth.signUp({
  email: 'user@example.com',
  password: 'secure123'
});

// Sign in
const { data, error } = await butterbase.auth.signIn({
  email: 'user@example.com',
  password: 'secure123'
});

// Get current user
const { data: user } = await butterbase.auth.getUser();

// Sign out
await butterbase.auth.signOut();

// Refresh session manually
const { data } = await butterbase.auth.refreshSession();

// OAuth
const { url } = butterbase.auth.signInWithOAuth({
  provider: 'google',
  redirectTo: 'http://localhost:3000/callback'
});
window.location.href = url;
\`\`\`

### Auth state changes

\`\`\`typescript
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'SESSION_RESTORED'
  console.log(event, session?.user);
});
\`\`\`

### Custom session storage

\`\`\`typescript
// Disable persistence
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  persistSession: false,
});

// Custom adapter (e.g. React Native)
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  sessionStorage: myCustomStorage, // implements { getItem, setItem, removeItem }
});
\`\`\`

### Storage

\`\`\`typescript
const { data, error } = await butterbase.storage.upload(file);
const { data } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);
\`\`\`

### Functions

\`\`\`typescript
const { data, error } = await butterbase.functions.invoke('my-function', {
  body: { key: 'value' },
  method: 'POST'
});
\`\`\`

### TypeScript support

All methods return \`ButterbaseResponse<T>\` with proper type inference:

\`\`\`typescript
interface Post {
  id: string;
  title: string;
  content: string;
  status: 'draft' | 'published';
}

const { data, error } = await butterbase
  .from<Post>('posts')
  .select('*')
  .eq('status', 'published');
// data is typed as Post[] | null
\`\`\`

### Deno usage

\`\`\`typescript
import { createClient } from 'npm:@butterbase/sdk';

const butterbase = createClient({
  appId: Deno.env.get('BUTTERBASE_APP_ID')!,
  apiUrl: Deno.env.get('BUTTERBASE_API_URL')!,
});
\`\`\`

### Admin: Custom Domains

\`\`\`typescript
// List custom domains
const { data } = await butterbase.admin.domains.list();

// Add a domain
const { data } = await butterbase.admin.domains.add('app.example.com');
// data.cname_target \u2192 'butterbase.dev'
// data.instructions \u2192 CNAME setup steps

// Check status
const { data } = await butterbase.admin.domains.getStatus(domainId);

// Re-verify
const { data } = await butterbase.admin.domains.verify(domainId);

// Remove
await butterbase.admin.domains.remove(domainId);
\`\`\`

### Migration from 0.x to 1.0

The \`authUrl\` parameter has been removed. All auth endpoints now run on the same URL as the API — just use \`apiUrl\`.
`,

  cli: `## CLI (@butterbase/cli)

Command-line tool for Butterbase project scaffolding and backend management.

### Installation

\`\`\`bash
npm install -g @butterbase/cli
\`\`\`

### Quick start

\`\`\`bash
# Login with your API key
butterbase login

# Create a new app
butterbase apps create my-app

# Set as current app
butterbase apps use app_abc123

# Get current schema
butterbase schema get --output schema.json

# Apply schema changes
butterbase schema apply schema.json

# Deploy a function
butterbase functions deploy ./functions/hello.ts

# Upload a file
butterbase storage upload ./image.png
\`\`\`

### Authentication

\`\`\`bash
butterbase login
butterbase logout
\`\`\`

### Configuration

\`\`\`bash
# Show current config
butterbase config get

# Set endpoint
butterbase config set endpoint https://api.butterbase.ai

# Set API key
butterbase config set apiKey bb_sk_...
\`\`\`

Configuration is stored in \`~/.butterbase/config.json\`. Project-level config can be placed in \`.butterbase/config.json\` (takes precedence over global).

### Apps

\`\`\`bash
butterbase apps list
butterbase apps create my-app
butterbase apps use app_abc123
butterbase apps delete app_abc123
\`\`\`

### Schema

\`\`\`bash
# Get current schema
butterbase schema get

# Save to file
butterbase schema get --output schema.json

# Preview changes (dry-run)
butterbase schema apply schema.json --dry-run

# Apply changes
butterbase schema apply schema.json

# Apply with custom migration name
butterbase schema apply schema.json --name "add_users_table"

# Use specific app
butterbase schema get --app app_abc123
\`\`\`

### Functions

\`\`\`bash
# List deployed functions
butterbase functions list

# Deploy function
butterbase functions deploy ./functions/hello.ts

# Deploy with custom name
butterbase functions deploy ./functions/hello.ts --name my-function

# Deploy cron function
butterbase functions deploy ./functions/cleanup.ts --trigger cron

# View logs
butterbase functions logs my-function

# Error logs only
butterbase functions logs my-function --level error

# Limit log count
butterbase functions logs my-function --limit 50
\`\`\`

### Storage

\`\`\`bash
butterbase storage list
butterbase storage upload ./image.png
butterbase storage delete obj_abc123
\`\`\`

### Custom Domains

\`\`\`bash
# List custom domains
butterbase domains list

# Add a domain
butterbase domains add app.example.com

# Check verification status
butterbase domains status <domain-id>

# Re-verify a pending domain
butterbase domains verify <domain-id>

# Remove a domain
butterbase domains delete <domain-id>
\`\`\`

### Global options

Most commands support \`--app\` to target a specific app:

\`\`\`bash
butterbase schema get --app app_abc123
butterbase functions list --app app_abc123
butterbase storage list --app app_abc123
\`\`\`

If \`--app\` is not provided, the CLI uses the current app set with \`butterbase apps use\`.

### Environment variables

- \`BUTTERBASE_API_KEY\` — API key
- \`BUTTERBASE_ENDPOINT\` — API endpoint URL

### Plugin Integration

Set up Claude Code / MCP integration for an existing project:

\`\`\`bash
butterbase plugin setup
\`\`\`

This generates a \`.mcp.json\` file configuring the Butterbase MCP server.

For guided skills (build-app, schema-design, deploy, debug-rls, functions, contributing):

\`\`\`bash
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills
claude plugin install butterbase
\`\`\`
`,

  realtime: `## Realtime WebSockets

Butterbase provides real-time data change notifications via WebSocket connections. When enabled on a table, any INSERT, UPDATE, or DELETE is broadcast to connected clients.

### Enabling realtime

Use the \`manage_realtime\` MCP tool with action: "configure":

\`\`\`
manage_realtime({ app_id: "app_abc123", action: "configure", tables: ["messages", "notifications"] })
\`\`\`

This installs database triggers that capture changes and broadcast them via pg_notify.

### Connecting via WebSocket

Connect to: \`ws://api.butterbase.local/v1/{app_id}/realtime\`

Authentication can be passed in two ways:

**Option 1: Authorization header** (Node.js / server-side clients)
- End-user JWT: \`Authorization: Bearer <end_user_jwt>\` — RLS enforced, only sees permitted rows
- API key: \`Authorization: Bearer bb_sk_...\` — service role, sees all changes
- No header: anonymous role

**Option 2: Query parameter** (browser clients — recommended)
- \`?token=<end_user_jwt>\` — the browser WebSocket API does not support custom headers, so pass the token as a query parameter instead
- \`?token=bb_sk_...\` — API key via query parameter
- Example: \`wss://api.butterbase.ai/v1/app_abc123/realtime?token=eyJhbG...\`

### Client protocol

Subscribe to tables after connecting:

\`\`\`json
// Client → Server
{ "type": "subscribe", "table": "messages" }
{ "type": "unsubscribe", "table": "messages" }

// Server → Client
{ "type": "connected", "app_id": "app_abc123", "role": "butterbase_user" }
{ "type": "subscribed", "table": "messages" }
{ "type": "change", "table": "messages", "op": "INSERT", "record": { "id": "...", "text": "hello" }, "old_record": null, "timestamp": "2026-04-09T..." }
{ "type": "change", "table": "messages", "op": "UPDATE", "record": { "id": "...", "text": "updated" }, "old_record": { "id": "...", "text": "hello" }, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "DELETE", "record": null, "old_record": { "id": "...", "text": "updated" }, "timestamp": "..." }
{ "type": "heartbeat", "timestamp": "..." }
{ "type": "error", "message": "..." }
\`\`\`

### JavaScript client example

\`\`\`javascript
// Browser — pass token as query parameter
const token = 'eyJhbG...'; // end-user JWT
const ws = new WebSocket(\`wss://api.butterbase.ai/v1/app_abc123/realtime?token=\${token}\`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', table: 'messages' }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'change') {
    console.log(msg.op, msg.table, msg.record);
  }
};
\`\`\`

\`\`\`javascript
// Node.js — can use Authorization header instead
const ws = new WebSocket('wss://api.butterbase.ai/v1/app_abc123/realtime', {
  headers: { Authorization: 'Bearer <jwt>' }
});
\`\`\`

### Row-Level Security

RLS is enforced on realtime events. If a table has RLS policies:
- \`butterbase_user\` subscribers only receive changes for rows they can \`SELECT\`
- \`butterbase_service\` subscribers receive all changes
- \`butterbase_anon\` subscribers receive changes based on anon policies

### MCP tools

| Tool | Description |
|------|-------------|
| \`manage_realtime(app_id, action: "configure", tables)\` | Enable realtime on tables |
| \`manage_realtime(app_id, action: "get")\` | View current realtime configuration |

### Subscription Filters

Subscribe to a subset of changes by providing a filter object:

\`\`\`json
{ "type": "subscribe", "table": "messages", "filter": { "channel_id": "abc" } }
\`\`\`

Only changes where \`channel_id = 'abc'\` will be delivered. Filters match on exact column equality. Omit \`filter\` to receive all changes on the table.

### Presence Tracking

Clients can opt into presence tracking to see who else is connected:

\`\`\`json
// Opt in with metadata
{ "type": "presence_track", "metadata": { "name": "Alice", "cursor": { "x": 10, "y": 20 } } }

// Update metadata (e.g. cursor moved)
{ "type": "presence_update", "metadata": { "cursor": { "x": 50, "y": 60 } } }
\`\`\`

Server broadcasts to all other presence-tracking clients in the same app:

\`\`\`json
{ "type": "presence_state", "clients": [{ "client_id": "...", "user_id": "...", "metadata": {...} }] }
{ "type": "presence_join", "client_id": "...", "user_id": "...", "metadata": {...} }
{ "type": "presence_update", "client_id": "...", "metadata": {...} }
{ "type": "presence_leave", "client_id": "...", "user_id": "..." }
\`\`\`

Presence is in-memory only — it resets on server restart (clients reconnect automatically).

### WebSocket Triggers

Deploy serverless functions that fire when clients send custom events:

\`\`\`
deploy_function({
  app_id: "app_abc123",
  name: "handle-chat",
  code: "export async function handler(req, ctx) { const { event, payload } = await req.json(); return new Response(JSON.stringify({ echo: payload })); }",
  trigger: { type: "websocket", config: { event: "chat_message" } }
})
\`\`\`

Then clients send events over the WebSocket connection:

\`\`\`json
{ "type": "event", "event": "chat_message", "payload": { "text": "hello" } }
\`\`\`

The function executes and the response is returned:

\`\`\`json
{ "type": "event_response", "event": "chat_message", "data": { "echo": { "text": "hello" } } }
\`\`\`

### Limitations

- Tables must exist before enabling realtime
- The full row is sent on each change (no column filtering yet)
- Events during LISTEN reconnection may be lost — clients should re-fetch state on reconnect
`,

  rag: `## RAG (Retrieval-Augmented Generation)

Butterbase includes built-in RAG that lets you upload documents, automatically chunk, embed, and index them, then query with natural language. It is a one-call operation — no need to set up pgvector, chunking pipelines, or embedding infrastructure manually.

### Collections

A collection is a namespace for related documents (e.g., "support-docs", "product-manual"). Create one with the \`manage_rag_content\` MCP tool (action: "create_collection").

- **Name** must be lowercase alphanumeric with hyphens or underscores (e.g. \`support-docs\`, \`product_manual\`)

**Access modes** control who can query documents in the collection:

| Mode | Behavior |
|------|----------|
| \`private\` (default) | Each user can only query their own documents |
| \`shared\` | All authenticated users can query all documents in the collection |
| \`custom\` | No auto-policies are created — define your own RLS rules |

### Ingesting Documents

There are two ways to ingest content:

1. **From storage** — Upload a file first via \`manage_storage\` (action: "upload_url"), then call \`manage_rag_content\` (action: "ingest") with the \`storage_object_id\` returned by the upload.
2. **Raw text** — Pass text directly using the \`text\` parameter of \`manage_rag_content\` (action: "ingest").

**Supported file types:** PDF, TXT, MD, CSV, HTML, DOCX, XLSX, PPTX

Ingestion is asynchronous. The call returns immediately with a document ID and a \`"pending"\` status. Documents go through:

\`\`\`
pending → processing → ready
\`\`\`

If something goes wrong, the status becomes \`failed\`. Check status at any time with \`manage_rag_content\` (action: "status").

### Querying

Use \`rag_query\` with a natural language question to search a collection. The response contains ranked chunks with similarity scores.

| Parameter | Description |
|-----------|-------------|
| \`query\` | Natural language question (required) |
| \`top_k\` | Number of chunks to return (default 5) |
| \`threshold\` | Minimum similarity score — chunks below this are excluded |
| \`filter\` | Metadata filter to narrow results |
| \`synthesize\` | Set to \`true\` to get an AI-generated answer based on the retrieved chunks |

When \`synthesize\` is enabled, the response includes an \`answer\` field with a natural language answer derived from the matched chunks. The default synthesis model is \`anthropic/claude-haiku-4.5\`; override with the \`model\` parameter.

### Example Workflow

\`\`\`
1. manage_rag_content (action: "create_collection") → name: "support-docs"
2. manage_storage (action: "upload_url") → upload a PDF
3. manage_rag_content (action: "ingest")  → storage_object_id from step 2
4. manage_rag_content (action: "status")  → wait for "ready"
5. rag_query                              → "What is the refund policy?"
\`\`\`

### MCP Tools

| Tool | What it does |
|------|--------------|
| **manage_rag_content** | Manage collections and documents (collection actions: create_collection, list_collections, get_collection, delete_collection; document actions: ingest, list, status, delete). |
| **rag_query** | Query a collection with natural language. Returns ranked chunks and optionally a synthesized answer. |

### SDK Usage

\`\`\`typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
});

// Create a shared collection
await butterbase.rag.createCollection({ name: 'docs', accessMode: 'shared' });

// Ingest raw text
await butterbase.rag.ingest('docs', { text: 'Your document content here...' });

// Query with a synthesized answer
const result = await butterbase.rag.query('docs', {
  query: 'What is the return policy?',
  synthesize: true,
});
console.log(result.answer);
\`\`\`

### Billing

- Embedding costs (during both ingestion and queries) count toward your plan's AI credits allowance
- File storage for uploaded documents counts toward your storage quota
- No additional RAG-specific charges
`,

  integrations: `## Integrations

Butterbase integrations let your end users connect their accounts with external services — Gmail, Slack, GitHub, Google Calendar, and 1,000+ others. Once connected, your app can send emails, post messages, create calendar events, and much more on their behalf.

### How It Works

1. **Configure** (admin, one-time) — Enable an integration toolkit for your app
2. **Connect** (end user) — User authenticates via OAuth to grant access
3. **Execute** — Your app runs actions on the user's connected account

### Curated Integrations (first-class support)

| Toolkit | Slug |
|---------|------|
| Gmail | gmail |
| Google Calendar | google-calendar |
| Slack | slack |
| Google Sheets | google-sheets |
| Notion | notion |
| GitHub | github |
| HubSpot | hubspot |
| Outlook | outlook |
| Google Drive | google-drive |
| Discord | discord |

Use \`manage_integrations\` (action: "list_available") or search via the REST API to browse 1,000+ available services.

---

### MCP Tools

#### manage_integrations (action: "configure" | "list" | "disable")

Enable, list, or disable integrations for your app.

\`\`\`json
{ "app_id": "app_abc123", "action": "configure", "toolkit": "gmail", "scopes": ["gmail.send"] }
{ "app_id": "app_abc123", "action": "list" }
{ "app_id": "app_abc123", "action": "disable", "toolkit": "slack" }
\`\`\`

| Parameter | Required | Description |
|-----------|----------|-------------|
| app_id | yes | Your app ID |
| action | yes | "configure", "list", or "disable" |
| toolkit | for configure/disable | Integration slug (e.g. gmail, slack) |
| scopes | no | OAuth scopes to request |
| display_name | no | Custom display name |

#### manage_integrations (action: "list_available")

Browse available integrations. Returns the curated list by default; pass \`search\` to query the full catalog.

\`\`\`json
{ "app_id": "app_abc123" }
{ "app_id": "app_abc123", "search": "calendar" }
\`\`\`

#### manage_integrations (action: "execute_action")

Execute an action on a user's connected account. The integration must be configured for the app, and the user must have a connected account.

\`\`\`json
{
  "app_id": "app_abc123",
  "tool_name": "GMAIL_SEND_EMAIL",
  "params": { "to": "recipient@example.com", "subject": "Hello", "body": "World" }
}
\`\`\`

To execute on behalf of a specific user from a service context (API key auth):

\`\`\`json
{
  "app_id": "app_abc123",
  "tool_name": "SLACK_POST_MESSAGE",
  "params": { "channel": "#general", "text": "Hello from my app!" },
  "user_id": "user_xyz"
}
\`\`\`

#### manage_integrations (action: "list_connected")

List which users have connected which integrations for an app.

\`\`\`json
{ "app_id": "app_abc123" }
\`\`\`

Response: \`{ connections: [{ id, toolkit_slug, app_user_id, status, connected_at }] }\`

#### manage_integrations (action: "list_tools")

List available action names and parameter schemas for a toolkit. Use this to discover what \`tool_name\` values to pass to \`manage_integrations\` (action: "execute_action").

\`\`\`json
{ "app_id": "app_abc123", "toolkit": "gmail" }
\`\`\`

Response: \`{ tools: [{ name: "GMAIL_SEND_EMAIL", description: "...", parameters: {...} }] }\`

---

### REST API

All integration routes live under \`/v1/:appId/integrations/\`.

#### Configure (admin, API key required)

\`\`\`
POST   /v1/:appId/integrations/configure
Body:  { toolkit, scopes?, displayName? }

GET    /v1/:appId/integrations/config
→     { integrations: [{ toolkit_slug, enabled, display_name }] }

DELETE /v1/:appId/integrations/configure/:toolkit

GET    /v1/:appId/integrations/available?search=...&curated=true
→     { integrations: [{ toolkit, displayName, curated }] }
\`\`\`

#### Connect (end user, JWT required)

\`\`\`
POST   /v1/:appId/integrations/connect
Body:  { toolkit, redirectUrl }
→     { authUrl, connectionRequestId }
   Redirect the user to authUrl to complete OAuth.

GET    /v1/:appId/integrations/connections
→     { connections: [{ id, toolkit_slug, status, connected_at }] }

DELETE /v1/:appId/integrations/connections/:id
\`\`\`

#### Execute (JWT or API key)

\`\`\`
GET    /v1/:appId/integrations/tools?toolkit=gmail
→     { tools: [{ name, description, parameters }] }

POST   /v1/:appId/integrations/execute
Body:  { toolName, params, userId? }
→     { successful, data?, error? }
\`\`\`

---

### TypeScript SDK

The \`IntegrationsClient\` is available at \`client.integrations\`.

\`\`\`typescript
import { createClient } from '@butterbase/sdk';

const admin = createClient({ appId: 'app_abc123', apiKey: process.env.BUTTERBASE_API_KEY });

// Enable an integration
await admin.integrations.configure('gmail', { scopes: ['gmail.send'] });

// List enabled integrations
const { data: configs } = await admin.integrations.getConfig();
// → [{ toolkit_slug: 'gmail', enabled: true, ... }]

// Disable an integration
await admin.integrations.disable('gmail');

// Browse available integrations
const { data: available } = await admin.integrations.listAvailable({ search: 'calendar' });
\`\`\`

\`\`\`typescript
// End-user client (JWT)
const userClient = createClient({ appId: 'app_abc123', userJwt: req.headers.authorization });

// Start OAuth — redirect the user to authUrl
const { data } = await userClient.integrations.connect('gmail', {
  redirectUrl: 'https://myapp.com/integrations/callback',
});
// → { authUrl: 'https://...', connectionRequestId: '...' }

// List user's connected accounts
const { data: connections } = await userClient.integrations.listConnections();

// Disconnect an account
await userClient.integrations.disconnect(connectionId);
\`\`\`

\`\`\`typescript
// Execute an action (JWT: uses authenticated user's account)
const { data: result } = await userClient.integrations.execute('GMAIL_SEND_EMAIL', {
  to: 'recipient@example.com',
  subject: 'Hello',
  body: 'Sent from my Butterbase app',
});
// → { successful: true, data: { messageId: '...' } }

// List available actions for a toolkit
const { data: tools } = await userClient.integrations.getTools('gmail');
// → [{ name: 'GMAIL_SEND_EMAIL', description: '...', parameters: {...} }]
\`\`\`

\`\`\`typescript
// Service-level execution (API key + userId)
// Use in cron jobs, webhooks, or admin flows acting on behalf of a specific user
const { data } = await admin.integrations.asUser('user_xyz').execute('SLACK_POST_MESSAGE', {
  channel: '#alerts',
  text: 'Your report is ready',
});
\`\`\`

> Inside a deployed function, \`ctx.integrations.asUser(userId).execute(...)\` is
> the canonical cron-driven form — the function-key injected as
> \`BUTTERBASE_FUNCTION_SERVICE_KEY\` is recognised by \`/integrations/execute\`
> when (and only when) the call targets the same app the function was deployed
> to. You do not need to set \`BUTTERBASE_API_KEY\` as a custom env var for this
> path to work.

---

### CLI

\`\`\`bash
# List available integrations (curated by default; use --search for full catalog)
butterbase integrations list [--search <query>] [--app <app_id>]

# Show enabled integrations for your app
butterbase integrations config [--app <app_id>]

# Enable an integration
butterbase integrations configure <toolkit> [--display-name "Gmail"] [--app <app_id>]

# Disable an integration
butterbase integrations disable <toolkit> [--app <app_id>]

# Generate an OAuth URL for a user to connect
butterbase integrations connect <toolkit> --redirect-url <url> [--user-id <id>] [--app <app_id>]

# List connected accounts
butterbase integrations connections [--app <app_id>]

# Disconnect an account
butterbase integrations disconnect <connection-id> [--app <app_id>]

# List available actions for a toolkit
butterbase integrations tools [<toolkit>] [--app <app_id>]

# Execute a tool action
butterbase integrations execute <tool-name> --data '{"to":"user@example.com","subject":"Hi"}' [--user-id <id>] [--app <app_id>]
\`\`\`

---

### Error Codes

| Code | Meaning |
|------|---------|
| INTEGRATIONS_NOT_CONFIGURED | Integrations are not set up for this environment |
| RESOURCE_NOT_FOUND | App or integration config not found |
| INTEGRATIONS_NOT_CONNECTED | The user has not connected this integration |
| INTEGRATIONS_EXECUTION_FAILED | The tool action returned a failure response |
`,

  substrate: `## Substrate

Substrate is a per-user memory and action coordination layer for AI agents. Entities, decisions, attention rules, and an audited action ledger all live in one shared per-user surface that every app linked to that user reads and writes against.

### When to use it

Reach for substrate whenever your app's job is on behalf of a person and a different app for the same person might want to know what happened. Concrete examples: a Q3 OKR was set (decision); the user committed to "ship phase 6 by Friday" (commitment); "Alice from Acme" is the same person across the CRM and the support tool (entity); on every Monday morning, summarize last week's decisions (attention rule).

Skip it when state is purely app-local (per-row TODOs, ephemeral form state) — use the regular [app database](./README.md#database) for that.

### Authentication

Three ways to reach the substrate over HTTP:

1. **Substrate-scoped API key** (\`bb_sub_*\`) — CLI / SDK / integrations. Generate with \`butterbase keys generate --substrate\`.
2. **Platform JWT** — dashboard / Cognito session.
3. **Inside a serverless function** — \`ctx.substrate\` is wired automatically when the app is linked to a substrate user; no token to manage.

Non-substrate API keys (\`bb_sk_*\`) return 403 on substrate routes.

### \`ctx.substrate\` in functions

\`\`\`typescript
export async function handler(req, ctx) {
  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Adopt substrate',
    kind: 'strategic',
    rationale: 'agents need shared memory',
  });
  const prior = await ctx.substrate.searchMemory('billing', { kinds: ['decisions'], limit: 5 });
  const people = await ctx.substrate.findEntities({ type: 'person', limit: 10 });
  const one = await ctx.substrate.getEntity('ent_…');
  return Response.json({ verdict, prior, people, one });
}
\`\`\`

Agent-proposed side-effecting actions (e.g. \`send_email_draft\`) always require human approval even if the user has \`yolo_mode\` on. Memory writes (\`record_decision\`, etc.) auto-execute.

### HTTP surface (high-traffic routes)

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /v1/me/substrate/settings | Read yolo mode + other toggles |
| PUT    | /v1/me/substrate/settings/yolo | Toggle yolo mode |
| POST   | /v1/me/substrate/actions/propose | Propose an action |
| GET    | /v1/me/substrate/actions | List action ledger |
| GET    | /v1/me/substrate/actions/{id} | Fetch one action |
| POST   | /v1/me/substrate/actions/{id}/approve | Approve a pending action |
| POST   | /v1/me/substrate/actions/{id}/reject | Reject a pending action |
| GET    | /v1/me/substrate/entities | List / search entities |
| GET    | /v1/me/substrate/entities/{id} | Fetch one entity |
| GET    | /v1/me/substrate/memory/search?q=… | Full-text search across decisions/commitments/learnings/source_artifacts |
| GET    | /v1/me/substrate/source-artifacts[…] | List / fetch source artifacts (meeting transcripts, email threads, documents) |
| GET    | /v1/me/substrate/snapshots?days=N | Daily snapshots |
| GET\\|POST\\|PUT\\|DELETE | /v1/me/substrate/attention-rules[…] | Attention rule CRUD + preview + enable/disable + firings |
| GET\\|PUT\\|DELETE | /v1/me/substrate/outbox-targets[…] | Webhook targets per capability |
| POST   | /v1/me/substrate/ws-ticket | Mint a 60s ticket for the WS stream |
| WS     | /v1/me/substrate/stream | Live push of every ledger / entity / rule / firing change |

### Propose an action

\`\`\`json
POST /v1/me/substrate/actions/propose

{
  "capability": "record_decision",
  "payload": { "title": "…", "kind": "operational", "rationale": "…" },
  "idempotency_key": "optional"
}
\`\`\`

Response:
\`\`\`json
{
  "action_id": "act_01…",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01…" }
}
\`\`\`

Verdict values: \`auto_approved\`, \`auto_approved_yolo\`, \`requires_approval\`, \`rejected\`.

### Attention rules

A rule fires on a cron schedule, evaluates a JSON-Logic predicate against today's snapshot, and proposes one action per matched binding.

\`\`\`json
POST /v1/me/substrate/attention-rules
{
  "name": "weekly digest",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [{ "var": "entity_count" }, 0] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities."
  }
}
\`\`\`

Use \`POST /v1/me/substrate/attention-rules/preview\` to dry-run a rule body against today's snapshot before saving.

### Outbox targets (webhooks)

Register one webhook per capability. When an action executes, the substrate POSTs the rendered payload to that URL, HMAC-signed with the secret you provided.

\`\`\`json
PUT /v1/me/substrate/outbox-targets/send_email_draft
{ "webhook_url": "https://example.com/hook", "signing_secret": "min-8-chars" }
\`\`\`

Delivery headers: \`X-Butterbase-Signature: sha256=<hex>\`, \`X-Butterbase-Delivery: <uuid>\`. Retries with backoff; final failures go to a dead-letter list.

### WebSocket stream

Browser clients can't put a Bearer in the WS handshake, so they exchange a one-shot 60s ticket first:

\`\`\`typescript
const { ticket } = await fetch('/v1/me/substrate/ws-ticket', {
  method: 'POST', credentials: 'include',
}).then(r => r.json());

const ws = new WebSocket(\`wss://api.butterbase.ai/v1/me/substrate/stream?ticket=\${ticket}\`);
ws.onmessage = (e) => {
  const change = JSON.parse(e.data);
  // { tbl: 'action_ledger', op: 'insert', id: 'act_…', user: '…' }
};
\`\`\`

Server frames:
- \`{"type":"hello","ts":…}\` on connect
- \`{"tbl":"…","op":"insert|update|delete","id":"…","user":"…"}\` per change

The stream does NOT include row payloads — clients refetch by id.

Server-side clients (with a \`bb_sub_\` key) can skip the ticket exchange and pass the key as the Authorization header on the upgrade, or as \`?token=bb_sub_…\`.

### CLI

The \`butterbase substrate\` command group mirrors the HTTP surface end-to-end. \`butterbase substrate ledger\`, \`butterbase substrate propose <capability>\`, \`butterbase substrate approve|reject\`, \`butterbase substrate entities list|get|update\`, \`butterbase substrate artifacts list|get\`, \`butterbase substrate memory <query>\`, \`butterbase substrate outbox list|cancel|retry\`, \`butterbase substrate rules list|get|create|enable|disable|delete|firings\`, \`butterbase substrate snapshots\`, \`butterbase substrate settings show|yolo on|off\`. All commands accept \`--json\` for scripting. See the [CLI Substrate page](https://docs.butterbase.ai/cli/substrate/) for full syntax.

### MCP

All substrate operations are exposed through a single MCP tool: \`manage_substrate\`. Pass \`{ action, ... }\` where \`action\` selects the operation. There is no per-capability or per-route tool — \`propose_action\`, \`find_entities\`, \`search_memory\`, \`manage_attention_rules\`, \`list_outbox\`, etc. are all collapsed into \`manage_substrate\` actions, mirroring how \`manage_kv\` works for the KV store.

Action groups:
- **Writes:** \`propose\`, \`approve\`, \`reject\`. All substrate writes (decisions, commitments, learnings, entities, source artifacts) go through \`propose\` with the appropriate \`capability\`.
- **Ledger:** \`list_actions\`, \`get_action\`.
- **Entities:** \`find_entities\`, \`get_entity\`.
- **Source artifacts:** \`list_source_artifacts\`, \`get_source_artifact\`. Writes use \`propose\` with \`capability: "upsert_source_artifact"\`.
- **Memory:** \`search_memory\` (kinds: \`decisions\`, \`commitments\`, \`learnings\`, \`source_artifacts\`).
- **Outbox:** \`list_outbox\`, \`retry_outbox\`, \`cancel_outbox\`.
- **Attention rules:** \`list_rules\`, \`get_rule\`, \`create_rule\`, \`update_rule\`, \`delete_rule\`, \`enable_rule\`, \`disable_rule\`, \`list_rule_firings\`.
- **Snapshots & settings:** \`snapshots\`, \`get_settings\`, \`set_yolo\`.

Example:

\`\`\`json
{
  "tool": "manage_substrate",
  "action": "propose",
  "capability": "record_commitment",
  "payload": {
    "title": "Ship phase 6 by Friday",
    "owner_entity_id": "ent_01…",
    "source_artifact_id": "art_01…"
  }
}
\`\`\`

### Common errors

| Code | Meaning |
|------|---------|
| AUTH_INVALID_TOKEN | Token couldn't be verified |
| 403 token is not substrate-scoped | Caller used a \`bb_sk_\` or app-scoped key |
| 403 substrate not provisioned for this user | First-time user; POST /v1/me/substrate/provision to create |
| 1008 unauthenticated (WS close) | Ticket missing, expired, reused, or token rejected |
| 409 wrong_status | Tried to approve/reject an action that already executed or was rejected |
`,

};

export function getUserDocumentation(topic: DocTopic): string {
  if (topic === 'all') {
    return [
      SECTIONS.overview,
      SECTIONS.mcp,
      SECTIONS.rest,
      SECTIONS.auth,
      SECTIONS.storage,
      SECTIONS.functions,
      SECTIONS.frontend,
      SECTIONS.ai,
      SECTIONS.meetings,
      SECTIONS.rag,
      SECTIONS.billing,
      SECTIONS.platform,
      SECTIONS.schema,
      SECTIONS.sdk,
      SECTIONS.cli,
      SECTIONS.integrations,
      SECTIONS.substrate,
    ].join('\n\n');
  }
  return SECTIONS[topic];
}
