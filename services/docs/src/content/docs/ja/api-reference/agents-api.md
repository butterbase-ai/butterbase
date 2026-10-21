---
title: エージェントAPI
description: エージェントの作成、設定、実行に使うRESTエンドポイントを説明します。
sidebar:
  order: 5
---

エージェントAPIには3つのグループがあります。

1. **エージェント管理**：作成、一覧、更新、削除、検証。所有者だけが利用できます。
2. **実行（認証あり）**：認証済みのアプリユーザーまたは所有者が、実行の開始・取得・ストリーム購読・中止・再開を行います。
3. **実行（公開）**：`visibility: "public"`のエージェントを匿名で実行します。

別のエンドポイント群で、アプリのエージェントが呼び出す**MCPサーバー**を管理します。

グラフ仕様、ノード、ツール、イベントの概要は[エージェントの概念](/ja/core-concepts/agents/)を参照してください。

<span id="agent-management"></span>

## エージェント管理

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/agents | アプリのエージェント一覧を取得 |
| POST | /v1/\{app_id}/agents | エージェントを作成 |
| GET | /v1/\{app_id}/agents/\{name} | 1つのエージェントを取得 |
| PATCH | /v1/\{app_id}/agents/\{name} | フィールドを更新（status、graph_spec、アクセス制御） |
| DELETE | /v1/\{app_id}/agents/\{name} | エージェントを論理削除 |
| POST | /v1/\{app_id}/agents/\{name}/validate | 保存せずにグラフ仕様の型を検証 |

<span id="create-an-agent"></span>

### エージェントの作成

```http
POST /v1/{app_id}/agents
Authorization: Bearer {token}

{
  "name": "billing-triage",
  "display_name": "Billing triage",
  "description": "Classifies billing questions and answers them.",
  "default_model": "anthropic/claude-3.5-haiku",
  "graph_spec": { ... see graph_spec schema below ... },
  "visibility": "private",
  "max_runs_per_user_per_hour": 60,
  "daily_budget_usd": 5.0,
  "max_concurrent_runs": 4,
  "safety_acknowledged": false
}
```

**必須フィールド：** `name`（スラッグ、1〜100文字）、`graph_spec`。

**既定のアクセス設定：** `visibility: "private"`、レート制限と予算の指定なし。公開エージェントには`safety_acknowledged: true`が必要です。

<span id="graph_spec-v1-schema"></span>

### graph_spec v1のスキーマ

```json
{
  "spec_version": "1",
  "entry": "<node_id>",
  "nodes": {
    "<node_id>": {
      "type": "llm" | "tool" | "end",
      "...": "type-specific fields, see below"
    }
  },
  "edges": [{ "from": "<node_id>", "to": "<node_id>" }],
  "tools": {
    "builtin": ["select_rows", "..."],
    "mcp_servers": [
      { "server_id": "uuid", "tools": ["search"], "tool_overrides": {} }
    ],
    "functions": ["lookup_account"]
  },
  "limits": {
    "max_steps": 1..200,
    "max_tool_calls": 0..500,
    "max_parallel_tools": 1..16,
    "timeout_seconds": 5..3600,
    "human_timeout_seconds": 60..604800
  }
}
```

<span id="llm-node"></span>

#### `llm`ノード

```json
{
  "type": "llm",
  "model": "anthropic/claude-3.5-sonnet",
  "system_prompt": "You are a {{ state.category }} agent.",
  "input_template": "{{ input.message }}",
  "output_key": "reply",
  "tools": [
    { "source": "builtin", "name": "select_rows" },
    { "source": "function", "name": "lookup_account" },
    { "source": "mcp", "server_id": "uuid", "name": "search" }
  ],
  "temperature": 0.7,
  "max_tokens": 1024
}
```

<span id="tool-node"></span>

#### `tool`ノード

```json
{
  "type": "tool",
  "tool_ref": { "source": "function", "name": "preprocess" },
  "args_template": { "raw": "{{ input.body }}" },
  "output_key": "preprocessed"
}
```

<span id="end-node"></span>

#### `end`ノード

```json
{ "type": "end", "output_template": "{{ state.reply }}" }
```

<span id="tool-references-and-overrides"></span>

### ツールの参照と設定の上書き

各`toolRef`には、次の2つの任意フィールドを指定できます。

- `mode_override`：`"read_only" | "read_write"`。このエージェントに対するツールの権限を指定します。
- `exposed_to_override`：`"developer_only" | "end_user"`。公開範囲を指定します。

アクセスは**狭める方向**にだけ変更できます（read_write→read_only、end_user→developer_only）。関数またはMCPツールに保存された設定を超える権限には拡張できません。

<span id="validate-without-saving"></span>

### 保存せずに検証する

```http
POST /v1/{app_id}/agents/{name}/validate
{ "graph_spec": { ... } }

200 { "valid": true }
200 { "valid": false, "issues": [{ "path": ["nodes","x","model"], "message": "..." }] }
```

<span id="runs-authenticated"></span>

