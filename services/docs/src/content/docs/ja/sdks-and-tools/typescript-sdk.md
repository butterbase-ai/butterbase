---
title: TypeScript SDK
description: ブラウザー、Node.js、Denoで使えるButterbase公式SDKです。
---

Butterbaseの公式TypeScript SDKです。ブラウザー、Node.js、Denoで動きます。

<span id="installation"></span>

## インストール

```bash
npm install @butterbase/sdk
```

<span id="quick-start"></span>

## クイックスタート

```typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  anonKey: 'your-anon-key' // Optional, for public access
});
```

アプリの[リージョン](/ja/core-concepts/regions/)にかかわらず`apiUrl`は同じです。適切なリージョンへ自動で転送するため、移動後も変更は不要です。

<span id="data-operations"></span>

## データ操作

<span id="query"></span>

### 取得

```typescript
const { data, error } = await butterbase
  .from('posts')
  .select('*')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(10);
```

<span id="insert"></span>

### 追加

```typescript
const { data, error } = await butterbase
  .from('posts')
  .insert({ title: 'Hello World', content: 'My first post' });
```

<span id="update"></span>

### 更新

```typescript
const { data, error } = await butterbase
  .from('posts')
  .update({ status: 'archived' })
  .eq('id', '123');
```

<span id="delete"></span>

### 削除

```typescript
const { data, error } = await butterbase
  .from('posts')
  .delete()
  .eq('id', '123');
```

<span id="query-operators"></span>

## クエリの演算子

| メソッド | 対応するSQL |
|--------|---------------|
| `eq(column, value)` | `=` |
| `neq(column, value)` | `!=` |
| `gt(column, value)` | `>` |
| `gte(column, value)` | `>=` |
| `lt(column, value)` | `<` |
| `lte(column, value)` | `<=` |
| `like(column, pattern)` | `LIKE`（大文字と小文字を区別） |
| `ilike(column, pattern)` | `ILIKE`（大文字と小文字を区別しない） |
| `in(column, values)` | `IN (...)` |
| `is(column, value)` | `IS NULL / TRUE / FALSE` |

<span id="query-modifiers"></span>

## クエリの調整

| メソッド | 説明 |
|--------|-------------|
| `select(columns)` | 指定した列を取得 |
| `order(column, options)` | 結果を並び替え |
| `limit(count)` | 取得件数を制限 |
| `offset(count)` | 指定件数を読み飛ばす |

<span id="authentication"></span>

## 認証

セッションは`localStorage`へ自動保存し、ページの再読み込みで復元します。アクセストークンは期限前に自動更新します。

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

<span id="magic-link-sign-in"></span>

### マジックリンクでのログイン

```typescript
// Send a 6-digit code by email. Same response whether or not the email exists.
await butterbase.auth.sendMagicLink('user@example.com');

// Exchange the code for tokens. New users are auto-created on first verify.
const { data, error } = await butterbase.auth.verifyMagicLink('user@example.com', '123456');
if (data) {
  // data.access_token, data.refresh_token, data.user
}
```

