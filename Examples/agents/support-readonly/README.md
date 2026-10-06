# support-readonly

A simple customer-support agent. Two LLM nodes:

1. **triage** — classify the message as `billing` or `other`.
2. **answer** — answer the question, calling `lookup_account` to fetch the user's record first.

The function tool is `read_only`, so the run never pauses for approval.

## Deploy

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

## Run

```bash
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/support-readonly/runs \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"message": "Why was I charged twice last month?", "email": "user@example.com"}}'
# Returns 202 {run_id, status}. Poll GET /v1/<app_id>/agents/support-readonly/runs/<run_id>/events.json
```

## What you should see

- `run_start`
- `node_start triage` → `llm_token_usage` → `node_end triage`
- `node_start answer` → `tool_call_start lookup_account` → `tool_call_end lookup_account` → `llm_token_usage` → `node_end answer`
- `run_end` with the final reply

Total wall-clock: ~3–5 seconds on Claude Haiku/Sonnet.
