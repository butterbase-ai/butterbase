# Agent examples

Three reference bundles that exercise the Butterbase agent system end to end. Each directory contains an `agent-spec.json` plus the function code or MCP server config you need to make it run.

| Bundle | What it shows |
|---|---|
| [`approval-hitl/`](./approval-hitl/) | A `read_write` tool that pauses the run for human approval before mutating state. |
| [`mcp-docs/`](./mcp-docs/) | Calling an external MCP server (Stripe docs) alongside built-in tools. |
| [`support-readonly/`](./support-readonly/) | Multi-node graph: triage → answer. Uses a `read_only` function tool to look up a customer. |

## Running an example

The pattern is the same for all three:

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

See each example's README for exact commands.
