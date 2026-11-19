---
title: AI会議API
description: 会議ボットのRESTエンドポイントを説明します。
sidebar:
  order: 7
---

会議ボットの起動、状態確認、録画・文字起こしの取得、Webhookの配信設定に使うAPIです。概要と一連の使用例は[AI会議](/ja/core-concepts/ai-meetings/)を参照してください。

すべてのエンドポイントはアプリ単位です。URLに`app_id`を指定し、そのアプリの所有者のButterbaseサービスキー（`bb_sk_...`）で認証します。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| POST | /v1/\{app_id\}/ai/meetings | 会議ボットを起動 |
| GET | /v1/\{app_id\}/ai/meetings/\{bot_id\} | ボットの状態、時間、URLを取得 |
| DELETE | /v1/\{app_id\}/ai/meetings/\{bot_id\} | ボットを会議から退出させる |
| GET | /v1/\{app_id\}/ai/meetings | アプリのボット一覧を取得 |
| GET | /v1/\{app_id\}/ai/meetings/\_estimate | 会議の米ドル建て料金を見積もる |
| GET | /v1/\{app_id\}/ai/meetings/usage | アプリの最近の`actor_usage_logs`を取得 |
| PUT | /v1/\{app_id\}/ai/meetings/webhook | 転送先URLを設定し、署名用シークレットを発行・更新 |
| GET | /v1/ai/meetings/\_status | 認証不要の公開API。`{ "available": true \| false }` |

<span id="spawn-a-bot"></span>

## ボットの起動

```
POST /v1/{app_id}/ai/meetings
Authorization: Bearer {token}
Content-Type: application/json

{
  "meetingUrl": "https://zoom.us/j/12345...",
  "transcript": true,
  "recording": "mp4",
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" },
  "automaticLeave": {
    "waitingRoomTimeoutSec": 900,
    "noOneJoinedTimeoutSec": 600,
    "everyoneLeftTimeoutSec": 120,
    "inCallNotRecordingTimeoutSec": 1800
  }
}
```

