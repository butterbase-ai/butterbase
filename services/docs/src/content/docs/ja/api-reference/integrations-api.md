---
title: 連携API
description: 連携設定、OAuth接続、外部ツール実行のRESTエンドポイント。
sidebar:
  order: 9
---

連携エンドポイントは認証が必要です。管理操作（設定、有効化解除、設定一覧）はAPIキー（`Authorization: Bearer bb_sk_...`）を使います。ユーザー操作（接続、実行、接続一覧）はユーザーJWT、または本文の`userId`とAPIキーを使います。OAuthコールバックは公開経路です。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 認証 | 説明 |
|--------|------|------|-------------|
| `GET` | `/v1/:appId/integrations/available` | APIキー | 推奨ツールキット一覧またはカタログ検索 |
| `GET` | `/v1/:appId/integrations/config` | APIキー | 有効な連携を一覧取得 |
| `POST` | `/v1/:appId/integrations/configure` | APIキー | ツールキットを有効化 |
| `DELETE` | `/v1/:appId/integrations/configure/:toolkit` | APIキー | ツールキットを無効化 |
| `POST` | `/v1/:appId/integrations/connect` | JWTまたはAPIキー＋userId | ユーザー用OAuth URLを生成 |
| `GET` | `/v1/:appId/integrations/callback` | 公開 | OAuthコールバック |
| `GET` | `/v1/:appId/integrations/connections` | JWTまたはAPIキー | 接続済みアカウント一覧 |
| `DELETE` | `/v1/:appId/integrations/connections/:id` | JWTまたはAPIキー | アカウント接続を解除 |
| `GET` | `/v1/:appId/integrations/tools` | JWTまたはAPIキー | 利用可能なツール一覧 |
| `POST` | `/v1/:appId/integrations/execute` | JWTまたはAPIキー＋userId | ツールを実行 |

## GET /v1/:appId/integrations/available

推奨ツールキット10種を一覧取得するか、`?search=`で全カタログを検索します。

```
GET /v1/app_abc/integrations/available?search=salesforce
```

レスポンス：
```json
{
  "integrations": [
    { "toolkit": "salesforce", "displayName": "Salesforce", "curated": false }
  ]
}
```

## POST /v1/:appId/integrations/configure

アプリでツールキットを有効にします。

```json
{
  "toolkit": "gmail",
  "displayName": "Gmail",
  "scopes": []
}
```

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `toolkit` | string | ✓ | ツールキットのスラッグ（例：`gmail`、`google-calendar`） |
| `displayName` | string | | ダッシュボードに表示する名前 |
| `scopes` | string[] | | OAuthスコープ（既定ではプラットフォームが管理） |

## POST /v1/:appId/integrations/connect

ユーザー用のOAuth URLを生成します。ユーザーを`authUrl`へ誘導してください。

```json
{
  "toolkit": "gmail",
  "redirectUrl": "https://yourapp.com/settings",
  "userId": "uuid"
}
```

APIキー認証では`userId`が必須です。ユーザーJWTでは省略します。

レスポンス：
```json
{
  "authUrl": "https://accounts.google.com/...",
  "connectionRequestId": "ca_xxx"
}
```

## POST /v1/:appId/integrations/execute

認証済みユーザーの接続アカウントでツールを実行します。

```json
{
  "toolName": "GMAIL_SEND_EMAIL",
  "params": { "to": "x@y.com", "subject": "Hi", "body": "Hello" },
  "userId": "uuid"
}
```

APIキー利用時は`userId`が必須です。ユーザーJWTでは省略します。

成功時のレスポンス：
```json
{ "successful": true, "data": { ... } }
```

失敗時のレスポンス（`422`はツール側の失敗、`502`はネットワークエラー）：
```json
{
  "error": {
    "code": "INTEGRATIONS_EXECUTION_FAILED",
    "message": "...",
    "remediation": "Check the tool name and parameters. Ensure the user has a connected account."
  }
}
```

<span id="error-codes"></span>

## エラーコード

| コード | HTTP | 意味 |
|------|------|---------|
| `INTEGRATIONS_NOT_CONFIGURED` | 400 | プラットフォームに連携サービスが未設定 |
| `INTEGRATIONS_TOOLKIT_NOT_ENABLED` | 400 | このアプリで未有効化。先に`/configure`を呼ぶ |
| `INTEGRATIONS_EXECUTION_FAILED` | 422/502 | ツール実行失敗（422：ツール側の失敗、502：ネットワークエラー） |
