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

# 2. Register any MCP server the example depends on.
butterbase mcp-servers add --name "name" --url "https://..." --auth-token "..."

# 3. Create the agent from the bundled spec.
butterbase agents create --name <name> --spec ./agent-spec.json

# 4. Run it.
butterbase agents run <name> --input '{"message": "..."}' --stream
```

See each example's README for exact commands.
