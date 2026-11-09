---
title: 外部連携
description: Gmail、Google Calendar、Slack、GitHubなどへユーザーが認証し、アプリから代理実行します。
---

ユーザーがGmail、Slack、GitHubなどのアカウントを接続し、アプリの代理操作を許可できます。OAuth、トークン保存、更新処理はButterbaseが管理します。

<span id="how-it-works"></span>

## 仕組み

1. **設定** — 開発者がツールキットを有効にすると、OAuth設定を作成します。
2. **接続** — ユーザーの接続操作でAPIを呼び、取得したURLへ誘導します。OAuthのやり取りは自動処理します。
3. **実行** — ツール名と引数でAPIを呼び、保存済みユーザー認証情報で外部へ転送します。

<span id="curated-integrations"></span>

## 推奨連携

検証済みで標準対応するツールキットです。

| ツールキット | スラッグ | 用途 |
|---------|------|-----------|
| Gmail | `gmail` | メール送信、受信一覧、ラベル管理 |
| Google Calendar | `google-calendar` | 予定作成、会議一覧 |
| Slack | `slack` | メッセージ、チャンネル、ユーザー管理 |
| Google Sheets | `google-sheets` | 表の読み書き |
| Notion | `notion` | ページ作成、検索、DB更新 |
| GitHub | `github` | Issue、PR、リポジトリ閲覧 |
| HubSpot | `hubspot` | 連絡先、商談、企業管理 |
| Outlook | `outlook` | メール、カレンダー |
| Google Drive | `google-drive` | アップロード、取得、一覧 |
| Discord | `discord` | メッセージ、サーバー管理 |

`GET /v1/:appId/integrations/available?search=<query>`で1000以上のツールキットを含む全カタログも検索できます。

<span id="configuring-an-integration-admin"></span>

## 管理者が連携を設定

APIキーでアプリのツールキットを有効にします。

```json
POST /v1/:appId/integrations/configure
{
  "toolkit": "gmail",
  "displayName": "Gmail",
  "scopes": []
}
```

レスポンス：
```json
{
  "id": "uuid",
  "app_id": "app_abc123",
  "toolkit_slug": "gmail",
  "enabled": true
}
```

無効化：`DELETE /v1/:appId/integrations/configure/:toolkit`

<span id="connecting-an-end-user-account"></span>

## ユーザーがアカウントを接続

リダイレクトURLを指定して接続APIを呼び、OAuth認可ページへ送ります。

```json
POST /v1/:appId/integrations/connect
Authorization: Bearer <user-jwt>
{
  "toolkit": "gmail",
  "redirectUrl": "https://yourapp.com/settings?tab=integrations"
}
```

レスポンス：
```json
{
  "authUrl": "https://accounts.google.com/...",
  "connectionRequestId": "ca_xxx"
}
```

ユーザーをauthUrlへ誘導します。認可後はredirectUrlへ`?status=connected&toolkit=gmail`付きで戻ります。

:::note
OAuthコールバックはButterbaseがすべて処理します。アプリにコールバック経路は不要です。
:::

<span id="executing-tools"></span>

## ツールを実行

接続後はそのツールキットの各ツールを実行できます。

```json
POST /v1/:appId/integrations/execute
Authorization: Bearer <user-jwt>
{
  "toolName": "GMAIL_SEND_EMAIL",
  "params": {
    "to": "user@example.com",
    "subject": "Hello from my app",
    "body": "This was sent via Butterbase integrations."
  }
}
```

レスポンス：
```json
{
  "successful": true,
  "data": { "messageId": "msg_xxx" }
}
```

利用可能なツールの一覧取得：

```
GET /v1/:appId/integrations/tools?toolkit=gmail
```

<span id="using-integrations-in-functions"></span>

## 関数から利用

全Butterbase関数にctx.integrationsを渡します。

```typescript
export default async function handler(ctx) {
  // Execute a tool on behalf of the calling user
  const result = await ctx.integrations.execute('GMAIL_SEND_EMAIL', {
    to: ctx.body.email,
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  });

  // Execute as a specific user (e.g. in a cron job)
  const events = await ctx.integrations.asUser(userId).execute(
    'GOOGLECALENDAR_EVENTS_LIST',
    { timeMin: new Date().toISOString() }
  );

  return { ok: true };
}
```

**認証：** アプリごとの関数キーを自動設定します。
このキーは対象アプリの/integrations/executeだけを呼べます。
サービスの呼び出し元として動くため、エンドユーザーの接続を使う場合は
.asUser(userId)が必要です（cron、定期同期、Webhookなど）。
ユーザー指定のないctx.integrations.execute(...)は、
エンドユーザーJWTで関数を呼んだ場合だけ利用できます。
リクエストの認証コンテキストから接続先を解決するためです。

## SDK

```typescript
import { Butterbase } from '@butterbase/sdk';
const bb = new Butterbase({ appId: 'app_xxx', apiKey: 'bb_sk_...' });

// Admin: configure a toolkit
await bb.integrations.configure('slack');

// Get configured integrations
const { data } = await bb.integrations.getConfig();

// User: generate OAuth connect URL
const { data: result } = await bb.integrations.connect('slack', {
  redirectUrl: 'https://yourapp.com/connected',
});
window.location.href = result.authUrl;

// Execute a tool (JWT auth)
const { data } = await bb.integrations.execute('SLACK_SEND_MESSAGE', {
  channel: '#general',
  text: 'Hello from my app',
});

// Service-level execution on behalf of a user
const { data } = await bb.integrations.asUser(userId).execute(
  'GMAIL_SEND_EMAIL',
  { to: 'user@example.com', subject: 'Hi', body: 'Hello' }
);
```

<span id="managing-connections"></span>

## 接続を管理

```
GET /v1/:appId/integrations/connections          — list connected accounts
DELETE /v1/:appId/integrations/connections/:id   — disconnect an account
```

ユーザーは自分の接続だけを見られます。APIキーではアプリの全接続を見られます。