## 実行（認証あり）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/agents/\{name}/runs | 実行を開始 |
| GET | /v1/\{app_id}/agents/\{name}/runs | 最近の実行一覧を取得 |
| GET | /v1/\{app_id}/agents/\{name}/runs/\{id} | 1つの実行を取得 |
| POST | /v1/\{app_id}/agents/\{name}/runs/\{id}/cancel | 待機中または実行中の処理を中止 |
| POST | /v1/\{app_id}/agents/\{name}/runs/\{id}/resume | 承認内容を指定して一時停止中の実行を再開 |
| GET | /v1/\{app_id}/agents/\{name}/runs/\{id}/events.json | イベントを1つのJSON配列として再送 |
| GET | /v1/\{app_id}/agents/\{name}/runs/\{id}/events | イベントをSSEでリアルタイム配信 |

<span id="start-a-run"></span>

### 実行の開始

```http
POST /v1/{app_id}/agents/billing-triage/runs
Authorization: Bearer {token}

{ "input": { "message": "Why was I charged twice?" } }

201 { "run_id": "run_...", "status": "queued" }
200 { "run_id": "run_...", "status": "running" }   // idempotent replay
409 { "error": "conflict", "existing_run_id": "run_..." }
```

リクエスト本文のハッシュが暗黙の冪等キーとして保存されます。重複排除期間内に同じ本文を送ると既存の実行を返します（`200`）。同じ期間内に同じエージェントへ異なる本文を送ると`409`になります。

<span id="sse-stream"></span>

### SSEストリーム

```http
GET /v1/{app_id}/agents/billing-triage/runs/run_abc/events
Authorization: Bearer {token}
Accept: text/event-stream

id: 1
event: run_start
data: {"input": {...}}

id: 2
event: node_start
data: {"node_id": "triage", "step": 1}

...

event: run_end
data: {"output": "Hi! I found your account..."}
```

イベントの種類：`run_start`、`node_start`、`node_end`、`tool_call_start`、`tool_call_end`、`llm_token_usage`、`run_paused`、`run_cancelled`、`run_failed`、`run_end`。

`Last-Event-ID`ヘッダーで受信を再開できます。最後に受信した`id`を付けて再接続すると、その後の未受信イベントを再送します。

<span id="pause--resume-hitl"></span>

### 一時停止と再開（HITL）

`read_write`ツールが呼ばれると、ランタイムは次のイベントを送ります。

```
event: run_paused
data: { "payload": { "tool_name": "delete_account", "args": {...}, "approval_token": "..." } }
```

同じ承認トークンと明示的な判断を指定して再開します。

```http
POST /v1/{app_id}/agents/{name}/runs/{id}/resume
{ "approval_token": "...", "approved": true }
```

承認を拒否すると（`approved: false`）、`reason: "approval_denied"`の`run_failed`で実行を終了します。

<span id="public-runs"></span>

## 公開実行

エージェントの`visibility`が`public`なら、匿名の呼び出し元がアプリの公開anonキーで公開エンドポイントを利用できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/public/agents/\{name}/runs | 公開実行を開始 |
| GET | /v1/\{app_id}/public/runs/\{id} | 公開実行を取得 |
| POST | /v1/\{app_id}/public/runs/\{id}/cancel | 公開実行を中止 |
| POST | /v1/\{app_id}/public/runs/\{id}/resume | 一時停止中の公開実行を再開 |
| GET | /v1/\{app_id}/public/runs/\{id}/events.json | イベントのJSON配列 |
| POST | /v1/\{app_id}/public/runs/\{id}/stream-token | SSE・WebSocketストリーム用の1回限りのトークンを発行 |
| GET | /v1/\{app_id}/public/runs/\{id}/events | SSEストリーム（上記の`?token=`が必要） |
| GET | /v1/\{app_id}/public/runs/\{id}/ws | WebSocketストリーム（上記の`?token=`が必要） |

公開実行にも、エージェントのIPごとのレート制限、1日の予算、同時実行数の上限が適用されます。

<span id="mcp-servers"></span>

## MCPサーバー

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/mcp-servers | 登録済みMCPサーバー一覧を取得 |
| POST | /v1/\{app_id}/mcp-servers | MCPサーバーを登録 |
| DELETE | /v1/\{app_id}/mcp-servers/\{id} | MCPサーバーを削除 |
| POST | /v1/\{app_id}/mcp-servers/\{id}/probe | サーバーが公開するツール一覧を再取得 |

```http
POST /v1/{app_id}/mcp-servers
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "stripe_docs",
  "transport": "streamable_http",
  "url": "https://mcp.stripe.com",
  "auth_header": "Bearer <stripe-token>"
}
```

`Authorization`はButterbaseへのリクエストの認証に使います。`auth_header`は
任意で、指定すると接続先のMCPサーバーへ転送されます。

登録したサーバーのツールは、`graph_spec.tools.mcp_servers`に指定するとエージェントから参照できます。

<span id="errors"></span>

## エラー

| コード | 意味 |
|---|---|
| 400 | グラフ仕様が不正、必須フィールドが不足、または予算を超過します。 |
| 401 | トークンがないか無効です。 |
| 403 | アプリの所有者権限がないか、`private`のエージェントを所有者以外が呼び出しています。 |
| 404 | エージェントまたは実行が見つかりません。 |
| 409 | 冪等性の競合、または`public`のエージェントに`safety_acknowledged: false`を指定しています。 |
| 422 | `POST /validate`の検証エラーです。 |
| 429 | ユーザー・IP・アプリごとのレート制限を超過しています。 |
| 503 | エージェントランタイムが過負荷です。間隔を空けて再試行してください。 |
