# はじめる

[SDKの日本語ガイド](../../README.ja.md)

`createClient`へアプリIDとAPI URLを渡します。アプリのリージョンにかかわらずAPI URLは共通で、リクエストは対応するリージョンへ転送されます。公開アクセスでは任意の`anonKey`を設定できます。

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

上の例は読み取り・追加・更新・削除をそれぞれ示しています。

## 0.xから1.0への移行

**破壊的変更：** `authUrl`は廃止されました。認証エンドポイントもAPIと同じURLを使います。

0.xの設定です。

```typescript
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  authUrl: 'https://auth.butterbase.com', // ❌ No longer needed
});
```

1.0以降の設定です。

```typescript
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai', // ✅ All endpoints use this URL
});
```
