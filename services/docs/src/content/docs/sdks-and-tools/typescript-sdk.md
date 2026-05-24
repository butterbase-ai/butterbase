---
title: TypeScript SDK
description: Official TypeScript SDK for Butterbase — works in browser, Node.js, and Deno.
---

The official TypeScript SDK for Butterbase. Works in browser, Node.js, and Deno environments.

## Installation

```bash
npm install @butterbase/sdk
```

## Quick start

```typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  anonKey: 'your-anon-key' // Optional, for public access
});
```

The `apiUrl` is the same regardless of which [region](/core-concepts/regions/) your app lives in. Requests are routed to the right region for you, so you don't need to change anything when you move an app.

## Data operations

### Query

```typescript
const { data, error } = await butterbase
  .from('posts')
  .select('*')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(10);
```

### Insert

```typescript
const { data, error } = await butterbase
  .from('posts')
  .insert({ title: 'Hello World', content: 'My first post' });
```

### Update

```typescript
const { data, error } = await butterbase
  .from('posts')
  .update({ status: 'archived' })
  .eq('id', '123');
```

### Delete

```typescript
const { data, error } = await butterbase
  .from('posts')
  .delete()
  .eq('id', '123');
```

## Query operators

| Method | SQL Equivalent |
|--------|---------------|
| `eq(column, value)` | `=` |
| `neq(column, value)` | `!=` |
| `gt(column, value)` | `>` |
| `gte(column, value)` | `>=` |
| `lt(column, value)` | `<` |
| `lte(column, value)` | `<=` |
| `like(column, pattern)` | `LIKE` (case-sensitive) |
| `ilike(column, pattern)` | `ILIKE` (case-insensitive) |
| `in(column, values)` | `IN (...)` |
| `is(column, value)` | `IS NULL / TRUE / FALSE` |

## Query modifiers

| Method | Description |
|--------|-------------|
| `select(columns)` | Select specific columns |
| `order(column, options)` | Order results |
| `limit(count)` | Limit results |
| `offset(count)` | Skip results |

## Authentication

Sessions are automatically persisted to `localStorage` and restored on page refresh. Access tokens are automatically refreshed before they expire.

```typescript
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
```

### Magic-link sign-in

```typescript
// Send a 6-digit code by email. Same response whether or not the email exists.
await butterbase.auth.sendMagicLink('user@example.com');

// Exchange the code for tokens. New users are auto-created on first verify.
const { data, error } = await butterbase.auth.verifyMagicLink('user@example.com', '123456');
if (data) {
  // data.access_token, data.refresh_token, data.user
}
```

