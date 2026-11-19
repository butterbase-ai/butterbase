---
title: 人物検索API
description: 人物と企業の検索、プロフィール取得、非同期の勤務先メール検索、クレジット計測のREST APIを説明します。
sidebar:
  order: 8
---

Butterbase標準の人物検索を使って、人物と企業の検索、情報を補完したプロフィールの取得、非同期の勤務先メール検索を行います。見込み客の検索、CRMの情報補完、人物検索機能に利用できます。

すべてアプリ単位のエンドポイントです。URLに`app_id`を指定し、そのアプリの所有者のButterbaseサービスキー（`bb_sk_...`）またはJWTで認証します。

呼び出しはプラットフォームの料金に基づき、ユーザーのButterbaseクレジット残高から差し引かれます。キャッシュからの取得は無料です。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| POST | /v1/\{app_id\}/people/search/person | 構造化した条件と意味に基づく人物検索 |
| POST | /v1/\{app_id\}/people/search/company | 構造化した条件と意味に基づく企業検索 |
| POST | /v1/\{app_id\}/people/profile | LinkedIn URLからプロフィールを補完（30日のキャッシュ） |
| POST | /v1/\{app_id\}/people/profile/email | 非同期の勤務先メール検索をキューに追加 |
| GET | /v1/\{app_id\}/people/email-lookup/\{lookup_id\} | 待機中のメール検索結果を確認 |

<span id="response-headers"></span>

## 応答ヘッダー

成功・エラーを問わず、料金を本文の解析なしで確認できるよう、次のヘッダーを含めます。

| ヘッダー | 補足 |
|---|---|
| `x-people-provider` | 呼び出したプロバイダーの枠（`primary`または`secondary`） |
| `x-people-credits-consumed` | 整数 |
| `x-people-usd-charged` | ユーザーの残高から差し引いた金額 |
| `x-people-cached` | プロフィール取得だけに付けるヘッダー |

成功、キャッシュ取得、残高不足による拒否（402）、エラー（503・4xx）のすべての応答にヘッダーを付けます。エラーや残高不足の場合、数値は`0`または`0.000000`です。`x-people-cached`は`/profile`だけに含まれます。

<span id="pricing"></span>

## 料金

料金は、運営者が指定したプロバイダーにより変わります。次の値は標準設定の目安です。実際の呼び出し料金は、常に応答の`x-people-*`ヘッダーと本文の`usage`で確認できます。

| 操作 | 通常のクレジット数 | 通常の米ドル料金 | 補足 |
|---|---|---|---|
| `search/person` (up to 10 results) | 7 | $0.0084 | 結果数に応じて増加。10件を超える追加結果ごとに約0.0012米ドル |
| `search/company` (up to 10 results) | 7 | $0.0084 | 人物検索と同じ料金計算 |
| `profile` (cache miss) | 2 | $0.040 | 設定されたプロフィールプロバイダーにより変動 |
| `profile` (cache hit, within 30 days) | 0 | $0 | 常に無料 |
| `profile/email` (queue) | 3 | $0.060 | キューへ追加するときに課金 |
| Email lookup resolved (provider webhook) | 1 | $0.020 | 非同期の結果を受信したときに課金 |
| Empty result set | 0 | $0 | 課金なし |

料金と接続先は各環境の運営者が個別に設定します。クライアントは`x-people-*`ヘッダーと本文の`usage`から、その呼び出しのクレジット数と米ドル料金を取得してください。表の値は標準設定の目安で、契約上の固定料金ではありません。

<span id="authentication"></span>

## 認証

```
Authorization: Bearer {service-key or JWT}
```

呼び出すユーザーは`{app_id}`のアプリを所有している必要があります。すべてのエンドポイントで所有権を確認し、所有者以外には`403 Forbidden`を返します。

<span id="search-people"></span>

## 人物の検索

```
POST /v1/{app_id}/people/search/person
Authorization: Bearer {token}
Content-Type: application/json

{
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "country": "US",
  "pageSize": 25
}
```

構造化したフィルターと任意の`query`に対応します。`query`を指定すると優先されます。省略すると、構造化したフィールドを自動で自然言語の説明にまとめ、設定済みの検索サービスへ送信します。

検索は意味に基づいて行います。構造化したフィールドには論理演算子（`AND`、`OR`、`NOT`、括弧、二重引用符で囲んだ語句）も指定できます。厳密に適用されるかはプロバイダーによります。意味検索のプロバイダーでは厳密なフィルターではなく順位の参考に使われます。動作は環境ごとに異なります。

