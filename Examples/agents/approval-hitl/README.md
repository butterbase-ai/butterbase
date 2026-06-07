# approval-hitl

Demonstrates the **human-in-the-loop** flow when an agent calls a `read_write` tool.

This agent has a single LLM node with one tool — `cancel_subscription` — marked `read_write`. The runtime emits a `run_paused` event when the tool is invoked, and the run waits for an explicit approve/deny from the caller before proceeding.

## Deploy

```bash
# 1. Deploy the function as a read_write agent tool.
butterbase functions deploy ./cancel_subscription.ts \
  --agent-tool \
  --agent-tool-description "Cancel a customer's subscription. Requires human approval." \
  --agent-tool-mode read_write \
  --agent-tool-exposed-to developer_only

# 2. Create the agent.
butterbase agents create \
  --name approval-hitl \
  --display-name "HITL approval demo" \
  --default-model anthropic/claude-3.5-sonnet \
  --spec ./agent-spec.json
```

## Run

```bash
butterbase agents run approval-hitl \
  --input '{"message": "Cancel the Pro plan for user_42"}' \
  --stream
```

You'll see the stream pause:

```
event: run_paused
data: {
  "payload": {
    "tool_name": "cancel_subscription",
    "args": { "user_id": "user_42" },
    "approval_token": "appr_xxx"
  }
}
```

The run sits in `paused` state until you approve or deny:

```bash
# Approve
butterbase agents resume approval-hitl <run_id> \
  --approval-token appr_xxx --approved

# Deny
butterbase agents resume approval-hitl <run_id> \
  --approval-token appr_xxx --denied
```

After approving, the stream continues:

```
event: tool_call_end   {"tool_name": "cancel_subscription", "result": {"cancelled": true}}
event: run_end         {"output": "Subscription for user_42 has been cancelled."}
```

On deny, the run terminates with `run_failed` and `reason: "approval_denied"`.

## When to use this pattern

Any agent action with **side effects** the user should consciously confirm — refunds, deletions, customer-facing emails, public posts. `read_write` mode + a clear `agent_tool_description` is the supported way to wire approval-gated tools into a graph.
