---
title: 認証
description: メール・パスワード、OAuth、JWT、パスワードリセットの認証機能。
---

エンドユーザーの認証を提供します。app_idごとにアカウントとトークンを分け、データはアプリと同じ[リージョン](/ja/core-concepts/regions/)へ保存します。

<span id="access-modes"></span>

## アクセスモード

access_modeは匿名リクエストがデータAPIとリアルタイムWebSocketへ到達できるかを制御します。その上でRLSも適用します。

| モード | 動作 |
|------|----------|
| `public`（既定） | 匿名を許可。設定済みのRLSは適用。 |
| `authenticated` | 匿名のデータ・リアルタイム通信を401拒否。ユーザーJWTとAPIキーだけ許可。 |

関数とストレージは独自の認証規則があり、access_modeの対象外です。

<span id="toggle-access-mode"></span>

### モードを変更

```json
PATCH /v1/{app_id}/config/access-mode
Authorization: Bearer {token}

{ "access_mode": "authenticated" }
```

レスポンス：

```json
{
  "message": "Access mode updated to \"authenticated\"",
  "app_id": "app_abc123",
  "access_mode": "authenticated"
}
```

<span id="lock-down-in-one-call"></span>

### 1回で保護する

`POST /v1/{app_id}/secure`は、authenticatedへの切り替えと、指定テーブルのユーザー分離RLS・自動入力トリガーをまとめて設定します。

```json
POST /v1/{app_id}/secure
Authorization: Bearer {token}

{
  "tables": [
    { "table_name": "posts", "user_column": "author_id" },
    { "table_name": "comments", "user_column": "user_id" }
  ]
}
```

public_read_columnに真偽列を指定すると、その列がtrueの行の読み取りも許可します。

```json
{
  "tables": [
    { "table_name": "posts", "user_column": "author_id", "public_read_column": "is_published" }
  ]
}
```

tablesを省くと、RLSは変えずモードだけを切り替えます。

tables_securedとtable_errorsを返します。一部のテーブルや列がなくても、ほかには適用します。

戻すにはモードをpublicへPATCHします。

<span id="signup"></span>

## ユーザー登録

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/signup | 15分に5回 |

```json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
```

**パスワード要件：** 8文字以上で、大文字、小文字、数字、記号を含むこと。

6桁の確認コードをメールで自動送信します。

<span id="login"></span>

## ログイン

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/login | 15分に10回 |

```json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!"
}
```

**レスポンス：**

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

APIには**アクセストークン**を送り、期限切れの更新には**リフレッシュトークン**を使います。

<span id="magic-link-sign-in"></span>

## マジックリンクでサインイン

メールで受け取った6桁コードを検証してログインします。パスワードは不要で、新規ユーザーも自動作成します。

**手順1：コード送信**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/magic-link | 15分に5回 |

```json
{
  "email": "user@example.com"
}
```

メールの登録有無によらず同じ応答を返し、ユーザーの列挙を防ぎます。期限は**15分**です。

**手順2：コード検証**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/magic-link/verify | 15分に10回 |

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

loginと同じaccess_token、refresh_token、expires_in、token_type、userを返します。メールを検証済みにし、コードは1回だけ使用できます。

**HTTP 400のエラー：**

| error | 原因 |
|---------|-------|
| `Invalid sign-in code` | 不一致 |
| `Sign-in code already used` | 使用済み |
| `Sign-in code expired` | 15分経過 |

**SDK:**

```ts
const { data, error } = await client.auth.sendMagicLink('user@example.com');
// later, after the user enters the code:
const { data, error } = await client.auth.verifyMagicLink('user@example.com', '123456');
```

verifyMagicLinkはsignInと同様にセッションを自動保存します。

<span id="behavior-notes"></span>

### 動作の補足

