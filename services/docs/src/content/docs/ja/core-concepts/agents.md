---
title: エージェント
description: LLM、組み込みツール、MCP、関数を呼ぶ複数段階の処理をグラフで定義します。
---

エージェントは**グラフ仕様**で宣言する複数段階のLLM処理です。JSONにノードと接続を定義し、各ノードはLLM、ツール、終了のいずれかを表します。ランタイムは順に実行し、再開できるよう各段階の状態を保存して、SSEでイベントを返します。

アプリごとに保存し、ダッシュボード、CLI、MCP、SDKから呼べます。publicエージェントは匿名HTTPにも対応します。

<span id="graph-spec-at-a-glance"></span>

## グラフ仕様の概要

```json
{
  "spec_version": "1",
  "entry": "classify",
  "nodes": {
    "classify": {
      "type": "llm",
      "model": "anthropic/claude-3.5-haiku",
      "system_prompt": "Classify the user's request as 'billing', 'support', or 'sales'.",
      "input_template": "{{ input.message }}",
      "output_key": "category",
      "tools": []
    },
    "respond": {
      "type": "llm",
      "model": "anthropic/claude-3.5-sonnet",
      "system_prompt": "You are a {{ state.category }} agent.",
      "input_template": "{{ input.message }}",
      "output_key": "reply",
      "tools": [
        { "source": "function", "name": "lookup_account" }
      ]
    },
    "done": { "type": "end", "output_template": "{{ state.reply }}" }
  },
  "edges": [
    { "from": "classify", "to": "respond" },
    { "from": "respond", "to": "done" }
  ],
  "tools": {
    "builtin": ["select_rows"],
    "mcp_servers": [],
    "functions": ["lookup_account"]
  },
  "limits": {
    "max_steps": 20,
    "max_tool_calls": 50,
    "max_parallel_tools": 4,
    "timeout_seconds": 300,
    "human_timeout_seconds": 86400
  }
}
```

spec_version: "1"でバージョンを指定し、サーバーで検証します。存在しないツールの参照は実行時に拒否します。

<span id="node-types"></span>

## ノードの種類

| 種類 | 用途 |
|---|---|
| `llm` | モデルを呼ぶ。現在の状態からsystem_promptとinput_templateを展開し、必要ならtoolsをモデルへ渡し、応答・ツール結果をoutput_keyへ保存。 |
| `tool` | LLMを介さず直接実行。select_rowsなど、決まった前処理に使用。 |
| `end` | 状態からoutput_templateを展開し、最終出力として返す。 |

接続は実行順を表し、完了後に次のノードへ移ります。グラフはentryからendに到達するDAG（循環のない有向グラフ）である必要があります。

<span id="tools"></span>

## ツール

3種類のツールを公開できます。

<span id="built-in-tools"></span>

### 組み込みツール

アプリのDB、ストレージ、KVなどを操作します。tools.builtinに名前を指定し、呼び出し元をend_userならbutterbase_user、それ以外ならbutterbase_serviceへ対応付けてRLSを適用します。

<span id="mcp-tools"></span>

### MCPツール

`POST /v1/{app_id}/mcp-servers`で登録したMCPサーバーのツールです。tools.mcp_serversでserver_idと公開するツール名を指定します。

<span id="functions"></span>

### 関数

デプロイした[関数](/ja/core-concepts/functions/)を**エージェントツールに指定**すると呼べます。設定例：

```http
POST /v1/{app_id}/functions
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email or account ID.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

tools.functionsに追加します。agent_tool: trueでない関数は実行時にスキップし、ダッシュボードでは保存前に警告します。

`agent_tool_mode`:
- read_only — 承認不要。
- read_write — 実行を停止し、承認情報付きのrun_pausedを送信。人の承認後に再開。

`agent_tool_exposed_to`:
- developer_only — ダッシュボード・CLIのテスト実行だけで利用。
- end_user — 公開エージェント呼び出しでも利用。

<span id="run-lifecycle"></span>

## 実行の流れ

```
queued → running → (paused →) running → completed | failed | cancelled
```

ノードごとにチェックポイントを保存します。ランタイム再起動時は最後の保存位置から再開します。

read_writeツールや明示的なHITL操作で一時停止します。`POST /runs/{id}/resume`かダッシュボードのApproveで続きを実行します。

SSEイベントの一覧：

| イベント | 発生タイミング |
|---|---|
| `run_start` | 受け付け後、ノード実行前。 |
| `node_start`／`node_end` | ノード開始・終了。node_idとstepを含む。 |
| `tool_call_start`／`tool_call_end` | ツール開始・終了。tool_name、args、resultを含む。 |
| `llm_token_usage` | LLM呼び出しごとのトークン数。 |
| `run_paused` | 書き込みツールが人の承認を要求。 |
| `run_cancelled` | 呼び出し元が中止。 |
| `run_failed` | エラーで終了。 |
| `run_end` | 成功。展開済みoutput_templateを含む。 |

<span id="idempotency"></span>

## 冪等性

POST /runsは本文のSHA-256を暗黙の冪等性キーにします。同じ本文の再送は既存の実行をHTTP 200で返し、重複作成しません。重複判定期間中に同名エージェントへ違う本文を送ると409 conflictになります。

<span id="limits"></span>

## 制限

仕様ごとに制限を指定し、サーバーが次の上限を適用します。

| 制限 | 上限 |
|---|---|
| `max_steps` | 1実行200回のグラフ遷移 |
| `max_tool_calls` | 1実行500回 |
| `max_parallel_tools` | 同時16ツール |
| `timeout_seconds` | 経過時間1時間 |
| `human_timeout_seconds` | 承認待ち7日 |

max_runs_per_user_per_hour、daily_budget_usd、max_concurrent_runsなども、ダッシュボードのAccess and limitsか`PATCH /v1/{app_id}/agents/{name}`で設定できます。

<span id="visibility"></span>

## 公開範囲

| 範囲 | 実行できる人 |
|---|---|
| `private` | 所有者（ダッシュボード、CLI、MCP）。 |
| `authenticated` | アプリにログインしたユーザー。 |
| `public` | アプリの公開anonキーを持つ人。厳しいレート制限とdaily_budget_usdを併用してください。 |

<span id="see-also"></span>

## 関連ページ

- [エージェント入門](/ja/getting-started/agents-quickstart/) — 関数をツールにして実行
- [エージェントAPI](/ja/api-reference/agents-api/) — エンドポイントとイベント
- [サーバーレス関数](/ja/core-concepts/functions/) — ツール用関数の公開
