---
title: Substrate
description: A per-user memory and action coordination layer for AI agents — entities, decisions, attention rules, and an audited action ledger.
---

Substrate is a per-user layer that gives your AI agents durable memory and a way to take real-world actions through a single audited surface. Instead of each agent owning its own scratchpad and side effects, all your apps share the same substrate for a given user — entities they reference, decisions they record, and actions they propose all land in one ledger you can review and govern.

It plugs into Butterbase the same way [Functions](/core-concepts/functions/) and [Storage](/core-concepts/storage/) do: you call it from inside a function via `ctx.substrate`, from the CLI with [`bb substrate`](/cli/substrate/), or from any client over HTTP with a substrate-scoped API key.

## What you get

| Concept | What it is |
|---|---|
| **Entities** | People, companies, projects, agents, etc. — the durable nouns your apps talk about. |
| **Action ledger** | Every action an agent or app proposed, with who proposed it, the policy verdict, and the result. |
| **Decisions, commitments, learnings, principles** | Long-form memory rows your agents can search later. |
| **Attention rules** | Scheduled rules that run on a snapshot of your substrate and propose actions when their conditions match. |
| **Outbox targets** | HMAC-signed webhooks that fire when actions execute (e.g. send the email draft to an external system). |
| **Settings** | Per-user toggles — `yolo_mode` for auto-approval, etc. |
| **WebSocket stream** | Live push of every ledger / entity / rule / firing change. |

## How agents use it

When you run a serverless function for an app that is linked to a substrate user, the function's `ctx` gains a `substrate` object:

```typescript
export async function handler(req, ctx) {
  // Propose an action. The substrate's policy engine decides whether it
  // executes immediately, queues for approval, or is rejected.
  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Migrate billing to Stripe',
    kind: 'strategic',
    rationale: 'Vendor consolidation; lower switching cost than custom.',
  });

  // Search prior memory.
  const prior = await ctx.substrate.searchMemory('billing', { kinds: ['decisions'], limit: 5 });

  // Look up an entity.
  const people = await ctx.substrate.findEntities({ type: 'person', limit: 10 });

  return Response.json({ verdict, prior, people });
}
```

The available calls are:

| Call | Purpose |
|---|---|
| `propose(capability, payload, opts?)` | Propose an action. Returns `{ action_id, verdict, requires_approval, result? }`. |
| `getEntity(entity_id)` | Fetch one entity. |
| `findEntities({ type?, q?, limit? })` | List or search entities. |
| `searchMemory(query, { kinds?, limit? })` | Full-text search across decisions, commitments, learnings. |

