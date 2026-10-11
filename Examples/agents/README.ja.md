# エージェントのサンプル

[English](README.md) | 日本語

Butterbaseのエージェントを確認する3つの参照用bundleです。それぞれに`agent-spec.json`と、必要な関数コードまたはMCP設定を含みます。

| bundle | 内容 |
|---|---|
| [approval-hitl](approval-hitl/README.ja.md) | `read_write`関数を、`interrupt`による人の承認と組み合わせる例 |
| [mcp-docs](mcp-docs/README.ja.md) | 外部のStripe docs MCPと組み込みツールを併用する例 |
| [support-readonly](support-readonly/README.ja.md) | triage → answerのgraphと、顧客を取得する`read_only`関数 |

## 共通の実行手順

依存する関数をagent toolとして配置し、必要なMCPサーバーをRESTで登録します。`agent-spec.json`はgraph_specだけなので、エージェント作成時はapp_id・nameなども指定します。実行はRESTで開始し、run_idを使ってイベントを取得します。

```bash
# 1. Deploy any function the example depends on, with agent_tool enabled.
butterbase functions deploy ./path/to/function.ts \
  --agent-tool \
  --agent-tool-description "..." \
  --agent-tool-mode read_only

# 2. Register any MCP server the example depends on (REST; there is no CLI command).
curl -X POST https://api.butterbase.ai/v1/<app_id>/mcp-servers   -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json"   -d '{"name": "name", "transport": "streamable_http", "url": "https://...", "auth_header": "Bearer ..."}'

# 3. Create the agent from the bundled spec. Use the MCP tool manage_agents with
#    { action: "create", app_id, name, graph_spec: <contents of agent-spec.json>, display_name?, default_model? }
#    (or POST /v1/<app_id>/agents with the same fields). The bundled agent-spec.json is the graph_spec only.

# 4. Run it (REST; returns 202 with run_id). Poll events via GET .../runs/<run_id>/events.json.
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/<name>/runs   -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json"   -d '{"input": {"message": "..."}}'
```

詳しいコマンドは各サンプルを参照してください。`read_write`を付けるだけでは一時停止しません。承認の例では`interrupt`の追加が必要です。
