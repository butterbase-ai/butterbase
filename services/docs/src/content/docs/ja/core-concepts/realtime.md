---
title: リアルタイム
description: WebSocketの変更通知、RLSに基づくフィルタリング、プレゼンス追跡。
---

WebSocket接続でデータ変更をリアルタイム通知します。テーブルで有効にすると、INSERT、UPDATE、DELETEを接続中のクライアントへ配信します。

<span id="enabling-realtime"></span>

## 有効にする

```
manage_realtime({ app_id: "app_abc123", action: "configure", tables: ["messages", "notifications"] })
```

変更を捕捉してpg_notifyで配信するデータベーストリガーを作成します。

<span id="connecting-via-websocket"></span>

## WebSocket接続

接続先：`wss://api.butterbase.ai/v1/{app_id}/realtime`

<span id="authentication"></span>

### 認証

**ブラウザ（推奨）：** クエリパラメーターにトークンを渡します。

```
wss://api.butterbase.ai/v1/app_abc123/realtime?token=eyJhbG...
```

**Node.js・サーバー側：** Authorizationヘッダーを使います。

```javascript
const ws = new WebSocket('wss://api.butterbase.ai/v1/app_abc123/realtime', {
  headers: { Authorization: 'Bearer <jwt>' }
});
```

| 認証方法 | 割り当てるロール |
|-------------|--------------|
| エンドユーザーJWT | butterbase_user（RLSを適用） |
| APIキー（`bb_sk_...`） | butterbase_service（全変更を取得） |
| 認証なし | butterbase_anon |

<span id="client-protocol"></span>

## クライアントのプロトコル

```json
// Client -> Server
{ "type": "subscribe", "table": "messages" }
{ "type": "unsubscribe", "table": "messages" }

// Server -> Client
{ "type": "connected", "app_id": "app_abc123", "role": "butterbase_user" }
{ "type": "subscribed", "table": "messages" }
{ "type": "change", "table": "messages", "op": "INSERT", "record": {...}, "old_record": null, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "UPDATE", "record": {...}, "old_record": {...}, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "DELETE", "record": null, "old_record": {...}, "timestamp": "..." }
{ "type": "heartbeat", "timestamp": "..." }
{ "type": "error", "message": "..." }
```

<span id="browser-example"></span>

## ブラウザの例

```javascript
const token = 'eyJhbG...'; // end-user JWT
const ws = new WebSocket(`wss://api.butterbase.ai/v1/app_abc123/realtime?token=${token}`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', table: 'messages' }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'change') {
    console.log(msg.op, msg.table, msg.record);
  }
};
```

<span id="subscription-filters"></span>

## 購読フィルター

変更の一部だけを購読します。

```json
{ "type": "subscribe", "table": "messages", "filter": { "channel_id": "abc" } }
```

`channel_id = 'abc'`に一致する変更だけを送ります。列の完全一致で判定します。

<span id="row-level-security"></span>

## 行レベルセキュリティ

リアルタイムのイベントにもRLSを適用します。
- **butterbase_user** — SELECT可能な行の変更だけを取得
- **butterbase_service** — 全変更を取得
- **butterbase_anon** — 匿名ユーザーのポリシーで許可された変更を取得

<span id="presence-tracking"></span>

## プレゼンス追跡

ほかの接続ユーザーを追跡します。

```json
// Opt in with metadata
{ "type": "presence_track", "metadata": { "name": "Alice", "cursor": { "x": 10, "y": 20 } } }

// Update metadata (e.g. cursor moved)
{ "type": "presence_update", "metadata": { "cursor": { "x": 50, "y": 60 } } }
```

サーバーはプレゼンス追跡中の全クライアントへ配信します。

```json
{ "type": "presence_state", "clients": [{ "client_id": "...", "user_id": "...", "metadata": {...} }] }
{ "type": "presence_join", "client_id": "...", "user_id": "...", "metadata": {...} }
{ "type": "presence_update", "client_id": "...", "metadata": {...} }
{ "type": "presence_leave", "client_id": "...", "user_id": "..." }
```

プレゼンスはメモリ内だけに保存し、サーバー再起動でリセットします。

<span id="websocket-triggers"></span>

## WebSocketトリガー

クライアントの自作イベントで起動する関数をデプロイします。

```
deploy_function({
  name: "handle-chat",
  code: "...",
  trigger: { type: "websocket", config: { event: "chat_message" } }
})
```

クライアントからイベントを送ります。
```json
{ "type": "event", "event": "chat_message", "payload": { "text": "hello" } }
```

関数のレスポンスを返します。
```json
{ "type": "event_response", "event": "chat_message", "data": { "echo": { "text": "hello" } } }
```

<span id="limitations"></span>

## 制限

- リアルタイム有効化の前にテーブルが存在する必要があります
- 各変更で行全体を送ります（列のフィルターは未対応）
- LISTENの再接続中にイベントを失う場合があります。再接続後は状態を再取得してください

<span id="substrate-changes"></span>

## Substrateの変更

このページはアプリの**データベーステーブル**を対象とします。[Substrate](/ja/core-concepts/substrate/)内のエンティティ、アクション台帳、決定・約束・学びには、組織単位で通知の外枠だけを送る別のストリームがあります。[Substrateのライブ更新](/ja/core-concepts/substrate/#8-stream-live-updates-to-a-ui)とSDKの`bb.substrate.stream`を参照してください。
