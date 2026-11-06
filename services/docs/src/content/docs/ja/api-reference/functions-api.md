---
title: 関数API
description: サーバーレス関数の各エンドポイントを説明します。
sidebar:
  order: 4
---

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/functions | 関数をデプロイまたは更新 |
| GET | /v1/\{app_id}/functions | 全関数を一覧表示 |
| GET | /v1/\{app_id}/functions/\{name} | 関数の詳細と指標を取得 |
| DELETE | /v1/\{app_id}/functions/\{name} | 関数を削除 |
| POST | /v1/\{app_id}/functions/\{name}/invoke | 関数をテスト実行 |
| GET | /v1/\{app_id}/functions/\{name}/logs | 呼び出しログを表示 |

<span id="public-invocation"></span>

## 公開エンドポイントからの呼び出し

| メソッド | パス | 用途 |
|--------|------|---------|
| ANY | /v1/\{app_id}/fn/\{function_name} | デプロイ済みの関数を呼び出す（任意のHTTPメソッド） |

エンドユーザーのトークンは関数へ転送されます。

<span id="deploy-a-function"></span>

## 関数のデプロイ

```json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\n    headers: { 'Content-Type': 'application/json' }\n  });\n}",
  "description": "A simple greeting function",
  "triggers": [
    { "type": "http", "config": { "auth": "required" } },
    { "type": "cron", "config": { "schedule": "0 9 * * *" } }
  ],
  "envVars": {
    "API_KEY": "secret123"
  },
  "timeoutMs": 30000,
  "memoryLimitMb": 128
}
```

<span id="required-fields"></span>

### 必須フィールド

| フィールド | 説明 |
|-------|-------------|
| `name` | 一意の名前（1〜100文字） |
| `code` | ハンドラーをデフォルトエクスポートするソースコード |

<span id="optional-fields"></span>

### 任意フィールド

