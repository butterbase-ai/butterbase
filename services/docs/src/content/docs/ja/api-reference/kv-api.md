---
title: KV API
description: KVの取得、保存、削除、不可分操作、一括処理、検索、公開ルール、監査ログのREST APIを説明します。
sidebar:
  order: 10
---

Butterbase KVは、HTTPで利用できるアプリごとのキーと値のストアです。すべての操作が1つのアプリを対象とし、リクエストごとに認証します。共通のベースパスと`{ error, message }`のエラー形式を使います。

<span id="base-url"></span>

## ベースURL

```
https://api.butterbase.ai/v1/{app_id}/kv/...
```

`{app_id}`をアプリのID（例：`app_abc123`）に置き換えてください。`kv/`は固定で、その後にはユーザーのキー、または以下の`_`で始まる予約済みのパスを指定します。

認証の詳細は[認証](/ja/core-concepts/authentication)を参照してください。

---

<span id="authentication"></span>

## 認証

各リクエストに`Authorization: Bearer <token>`を指定します。ヘッダーがなければ匿名リクエストとして扱います。トークンは3種類に対応しています。

<span id="function-key"></span>

### 関数キー

```http
Authorization: Bearer <function_key>
```

Butterbaseの関数内で動くサーバー側のコードに使います。ランタイムが自動で設定するため、直接管理する必要はありません。関数キーはすべてのキーを読み書きでき、公開ルールも管理できます。

<span id="end-user-jwt"></span>

### エンドユーザーのJWT

```http
Authorization: Bearer <jwt>
```

`auth_config`で設定したアプリの認証プロバイダーが発行するJWTです。ログイン後、フロントエンドから送信します。有効な`expose()`ルールの対象となるキーだけにアクセスできます。ルールがなければ401または403です。JWTは`.`で区切る3つの要素（`header.payload.signature`）で構成します。

<span id="platform-jwt-owner--dashboard"></span>

### プラットフォームのJWT（所有者・ダッシュボード）

```http
Authorization: Bearer <platform_jwt>
```

アプリを所有するプラットフォームアカウントにButterbaseが発行するJWTです。ダッシュボードや所有者用ツールに使います。公開ルールの管理を含め、関数キーと同じ権限を持ちます。通常のアプリコードには関数キーを使ってください。

---

<span id="endpoints"></span>

## エンドポイント

### GET /v1/:app_id/kv/:key

`key`の値を読み取ります。キーにスラッシュを含められます（例：`session/abc-123`）。

**認証：** 関数キー、プラットフォームJWT、読み取りを許可する公開ルールの対象となるエンドユーザーJWT、または`public`読み取りを許可するルールの対象となる匿名リクエスト。

**クエリパラメーター**

| パラメーター | 型 | 説明 |
|-----------|------|-------------|
| `touch` | `boolean` | `true`なら、永続キーのTTLを元の値に戻します（アクセスによる有効期限の延長）。既定値は`false`。 |

**応答`200`**

```json
{ "value": <any JSON value> }
```

**応答`404`**

```json
{ "error": "not_found", "message": "not_found" }
```

**例**

```bash
GET /v1/app_abc123/kv/session/user-42
Authorization: Bearer <function_key>
```

```json
{ "value": { "userId": "user-42", "role": "admin" } }
```

---

### GET /v1/:app_id/kv/:key/ttl

`key`の残りのTTLを秒単位で返します。

**認証：** GET `:key`と同じです。

**応答`200`**

```json
{ "ttl": 86312 }
```

有効期限がなければ`ttl`は`null`、あれば秒単位の正の整数です。キーがなければ404を返します。

---

### GET /v1/:app_id/kv/:key/exists

値を取得せずに`key`の存在を確認します。

**認証：** GET `:key`と同じです。

**応答`200`**

```json
{ "exists": true }
```

常に200を返し、`exists`は`true`または`false`です。

---

### PUT /v1/:app_id/kv/:key

`key`を作成または上書きします。既存の値は不可分な操作として置き換えます。

