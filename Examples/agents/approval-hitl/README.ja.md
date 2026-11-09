# approval-hitl

[English](README.md) | 日本語

`read_write`の関数ツール`cancel_subscription`を、human-in-the-loopの承認と組み合わせる例です。1つのLLMノードから呼び出します。

**現行runtimeの注意：** 一時停止は`services/agent-runtime/src/agent_runtime/tools/builtin.py`の組み込み`interrupt`で行います。`read_write`だけでは止まらず、`approval_token`もありません。同梱specは`tools.builtin`が空なので、`tools.builtin`とノードの`tools`へ`interrupt`を追加します。pauseイベントのpayloadは`{reason, data}`です。

## デプロイ

```bash
# 1. Deploy the function as a read_write agent tool.
butterbase functions deploy ./cancel_subscription.ts \
  --agent-tool \
  --agent-tool-description "Cancel a customer's subscription. Requires human approval." \
  --agent-tool-mode read_write \
  --agent-tool-exposed-to developer_only

# 2. Create the agent.
# (MCP tool manage_agents)
#   { action: "create", app_id, name: "approval-hitl", display_name: "HITL approval demo",
#     default_model: "anthropic/claude-3.5-sonnet", graph_spec: <contents of ./agent-spec.json> }
```

## 実行

```bash
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/approval-hitl/runs \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"message": "Cancel the Pro plan for user_42"}}'
# Returns 202 {run_id, status}. Poll GET /v1/<app_id>/agents/approval-hitl/runs/<run_id>/events.json
```

一時停止を構成した場合、次のイベントで`paused`になり、再開を待ちます。

```
event: run_paused
data: {
  "payload": {
    "reason": "Approve cancel_subscription for user_42?",
    "data": { "user_id": "user_42" }
  }
}
```

RESTの再開bodyには`input`が必須です。graphでは`state.human_input`として受け取ります。

```bash
# Resume (REST; body must contain `input`, which the graph sees as state.human_input)
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/approval-hitl/runs/<run_id>/resume \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"approved": true}}'
```

承認すると処理を続行します。

```
event: tool_call_end   {"tool_source": "function", "tool_name": "cancel_subscription", "status": "ok", "duration_ms": 120}
event: run_end         {"output": "Subscription for user_42 has been cancelled."}
```

拒否も`{"approved": false}`などのinputで再開し、その内容にどう対応するかはgraphで定義します。

## 使用する場面

返金・削除・顧客向けメール・公開投稿など、人が確認すべき副作用のある操作です。関数に`read_write`と明確な`agent_tool_description`を設定し、`interrupt`で承認を待つ構成にします。
