# approval-hitl

Demonstrates the **human-in-the-loop** flow when an agent calls a `read_write` tool.

This agent has a single LLM node with one tool — `cancel_subscription` — marked `read_write`. The runtime emits a `run_paused` event when a run is paused, and the run waits for the caller to resume it before proceeding.

> Note: in the current agent-runtime, the pause is raised by the built-in `interrupt` tool (`services/agent-runtime/src/agent_runtime/tools/builtin.py`); `read_write` mode alone does not pause the run, and there is no `approval_token`. The bundled `agent-spec.json` does not include `interrupt` (`tools.builtin` is empty), so add it to `tools.builtin` and the node's `tools` to get a pause. The event payload is `{reason, data}`.

## Deploy

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

## Run

```bash
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/approval-hitl/runs \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"message": "Cancel the Pro plan for user_42"}}'
# Returns 202 {run_id, status}. Poll GET /v1/<app_id>/agents/approval-hitl/runs/<run_id>/events.json
```

You'll see the stream pause:

```
event: run_paused
data: {
  "payload": {
    "reason": "Approve cancel_subscription for user_42?",
    "data": { "user_id": "user_42" }
  }
}
```

The run sits in `paused` state until you approve or deny:

```bash
# Resume (REST; body must contain `input`, which the graph sees as state.human_input)
curl -X POST https://api.butterbase.ai/v1/<app_id>/agents/approval-hitl/runs/<run_id>/resume \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"approved": true}}'
```

After approving, the stream continues:

```
event: tool_call_end   {"tool_source": "function", "tool_name": "cancel_subscription", "status": "ok", "duration_ms": 120}
event: run_end         {"output": "Subscription for user_42 has been cancelled."}
```

A denial is just whatever `input` you resume with (e.g. `{"approved": false}`); the graph decides what to do with `state.human_input`.

## When to use this pattern

Any agent action with **side effects** the user should consciously confirm — refunds, deletions, customer-facing emails, public posts. Mark such functions `read_write` with a clear `agent_tool_description`, and gate them with the built-in `interrupt` tool.