**認証：** 関数キー、プラットフォームJWT、または書き込みを許可する公開ルールの対象となるエンドユーザーJWT。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `value` | any JSON | はい | 保存する値。JSONへ変換できる任意の型に対応します。 |
| `ttl` | integer or `null` | いいえ | 秒単位の有効期限。`null`なら期限を削除します。省略すると既定値の30日です。数値を指定する場合は正の整数にします。 |
| `ephemeral` | boolean | いいえ | `true`なら短期間・低コストの一時層へ保存します。既定値は`false`（永続層）。 |

**応答`204`**：本文なし。

**例**

```bash
PUT /v1/app_abc123/kv/session/user-42
Authorization: Bearer <function_key>
Content-Type: application/json

{
  "value": { "userId": "user-42", "role": "admin" },
  "ttl": 3600
}
```

---

### DELETE /v1/:app_id/kv/:key

`key`を削除します。永続層と一時層の両方にあれば、両方を削除します。

**認証：** 関数キー、プラットフォームJWT、または書き込みを許可する公開ルールの対象となるエンドユーザーJWT。

**応答`200`**

```json
{ "deleted": 1 }
```

`deleted`はストアから削除した件数です。キーがなければ0、一方の層にあれば1、両方にあれば2です。

---

### POST /v1/:app_id/kv/:key/incr

`key`の数値カウンターを不可分な操作で加算します。キーがなければ0で初期化してから加算します。

**認証：** 関数キー、プラットフォームJWT、またはエンドユーザーJWT（書き込みの公開ルールが必要）。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `by` | integer | いいえ | 加算する整数。既定値は1。 |

**応答`200`**

```json
{ "value": 42 }
```

`value`は操作後の新しい整数値です。

---

### POST /v1/:app_id/kv/:key/decr

数値カウンターを不可分な操作で減算します。加算ではなく減算する点を除き、`incr`と同じです。

**認証：** 関数キー、プラットフォームJWT、またはエンドユーザーJWT（書き込みの公開ルールが必要）。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `by` | integer | いいえ | 減算する整数。既定値は1。 |

**応答`200`**

```json
{ "value": 7 }
```

---

### POST /v1/:app_id/kv/:key/setnx

`key`が**存在しない場合だけ**保存します（set if not exists）。

**認証：** 関数キー、プラットフォームJWT、またはエンドユーザーJWT（書き込みの公開ルールが必要）。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `value` | any JSON | はい | キーが存在しない場合に保存する値 |
| `ttl` | integer or `null` | いいえ | 秒単位のTTL。PUTと同じ条件です。 |
| `ephemeral` | boolean | いいえ | 一時層へ保存します。既定値は`false`。 |

**応答**

| コード | 本文 | 意味 |
|------|------|---------|
| `201` | `{ "wrote": true }` | キーがなく、値を保存しました。 |
| `200` | `{ "wrote": false }` | キーが既にあり、変更しませんでした。 |

---

### POST /v1/:app_id/kv/:key/cas

比較して置き換える操作（compare-and-swap）。現在の値が`expected`と等しい場合だけ、`key`を不可分な操作で更新します。

**認証：** 関数キー、プラットフォームJWT、またはエンドユーザーJWT（書き込みの公開ルールが必要）。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `expected` | any JSON or `null` | はい | 一致させる現在値。キーが存在しない状態を指定するには`null`を使います。 |
| `next` | any JSON | はい | 一致した場合に保存する新しい値 |

**応答`200`**

```json
{ "swapped": true }
```

更新が成功すると`swapped`は`true`です。現在値が`expected`と異なる場合は`false`です。

**補足：** CASでは、JSON文字列`"__NULL__"`の値と、キーが存在しないことを示す内部値を区別できません。操作名で終わるキー（例：`session/cas`）を使うには、区切りをURLエンコードしてください（`session%2Fcas`）。

---

### POST /v1/:app_id/kv/:key/expire

値を変えずに、既存キーのTTLを更新または削除します。

