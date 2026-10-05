# mcp-docs

Demonstrates using an **external MCP server** as an agent tool source. This example wires up the [Stripe docs MCP server](https://mcp.stripe.com) and lets the agent answer Stripe API questions by searching the docs.

## Deploy

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

## Run

```bash
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/docs-helper/runs \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"question": "How do I create a subscription with a trial period?"}}'
# Returns 202 {run_id, status}. Poll GET /v1/<app_id>/agents/docs-helper/runs/<run_id>/events.json
```

You'll see the agent issue one or more `search` tool calls to the Stripe MCP server, then synthesize an answer.

## Pattern

This is the canonical shape for "agent that uses an external knowledge source":

1. Register the external MCP server once per app (it persists).
2. List the subset of its tools you want exposed in `tools.mcp_servers[].tools`.
3. Optionally override `mode`/`exposed_to` per tool via `tool_overrides`.

You can mix MCP, built-in, and function tools freely in the same graph.
