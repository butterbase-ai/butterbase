---
title: Substrate
description: A per-user memory and action coordination layer for AI agents — entities, decisions, attention rules, and an audited action ledger.
---

Substrate is a per-user layer that gives your AI agents durable memory and a way to take real-world actions through a single audited surface. Instead of each agent owning its own scratchpad and side effects, all your apps share the same substrate for a given user — entities they reference, decisions they record, and actions they propose all land in one ledger you can review and govern.

It plugs into Butterbase the same way [Functions](/core-concepts/functions/) and [Storage](/core-concepts/storage/) do: you call it from inside a function via `ctx.substrate`, from the CLI with [`butterbase substrate`](/cli/substrate/), or from any client over HTTP with a substrate-scoped API key.

## What you get

| Concept | What it is |
|---|---|
| **Entities** | People, companies, projects, agents, etc. — the durable nouns your apps talk about. |
| **Action ledger** | Every action an agent or app proposed, with who proposed it, the policy verdict, and the result. |
| **Decisions, commitments, learnings, principles** | Long-form memory rows your agents can search later. |
| **Source artifacts** | Durable, FTS-indexed source material — meeting transcripts, email threads, call recordings, documents — that decisions, commitments, and learnings can link back to. Provenance for everything else in the substrate. |
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
| `searchMemory(query, { kinds?, limit? })` | Full-text search across decisions, commitments, learnings, and source artifacts. |

### Capabilities at a glance

Every proposed action either executes immediately or blocks in `proposed` state until the owner approves it. The `Default policy` column shows which behavior the platform applies out of the box. Owners can override with `dangerously_skip_approval: true` on a single call, but agents cannot.

A non-obvious asymmetry that has tripped up agent authors: **`record_decision` auto-approves, but `record_principle`, `supersede_decision`, and `retire_principle` all require human approval by default.** All three mutate the policy-enforcement layer of the substrate, so the platform conservatively gates them.

| Capability | Default policy | Reversible | Restricted | Notes |
|---|---|---|---|---|
| `record_decision` | auto | yes | no | Write a decision row. |
| `record_commitment` | auto | yes | no | Write a commitment. Accepts optional `source_artifact_id`. |
| `record_learning` | auto | yes | no | Write a retrospective learning. |
| `upsert_entity` | auto | yes | no | Create or update an entity. Dedups by id > canonical_keys > primary_email. |
| `update_entity` | auto | yes | no | Replace `attrs` wholesale on an existing entity (legacy). Prefer `patch_entity`. |
| `patch_entity` | auto | yes | no | RFC 7396 merge-patch over `attrs`. Supports `if_updated_at` optimistic lock. |
| `upsert_source_artifact` | auto | yes | no | Insert or update a source artifact. Idempotent by `(external_system, external_id)`. |
| `revert_action` | auto | no | no | Revert a single reversible ledger action. |
| `record_principle` | approval_required | no | no | Record a durable principle used by the policy engine. Requires human approval. |
| `supersede_decision` | approval_required | no | no | Mark an existing decision superseded and insert a replacement. Requires human approval. |
| `retire_principle` | approval_required | no | no | Set a principle to `status=expired`. Requires human approval. |
| `delete_entity` | approval_required | no | no | Hard-delete an entity. Not reversible. |
| `merge_entities` | approval_required | no | no | Collapse a duplicate entity into a survivor via alias. Not reversible. |
| `bulk_revert_actions` | approval_required | no | no | Revert up to 200 ledger actions in one call. Per-action failures are collected, not raised. |
| `send_email_draft` | approval_required | no | no | Record an intended email draft. Side-effecting; always requires approval for agent proposers. |