**認証：** 関数キー、プラットフォームJWT、またはエンドユーザーJWT（書き込みの公開ルールが必要）。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `ttl` | integer or `null` | はい | 新しいTTL（秒単位の0以上の整数）。`null`なら無期限に保持します。 |

**応答`200`**

```json
{ "applied": true }
```

キーが存在してTTLを更新した場合、`applied`は`true`です。キーがなければ`false`です。

---

### POST /v1/:app_id/kv/_batch

1回の通信で最大100件の`get`、`set`、`del`を実行します。

**認証：** 関数キー、プラットフォームJWT、またはエンドユーザーJWT。JWTや匿名の呼び出しでは、各操作に公開ルールのアクセス確認を適用します。

**リクエスト本文**

```json
{
  "ops": [
    { "op": "get", "key": "counter/daily" },
    { "op": "set", "key": "counter/daily", "value": 0 },
    { "op": "del", "key": "temp/scratch" }
  ]
}
```

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `ops` | array | はい | 操作オブジェクトの配列。最大100件。 |
| `ops[].op` | `"get"` \| `"set"` \| `"del"` | はい | 操作の種類 |
| `ops[].key` | string | はい | 操作するキー |
| `ops[].value` | any JSON | `set`では必須 | 保存する値 |

**応答`200`**

```json
{
  "results": [
    { "value": 17 },
    { "ok": true },
    { "deleted": 1 }
  ]
}
```

`ops`と同じ順序で結果を返します。一部の操作が失敗しても全体は失敗せず、その結果に`error`を含めます。

| 結果の形式 | 意味 |
|---|---|
| `{ "value": <v> }` | `get`成功（キーがなければ`value`は`null`） |
| `{ "ok": true }` | `set`成功 |
| `{ "deleted": N }` | `del`完了（`N`は0または1） |
| `{ "error": "key_invalid" }` | キーの検証に失敗 |
| `{ "error": "KV_VALUE_TOO_LARGE" }` | 値が256KBを超過 |
| `{ "error": "KV_FORBIDDEN" }` | 公開ルールがこのキーへのアクセスを拒否 |
| `{ "error": "invalid op" }` | `op`が`get`、`set`、`del`のいずれでもない |
| `{ "error": "missing value" }` | `set`で`value`が不足 |
| `{ "error": "redis_error", "message": "..." }` | 一時的なストレージのエラー |

---

### GET /v1/:app_id/kv/_scan

アプリの全キーを走査します。任意のプレフィックスで絞り込めます。ツールや管理用スクリプト向けです。

**認証：** 関数キーまたはプラットフォームJWTのみ。エンドユーザーJWTと匿名リクエストには403を返します。

**クエリパラメーター**

| パラメーター | 型 | 説明 |
|-----------|------|-------------|
| `prefix` | string | この文字列で始まるキーだけを返します。 |
| `limit` | integer | 1ページあたりの最大件数 |
| `cursor` | string | 前の走査で返されたカーソル。次のページの取得に使います。 |

**応答`200`**

```json
{
  "keys": ["counter/daily", "session/user-1", "session/user-2"],
  "cursor": "eyJwYWdlIjoxfQ"
}
```

次のページがなければ`cursor`は`null`、または省略されます。

---

### GET /v1/:app_id/kv/_stats

アプリのストレージの統計を返します。

**認証：** 関数キーまたはプラットフォームJWTのみ。エンドユーザーJWTと匿名リクエストには403を返します。

**応答`200`**

```json
{
  "keys_total": 4821,
  "bytes_used": 1048576,
  "ops_per_sec": null,
  "limit": {
    "max_ops_per_sec": 50,
    "max_storage_bytes": 10485760,
    "max_keys_total": 100000,
    "max_value_bytes": 262144
  }
}
```

`ops_per_sec`は実際の通信量を表し、最近の操作がなければ`null`の場合があります。`limit`には現在のプランの上限を含めます。

---

### POST /v1/:app_id/kv/_flush

アプリの全キーを削除します。元に戻せません。

