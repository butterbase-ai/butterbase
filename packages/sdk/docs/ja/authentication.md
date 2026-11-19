# 認証

[SDKの日本語ガイド](../../README.ja.md)

セッションは既定で`localStorage`へ保存され、ページを再読み込みすると復元されます。アクセストークンは有効期限の前に自動更新されます。

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

## 認証状態の変化

サインイン・サインアウト・トークン更新・セッション復元に応じて処理を実行できます。購読が不要になったら`unsubscribe()`を呼びます。

```typescript
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'SESSION_RESTORED'
  console.log(event, session?.user);
});

// Stop listening
unsubscribe();
```

## 保存先の変更

SSR・Node.jsで`localStorage`が使えない場合はメモリーへ保存します。`persistSession: false`で永続化を無効にでき、`sessionStorage`で`getItem`・`setItem`・`removeItem`を実装した保存先へ変更できます。

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

Reactでの利用は[React・Deno・型](react-typescript.md)を参照してください。