| フィールド | 型 | 補足 |
|---|---|---|
| `query` | string | 任意。探す人物の条件を自然言語で指定します。指定すると構造化したフィルターより優先します。 |
| `currentRoleTitle` | string | 現在の役職。論理演算子は順位の参考に使います。 |
| `pastRoleTitle` | string | 過去の役職 |
| `currentCompanyName` | string | |
| `currentCompanyIndustry` | string | |
| `country` | string | 例：`US`、`GB` |
| `region` | string | 州・地域 |
| `city` | string | |
| `educationSchoolName` | string | 例：`(Harvard OR Stanford)` |
| `educationDegreeName` | string | 例：`MBA`、`PhD`、`MD` |
| `educationFieldOfStudy` | string | 例：`"Computer Science"` |
| `pageSize` | number | 1〜100 |
| `nextToken` | string | 前の応答から取得したページのカーソル |

<span id="response"></span>

### 応答

```json
{
  "data": {
    "results": [
      {
        "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123",
        "profile": {
          "fullName": "Jane Doe",
          "firstName": "Jane",
          "lastName": "Doe",
          "headline": "Founder at InwestCo",
          "city": "San Francisco",
          "state": "CA",
          "country": "US",
          "experiences": [
            { "title": "Founder", "company": "InwestCo", "location": "San Francisco, CA", "startsAt": "2021-03", "endsAt": null }
          ],
          "education": [
            { "school": "Stanford University", "degree": "BS Computer Science", "schoolUrl": "https://www.linkedin.com/school/stanford-university/", "dates": "2013–2017" }
          ],
          "skills": ["Product Strategy", "AI", "Fundraising"],
          "languages": ["English"],
          "profilePicUrl": "https://media.licdn.com/..."
        },
        "lastUpdated": "2026-06-15T00:00:00Z"
      }
    ],
    "nextPage": "https://api.platform.example.com/search/person?next_token=...",
    "totalResultCount": 8269
  },
  "usage": {
    "creditsConsumed": 7,
    "usdCharged": 0.0084
  }
}
```

すべての結果で全フィールドが返るとは限りません。提供する情報はプロバイダーごとに異なります。正規のLinkedIn URLを確実に取得できない場合、`linkedinProfileUrl`が内部の参照ページを指すこともあります。

`totalResultCount`は条件全体に対する検索サービスの件数で、次ページを取得する前の料金確認に使えます。`nextPage`があれば、その`next_token`を次のリクエストの`nextToken`へ指定します。

<span id="errors"></span>

### エラー

| HTTP | 本文 | 発生条件 |
|---|---|---|
| 402 | `{ "error": "insufficient_credits" }` | 合計クレジット残高が最低利用額（既定値0.05米ドル）未満。プロバイダーは呼び出しません。 |
| 403 | `{ "error": "forbidden" }` | 認証したユーザーがアプリの所有者ではありません。 |
| 404 | `{ "error": "app_not_found" }` | 指定したIDのアプリがありません。 |
| 502 | 設定された検索・情報補完プロバイダーのエラー。一時的なエラーの説明を本文に含めます。機械的に解析せず、再試行可能なエラーとして扱ってください。 |
| 503 | `{ "error": "people_disabled" }` | この環境では機能フラグが無効です。 |
| 503 | `{ "error": "people_unavailable" }` | この環境にはプロバイダーが登録されていません。 |
| 503 | `{ "error": "provider_not_registered", "slot": "primary" }` | 運営者の設定不備。指定の枠にプロバイダーがありません。 |
| 503 | `{ "error": "provider_action_unsupported", "slot": "primary" }` | 運営者の設定不備。指定の枠のプロバイダーがこの操作に対応していません。 |

<span id="search-companies"></span>

## 企業の検索

```
POST /v1/{app_id}/people/search/company
Authorization: Bearer {token}
Content-Type: application/json

{
  "industry": "Financial Services",
  "country": "US",
  "employeeCountMax": 200,
  "pageSize": 25
}
```

`search/person`と同じ`query`に対応します。指定した場合は構造化したフィルターより優先します。

| フィールド | 型 |
|---|---|
| `query` | string：任意の自然言語の説明 |
| `industry` | string |
| `country` | string |
| `employeeCountMax` | number |
| `pageSize` / `nextToken` | 人物検索と同じ |

<span id="response-1"></span>

### 応答

```json
{
  "data": {
    "results": [
      { "linkedinUrl": "https://www.linkedin.com/company/inwestco/", "name": "InwestCo", "industry": "Financial Services", "country": "US", "employeeCount": 187 }
    ],
    "nextPage": null,
    "totalResultCount": 94950
  },
  "usage": { "creditsConsumed": 7, "usdCharged": 0.0084 }
}
```

<span id="errors-1"></span>

### エラー

上記の`search/person`と同じエラーです。

<span id="get-a-profile-cached"></span>

## プロフィールの取得（キャッシュあり）

```
POST /v1/{app_id}/people/profile
Authorization: Bearer {token}
Content-Type: application/json

{
  "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123"
}
```