Codes are 6 digits, expire after 15 minutes, and are single-use. See the [magic-link concept page](/core-concepts/authentication#magic-link-sign-in) for behavior details.

## Auth state changes

```typescript
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'SESSION_RESTORED'
  console.log(event, session?.user);
});
```

## Custom session storage

```typescript
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
```

## Storage

```typescript
const { data, error } = await butterbase.storage.upload(file);
const { data } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);
```

## Functions

```typescript
const { data, error } = await butterbase.functions.invoke('my-function', {
  body: { key: 'value' },
  method: 'POST'
});
```

## Integrations

Connect end-user accounts (Gmail, Slack, GitHub, etc.) and execute tools on their behalf. See the [integrations concept page](/core-concepts/integrations) for the platform model.

```typescript
// Admin: enable a toolkit for the app (requires API key)
await butterbase.integrations.configure('gmail');

// Browse the catalog
const { data: list } = await butterbase.integrations.listAvailable({ search: 'crm' });

// End-user: generate the OAuth connect URL, then redirect the user
const { data: connect } = await butterbase.integrations.connect('gmail', {
  redirectUrl: 'https://app.example.com/integrations/callback',
});
window.location.href = connect.authUrl;

// End-user: list their connected accounts
const { data: connections } = await butterbase.integrations.listConnections();

// Execute a tool with the calling user's credentials
const { data: result } = await butterbase.integrations.execute('GMAIL_SEND_EMAIL', {
  to: 'user@example.com',
  subject: 'Hi',
  body: 'Hello',
});

// Service-level execution on behalf of a specific user (API key required)
await butterbase.integrations.asUser(userId).execute('GMAIL_SEND_EMAIL', {
  to: 'user@example.com', subject: 'Hi', body: 'Hello'
});
```

## Admin client

`butterbase.admin` exposes platform-management surfaces normally driven from the dashboard, MCP tools, or CLI. Methods on `admin.*` require an API key (`bb_sk_...`).

| Subclient | Manages |
|-----------|---------|
| `admin.schema` | Get/apply/dry-run schema, list migrations |
| `admin.rls` | Enable RLS, create policies, user-isolation shortcut |
| `admin.oauth` | OAuth provider configuration (Google, GitHub, etc.) |
| `admin.config` | App config (CORS, JWT TTL, storage public-read) |
| `admin.functions` | Deploy / list / inspect / log / env-update / delete functions |
| `admin.frontend` | Frontend deployments and build env vars |
| `admin.realtime` | Toggle realtime on tables |
| `admin.domains` | Custom domains lifecycle |
| `admin.apiKeys` | Generate / list / revoke keys |
| `admin.auditLogs` | Query auth/audit events |

### Custom domains

```typescript
// Add a domain — response includes the CNAME target you have to set up
const { data: result } = await butterbase.admin.domains.add('app.example.com');
// result.cname_target → set as a CNAME at your DNS provider (DNS-only if Cloudflare)

// Poll status until ssl_status === 'active'
const { data: status } = await butterbase.admin.domains.getStatus(result.domain.id);

// Re-trigger verification after fixing DNS
await butterbase.admin.domains.verify(result.domain.id);

// Remove
await butterbase.admin.domains.remove(result.domain.id);
```

### App config

```typescript
const { data: cfg } = await butterbase.admin.config.get();

await butterbase.admin.config.updateCors({
  allowed_origins: ['https://app.example.com'],
});

await butterbase.admin.config.updateJwt({ token_ttl: 3600 });

// Make all storage objects publicly readable across the app
await butterbase.admin.config.updateStorage({ publicReadEnabled: true });
```

### RLS

```typescript
await butterbase.admin.rls.enable('posts');

await butterbase.admin.rls.createUserIsolation('posts', 'author_id');

await butterbase.admin.rls.createPolicy({
  table_name: 'posts',
  policy_name: 'public_read_published',
  command: 'SELECT',
  role: 'anon',
  using_expression: 'is_published = true',
});
```

## TypeScript support

All methods return `ButterbaseResponse<T>` with proper type inference:

```typescript
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
```

## Deno usage

```typescript
import { createClient } from 'npm:@butterbase/sdk';

const butterbase = createClient({
  appId: Deno.env.get('BUTTERBASE_APP_ID')!,
  apiUrl: Deno.env.get('BUTTERBASE_API_URL')!,
});
```

## KV (ctx.kv)

Access the KV store from functions and client-side code. All methods are asynchronous.

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `get<T>(key: string, opts?: { touch?: boolean }): Promise<T \| null>` | Retrieve a value by key; returns null if not found |
| `set` | `set(key: string, value: unknown, opts?: { ttl?: number \| null; ephemeral?: boolean }): Promise<void>` | Set a key to a value with optional TTL (seconds) |
| `del` | `del(key: string): Promise<number>` | Delete a key; returns number of keys deleted |
| `incr` | `incr(key: string, by?: number): Promise<number>` | Increment a numeric value (default by 1) |
| `decr` | `decr(key: string, by?: number): Promise<number>` | Decrement a numeric value (default by 1) |
| `setnx` | `setnx(key: string, value: unknown, opts?: { ttl?: number \| null; ephemeral?: boolean }): Promise<boolean>` | Set only if key does not exist; returns true if set |
| `setex` | `setex(key: string, value: unknown, ttl: number, opts?: { ephemeral?: boolean }): Promise<void>` | Set a value with explicit TTL (shorthand for set + ttl) |
| `cas` | `cas(key: string, expected: unknown, next: unknown): Promise<boolean>` | Compare-and-swap: atomically set next only if current equals expected |
| `exists` | `exists(key: string): Promise<boolean>` | Check if a key exists |
| `ttl` | `ttl(key: string): Promise<number \| null>` | Get remaining TTL in seconds; null means no expiry, undefined means key not found |
| `expire` | `expire(key: string, ttl: number \| null): Promise<boolean>` | Set or clear TTL on an existing key |
| `mget` | `mget<T>(keys: string[]): Promise<(T \| null)[]>` | Get multiple keys at once; returns array with nulls for missing keys |
| `mset` | `mset(entries: Record<string, unknown>, opts?: { ttl?: number \| null }): Promise<void>` | Set multiple key-value pairs (applies ttl to all) |
| `expose` | `expose(pattern: string, opts: { read: Role; write: Role }): Promise<void>` | Configure role-based access to a key pattern |
| `unexpose` | `unexpose(pattern: string): Promise<number>` | Remove an exposure rule; returns number of rules deleted |
| `listRules` | `listRules(): Promise<Array<{ pattern: string; read: Role; write: Role; order: number }>>` | List all active exposure rules |

### Client-side example

```typescript
const { data } = await butterbase.from('users').select('id').eq('id', userId);
const userId = data?.[0]?.id;

// Increment a counter in KV
const count = await butterbase.kv.incr(`user_clicks:${userId}`);
console.log(`User has clicked ${count} times`);

// Set with TTL
await butterbase.kv.set(`session:${sessionId}`, sessionData, { ttl: 3600 });
```

### Function example

```typescript
export async function handler(req: Request, ctx: FunctionContext) {
  const key = 'request_count';
  const count = await ctx.kv.incr(key);
  
  // Set up role-based access (admin only)
  if (ctx.user?.role === 'admin') {
    await ctx.kv.expose('secret:*', { read: 'owner', write: 'owner' });
  }
  
  return new Response(JSON.stringify({ count }));
}
```

**Read with sliding TTL refresh:**

```ts
// Each read refreshes the TTL back to the original window
const session = await ctx.kv.get<Session>(`session:${id}`, { touch: true });
```

**Batch reads and writes:**

```ts
await ctx.kv.mset({
  'feature:new-checkout': 'on',
  'feature:new-pricing': 'off',
});

const flags = await ctx.kv.mget(['feature:new-checkout', 'feature:new-pricing']);
// flags === ['on', 'off']  (null for any missing key)
```

**Ephemeral cache write (smaller, faster, not durable across regional restarts):**

```ts
await ctx.kv.set(`cache:user:${id}`, payload, { ttl: 60, ephemeral: true });
```

## Migration from 0.x to 1.0

The `authUrl` parameter has been removed. All auth endpoints now run on the same URL as the API — just use `apiUrl`.