| フィールド | 型 | 既定値 | 補足 |
|---|---|---|---|
| `meetingUrl` | string | 必須 | Zoom・Meet・Teams・Webexの会議URL |
| `transcript` | boolean | `true` | 録画に加えて文字起こしを実行 |
| `recording` | `"mp4" \| "audio_only" \| false` | `"mp4"` | `false`なら録画しません。 |
| `botName` | string | `"Butterbase Notetaker"` | 会議に参加するときの表示名。1〜64文字。 |
| `metadata` | `Record<string,string>` | `{}` | 任意の文字列のキーと値。予約済みの`bb_`で始まるキーは使えません。 |
| `automaticLeave` | object | `{}` | ボットごとの自動退出タイマー。省略したサブフィールドはプロバイダーの既定値を使います。[自動退出のタイマー](#auto-leave-timers)を参照してください。 |

<span id="auto-leave-timers"></span>

### 自動退出のタイマー

ボットが自動で退出するまでの待ち時間を指定します。各フィールドは任意で、省略するとプロバイダーの既定値を使います。値は**秒**単位の正の整数で、最大`86400`（24時間）です。

| サブフィールド | 退出する条件 |
|---|---|
| `waitingRoomTimeoutSec` | 主催者に入室を許可されず、待機室で指定秒数が経過したとき。 |
| `noOneJoinedTimeoutSec` | ボットだけが入室し、指定秒数以内に誰も参加しなかったとき。 |
| `everyoneLeftTimeoutSec` | 全員が退出し、空の会議室で指定秒数が経過したとき。 |
| `inCallNotRecordingTimeoutSec` | 会議に参加しているが録画できず、指定秒数が経過したとき（例：録画の同意が得られない場合）。 |

**例：15分以内に入室を許可されなければ退出する設定：**

```json
{ "automaticLeave": { "waitingRoomTimeoutSec": 900 } }
```

応答：

```json
{
  "id": "c086e720-d319-44b8-82d8-3a363f2cd9f4",
  "status": "joining",
  "startedAt": null,
  "completedAt": null,
  "durationSeconds": null,
  "recordingUrl": null,
  "transcriptUrl": null,
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" }
}
```

`botName`は応答にも含まれ、送信した名前を確認できます。このフィールドの対応前に作成したボットでは`"Butterbase Notetaker"`を返します。

処理の進行に応じて`startedAt`、`completedAt`、各URLが設定されます。`GET /v1/{app_id}/ai/meetings/{id}`をポーリングするか、Webhookで確認してください。

<span id="get-a-bot"></span>

## ボットの取得

```
GET /v1/{app_id}/ai/meetings/{bot_id}
Authorization: Bearer {token}
```

`POST`と同じ形式を返します。`status`は次の状態を表します。

| 状態 | 意味 |
|---|---|
| `joining` | ボットが接続中 |
| `waiting_room` | 待機室で主催者の許可待ち |
| `in_call` | 会議に参加済み（録画開始前の場合もあります） |
| `recording` | 録画中 |
| `ended` | 会議が終了し、成果物を処理中 |
| `done` | 正常終了。`recordingUrl`と`transcriptUrl`を利用できます。 |
| `fatal` | 参加失敗、退出させられた、または致命的なエラーで終了 |

<span id="list-bots"></span>

## ボット一覧の取得

```
GET /v1/{app_id}/ai/meetings?status={status}&limit={n}&cursor={cursor}
Authorization: Bearer {token}
```

クエリパラメーター（すべて任意）：

| パラメーター | 型 | 既定値 | 補足 |
|---|---|---|---|
| `status` | string | — | 状態で絞り込む |
| `limit` | integer | 20 | 1〜100 |
| `cursor` | string | — | 前の応答の`nextCursor`を指定 |

応答：

```json
{
  "bots": [ /* MeetingBot[] */ ],
  "nextCursor": "..." | null
}
```

<span id="stop-a-bot"></span>

## ボットの停止

```
DELETE /v1/{app_id}/ai/meetings/{bot_id}
Authorization: Bearer {token}
```

ボットを会議から退出させます。成功時は`204`です。停止済み・終了済みでも`204`を返す冪等な操作です。

<span id="cost-estimate"></span>

## 料金の見積もり

```
GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes={n}&transcript={bool}
Authorization: Bearer {token}
```

| パラメーター | 型 | 既定値 | 補足 |
|---|---|---|---|
| `durationMinutes` | integer | 必須 | 1〜1440 |
| `transcript` | boolean | `true` | 文字起こしの料金を含めるかどうか |

応答：

```json
{ "usd": 0.39 }
```

<span id="configure-forward-webhook"></span>

## 転送Webhookの設定

```
PUT /v1/{app_id}/ai/meetings/webhook
Authorization: Bearer {token}
Content-Type: application/json

{
  "forward_url": "https://your-app.example.com/recall/events",
  "rotate_secret": true
}
```

| フィールド | 型 | 補足 |
|---|---|---|
| `forward_url` | string (URL) | Butterbaseが転送イベントをPOSTするURL |
| `rotate_secret` | boolean | trueの場合、または設定がまだない場合に、アプリ専用の新しいシークレットを発行 |

応答：

```json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://your-app.example.com/recall/events",
  "secret": "wsec_..."
}
```

`secret`を返すのは、初回作成時または`rotate_secret: true`による更新時の**1回だけ**です。すぐに保存してください。それ以外は`null`を返します。ButterbaseではAES-256-GCMで暗号化して保存し、転送イベントへ署名する間だけ復号します。

<span id="forwarded-event-shape"></span>

### 転送イベントの形式

ボットの状態が変化したとき、または成果物の準備ができたときに、Butterbaseから`forward_url`へPOSTします。

```
POST /your/configured/path
content-type: application/json
x-bb-event: bot.done
x-bb-signature: v1,<base64 HMAC-SHA256>

{
  "event": "bot.done",
  "data": {
    "bot":  { "id": "c086e720-...", "metadata": { ... } },
    "data": { "code": "done", "sub_code": null, "updated_at": "..." }
  }
}
```

<span id="verifying-the-signature"></span>

### 署名の検証

`base64(HMAC-SHA256(<your wsec_>, <raw request body>))`を計算し、先頭に`v1,`を付けて`x-bb-signature`と定数時間で比較します。Stripe・GitHub・Recall.aiと同様の検証方式です。[実装例](/ja/core-concepts/ai-meetings/#verifying-a-forwarded-event)を参照してください。

<span id="default-subscriptions"></span>

### 既定の購読イベント

新しいアプリには、既定で次のイベントを転送します。

- `bot.in_call_recording`
- `bot.done`
- `bot.fatal`
- `recording.done`
- `transcript.done`
- `transcript.failed`

<span id="webhook-payloads-carry-ids-not-urls"></span>

### Webhookで受け取る成果物のID

`recording.done`と`transcript.done`には、成果物の**ID**とメタデータだけが含まれます。ダウンロードURLは`GET /v1/{app_id}/ai/meetings/{bot_id}`の応答の`recordingUrl`と`transcriptUrl`から取得してください。URLは短期間で失効し、Recallが必要に応じて再発行するため、Webhook本文には含めません。

<span id="usage"></span>

## 使用量

```
GET /v1/{app_id}/ai/meetings/usage
Authorization: Bearer {token}
```

`actor_usage_logs`の最新100件を返します。

```json
{
  "rows": [
    {
      "id": "5",
      "dimension": "recording",
      "seconds": 44,
      "usd_charged": "0.007333",
      "created_at": "2026-06-11T19:18:53.734Z"
    },
    {
      "id": "4",
      "dimension": "transcription",
      "seconds": 44,
      "usd_charged": "0.002200",
      "created_at": "2026-06-11T19:18:53.485Z"
    }
  ]
}
```

終了した会議ごとに、`recording`と、文字起こしが有効なら`transcription`の各項目につき1行を記録します。

<span id="availability"></span>

## 利用可否

```
GET /v1/ai/meetings/_status
```

認証なしで利用できる公開エンドポイントです。次の形式を返します。

```json
{ "available": true }
```

`false`の場合、この環境にはプロバイダーが登録されていません（例：`MEETINGS_API_KEY`を設定していないOSS版）。クライアント側で対応する画面や操作の表示を切り替えられます。

<span id="errors"></span>

## エラー

OpenAI互換の形式：`{ "error": { "message", "type", "code" } }`。

| 状態 | `error.type` | `error.code` | 発生条件 |
|---|---|---|---|
| 400 | `invalid_request_error` | `invalid_request` | リクエスト本文の検証に失敗。`error.details`にzodの検証結果を返します。 |
| 401 | `authentication_error` | `missing_credentials` | Authorizationヘッダーがないか無効です。 |
| 402 | `billing_error` | `insufficient_credits` | 残高が組織の利用可能下限を下回っているため、新しい会議を開始できません。`error.balance_usd`（月間利用枠と追加購入分の合計残高）と`error.credit_floor_usd`（利用可能な最低残高。与信がなければ`0`）を返します。 |
| 403 | `permission_error` | `not_authorized` | 認証済みのユーザーがこのアプリの所有者ではありません。 |
| 404 | `invalid_request_error` | `app_not_found` | `app_id`が存在しません。 |
| 501 | `api_error` | `provider_unavailable` | この環境に会議プロバイダーが登録されていません。 |
| 5xx | `api_error` | (varies) | 接続先のプロバイダーのエラー。間隔を空けて再試行してください。 |