When the function runs on behalf of an app, the proposer is recorded as `kind: 'agent'` and certain side-effect capabilities require human approval even if the user has [`yolo_mode`](#yolo-mode) on.

## Authentication

Three ways to reach the substrate over HTTP:

1. **Substrate-scoped API key** (`bb_sub_*`) — for CLIs, SDK clients, and headless integrations. Generate one with `bb keys generate --scope substrate`.
2. **Cognito session** (the dashboard at [docs.butterbase.ai](https://docs.butterbase.ai)) — handled for you by the web app.
3. **Inside a deployed function** — `ctx.substrate` is wired automatically when the app is linked to a substrate user; no token to manage.

## Yolo mode

By default every action goes through the policy engine and may require approval before it executes. Turn on `yolo_mode` to auto-approve any action where the proposer is a human:

```bash
bb substrate settings yolo on
```

Agent proposals from `ctx.substrate` are **not** affected by `yolo_mode` for side-effecting capabilities — that's a deliberate safety rail.

## The dashboard

Visit `/substrate` in your Butterbase dashboard to see the action ledger, entities, memory, attention rules, and pending approvals in a UI. The dashboard is a complete substitute for the CLI — anything you can do with `bb substrate` you can do in the browser.

## Walkthrough — your first substrate-aware agent

This walkthrough takes you from zero to a function that proposes a decision, an attention rule that watches your substrate on a schedule, and a webhook that fires when an action executes. ~10 minutes.

### 1. Provision your substrate

A substrate is created on first use. Either trigger it from the dashboard (click "Open Substrate") or from the CLI:

```bash
bb substrate settings show
```

If you see `{"yolo_mode": false, ...}`, you're provisioned. If you see a `not provisioned` error with a remediation hint, follow it.

### 2. Generate a substrate-scoped key

```bash
bb keys generate --scope substrate --name "my-laptop"
# → bb_sub_…  (shown once — store it now)
export BUTTERBASE_API_KEY="bb_sub_..."
```

The key is bound to your user's substrate. It cannot read or write any *app* database; substrate routes only.

### 3. Propose your first action from the CLI

```bash
bb substrate propose record_decision \
  --payload '{"title":"Adopt substrate","kind":"strategic","rationale":"agent memory needs a single source of truth"}'
```

Returns:

```json
{
  "action_id": "act_01...",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01..." }
}
```

Your decision is now in `substrate.decisions`. Verify:

```bash
bb substrate memory "adopt substrate" --kinds decisions
```

### 4. Link an app to substrate

Substrate only injects into functions for apps that are explicitly linked to your substrate user. From the dashboard, open an app and click "Link to substrate", or use the SDK / CLI as your team's conventions dictate.

### 5. Deploy a function that uses `ctx.substrate`

```typescript
// fn-summarize-week.ts
export async function handler(req, ctx) {
  const lastWeekDecisions = await ctx.substrate.searchMemory('', { kinds: ['decisions'], limit: 20 });

  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Weekly summary',
    kind: 'operational',
    rationale: `Reviewed ${lastWeekDecisions.length} decisions this week.`,
  });

  return Response.json({ verdict, count: lastWeekDecisions.length });
}
```

Deploy with `bb fn deploy` (or via MCP `deploy_function`). Invoke it once; in the action ledger you'll see the new decision attributed to `kind: 'agent'` with `source_app_id` set to your app.

### 6. Add an attention rule

Attention rules let your substrate take initiative on a schedule. They run a [JSON-Logic](https://jsonlogic.com/) predicate against your daily snapshot and, if it matches, propose actions from a template.

```json
{
  "name": "weekly digest",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [ { "var": "entity_count" }, 0 ] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities tracked this week."
  }
}
```

Save it and create:

```bash
bb substrate rules create --file rule.json
```

Preview what it would do today without scheduling it:

```bash
bb substrate rules preview --file rule.json
```

### 7. Send execution events to a webhook

When an action with a `send_email_draft` capability auto-executes, the substrate can POST it to your own endpoint:

```bash
bb substrate outbox put send_email_draft \
  --webhook-url https://example.com/hooks/substrate \
  --signing-secret "$(openssl rand -hex 16)"
```

Every webhook delivery is signed with `X-Butterbase-Signature: sha256=…` using the secret you provided. Retries and dead-lettering are handled for you.

### 8. Stream live updates to a UI

Browsers can't put a Bearer token in a WebSocket handshake, so the substrate uses a single-use ticket exchange. Your dashboard (or any browser client) does:

```typescript
// 1. Get a one-shot ticket (60s, single-use). Cookies/Cognito auth here.
const { ticket } = await fetch('/v1/me/substrate/ws-ticket', {
  method: 'POST',
  credentials: 'include',
}).then(r => r.json());

// 2. Open the WS with the ticket in the URL.
const ws = new WebSocket(`wss://api.butterbase.ai/v1/me/substrate/stream?ticket=${ticket}`);

ws.onmessage = (evt) => {
  const change = JSON.parse(evt.data);
  // { tbl: 'action_ledger', op: 'insert', id: 'act_…', user: '…' }
};
```

The server pushes a `{type: 'hello'}` frame on connect, then one message per change. Reconnect with backoff and fetch a fresh ticket on each reconnect — tickets are single-use.

## See also

- [CLI: `bb substrate`](/cli/substrate/) — every command for managing substrate from the shell.
- [Substrate API reference](/api-reference/substrate-api/) — every HTTP route, payload, and response shape.
- [Functions](/core-concepts/functions/) — how `ctx.substrate` plugs in.
- [Realtime](/core-concepts/realtime/) — the general realtime layer (substrate stream is a sibling, not a replacement).
