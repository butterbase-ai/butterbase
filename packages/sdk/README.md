# @butterbase/sdk

Universal TypeScript SDK for Butterbase - works in browser, Node.js, and Deno environments.

## Installation

```bash
npm install @butterbase/sdk
```

## Quick Start

```typescript
import { createClient } from '@butterbase/sdk';

// Initialize client.
// apiUrl is the same regardless of which region your app lives in —
// requests are routed to the right region automatically.
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  anonKey: 'your-anon-key' // Optional, for public access
});

// Query data
const { data, error } = await butterbase
  .from('posts')
  .select('*')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(10);

// Insert data
const { data, error } = await butterbase
  .from('posts')
  .insert({ title: 'Hello World', content: 'My first post' });

// Update data
const { data, error } = await butterbase
  .from('posts')
  .update({ status: 'archived' })
  .eq('id', '123');

// Delete data
const { data, error } = await butterbase
  .from('posts')
  .delete()
  .eq('id', '123');
```

## Migration from 0.x to 1.0

**Breaking Change:** The `authUrl` parameter has been removed. All auth endpoints now run on the same URL as the API.

**Before (0.x):**
```typescript
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  authUrl: 'https://auth.butterbase.com', // ❌ No longer needed
});
```

**After (1.0):**
```typescript
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai', // ✅ All endpoints use this URL
});
```

## Authentication

Sessions are automatically persisted to `localStorage` and restored on page refresh. Access tokens are automatically refreshed before they expire.

```typescript
// Sign up
const { data, error } = await butterbase.auth.signUp({
  email: 'user@example.com',
  password: 'secure123'
});

// Sign in (session is automatically persisted)
const { data, error } = await butterbase.auth.signIn({
  email: 'user@example.com',
  password: 'secure123'
});

// Get current user (works after page refresh)
const { data: user } = await butterbase.auth.getUser();

// Sign out (clears persisted session)
await butterbase.auth.signOut();

// Refresh session manually (uses stored refresh token if none provided)
const { data } = await butterbase.auth.refreshSession();

// OAuth
const { url } = butterbase.auth.signInWithOAuth({
  provider: 'google',
  redirectTo: 'http://localhost:3000/callback'
});
window.location.href = url;
```

### Auth State Changes

Subscribe to authentication events to react to sign-ins, sign-outs, and token refreshes:

```typescript
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'SESSION_RESTORED'
  console.log(event, session?.user);
});

// Stop listening
unsubscribe();
```

### React Usage

```typescript
import { useEffect, useState } from 'react';
import { butterbase } from './lib';

function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    // Session is auto-restored — check current state
    const session = butterbase.sessionManager.getSession();
    if (session) setUser(session.user);

    // React to future auth changes
    const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
    });
    return unsubscribe;
  }, []);
}
```

### Custom Storage

By default, the SDK uses `localStorage` with an in-memory fallback for SSR/Node.js environments. You can provide a custom storage adapter:

```typescript
import { createClient, MemorySessionStorage } from '@butterbase/sdk';

// Memory-only (no persistence)
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  persistSession: false,
});

// Custom storage adapter (e.g., for React Native)
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  sessionStorage: myCustomStorage, // implements { getItem, setItem, removeItem }
});
```

## Storage

```typescript
// Upload file
const { data, error } = await butterbase.storage.upload(file);

// Get download URL
const { data } = await butterbase.storage.getDownloadUrl(objectId);

// List files
const { data: objects } = await butterbase.storage.list();

// Delete file
await butterbase.storage.delete(objectId);
```

## Functions

```typescript
// Invoke serverless function
const { data, error } = await butterbase.functions.invoke('my-function', {
  body: { key: 'value' },
  method: 'POST'
});
```

## Query Builder

### Operators

- `eq(column, value)` - Equal to
- `neq(column, value)` - Not equal to
- `gt(column, value)` - Greater than
- `gte(column, value)` - Greater than or equal to
- `lt(column, value)` - Less than
- `lte(column, value)` - Less than or equal to
- `like(column, pattern)` - Pattern matching (case-sensitive)
- `ilike(column, pattern)` - Pattern matching (case-insensitive)
- `in(column, values)` - Value in array
- `is(column, value)` - Is null/true/false

### Modifiers

- `select(columns)` - Select specific columns
- `order(column, options)` - Order results
- `limit(count)` - Limit results
- `offset(count)` - Skip results

## Usage in Deno

```typescript
import { createClient } from 'npm:@butterbase/sdk';

const butterbase = createClient({
  appId: Deno.env.get('BUTTERBASE_APP_ID')!,
  apiUrl: Deno.env.get('BUTTERBASE_API_URL')!,
});

// Use in serverless functions
export async function handler(req: Request, ctx: any) {
  const { data } = await butterbase.from('posts').select('*');
  return Response.json({ data });
}
```

## TypeScript Support

The SDK is fully typed with TypeScript. All methods return `ButterbaseResponse<T>` with proper type inference:

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
// error is typed as Error | null
```

## Integrations

Connect third-party services to your app and execute actions on behalf of your users.

### Admin configuration (API key)

```typescript
// Enable a toolkit
await bb.integrations.configure('gmail', { displayName: 'Gmail' });

// List enabled integrations
const { data } = await bb.integrations.getConfig();

// Disable a toolkit
await bb.integrations.disable('gmail');

// Search available toolkits
const { data } = await bb.integrations.listAvailable({ search: 'salesforce' });
```

### End-user OAuth flow (user JWT)

```typescript
// Generate connect URL — redirect the user to authUrl
const { data } = await bb.integrations.connect('gmail', {
  redirectUrl: 'https://yourapp.com/settings',
});
window.location.href = data.authUrl;

// List user's connected accounts
const { data } = await bb.integrations.listConnections();

// Disconnect an account
await bb.integrations.disconnect(connectionId);
```

### Executing tools

```typescript
// List tools for a toolkit
const { data } = await bb.integrations.getTools('gmail');
// data[0] = { name: 'GMAIL_SEND_EMAIL', description: '...', parameters: { ... } }

// Execute a tool (user JWT auth)
const { data } = await bb.integrations.execute('GMAIL_SEND_EMAIL', {
  to: 'user@example.com',
  subject: 'Hello',
  body: 'Sent via Butterbase integrations.',
});

// Execute on behalf of a user (API key + userId, e.g. in a cron)
const { data } = await bb.integrations
  .asUser('user-uuid')
  .execute('GOOGLECALENDAR_EVENTS_LIST', { timeMin: new Date().toISOString() });
```

## Error handling

All client methods return `{ data, error }`. When the backend returned a
recognizable agent-friendly error, `error` is a typed `ButterbaseError`
subclass (`AuthError`, `ValidationError`, `NotFoundError`, `QuotaError`,
`NetworkError`) carrying `code`, `status`, `remediation`, and `details`.

```typescript
import {
  ButterbaseClient, ErrorCodes,
  AuthError, NotFoundError, QuotaError,
} from '@butterbase/sdk';

const r = await client.from('posts').select('*').execute();

if (r.error instanceof NotFoundError) {
  console.error('Missing table:', r.error.remediation);
}
if (r.error?.code === ErrorCodes.AUTH_INVALID_API_KEY) {
  // rotate the key
}
if (r.error instanceof QuotaError) {
  console.error(`Quota hit (${r.error.code}): ${r.error.remediation}`);
}
```

The full set of codes lives in `ErrorCodes` (re-exported from
`@butterbase/shared`). Use `parseApiError(status, body)` if you're wrapping
fetch yourself and want to dispatch to the same typed classes.

## License

MIT
