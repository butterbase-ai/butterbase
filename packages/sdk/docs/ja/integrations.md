# 外部連携とほかのクライアント

[SDKの日本語ガイド](../../README.ja.md)

外部サービスをアプリへ接続し、利用者に代わって操作できます。

## 管理者の設定（APIキー）

toolkitの有効化・一覧取得・無効化・検索を行います。

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

## 利用者のOAuth（利用者JWT）

接続URLへ利用者を移動させ、認証後に接続済みアカウントを取得します。不要な接続は解除できます。

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

## ツールの実行

利用者JWTで実行するか、cronなどからAPIキーと`asUser(userId)`を使って利用者を指定します。

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

## ほかのクライアント

| クライアント | 機能 |
|---|---|
| `butterbase.realtime` | テーブル変更購読・presence。`connect`、`on`、`trackPresence`、`onPresence`、`send` |
| `butterbase.ai` | `chat`、`chatStream`、`embed`、`decide`、`listModels`、`getConfig`、`getUsage` |
| `butterbase.rag` | collection、`ingest`、文書、`query` |
| `butterbase.billing` | アプリのStripe Connectプラン・商品・購読・注文 |
| `butterbase.partners`、`people`、`substrate` | パートナーAPI、人物・企業情報の検索と補完、substrate |
| `butterbase.admin.*` | スキーマ・RLS・OAuth・設定・関数・APIキー・監査・フロントエンド・ドメイン・Durable Object・edge SSR・移行 |

パッケージは`defineKvConfig`と`Kv*`エラークラスも公開します。
