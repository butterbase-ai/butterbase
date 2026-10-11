# ストレージ・関数・クエリ

[SDKの日本語ガイド](../../README.ja.md)

## ストレージ

アップロードしたファイルは`objectId`で参照します。表示やダウンロードの際に`getDownloadUrl(objectId)`でURLを取得します。

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

## 関数

```typescript
// Invoke serverless function
const { data, error } = await butterbase.functions.invoke('my-function', {
  body: { key: 'value' },
  method: 'POST'
});
```

サーバー側の関数ハンドラーでは、クライアントSDKとは別に`ctx.invoke`・`ctx.invokeDO`を使えます。呼び出し側でbearerを用意せずに、ほかの関数やDurable Objectへ接続できます。

> ```typescript
> export async function handler(req, ctx) {
>   const r1 = await ctx.invoke('sibling-fn', { hello: 'world' });
>   const r2 = await ctx.invokeDO('room', 'room-42', { cmd: 'join' });
>   return new Response('ok');
> }
> ```

詳しくは[関数のサーバー間呼び出し](https://docs.butterbase.ai/core-concepts/functions#server-to-server-function-calls)と[Durable Objectのサーバー間呼び出し](https://docs.butterbase.ai/core-concepts/durable-objects#server-to-server-calls-into-durable-objects)を参照してください。

## 検索条件

| メソッド | 条件 |
|---|---|
| `eq(column, value)` | 等しい |
| `neq(column, value)` | 等しくない |
| `gt(column, value)` | より大きい |
| `gte(column, value)` | 以上 |
| `lt(column, value)` | より小さい |
| `lte(column, value)` | 以下 |
| `like(column, pattern)` | 大文字・小文字を区別したパターン一致 |
| `ilike(column, pattern)` | 大文字・小文字を区別しないパターン一致 |
| `in(column, values)` | 配列に含まれる |
| `is(column, value)` | null・true・falseとの比較 |

## 結果の指定

| メソッド | 用途 |
|---|---|
| `select(columns)` | 取得する列を指定 |
| `order(column, options)` | 並び順を指定 |
| `limit(count)` | 最大件数を指定 |
| `offset(count)` | 先頭から指定件数を飛ばす |
