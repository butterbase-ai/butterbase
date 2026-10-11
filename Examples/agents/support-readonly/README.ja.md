# support-readonly

[English](README.md) | 日本語

顧客対応のエージェントです。2つのLLMノードを使います。

1. `triage`がメッセージを`billing`か`other`へ分類します。
2. `answer`が`lookup_account`で顧客情報を取得し、質問へ答えます。

関数ツールは`read_only`で、承認のために一時停止しません。

## デプロイ

```bash
# 1. Deploy the function.
butterbase functions deploy ./lookup_account.ts \
  --agent-tool \
  --agent-tool-description "Look up a customer by email. Returns id, plan, status." \
  --agent-tool-mode read_only \
  --agent-tool-exposed-to developer_only

# 2. Create the agent (MCP tool manage_agents).
#    { action: "create", app_id, name: "support-readonly", display_name: "Support (read-only)",
#      default_model: "anthropic/claude-3.5-haiku", graph_spec: <contents of ./agent-spec.json> }
```

## 実行

```bash
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/support-readonly/runs \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"message": "Why was I charged twice last month?", "email": "user@example.com"}}'
# Returns 202 {run_id, status}. Poll GET /v1/<app_id>/agents/support-readonly/runs/<run_id>/events.json
```

## イベントの目安

- `run_start`
- `node_start triage` → `llm_token_usage` → `node_end triage`
- `node_start answer` → `tool_call_start lookup_account` → `tool_call_end lookup_account` → `llm_token_usage` → `node_end answer`
- 最終回答を持つ`run_end`

原文ではClaude Haiku/Sonnetで約3〜5秒が目安です。実行環境やモデルにより変わります。
