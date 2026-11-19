---
title: 認証API
description: 認証のエンドポイント一覧。
sidebar:
  order: 2
---

全認証経路は`{app_id}`ごとに分かれ、ユーザーアカウントとトークンもアプリごとに独立しています。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | レート制限 | 用途 |
|--------|------|------------|---------|
| POST | /auth/\{app_id}/signup | 5回/15分 | ユーザーを登録 |
| POST | /auth/\{app_id}/login | 10回/15分 | サインイン |
| POST | /auth/\{app_id}/magic-link | 5回/15分 | 6桁のサインインコードをメール送信 |
| POST | /auth/\{app_id}/magic-link/verify | 10回/15分 | コードをトークンへ交換 |
| POST | /auth/\{app_id}/refresh | 20回/15分 | アクセストークンを更新 |
| POST | /auth/\{app_id}/logout | 認証必須 | セッションを終了 |
| POST | /auth/\{app_id}/verify-email | 10回/15分 | コードでメールを検証 |
| POST | /auth/\{app_id}/forgot-password | 3回/15分 | リセットコードを要求 |
| POST | /auth/\{app_id}/reset-password | 5回/15分 | パスワードをリセット |
| GET | /auth/\{app_id}/me | 認証必須 | 現在のユーザー情報を取得 |
| GET | /auth/\{app_id}/.well-known/jwks.json | 5分キャッシュ | トークン検証用の公開鍵 |

<span id="oauth-endpoints"></span>

## OAuthのエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /auth/\{app_id}/oauth/\{provider}?redirect_to=\{url} | OAuthを開始 |
| GET | /auth/\{app_id}/oauth/\{provider}/callback | OAuthコールバック |
| POST | /auth/\{app_id}/oauth/\{provider}/callback | POSTコールバック（Apple） |

<span id="oauth-configuration"></span>

## OAuthの設定

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/auth/oauth-config | プロバイダーを登録 |
| GET | /v1/\{app_id}/auth/oauth-config | 全プロバイダーを取得 |
| GET | /v1/\{app_id}/auth/oauth-config/\{provider} | 設定を取得 |
| PATCH | /v1/\{app_id}/auth/oauth-config/\{provider} | 設定を更新 |
| DELETE | /v1/\{app_id}/auth/oauth-config/\{provider} | プロバイダーを削除 |

<span id="register-a-provider"></span>

### プロバイダーの登録

```json
POST /v1/{app_id}/auth/oauth-config

{
  "provider": "google",
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/google/callback"]
}
```

**組み込みプロバイダー**（`provider`、`client_id`、`client_secret`、`redirect_uris`だけが必要）：
google, github, discord, facebook, linkedin, microsoft, apple, x

**独自プロバイダー**では`authorization_url`、`token_url`、`userinfo_url`も必要です。

<span id="apple-provider"></span>

### Appleプロバイダー

`provider_metadata`が必要です。

```json
{
  "provider": "apple",
  "client_id": "com.example.app",
  "client_secret": "placeholder",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/apple/callback"],
  "provider_metadata": {
    "teamId": "ABCDE12345",
    "keyId": "KEY123",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n..."
  }
}
```

<span id="requestresponse-examples"></span>

## リクエスト・レスポンス例

<span id="signup"></span>

### ユーザー登録

```json
POST /auth/{app_id}/signup

{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
```

**パスワード要件：** 8文字以上で、大文字、小文字、数字、記号を含むこと。

<span id="login-response"></span>

### ログインのレスポンス

```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "email_verified": true,
    "display_name": "Jane Doe",
    "avatar_url": null
  }
}
```

<span id="magic-link-send"></span>

### サインインコードの送信

```json
POST /auth/{app_id}/magic-link

{ "email": "user@example.com" }
```

メールの存在を推測できないよう、登録の有無によらず同じレスポンスを返します。

```json
{ "message": "If an account exists with that email, a sign-in code has been sent" }
```

コードは**15分**で期限切れになり、1回だけ使えます。初回の検証時に新規ユーザーを自動作成します。

<span id="magic-link-verify"></span>

### サインインコードの検証

```json
POST /auth/{app_id}/magic-link/verify

{ "email": "user@example.com", "code": "123456" }
```

成功時はログインと同じ形のレスポンスです。失敗はHTTP 400で、`Invalid sign-in code`、`Sign-in code already used`、`Sign-in code expired`のいずれかを返します。

<span id="app-configuration"></span>

## アプリの設定

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/config | アプリの全設定を取得 |
| PATCH | /v1/\{app_id}/config/cors | CORSのオリジンを更新 |
| PATCH | /v1/\{app_id}/config/jwt | トークンの有効期間を更新 |
| PATCH | /v1/\{app_id}/config/pause | アプリを一時停止・再開。本文：`{ paused: boolean, reason?: string }`。停止中のデータプレーンは`code: APP_PAUSED`の503を返す。認証とコントロールプレーンは引き続き利用可能。 |

<span id="audit-logs"></span>

## 監査ログ

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/audit-logs | 認証イベントを検索。フィルター：`user_id`、`event_type`、`limit`、`offset` |
