---
title: Key-Valueストア
description: セッション、ロック、冪等性キー、フラグ、カウンターをアプリ単位で保存します。
---

データベースと同じ[リージョン](/ja/core-concepts/regions/)に、永続的な高速KVを用意します。キーで取得し、自然に期限切れになり、結合の不要なセッション、ロック、冪等性キー、レート制限、フラグに適します。

キーはアプリへ自動で限定するため、ID接頭辞や別アプリとの衝突を考える必要はありません。

<span id="when-to-use-kv"></span>

## 向く用途

| 用途 | 適する保存先 |
|---|---|
| セッション・認証・更新トークン | **KV** |
| 分散ロック・リーダー選出 | **KV**のsetnx／cas |
| 冪等性キー | **KV**のsetnx |
| レート制限・閲覧数 | **KV**のincr／decr |
| 機能フラグ・A/B設定 | **KV** |
| 短期キャッシュ | **KV**のephemeral: true |
| 構造化したユーザーデータ・結合 | **データベース** |
| ファイル・画像・文書 | **ストレージ** |

キュー、pub/sub、ソート済み集合、リスト、ストリーム向けではありません。リアルタイムや関数間呼び出しを使います。

<span id="data-model"></span>

## データモデル

プラン上限内の任意JSONを保存します。カウンターのincr／decrは未作成なら0から始め、原子的に処理します。

<span id="keys"></span>

### キー

任意の文字列を使えます。名前空間は通常コロンで区切ります（session:user_abc123、lock:checkout:order_99など）。アプリの分離用接頭辞は不要です。

### TTL

新規キーの既定期限は**30日**で、書き込み時に変更できます。

| TTL | 動作 |
|---|---|
| 省略 | 30日 |
| `{ ttl: N }` | N秒で期限切れ |
| `{ ttl: null }` | 無期限 |

値を変えず期限だけ更新するにはexpire(key, seconds)かexpire(key, null)を使います。

<span id="persistence"></span>

### 永続性

**既定は永続**で、再起動後も残り、複製されます。失ってもよいキャッシュならephemeral: trueを指定します。速い代わりに再起動時の保持は保証しません。

<span id="quickstart"></span>

## クイックスタート

[関数](/ja/core-concepts/functions/)内ではctx.kvを使います。

```typescript
export default async function handler(ctx) {
  // Store a session token for 1 hour
  await ctx.kv.set('session:abc123', { userId: 'u_1', role: 'admin' }, { ttl: 3600 });

  // Read it back (returns null if missing or expired)
  const session = await ctx.kv.get<{ userId: string; role: string }>('session:abc123');

  // Atomic counter — initialises to 0 if missing, then increments
  const views = await ctx.kv.incr('counter:page:/home');

  // Acquire a lock — only succeeds if key does not exist
  const acquired = await ctx.kv.setnx('lock:checkout:order_99', 1, { ttl: 30 });

  return { session, views, acquired };
}
```

書き込みを許可せず、フロントエンドからカウンターを読めるようにします。

```ts
// In a function handler — set up the rule once
await ctx.kv.expose('hits:home', { read: 'public', write: 'deny' });
await ctx.kv.incr('hits:home');
```

```ts
// In the frontend
const res = await fetch(`${api}/v1/${appId}/kv/hits:home`);
const { value } = await res.json();
```

<span id="access-control"></span>

## アクセス制御

既定では**全キーが非公開**で、自分の関数からサービスキーで利用します。ブラウザ・モバイルは明示的な公開設定なしに読み書きできません。

ctx.kv.expose(pattern, { read, write })でユーザー向けに開きます。通常は初期設定か移行用関数で一度実行します。

{user.id}のテンプレートで、各ユーザーが自分のキーだけを使えます。

```ts
// Function: allow each signed-in user to read & write their own profile blob
await ctx.kv.expose('profile:{user.id}', { read: 'owner', write: 'owner' });

// User u_42 signs in. From the frontend:
//   GET  /v1/:app_id/kv/profile:u_42  → 200, value
//   GET  /v1/:app_id/kv/profile:u_99  → 403 (not their key)
```

<span id="roles"></span>

### ロール

| ロール | 対象 |
|---|---|
| deny | 拒否（既定） |
| public | 未認証を含む全員 |
| authed | 認証済みユーザー |
| owner | キーに含まれるIDの本人 |

<span id="pattern-syntax"></span>

### パターン

glob形式で照合します。

| 記号 | 一致するもの |
|---|---|
| `*` | コロンを含まない1区間 |
| `**` | 区切りを含む任意数の区間 |
| `{user.id}` | リクエスト時に認証済みIDへ置換 |
| `{user.role}` | 認証済みロール |

<span id="examples"></span>

### 例

**ユーザーごとの領域** — 自分のキーだけ読み書き。

```typescript
// Keys like "prefs:user_abc123" are readable/writable only by user_abc123
await ctx.kv.expose('prefs:{user.id}', { read: 'owner', write: 'owner' });
```

**公開読み取り、管理者書き込み** — 全クライアントが読む機能フラグ。

