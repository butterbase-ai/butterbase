# mcp-docs

Demonstrates using an **external MCP server** as an agent tool source. This example wires up the [Stripe docs MCP server](https://mcp.stripe.com) and lets the agent answer Stripe API questions by searching the docs.

## Deploy

```bash
# 1. Register the MCP server with the app.
butterbase mcp-servers add \
  --name "Stripe docs" \
  --url "https://mcp.stripe.com" \
  --auth-token "$STRIPE_DOCS_TOKEN"

# Note the printed server_id — you'll paste it into agent-spec.json.

# 2. Probe to load the server's advertised tool list.
butterbase mcp-servers probe <server_id>

# 3. Edit agent-spec.json and replace REPLACE_WITH_SERVER_ID with the UUID printed above.

# 4. Create the agent.
butterbase agents create \
  --name docs-helper \
  --display-name "Stripe docs helper" \
  --default-model anthropic/claude-3.5-sonnet \
  --spec ./agent-spec.json
```

## Run

```bash
butterbase agents run docs-helper \
  --input '{"question": "How do I create a subscription with a trial period?"}' \
  --stream
```

You'll see the agent issue one or more `search` tool calls to the Stripe MCP server, then synthesize an answer.

## Pattern

This is the canonical shape for "agent that uses an external knowledge source":

1. Register the external MCP server once per app (it persists).
2. List the subset of its tools you want exposed in `tools.mcp_servers[].tools`.
3. Optionally override `mode`/`exposed_to` per tool via `tool_overrides`.

You can mix MCP, built-in, and function tools freely in the same graph.