| フィールド | 既定値 | 説明 |
|-------|---------|-------------|
| `description` | — | 関数の説明 |
| `envVars` | — | 暗号化して保存する環境変数。実行時にはプラットフォームが`BUTTERBASE_*`キーも自動で設定します。[プラットフォームのコンテキスト](/ja/core-concepts/functions/#platform-context)を参照してください。これらは`envVars`の後に設定されるため、上書きできません。再デプロイ時は既存の環境変数へマージされ、指定したキーの値が優先されます。省略すると既存の値を維持します。 |
| `envVarsReplace` | `false` | `true`にすると、マージせずに関数の環境変数全体を`envVars`で置き換えます。 |
| `timeoutMs` | 30000 | 実行時間の上限（最大300000ミリ秒） |
| `memoryLimitMb` | 128 | メモリの上限（64〜1024MB） |
| `triggers` | `[{type: "http"}]` | トリガー設定の配列。各種類につき最大1つです。 |
| `trigger` | — | **旧形式**の単一トリガー指定。サーバー側で要素が1つの`triggers`配列に変換されます。 |
| `agent_tool` | `false` | この関数をエージェントのツールとして公開します。 |
| `agent_tool_description` | — | LLMに表示する短い説明（最大500文字）。 |
| `agent_tool_mode` | `read_only` | `read_only`または`read_write`。`read_write`には人による承認（HITL）が必要です。 |
| `agent_tool_exposed_to` | `developer_only` | `developer_only`または`end_user`。 |
| `allow_service_key_impersonation` | `true` | `true`の場合、アプリに対応するサービスキーによる`X-Butterbase-As-User`を受け付け、指定されたユーザーIDを`ctx.user.id`に設定します。管理者専用や課金Webhookのハンドラーでは`false`にしてください。この場合、同ヘッダーのあるリクエストはエッジで403になります。[サーバー間の関数呼び出し](/ja/core-concepts/functions/#server-to-server-function-calls)を参照してください。 |

<span id="trigger-types"></span>

### トリガーの種類

トリガーには`type`と種類ごとの`config`を指定します。1つの関数に設定できるトリガーは各種類につき1つです。重複は一意インデックスで防ぎます。

| 型 | 設定 | 補足 |
|------|--------|-------|
| `http` | `{ method?, path?, auth? }` | `auth`の既定値は`required`です。匿名の呼び出しはエッジで401になります。意図的に公開する場合だけ`none`を指定してください。 |
| `cron` | `{ schedule, timezone? }` | `schedule`はcron式（例：`*/5 * * * *`）。`timezone`の既定値はUTCです。 |
| `s3_upload` | `{ bucket, prefix?, contentTypes? }` | `prefix`と、指定した場合はMIMEタイプに一致するオブジェクトがバケットに保存されると実行します。 |
| `webhook` | `{ secret_required?, allowed_sources? }` | 署名付きWebhook URLを生成します。`allowed_sources`はプロバイダーのタグをカンマで区切った一覧です。 |
| `websocket` | `{}` | リアルタイムチャネルでWebSocketフレームを受信するたびに実行します。 |

<span id="exposing-a-function-as-an-agent-tool"></span>

### 関数をエージェントのツールとして公開する

`agent_tool: true`にすると、同じアプリのエージェントがグラフ仕様の`tools.functions[]`に関数名を指定して呼び出せます。指定方法は[エージェントAPI](/ja/api-reference/agents-api/)を参照してください。

```json
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email. Returns id, plan, status.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

4つの`agent_tool*`フィールドは`GET /functions`と`GET /functions/{name}`の応答にも含まれるため、クライアントで設定状態を表示できます。

<span id="update-function-settings"></span>

## 関数設定の更新

```json
PATCH /v1/{app_id}/functions/{name}/settings
Authorization: Bearer {token}

{
  "allow_service_key_impersonation": false
}
```

コードを再デプロイせずに関数ごとの設定を変更できます。現在対応しているのは
`allow_service_key_impersonation`だけです。これはフェーズ2の
代理呼び出し制御です。更新が成功するとランタイムのキャッシュが無効になり、
次の呼び出しから新しい値が適用されます。

<span id="update-environment-variables"></span>

## 環境変数の更新

```json
PATCH /v1/{app_id}/functions/{name}/env
Authorization: Bearer {token}

{
  "envVars": {
    "API_KEY": "new-secret",
    "NEW_VAR": "value",
    "OLD_VAR": null
  }
}
```

値は既存の環境変数に**マージ**されます。全体の置換ではありません。キーを削除するには値を`null`にします。

<span id="invocation-logs"></span>

## 呼び出しログ

```
GET /v1/{app_id}/functions/{name}/logs?limit=50&since=2026-01-01T00:00:00Z&level=error
```

| パラメーター | 説明 |
|-----------|-------------|
| `limit` | 取得するログの件数 |
| `since` | ISO形式の日付による絞り込み |
| `level` | レベルによる絞り込み（`error`、`all`） |
| `include_deleted` | `true`にすると論理削除済みの関数のログも取得します（インシデント調査用）。既定値は`false`です。 |

<span id="log-entry-fields"></span>

### ログのフィールド

| フィールド | 説明 |
|-------|-------------|
| `method` | HTTPメソッド |
| `path` | リクエストのパス |
| `status_code` | 応答のステータス |
| `duration_ms` | 実行時間 |
| `memory_mb` | 使用したメモリ |
| `error` | エラーメッセージ（ある場合） |
| `consoleLogs` | 収集したコンソール出力の配列（`{ level, message, timestamp }`） |

<span id="function-metrics"></span>

## 関数の指標

| 指標 | 説明 |
|--------|-------------|
| `total_invocations` | 呼び出しの総数 |
| `error_count` | エラーの件数 |
| `error_rate` | エラー率 |
| `avg_duration_ms` | 平均実行時間 |
| `last_invocation` | 最後に呼び出した日時 |