コードは6桁で、15分間有効かつ1回限りです。[マジックリンク](/ja/core-concepts/authentication#magic-link-sign-in)を参照してください。

<span id="auth-state-changes"></span>

## 認証状態の変更

```typescript
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'SESSION_RESTORED'
  console.log(event, session?.user);
});
```

<span id="custom-session-storage"></span>

## 独自のセッション保存先

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

<span id="storage"></span>

## ストレージ

```typescript
const { data, error } = await butterbase.storage.upload(file);
const { data } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);
```

<span id="functions"></span>

## 関数

```typescript
const { data, error } = await butterbase.functions.invoke('my-function', {
  body: { key: 'value' },
  method: 'POST'
});
```

<span id="substrate-stream"></span>

## Substrateのストリーム

[Substrate](/ja/core-concepts/substrate/)の変更をWebSocketで購読します。`bb.substrate.stream`が接続と再試行を行い、変更ごとにコールバックを呼び出します。フレームは`{ org, op, tbl, id }`だけで、行はIDから再取得します。

```typescript
const sub = butterbase.substrate.stream({
  token: process.env.BUTTERBASE_SUBSTRATE_KEY, // bb_sub_… or bb_sk_…
  onChange: (evt) => {
    // evt: { org, op: 'insert' | 'update' | 'delete', tbl, id }
    if (evt.tbl === 'entities') refetchEntity(evt.id);
  },
  onStatus: (s) => console.log(s), // 'connecting' | 'open' | 'closed'
});

// stop listening
sub.unsubscribe();
```

サーバー・スクリプト用の`token`（Substrateキー）と、ブラウザー用の`ticket`（1回限りの`wst_…`）の**どちらか一方**を指定します。[UIへのリアルタイム配信](/ja/core-concepts/substrate/#8-stream-live-updates-to-a-ui)を参照してください。認証情報に紐付く組織に制限します。

<span id="integrations"></span>

## 外部サービスとの連携

Gmail、Slack、GitHubなどのユーザーのアカウントを接続し、そのユーザーとしてツールを実行できます。[外部サービスとの連携](/ja/core-concepts/integrations)を参照してください。

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

<span id="admin-client"></span>

## 管理クライアント

`butterbase.admin`で、ダッシュボード、MCP、CLIの管理操作を行えます。`admin.*`にはAPIキー（`bb_sk_...`）が必要です。

| サブクライアント | 管理内容 |
|-----------|---------|
| `admin.schema` | スキーマの取得・適用・確認、マイグレーション一覧 |
| `admin.rls` | RLSの有効化、ポリシー作成、ユーザー分離 |
| `admin.oauth` | Google、GitHubなどのOAuth設定 |
| `admin.config` | CORS、JWTのTTL、ストレージの公開読み取り |
| `admin.functions` | 関数のデプロイ、一覧、詳細、ログ、環境変数、削除 |
| `admin.frontend` | フロントエンドのデプロイとビルド環境変数 |
| `admin.realtime` | テーブルのリアルタイム設定 |
| `admin.domains` | カスタムドメインの管理 |
| `admin.apiKeys` | キーの発行・一覧・失効 |
| `admin.auditLogs` | 認証・監査イベントの検索 |

<span id="custom-domains"></span>

### カスタムドメイン

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

<span id="app-config"></span>

### アプリの設定

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

<span id="typescript-support"></span>

## TypeScriptへの対応

すべてのメソッドは型推論付きの`ButterbaseResponse<T>`を返します。

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

<span id="deno-usage"></span>

## Denoでの利用

```typescript
import { createClient } from 'npm:@butterbase/sdk';

const butterbase = createClient({
  appId: Deno.env.get('BUTTERBASE_APP_ID')!,
  apiUrl: Deno.env.get('BUTTERBASE_API_URL')!,
});
```

<span id="kv-ctxkv"></span>

## KV（ctx.kv）

関数やクライアントから利用できます。すべてのメソッドは非同期です。

| メソッド | シグネチャ | 説明 |
|--------|-----------|-------------|
| `get` | `get<T>(key: string, opts?: { touch?: boolean }): Promise<T \| null>` | キーの値を取得。なければnull。 |
| `set` | `set(key: string, value: unknown, opts?: { ttl?: number \| null; ephemeral?: boolean }): Promise<void>` | 値を保存。任意の秒単位TTL。 |
| `del` | `del(key: string): Promise<number>` | 削除し、削除件数を返す |
| `incr` | `incr(key: string, by?: number): Promise<number>` | 数値を加算（既定1） |
| `decr` | `decr(key: string, by?: number): Promise<number>` | 数値を減算（既定1） |
| `setnx` | `setnx(key: string, value: unknown, opts?: { ttl?: number \| null; ephemeral?: boolean }): Promise<boolean>` | 存在しない場合だけ保存。成功ならtrue。 |
| `setex` | `setex(key: string, value: unknown, ttl: number, opts?: { ephemeral?: boolean }): Promise<void>` | TTLを指定して保存（set＋ttlの短縮形） |
| `cas` | `cas(key: string, expected: unknown, next: unknown): Promise<boolean>` | 現在値がexpectedと一致する場合だけnextへ不可分に置換 |
| `exists` | `exists(key: string): Promise<boolean>` | キーの存在を確認 |
| `ttl` | `ttl(key: string): Promise<number \| null>` | 残りのTTLを秒で取得。nullは無期限、undefinedはキーなし。 |
| `expire` | `expire(key: string, ttl: number \| null): Promise<boolean>` | 既存キーのTTLを設定・解除 |
| `mget` | `mget<T>(keys: string[]): Promise<(T \| null)[]>` | 複数の値を配列で取得。ないキーはnull。 |
| `mset` | `mset(entries: Record<string, unknown>, opts?: { ttl?: number \| null }): Promise<void>` | 複数のキーと値を保存し、すべてにTTLを適用 |
| `expose` | `expose(pattern: string, opts: { read: Role; write: Role }): Promise<void>` | パターンに対するロールのアクセス権を設定 |
| `unexpose` | `unexpose(pattern: string): Promise<number>` | 公開ルールを削除し、削除件数を返す |
| `listRules` | `listRules(): Promise<Array<{ pattern: string; read: Role; write: Role; order: number }>>` | 有効な公開ルールを一覧表示 |

<span id="client-side-example"></span>

### クライアントの例

```typescript
const { data } = await butterbase.from('users').select('id').eq('id', userId);
const userId = data?.[0]?.id;

// Increment a counter in KV
const count = await butterbase.kv.incr(`user_clicks:${userId}`);
console.log(`User has clicked ${count} times`);

// Set with TTL
await butterbase.kv.set(`session:${sessionId}`, sessionData, { ttl: 3600 });
```

<span id="function-example"></span>

### 関数の例

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

**読み取りでTTLを延長：**

```ts
// Each read refreshes the TTL back to the original window
const session = await ctx.kv.get<Session>(`session:${id}`, { touch: true });
```

**読み書きの一括処理：**

```ts
await ctx.kv.mset({
  'feature:new-checkout': 'on',
  'feature:new-pricing': 'off',
});

const flags = await ctx.kv.mget(['feature:new-checkout', 'feature:new-pricing']);
// flags === ['on', 'off']  (null for any missing key)
```

**一時キャッシュへの保存（小さく高速。リージョンの再起動で消える場合があります）：**

```ts
await ctx.kv.set(`cache:user:${id}`, payload, { ttl: 60, ephemeral: true });
```

<span id="migration-from-0x-to-10"></span>

## 0.xから1.0への移行

`authUrl`は廃止しました。認証もAPIと同じURLを使うため、`apiUrl`だけを指定してください。