**認証：** 関数キーまたはプラットフォームJWTのみ。エンドユーザーJWTと匿名リクエストには403を返します。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `confirm` | `true` | はい | 真偽値の`true`が必須です。省略した場合や別の値では400の`confirm_required`エラーを返します。 |
| `include_config` | boolean | いいえ | `true`なら公開ルールなど、アプリごとのKV設定も削除します。既定値は`false`。 |

**応答`200`**

```json
{ "deleted": 4821 }
```

`deleted`は削除したキーの合計件数です。

---

### GET /v1/:app_id/kv/_expose

アプリの全公開ルールを返します。公開ルールは、エンドユーザーJWTと匿名の呼び出し元が、どのキーにどの権限でアクセスできるかを制御します。

**認証：** 関数キーまたはプラットフォームJWTのみ。

**応答`200`**

```json
{
  "rules": [
    { "pattern": "session/{user.id}/*", "read": "owner", "write": "owner", "order": 0 },
    { "pattern": "public/*",            "read": "public", "write": "deny",  "order": 1 }
  ]
}
```

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `pattern` | string | glob形式のキーパターン。`owner`の確認では`{user.id}`と`{user.role}`を呼び出し元のJWTのクレームで置き換えます。 |
| `read` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | 読み取りに必要な権限 |
| `write` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | 書き込みに必要な権限 |
| `order` | integer | 宣言の順序。競合時は小さい番号を優先します。 |

ロールの意味：

| ロール | 意味 |
|------|---------|
| `public` | 匿名を含むすべての呼び出し元 |
| `authed` | 有効なエンドユーザーJWTのある呼び出し元 |
| `owner` | `user.id`または`user.role`がパターンの置換結果と一致する認証済みユーザー |
| `deny` | 一致する種類のアクセスを常に拒否 |

---

### PUT /v1/:app_id/kv/_expose/:pattern

公開ルールを作成または更新します。`:pattern`はURLエンコードしてください（例：`session%2F%7Buser.id%7D%2F*`）。

**認証：** 関数キーまたはプラットフォームJWTのみ。

**リクエスト本文**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `read` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | はい | このパターンの読み取り権限 |
| `write` | `"public"` \| `"authed"` \| `"owner"` \| `"deny"` | はい | このパターンの書き込み権限 |

**応答`204`**：ルールを保存しました。本文はありません。

**応答`409`**

```json
{
  "error": "KV_EXPOSE_CONFLICT",
  "message": "pattern conflicts with existing rule",
  "existing": { "pattern": "session/*", "read": "authed", "write": "deny" }
}
```

新しいパターンが既存のルールと曖昧に重複する場合に返します（同じキーの範囲、重なる権限）。

**例**

```bash
PUT /v1/app_abc123/kv/_expose/session%2F%7Buser.id%7D%2F*
Authorization: Bearer <function_key>
Content-Type: application/json

{ "read": "owner", "write": "owner" }
```

---

### DELETE /v1/:app_id/kv/_expose/:pattern

公開ルールを削除します。`:pattern`はURLエンコードしてください。

**認証：** 関数キーまたはプラットフォームJWTのみ。

**応答`200`**

```json
{ "deleted": 1 }
```

ルールが存在して削除した場合、`deleted`は1です。一致するルールがなければ0です。

---

### GET /v1/:app_id/kv/_audit_recent

最近のKVエラー（HTTP 4xx・5xx）を返します。拒否されたパターンの調査や、公開ルールの設定不備の確認に使えます。

**認証：** 認証済みの呼び出し元（関数キー、プラットフォームJWT、エンドユーザーJWT）。匿名には401を返します。

**クエリパラメーター**

| パラメーター | 型 | 説明 |
|-----------|------|-------------|
| `limit` | integer | 取得件数。既定値50、最大200。 |

**応答`200`**