```typescript
// Any authenticated user can read flags; only service keys can write
await ctx.kv.expose('flags:**', { read: 'authed', write: 'deny' });
```

**全体の公開読み取り** — 匿名カウンターや設定。

```typescript
await ctx.kv.expose('public:**', { read: 'public', write: 'deny' });
```

不要になったら**ルールを削除**します。

```typescript
await ctx.kv.unexpose('prefs:{user.id}');
```

**現在のルールを確認**します。

```typescript
const rules = await ctx.kv.listRules();
// [{ pattern: 'prefs:{user.id}', read: 'owner', write: 'owner', order: 0 }, ...]
```

最も具体的なパターン（リテラル接頭辞が最長）が優先です。同じパターンを違うロールで追加すると409 KV_EXPOSE_CONFLICTになるため、先にunexposeします。

<span id="ttl--persistence"></span>

## TTLと永続性

```typescript
// 30-day default
await ctx.kv.set('key', 'value');

// Explicit TTL in seconds
await ctx.kv.setex('key', 'value', 3600);           // 1 hour
await ctx.kv.set('key', 'value', { ttl: 3600 });    // same

// Never expires
await ctx.kv.set('key', 'value', { ttl: null });

// Update TTL of an existing key
await ctx.kv.expire('key', 7200);     // 2 hours from now
await ctx.kv.expire('key', null);     // pin forever

// Read remaining TTL in seconds (null = no expiry, null if key missing)
const remaining = await ctx.kv.ttl('key');

// Touch-on-read: resets TTL to the default each time the key is read
const value = await ctx.kv.get('key', { touch: true });

// Ephemeral write — fast cache tier, not guaranteed durable
await ctx.kv.set('cache:heavy-query', result, { ephemeral: true, ttl: 300 });
```

<span id="atomic-operations"></span>

## 原子的な操作

追加の調整処理なしで、分散処理の整合性を保つための操作です。

| メソッド | シグネチャ | 用途 |
|---|---|---|
| `setnx` | `(key, value, opts?) → boolean` | ロック・初回書き込み。作成ならtrue、既存ならfalse。 |
| `setex` | `(key, value, ttl, opts?) → void` | TTL必須のset。 |
| `cas` | `(key, expected, next) → boolean` | 現在値がexpectedなら更新しtrue、違えばfalse。 |
| `incr` | `(key, by?) → number` | by（既定1）増加。未作成は0で開始。 |
| `decr` | `(key, by?) → number` | by（既定1）減少。未作成は0で開始。 |
| `exists` | `(key) → boolean` | 値を読まず存在確認。 |

<span id="distributed-lock-pattern"></span>

### 分散ロック

```typescript
// Try to acquire lock (TTL is the lock lease time)
const acquired = await ctx.kv.setnx('lock:job:42', ctx.requestId, { ttl: 30 });
if (!acquired) {
  return { status: 'already_running' };
}
try {
  // ... do exclusive work ...
} finally {
  // Only release if we still own it
  await ctx.kv.cas('lock:job:42', ctx.requestId, null);
  await ctx.kv.del('lock:job:42');
}
```

<span id="idempotency-key-pattern"></span>

### 冪等性キー

```typescript
// Prevent duplicate charge on retry
const created = await ctx.kv.setnx(`idem:charge:${requestId}`, true, { ttl: 86400 });
if (!created) {
  return { status: 'duplicate' };
}
// proceed with charge
```

<span id="bulk-operations"></span>

## 一括操作

```typescript
// Read multiple keys in one call
const [session, prefs] = await ctx.kv.mget<unknown>(['session:abc', 'prefs:abc']);

// Write multiple keys (parallel PUTs; all share the same TTL option)
await ctx.kv.mset(
  { 'flag:dark-mode': true, 'flag:beta-ui': false },
  { ttl: null },
);
```

<span id="error-handling"></span>

## エラー処理

| エラー | HTTP | 意味 |
|---|---|---|
| `KvNotFoundError` | — | getはnullを返し、例外は投げない |
| `KvForbiddenError` | 403 | ユーザーをアクセス規則で拒否 |
| `KvCasMismatchError` | 409 | expected不一致。再試行が必要 |
| `KvValueTooLargeError` | 413 | キーあたりのサイズ超過 |
| `KvRateLimitedError` | 429 | 毎秒操作数超過。間隔を空ける |
| `KvStorageFullError` | 507 | 合計保存量の上限 |
| `KvKeysExhaustedError` | 507 | キー数の上限 |

429は短い待機後に再試行してください。413の大きな値は[ストレージ](/ja/core-concepts/storage/)も検討できます。

<span id="limits"></span>

## 制限

毎秒操作数、値の最大サイズ、キー数、合計容量を制限します。プランごとの数値は[KV API](/ja/api-reference/kv-api/)を参照してください。

<span id="where-next"></span>

## 次に読む

- [REST API](/ja/api-reference/kv-api/)
- [CLI](/ja/sdks-and-tools/cli/)
- [manage_kv MCPツール](/ja/api-reference/mcp-tools/#manage_kv-actions)