- **新規登録：** 未登録のメールには送信時にユーザーを作成し、初回検証でログイン。
- **isNewUser：** 作成から2分以内の検証を、監査ログと認証後フックで新規ユーザーとして扱う。
- **認証後フック：** event: magic_link_loginとprovider: magic_linkを通知。[フック](#post-auth-hooks)を参照。
- **監査イベント：** 送信はmagic_link_requested、検証はmagic_link_login。

<span id="token-refresh"></span>

## トークン更新

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/refresh | 15分に20回 |

新しいアクセストークンへ交換し、古いリフレッシュトークンを無効にします。

```json
{
  "refresh_token": "your-refresh-token"
}
```

<span id="logout"></span>

## ログアウト

| メソッド | パス | 認証 |
|--------|------|---------------|
| POST | /auth/\{app_id}/logout | Bearer必須 |

全リフレッシュトークンを失効し、再ログインを要求します。

<span id="email-verification"></span>

## メール検証

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/verify-email | 15分に10回 |

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

コードの期限は**24時間**です。

<span id="password-reset"></span>

## パスワードリセット

**手順1：コード要求**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/forgot-password | 15分に3回 |

登録有無によらず成功応答を返します。

**手順2：変更**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\{app_id}/reset-password | 15分に5回 |

```json
{
  "email": "user@example.com",
  "code": "123456",
  "new_password": "NewP@ssw0rd!"
}
```

コードは**1時間**で失効します。既存の全セッションを無効にします。

<span id="social-sign-in-oauth"></span>

## SNSログイン（OAuth）

manage_oauth configureか[設定API](/ja/api-reference/auth-api)で登録します。

<span id="built-in-providers"></span>

### 組み込みプロバイダー

client_id、client_secret、redirect_urisを渡すと、URLと既定スコープを自動設定します。

| プロバイダー | 既定スコープ |
|----------|---------------|
| **google** | openid, email, profile |
| **github** | user:email |
| **discord** | identify, email |
| **facebook** | email, public_profile |
| **linkedin** | openid, profile, email |
| **microsoft** | openid, email, profile, User.Read |
| **apple** | name、email（provider_metadataが必要） |
| **x** | tweet.read、users.read（メールなし、代替メールを生成） |

独自プロバイダーはauthorization_url、token_url、userinfo_urlも必要です。

<span id="oauth-flow"></span>

### OAuthの流れ

1. `/auth/{app_id}/oauth/{provider}?redirect_to=https://yourapp.com/callback`へ誘導。
2. プロバイダーにログイン。
3. コールバックへ戻る。
4. クエリにトークンを返す：`?access_token=...&refresh_token=...&expires_in=900`。

<span id="provider-specific-notes"></span>

### プロバイダー固有の補足

- **Google・LinkedIn・Apple：** JWKSでIDトークンから情報を取得。
- **GitHub：** 非公開メールは/user/emailsから自動取得。
- **Apple：** form_postを使用。teamId、keyId、privateKeyのprovider_metadataが必要。名前は初回だけ。
- **X：** PKCEを使用。メールは代替値を生成。

<span id="user-profile"></span>

## ユーザープロフィール

| メソッド | パス | 認証 |
|--------|------|---------------|
| GET | /auth/\{app_id}/me | 必須 |

現在のユーザー情報を返します。

<span id="token-verification-jwks"></span>

## JWKSでトークン検証

| メソッド | パス | キャッシュ |
|--------|------|-------|
| GET | /auth/\{app_id}/.well-known/jwks.json | 5分 |

自分のバックエンドで検証する公開鍵を返します。

<span id="using-tokens-with-the-data-api"></span>

## データAPIでトークンを使う

アクセストークンを含めて呼びます。

```
GET /v1/{app_id}/posts
Authorization: Bearer {access_token}
```

ユーザー分離RLSを有効にすると、自分の行だけが見えます。

<span id="post-auth-hooks"></span>

## 認証後のフック

OAuthログイン、メールログイン、登録の成功後に関数を実行します。fire-and-forgetで、トークン発行を遅らせません。

<span id="configuring"></span>

### 設定

configure_auth_hookかAPIを使います。

```json
PATCH /v1/{app_id}/config/auth-hooks
Authorization: Bearer {token}

{
  "post_auth_function": "on-auth"
}
```

post_auth_function: nullで解除します。先に対象関数を公開してください。

<span id="hook-payload"></span>

### フックの本文

次のJSONをPOSTします。

```json
{
  "event": "oauth_login",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "provider": "google",
    "display_name": "Jane Doe",
    "avatar_url": "https://..."
  },
  "isNewUser": true,
  "provider": "google"
}
```

| フィールド | 値 |
|-------|--------|
| `event` | `"oauth_login"`, `"signup"`, `"login"` |
| `isNewUser` | 初回true、再訪false |
| `provider` | google、github、emailなど |

<span id="example-hook-function"></span>

### フックの例

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { event, user, isNewUser } = await req.json();

  if (isNewUser) {
    // Send welcome email
    ctx.waitUntil(
      fetch("https://api.email.com/send", {
        method: "POST",
        body: JSON.stringify({ to: user.email, template: "welcome" }),
      })
    );

    // Sync profile to your own table
    await ctx.db.query(
      "INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)",
      [user.id, user.display_name]
    );
  }

  return new Response("ok");
}
```

butterbase_serviceとして実行します（RLSをバイパス）。ctx.userはnullです。ユーザーの特定には本文を使います。

<span id="token-lifetimes"></span>

## 有効期間

update_jwt_configでアプリごとに変更します。

- **アクセス：** 既定1h。15m、30m、1h、2h、1dから選択。
- **リフレッシュ：** 既定7日。日単位で変更可能。

SSRのCookieより早くJWTが失効して無応答になるのを避けるため、既定は1時間です。短くする場合はaccess_token_ttl: 15mなどへ変更し、Cookie内のトークンが切れる前にクライアントが更新してください。