```json
{
  "entries": [
    {
      "at": "2026-05-24T10:31:02.000Z",
      "method": "PUT",
      "path": "/v1/app_abc123/kv/session/user-42",
      "status_code": 403,
      "error_code": "forbidden",
      "key": "session/user-42"
    }
  ]
}
```

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `at` | ISO 8601 string | リクエストの日時 |
| `method` | string | HTTPメソッド |
| `path` | string | リクエストの完全なパス |
| `status_code` | integer | 応答のHTTPステータス |
| `error_code` | string or `null` | 応答本文の`error`（ある場合） |
| `key` | string or `null` | パスから取得したユーザーのキー（`_`で始まる管理パスでは省略） |

---

<span id="limits"></span>

## 上限

新しいアプリに適用する既定の上限です。有料プランでは上限を増やせます。

| 上限 | 既定値 |
|-------|---------|
| 1秒あたりの操作数 | 50回 |
| ストレージの合計 | アプリあたり10MB |
| キーの合計 | 100,000件 |
| 値のサイズ | キーあたり256KB |
| 一括処理の件数 | `_batch`のリクエストあたり100件 |
| PUTで`ttl`を省略した場合のTTL | 30日 |

上限を超えると対応するエラーコードを返します。[エラーコード](#error-codes)を参照してください。

---

<span id="error-codes"></span>

## エラーコード

エラーの形式はすべて`{ "error": "<code>", "message": "<human-readable description>" }`です。

| コード | HTTPステータス | 意味 | 対応方法 |
|------|-------------|---------|---------------|
| `auth_failed` | 401 / 403 / 404 | 認証を完了できませんでした。本文の`error`には、以下の詳細なコードのいずれかを含めます。 | 詳細なエラーコードを確認してください。 |
| `bad_request` | 400 | 必須フィールドの不足、または型が不正です（TTL、加減算値、権限、配列、100件を超える一括処理など）。 | 本文またはクエリパラメーターを修正してください。 |
| `confirm_required` | 400 | `{ "confirm": true }`なしで`POST _flush`を呼び出しました。 | 本文に`"confirm": true`を指定してください。 |
| `forbidden` | 403 | 認証済みですが権限がありません。公開ルールがない、`deny`に一致する、または関数・プラットフォームキーを必要とする操作です。 | `GET _expose`で公開ルールを確認し、管理操作には関数キーを使ってください。 |
| `invalid_key` | 400 | URLのキーが空です。 | `/kv/`の後に空でないキーを指定してください。 |
| `invalid_jwt` | 401 | Authorizationヘッダーの3要素のトークンの署名検証に失敗しました。 | ユーザーの新しいセッショントークンを発行してください。 |
| `key_invalid` | 400 | キーの文字やパターンが形式の規則に合いません。 | 表示可能なASCIIを使い、制御文字と予約済みのプレフィックスを避けてください。 |
| `KV_EXPOSE_CONFLICT` | 409 | 新しいパターンが既存のルールと曖昧に重なるため、`PUT _expose/:pattern`を拒否しました。本文の`existing`で競合するルールを確認できます。 | 競合するルールを更新するか、重ならないパターンを選んでください。 |
| `KV_FORBIDDEN` | — (batch item error) | `_batch`内の操作1件が公開ルールにより拒否されました。全体は200で、`results[].error`だけに表示します。 | 該当キーの公開ルールを確認してください。 |
| `KV_VALUE_TOO_LARGE` | 413 (or batch item error) | 変換後の値がキーあたり256KBの上限を超えています。 | 値を小さくするか、複数のキーに分けてください。 |
| `no_kv_credential` | 404 | アプリにKVが用意されていないか、アプリが存在しません。 | アプリの初期化とKVの有効化を確認してください。 |
| `not_found` | 404 | 指定したキーがありません。 | 名前の誤りや、値が保存済みかを確認してください。 |
| `redis_error` | — (batch item error) | 一括処理の1件で一時的なストレージエラーが発生しました。他の操作は成功している場合があります。 | 失敗した操作だけを再試行してください。 |
| `unauthorized` | 401 | 公開ルールが認証を要求していますが、有効な認証情報がありません。 | ユーザーがログインして取得したJWTを付けてください。 |
