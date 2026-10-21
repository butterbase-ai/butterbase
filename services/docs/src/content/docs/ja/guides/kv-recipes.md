---
title: KVの使い方
description: セッション、ロック、レート制限、重複排除、機能フラグの実装例です。
---

短期間のデータ、キーで取得するデータ、リレーショナルな検索を必要としないデータに適しています。[関数](/ja/core-concepts/functions/)へ例を貼り、キーとTTLを調整してください。

すべて関数内のctx.kvを使います。[KVストア](/ja/core-concepts/kv/)も参照してください。

<span id="session-store"></span>

## セッションの保存

認証セッション、カート、入力手順の進行など、期限のあるユーザー状態をアプリごとにJSONで保存できます。自動で失効するため、削除ジョブは不要です。

```typescript
export default async function handler(req, ctx) {
  // Read an existing session
  const sessionId = req.headers.get('x-session-id');
  const session = await ctx.kv.get<{ userId: string; role: string }>(
    `session:${sessionId}`,
  );
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  // session.userId and session.role are available here
  return Response.json({ userId: session.userId });
}

// On login — write a session with a 24-hour TTL
async function createSession(ctx, sessionId: string, userId: string, role: string) {
  await ctx.kv.set(
    `session:${sessionId}`,
    { userId, role },
    { ttl: 60 * 60 * 24 },
  );
}

// On logout — delete immediately rather than waiting for expiry
async function destroySession(ctx, sessionId: string) {
  await ctx.kv.del(`session:${sessionId}`);
}
```

TTLは保存時に固定します。読み取りのたびに延長するには、getの成功後に`ctx.kv.expire(key, seconds)`を使います。値はユーザーIDやロールなど小さく保ち、大きなデータには[ストレージ](/ja/core-concepts/storage/)を検討してください。

```bash
# Inspect a live session; force sign-out a specific user without waiting for TTL
butterbase kv get session:<id>
butterbase kv del session:<id>
```

<span id="distributed-lock"></span>

## 分散ロック

同じジョブを複数のワーカーが同時実行してはいけない場合に使います。setnxは存在しない場合だけ保存し、ロックを取得するとtrueを返します。

```typescript
export default async function handler(req, ctx) {
  const { orderId } = await req.json();
  const lockKey = `lock:order:${orderId}`;

  // Attempt to acquire — lock expires in 30 s if the worker crashes
  const acquired = await ctx.kv.setnx(lockKey, ctx.requestId, { ttl: 30 });
  if (!acquired) {
    return Response.json({ error: 'already_processing' }, { status: 409 });
  }

  try {
    // ... do the exclusive work here ...
    return Response.json({ status: 'done' });
  } finally {
    // Release only if we still own the lock (guards against TTL expiry race)
    const swapped = await ctx.kv.cas(lockKey, ctx.requestId, null);
    if (swapped) {
      await ctx.kv.del(lockKey);
    }
  }
}
```

TTLは処理の期限ではなく、クラッシュした際の解放用です。処理時間より十分長くしてください。30秒を超える場合はTTLの延長やexpireでの更新を検討します。競合時に即座の応答が必要なユーザー操作では、下の重複排除を検討してください。

```bash
# Inspect who holds the lock; force-release if a worker crashed without TTL covering it
butterbase kv get lock:order:<id>
butterbase kv del lock:order:<id>
```

<span id="rate-limiter"></span>

## レート制限

時間帯を含むキーのカウンターで、ユーザーごとの回数を制限します。期間が切り替わると新しいキーを使います。

```typescript
export default async function handler(req, ctx) {
  const userId = req.headers.get('x-user-id') ?? 'anonymous';
  const windowMinute = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:${userId}:${windowMinute}`;

  const count = await ctx.kv.incr(key);
  // Set the TTL on the first increment so the key expires after the window
  if (count === 1) {
    await ctx.kv.expire(key, 60);
  }
  if (count > 100) {
    return new Response('Rate limit exceeded', { status: 429 });
  }

  // ... handle the request ...
  return Response.json({ remaining: 100 - count });
}
```

フロントエンドから直接アクセスする場合、expose()で対象を公開できます。

```typescript
// Call once during app setup or in a migration function
await ctx.kv.expose('ratelimit:{user.id}:*', { read: 'owner', write: 'owner' });
```

クライアントのアクセス権を設定するKVメソッドはexpose()です。[アクセス制御](/ja/core-concepts/kv/#access-control)を参照してください。

固定の期間では、境界の直前と直後に上限の2倍まで集中する場合があります。より平滑な制限には、タイムスタンプの一覧などを使う移動する期間の方式を検討してください。

```bash
# Inspect the running request count for a user in the current time window
butterbase kv get ratelimit:<user>:<window>
```

<span id="idempotency-keys"></span>

## 重複排除のキー

通信失敗や重複送信で再試行しても、処理を1回だけ行い、同じ結果を返す必要があります。setnxでリクエストIDを不可分に確保します。

```typescript
export default async function handler(req, ctx) {
  const requestId = req.headers.get('x-idempotency-key');
  if (!requestId) {
    return new Response('Missing X-Idempotency-Key header', { status: 400 });
  }

  const idemKey = `idempotent:${requestId}`;

  // Try to claim this request ID
  const claimed = await ctx.kv.setnx(idemKey, 'pending', { ttl: 60 * 60 * 24 });

  if (!claimed) {
    // Already processed (or in progress) — return cached result
    const cached = await ctx.kv.get<string>(idemKey);
    if (cached && cached !== 'pending') {
      return new Response(cached, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Still pending — tell client to retry shortly
    return new Response('Request in progress', { status: 409 });
  }

  // We own it — do the work
  const result = await doTheWork();

  // Store the serialised result so duplicates can return it
  await ctx.kv.set(idemKey, JSON.stringify(result), { ttl: 60 * 60 * 24 });

  return Response.json(result);
}

async function doTheWork() {
  // your business logic here
  return { charged: true, amount: 4900 };
}
```

TTLはクライアントの再試行期間より長くします。処理が例外になるとpendingがTTL内で残るため、エラーの保存やキーの削除で再試行できるようにしてください。

```bash
# Verify whether a specific request ID has already been claimed
butterbase kv get idempotent:<request-id>
```

<span id="feature-flags"></span>

## 機能フラグ

KVに値を保存し、リクエストごとに読みます。再デプロイせず次のリクエストから反映できます。

```typescript
export default async function handler(req, ctx) {
  // Read flag — default to 'off' if key is missing
  const flagValue = await ctx.kv.get<string>('feature:new-checkout');
  const newCheckoutEnabled = flagValue === 'on';

  if (newCheckoutEnabled) {
    // new checkout path
    return Response.json({ checkout: 'v2' });
  } else {
    // legacy path
    return Response.json({ checkout: 'v1' });
  }
}
```

コードを変更せずに切り替えます。

```bash
# CLI
butterbase kv set feature:new-checkout on
butterbase kv set feature:new-checkout off
```

MCPのmanage_kvのsetや、ダッシュボードの**KV**でも変更できます。

割合で公開するには閾値（例：30%の30）を保存し、ユーザーIDの一定のハッシュと比較します。

```typescript
const threshold = parseInt((await ctx.kv.get<string>('rollout:new-checkout')) ?? '0', 10);
const bucket = hashUserId(userId) % 100; // your own stable hash function
const enabled = bucket < threshold;
```

同じユーザーは同じ結果になるため、閾値を上げて徐々に対象を広げられます。

```bash
# Flip a flag instantly without redeploying; read back to confirm the new value
butterbase kv set feature:<name> on
butterbase kv get feature:<name>
```
