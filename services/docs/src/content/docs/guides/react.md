---
title: React
description: Build React applications with Butterbase using the TypeScript SDK.
---

Build React applications with Butterbase using the TypeScript SDK.

## Setup

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app && npm install
npm install @butterbase/sdk
```

Create client:

```typescript
// src/lib/butterbase.ts
import { createClient } from '@butterbase/sdk';
export const butterbase = createClient({
  appId: import.meta.env.VITE_BUTTERBASE_APP_ID,
  apiUrl: import.meta.env.VITE_BUTTERBASE_API_URL,
});
```

Environment variables (`.env.local`):

```
VITE_BUTTERBASE_APP_ID=app_abc123
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
```

## Authentication component

```tsx
const handleSignIn = async () => {
  const { data, error } = await butterbase.auth.signIn({ email, password });
};
```

## Data fetching

```tsx
const { data: posts } = await butterbase
  .from<Post>('posts')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(20);
```

## Auth state changes

```tsx
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  setUser(session?.user ?? null);
});
return () => unsubscribe();
```

## OAuth

```tsx
const { url } = await butterbase.auth.signInWithOAuth({
  provider: 'google',
  redirectTo: window.location.origin + '/auth/callback',
});
window.location.href = url;
```

## File uploads

```tsx
const { data, error } = await butterbase.storage.upload(file);
// Save data.objectId in your database
```

## Deploy

```bash
npm run build
cd dist && zip -r ../frontend.zip .
```

Use `create_frontend_deployment` and `start_frontend_deployment` MCP tools to deploy.