| フィールド | 型 | 補足 |
|---|---|---|
| `linkedinProfileUrl` | string | 必須。サーバー側でホストとパスを小文字にし、末尾のスラッシュとクエリを除去して正規化します。 |
| `liveFetch` | `"force"` | キャッシュを使わずにプロバイダーから取得します。 |

<span id="cache-behavior"></span>

### キャッシュの動作

正規化したURLへの初回アクセスでは、設定済みのプロフィールプロバイダーを呼び出し（約2秒）、`people_profile_cache`へ保存します。TTL内の再取得はキャッシュを使い（通常30ミリ秒未満）、**料金は0米ドル**です。

| 結果 | TTL |
|---|---|
| `ok`（プロフィール取得成功） | 30日 |
| `not_found`（プロバイダーの404） | 7日 |
| `failed`（一時的なエラー） | 1時間。キャッシュ未取得として扱い、再試行できます。 |

<span id="response--cache-miss"></span>

### 応答：キャッシュ未取得

```json
{
  "data": {
    "publicIdentifier": "jane-doe-abc123",
    "firstName": "Jane",
    "lastName": "Doe",
    "fullName": "Jane Doe",
    "headline": "VP at InwestCo",
    "occupation": "VP at InwestCo",
    "summary": "…",
    "city": "New York", "state": "NY", "country": "US",
    "experiences": [ "…" ],
    "education": [ "…" ]
  },
  "status": "ok",
  "usage": { "creditsConsumed": 2, "usdCharged": 0.040, "cached": false }
}
```

<span id="response--cache-hit"></span>

### 応答：キャッシュ取得

```json
{
  "data": { "…": "same shape as above" },
  "status": "ok",
  "usage": { "creditsConsumed": 0, "usdCharged": 0, "cached": true }
}
```

<span id="response--not-found"></span>

### 応答：見つからない場合

```json
{
  "data": null,
  "status": "not_found",
  "usage": { "creditsConsumed": 0, "usdCharged": 0, "cached": false }
}
```

<span id="errors-2"></span>

### エラー

エラーコードは[人物の検索](#search-people)と同じです。

<span id="queue-an-async-work-email-lookup"></span>

## 非同期の勤務先メール検索

勤務先メール検索は非同期です。リクエストをキューに追加し、プロバイダーのWebhookを待ちます。

```
POST /v1/{app_id}/people/profile/email
Authorization: Bearer {token}
Content-Type: application/json

{
  "linkedinProfileUrl": "https://www.linkedin.com/in/jane-doe-abc123"
}
```

<span id="response-2"></span>

### 応答

```json
{
  "lookupId": "0e9796cf-0b54-4d49-9fbd-80ad2a3468ae",
  "status": "pending",
  "usage": { "creditsConsumed": 3 }
}
```

`lookupId`を保存し、`status === "resolved"`になるまで`GET /email-lookup/{lookup_id}`をポーリングしてください。

<span id="errors-3"></span>

### エラー

エラーコードは[人物の検索](#search-people)と同じです。

<span id="poll-an-email-lookup"></span>

## メール検索結果の確認

```
GET /v1/{app_id}/people/email-lookup/{lookup_id}
Authorization: Bearer {token}
```

```json
{
  "status": "pending" | "resolved" | "failed" | "expired",
  "email": "jane.doe@inwestco.com" | null,
  "credits_consumed": 1
}
```

Webhookを受信すると`email`を設定します。`credits_consumed`は、キューへの追加と結果確定で課金した合計です。

<span id="errors-4"></span>

### エラー

エラーコードは[人物の検索](#search-people)と同じです。

<span id="audit-trail"></span>

## 監査記録

成功した呼び出しとプロバイダーのエラーは、`people_usage_logs`へ記録します。

| 列 | 補足 |
|---|---|
| `action` | `search_person`、`search_company`、`profile`、`profile_cache_hit`、`profile_email_queue`、`profile_email_resolved`。失敗時は`*_error`。 |
| `credits_consumed` | 使用したプロバイダーのクレジット |
| `usd_cost` | Butterbaseがプロバイダーへ支払う金額 |
| `usd_charged` | ユーザーから差し引いた金額（途中で残高が尽きた場合は少なくなることがあります） |
| `response_status` | プロバイダーのHTTPステータス |
| `linkedin_url` | 該当する場合のURL |
| `created_at` | |

CRMでの使用量分析には、MCPツールの`manage_data`や`select_rows`で直接クエリを実行できます。

<span id="notes"></span>

## 補足

- 検索結果が0件なら、課金するクレジットも0です。
- キャッシュからの取得はクレジット残高から差し引きません。
- 非同期メール検索が無効の環境では、`profile/email`は503を返します。結果の確定には時間がかかります。プロバイダーの通知はサーバー側で処理するため、`GET /people/email-lookup/{id}`をポーリングして確認してください。
