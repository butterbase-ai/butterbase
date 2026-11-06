---
title: React
description: TypeScript SDKを使い、Butterbaseと連携するReactアプリを作ります。
---

TypeScript SDKを使い、Butterbaseと連携するReactアプリを作ります。

<span id="setup"></span>

## セットアップ

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app && npm install
npm install @butterbase/sdk
```

クライアントを作成します。

```typescript
// src/lib/butterbase.ts
import { createClient } from '@butterbase/sdk';
export const butterbase = createClient({
  appId: import.meta.env.VITE_BUTTERBASE_APP_ID,
  apiUrl: import.meta.env.VITE_BUTTERBASE_API_URL,
});
```

環境変数（`.env.local`）：

```
VITE_BUTTERBASE_APP_ID=app_abc123
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
```

<span id="authentication-component"></span>

## 認証コンポーネント

```tsx
const handleSignIn = async () => {
  const { data, error } = await butterbase.auth.signIn({ email, password });
};
```

<span id="data-fetching"></span>

## データ取得

```tsx
const { data: posts } = await butterbase
  .from<Post>('posts')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(20);
```

<span id="auth-state-changes"></span>

## 認証状態の変更

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

<span id="file-uploads"></span>

## ファイルのアップロード

```tsx
const { data, error } = await butterbase.storage.upload(file);
// Save data.objectId in your database
```

<span id="deploy"></span>

## デプロイ

```bash
npm run build
cd dist && zip -r ../frontend.zip .
```

`create_frontend_deployment`と`manage_frontend`（actionは`start_deployment`）MCPツールでデプロイします。
