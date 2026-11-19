# mcp-docs

[English](README.md) | 日本語

外部MCPサーバーをツールとして使う例です。[Stripe docs MCP](https://mcp.stripe.com)を接続し、文書を検索してStripe APIの質問へ答えます。

## デプロイ

登録結果のserver.idを控え、probeで公開ツールを読み込み、specの`REPLACE_WITH_SERVER_ID`をUUIDへ置き換えます。

```bash
# 1. Register the MCP server with the app.
curl -X POST https://api.butterbase.ai/v1/<app_id>/mcp-servers \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "stripe-docs", "transport": "streamable_http", "url": "https://mcp.stripe.com", "auth_header": "Bearer '"$STRIPE_DOCS_TOKEN"'"}'

# Note the returned server.id — you'll paste it into agent-spec.json.

# 2. Probe to load the server's advertised tool list.
curl -X POST https://api.butterbase.ai/v1/<app_id>/mcp-servers/<server_id>/probe \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"

# 3. Edit agent-spec.json and replace REPLACE_WITH_SERVER_ID with the UUID printed above.

# 4. Create the agent (MCP tool manage_agents).
#    { action: "create", app_id, name: "docs-helper", display_name: "Stripe docs helper",
#      default_model: "anthropic/claude-3.5-sonnet", graph_spec: <contents of ./agent-spec.json> }
```

## 実行

```bash
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/docs-helper/runs \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"question": "How do I create a subscription with a trial period?"}}'
# Returns 202 {run_id, status}. Poll GET /v1/<app_id>/agents/docs-helper/runs/<run_id>/events.json
```

Stripe MCPへ1回以上の`search`を実行し、結果をもとに回答します。

## 外部知識を使う構成

1. アプリごとに外部MCPサーバーを登録します。登録は保存されます。
2. 公開したいツールを`tools.mcp_servers[].tools`へ指定します。
3. 必要なら`tool_overrides`で各ツールの`mode`・`exposed_to`を変更します。

MCP・組み込み・関数ツールは、同じgraphで併用できます。