When the function runs on behalf of an app, the proposer is recorded as `kind: 'agent'` and certain side-effect capabilities require human approval even if the user has [`yolo_mode`](#yolo-mode) on.

## Entity primitives

### Upsert (`upsert_entity`)

Dedup order: **`id` > `canonical_keys` > `primary_email` > insert new**.

- If you pass `id`, it's an upsert by id (current legacy behavior).
- Else if you pass non-empty `canonical_keys`, substrate looks up an entity of the same type whose canonical_keys contain every key/value pair you sent (JSONB `@>`). On hit: update and return `was_insert: false`.
- Else if you pass `primary_email`, substrate looks up by `(type, lower(primary_email))`. On hit: update. On insert, substrate **auto-promotes** `primary_email` into `canonical_keys.email` so future calls can dedup either way.

Race-safety: primary_email lookups are protected by a partial unique index. Canonical_keys-only lookups are best-effort — two near-simultaneous identical writes can still race; clean up with `merge_entities`.

### Patch (`patch_entity`)

RFC 7396 JSON Merge Patch over `attrs`. Atomic.

```ts
await ctx.substrate.patchEntity('ent_…', { title: 'CTO', previous_title: null });
// title set to 'CTO', previous_title key deleted, all other attrs untouched.
```

Optional optimistic concurrency: pass `if_updated_at` to get an error instead of a silent clobber.

Use `patch_entity` for any partial update. `update_entity` (legacy) replaces `attrs` wholesale and is kept only for backwards compatibility.

### Merge (`merge_entities`)

Collapse a duplicate into a survivor.

```ts
await ctx.substrate.mergeEntities('ent_loser', 'ent_winner', 'duplicate by email');
```

Semantics:
- The **loser** is hard-deleted from `substrate.entities`.
- An alias row is inserted into `substrate.entity_aliases` mapping `loser_id → winner_id`.
- **No automatic FK rewriting.** If your app stores `attrs.company_id = 'ent_loser'` on other entities, those references will not be updated by `merge_entities`. Your read path must resolve old IDs through `entity_aliases`:

  ```sql
  SELECT COALESCE(a.canonical_id, $1) AS resolved_id
  FROM (VALUES ($1)) t(id)
  LEFT JOIN substrate.entity_aliases a ON a.alias_id = $1;
  ```

- One ledger action per merge. `reversible: false` — undoing a merge means re-creating the loser, which the platform won't do for you.

### Delete (`delete_entity`)

Hard delete, not reversible. Requires approval by default.

```ts
await ctx.substrate.deleteEntity('ent_…', 'manual cleanup');
```

Prefer `merge_entities` when collapsing duplicates (preserves alias resolution). Use `delete_entity` only when the entity is genuinely garbage with no inbound references worth preserving.

For soft delete, patch the entity instead: `ctx.substrate.patchEntity(id, { deleted_at: new Date().toISOString() })` and filter on read.

### Idempotent proposals

Pass `idempotency_key` as a third argument to `propose` (or as a body field on `POST /v1/me/substrate/actions/propose`) to protect retries — network blips, lambda re-runs, or duplicate webhook deliveries — from doubling actions in the ledger:

```ts
await ctx.substrate.propose('record_decision', payload, {
  idempotency_key: 'mtg_2026-06-16:record_decision',
});
```

Keys are scoped per substrate user (two users can reuse the same string without collision) and are retained forever — there is no TTL. Pick keys that are stable for the unit of work you are deduplicating; a meeting ID combined with the capability is a good pattern, while a per-call UUID defeats the purpose. When the key matches a prior action, the response returns that prior action's verdict and result unchanged, and includes `"replay": true` so callers can tell a replay apart from a fresh propose.

### Bulk revert (`bulk_revert_actions`)

Revert up to 200 ledger actions in one call. Per-action failures are collected into the response, not raised. Use after a buggy ingest run produced many bad actions:

```ts
await ctx.substrate.propose('bulk_revert_actions', {
  action_ids: ['act_…', 'act_…', /* … */],
  reason: 'rolling back failed ingest run 2026-06-11',
});
```

## Authentication

Three ways to reach the substrate over HTTP:

1. **Substrate-scoped API key** (`bb_sub_*`) — for CLIs, SDK clients, and headless integrations. Generate one with `butterbase keys generate --substrate`.
2. **Cognito session** (the dashboard at [docs.butterbase.ai](https://docs.butterbase.ai)) — handled for you by the web app.
3. **Inside a deployed function** — `ctx.substrate` is wired automatically when the app is linked to a substrate user; no token to manage.

## Yolo mode

By default every action goes through the policy engine and may require approval before it executes. Turn on `yolo_mode` to auto-approve any action where the proposer is a human:

```bash
butterbase substrate settings yolo on
```

Agent proposals from `ctx.substrate` are **not** affected by `yolo_mode` for side-effecting capabilities — that's a deliberate safety rail.

## The dashboard

Visit `/substrate` in your Butterbase dashboard to see the action ledger, entities, memory, attention rules, and pending approvals in a UI. The dashboard is a complete substitute for the CLI — anything you can do with `butterbase substrate` you can do in the browser.

## Walkthrough — your first substrate-aware agent

This walkthrough takes you from zero to a function that proposes a decision, an attention rule that watches your substrate on a schedule, and a webhook that fires when an action executes. ~10 minutes.

### 1. Provision your substrate

A substrate is created on first use. Either trigger it from the dashboard (click "Open Substrate") or from the CLI:

```bash
butterbase substrate settings show
```

If you see `{"yolo_mode": false, ...}`, you're provisioned. If you see a `not provisioned` error with a remediation hint, follow it.

### 2. Generate a substrate-scoped key

```bash
butterbase keys generate --substrate --name "my-laptop"
# → bb_sub_…  (shown once — store it now)
export BUTTERBASE_API_KEY="bb_sub_..."
```

The key is bound to your user's substrate. It cannot read or write any *app* database; substrate routes only.

### 3. Propose your first action from the CLI

```bash
butterbase substrate propose record_decision \
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
butterbase substrate memory "adopt substrate" --kinds decisions
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

Deploy with `butterbase fn deploy` (or via MCP `deploy_function`). Invoke it once; in the action ledger you'll see the new decision attributed to `kind: 'agent'` with `source_app_id` set to your app.

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
butterbase substrate rules create --file rule.json
```

Preview what it would do today without scheduling it:

```bash
butterbase substrate rules preview --file rule.json
```

### 7. Send execution events to a webhook

When an action with a `send_email_draft` capability auto-executes, the substrate can POST it to your own endpoint:

```bash
butterbase substrate outbox put send_email_draft \
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

- [CLI: `butterbase substrate`](/cli/substrate/) — every command for managing substrate from the shell.
- [Substrate API reference](/api-reference/substrate-api/) — every HTTP route, payload, and response shape.
- [Functions](/core-concepts/functions/) — how `ctx.substrate` plugs in.
- [Realtime](/core-concepts/realtime/) — the general realtime layer (substrate stream is a sibling, not a replacement).
