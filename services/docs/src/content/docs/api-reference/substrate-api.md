---
title: Substrate API
description: Complete reference for the Butterbase substrate HTTP API.
sidebar:
  order: 9
---

The substrate API is a per-user surface: every route operates on the substrate that belongs to the calling user, identified by the Bearer token. There is no `{app_id}` path segment.

## Authentication

All routes accept either:

- A **substrate-scoped API key**: `Authorization: Bearer bb_sub_…` (generate with `butterbase keys generate --substrate`).
- A **platform JWT** (dashboard / Cognito session).

Non-substrate-scoped API keys (`bb_sk_…`) are not accepted by these routes — they return `403`.

Errors follow the standard envelope:

```json
{ "error": { "code": "AUTH_INVALID_TOKEN", "message": "…", "remediation": "…" } }
```

## Settings

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/me/substrate/settings | Get yolo mode and other per-user toggles |
| PUT | /v1/me/substrate/settings/yolo | Toggle yolo mode |

```json
PUT /v1/me/substrate/settings/yolo
{ "yolo_mode": true }
```

## Actions

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/me/substrate/actions/propose | Propose a new action |
| GET | /v1/me/substrate/actions | List actions in the ledger |
| GET | /v1/me/substrate/actions/\{action_id} | Fetch one action |
| POST | /v1/me/substrate/actions/\{action_id}/approve | Approve a pending action |
| POST | /v1/me/substrate/actions/\{action_id}/reject | Reject a pending action |

### Propose

```json
POST /v1/me/substrate/actions/propose
{
  "capability": "record_decision",
  "payload": { "title": "…", "kind": "operational", "rationale": "…" },
  "idempotency_key": "optional-stable-string"
}
```

Response:

```json
{
  "action_id": "act_01…",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01…" }
}
```

Verdict values: `auto_approved`, `auto_approved_yolo`, `requires_approval`, `rejected`.

### List

```
GET /v1/me/substrate/actions?status=executed&capability=send_email_draft&limit=25&before=2026-05-28T00:00:00Z
```

| Query param | Type | Default |
|---|---|---|
| `status` | `proposed` \| `executed` \| `rejected` | _all_ |
| `capability` | string | _all_ |
| `limit` | int (1–500) | 100 |
| `before` | ISO timestamp | _now_ |
| `source_app_id` | string | _all_ |
| `source_rule_id` | string | _all_ |

### Approve / reject

```
POST /v1/me/substrate/actions/{action_id}/approve
POST /v1/me/substrate/actions/{action_id}/reject
{ "reason": "policy mismatch" }
```

Both return the updated action row. Approving or rejecting an action that is not in `proposed` status returns `409 wrong_status`.

## Entities

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/me/substrate/entities | List entities |
| GET | /v1/me/substrate/entities/\{entity_id} | Fetch one entity |
| PATCH | /v1/me/substrate/entities/\{entity_id} | Update an entity (routed through propose) |

```
GET /v1/me/substrate/entities?type=person&q=alice&limit=20&count=true
```

| Query param | Type | Default |
|---|---|---|
| `type` | `person` \| `company` \| `fund` \| `workspace` \| `team` \| `project` \| `event` \| `agent` \| `self` | _all_ |
| `q` | string (display-name search) | _none_ |
| `limit` | int (1–200) | 50 |
| `count` | `true` to include `total` in response | `false` |

## Source artifacts

Source artifacts are durable, full-text-indexed source material — meeting transcripts, email threads, call recordings, documents — that the substrate extracts decisions, commitments, and learnings from. A commitment can carry a `source_artifact_id` pointing back to the artifact it was extracted from.

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/me/substrate/source-artifacts | List / filter / FTS over artifacts |
| GET | /v1/me/substrate/source-artifacts/\{artifact_id} | Fetch one artifact (incl. full `content`) |

```
GET /v1/me/substrate/source-artifacts?kind=meeting_transcript&q=billing&limit=20&count=true
```

| Query param | Type | Default |
|---|---|---|
| `kind` | string | _all_ |
| `q` | string (FTS over `title + summary + content`) | _none_ |
| `limit` | int (1–200) | 50 |
| `count` | `true` to include `total` in response | `false` |

Response:

```json
{
  "artifacts": [
    {
      "id": "art_01…",
      "kind": "meeting_transcript",
      "external_system": "fireflies",
      "external_id": "abc123",
      "title": "Weekly product sync — 2026-06-09",
      "summary": "Reviewed phase 6 scope; Alice owns billing migration.",
      "url": "https://fireflies.ai/…",
      "storage_object_id": null,
      "links": { "entity_ids": ["ent_01…"], "project_tags": ["phase-6"] },
      "attrs": {},
      "source_app_id": "app_…",
      "created_at": "2026-06-09T…",
      "updated_at": "2026-06-09T…"
    }
  ]
}
```

`GET /v1/me/substrate/source-artifacts/{artifact_id}` returns the same shape plus the full `content` field.

Artifacts are written via the `upsert_source_artifact` capability through `POST /v1/me/substrate/actions/propose`. Upsert is idempotent: if `id` is omitted, the substrate resolves the row by `(external_system, external_id)`; otherwise it generates an `art_<ulid>`. Artifacts proposed by an installed app are auto-attributed to that app via `source_app_id`.

## Memory search

Full-text search across `decisions`, `commitments`, `learnings`, and `source_artifacts`.

```
GET /v1/me/substrate/memory?q=billing&kinds=decisions,commitments&limit=20
```

`kinds` accepts any subset of `decisions`, `commitments`, `learnings`, `source_artifacts` (comma-separated). Omitting `kinds` searches all of them.

| Query param | Type | Default |
|---|---|---|
| `q` | string (FTS query; omit or pass `*` to list all) | _none_ |
| `kinds` | comma-separated subset of `decisions`, `commitments`, `learnings`, `source_artifacts` | _all_ |
| `limit` | int (1–200) | 20 |
| `match` | `and` \| `or` \| `phrase` | `and` |

When `q` is omitted or empty (or `*`), the endpoint returns the most recent items across the selected kinds ordered by `updated_at DESC`, capped by `limit`. No full-text ranking is performed — `rank` will be `null` in those rows. Use this as a "list all" path.

`match` controls how multi-word queries are evaluated: `and` requires all words (default), `or` matches any word, `phrase` requires words to appear adjacently. Omitting `match` is identical to `match=and`.

:::note[When to use which]
Use `GET /v1/me/substrate/memory` when you need FTS-ranked results and a relevance score (`rank`). Use `GET /v1/me/substrate/memory/list` when you need chronological ordering or structural filters (kind subset, source artifact scope, superseded status). The two endpoints share the same underlying tables but serve different query shapes.
:::

Response:

```json
{
  "results": [
    {
      "id": "dec_01…",
      "kind": "decision",
      "title": "Adopt substrate",
      "body_text": "agent memory needs a single source of truth",
      "rank": 0.18,
      "updated_at": "2026-05-31T…",
      "source_artifact_id": null,
      "supersedes": null,
      "status": "active"
    },
    {
      "id": "art_01…",
      "kind": "source_artifact",
      "title": "Weekly product sync — 2026-06-09",
      "body_text": "Reviewed phase 6 scope; Alice owns billing migration.",
      "rank": 0.12,
      "updated_at": "2026-06-09T…",
      "source_artifact_id": null,
      "supersedes": null,
      "status": null
    }
  ]
}
```

Three fields are present on every result row:

| Field | Type | Notes |
|---|---|---|
| `source_artifact_id` | `string \| null` | Back-pointer to the source artifact this memory was extracted from. `null` for source artifacts themselves and for items ingested without one. |
| `supersedes` | `string \| null` | Only set on `kind: 'decision'` rows where this decision replaces an earlier one (holds the replaced decision ID). |
| `status` | `string \| null` | `'active'` / `'superseded'` / `'reversed'` / `'expired'` for decisions; `'proposed'` / `'confirmed'` / `'fulfilled'` / `'expired'` / `'broken'` / etc. for commitments; `null` for learnings and source_artifacts. |

## Memory list (chronological browse)

Chronological browse across `decisions`, `commitments`, `learnings`, and `source_artifacts` with structural filters. Unlike the FTS search endpoint, results are always ordered by `updated_at DESC` and there is no relevance ranking.

```
GET /v1/me/substrate/memory/list?source_artifact_id=art_…&kinds=decisions,commitments,learnings&limit=25
```

| Query param | Type | Default |
|---|---|---|
| `kinds` | comma-separated subset of `decisions`, `commitments`, `learnings`, `source_artifacts` | _all_ |
| `source_artifact_id` | string | _none_ |
| `superseded` | `true` \| `false` | _include all_ |
| `before` | ISO timestamp (keyset cursor from `next_before`) | _none_ |
| `limit` | int (1–100) | 25 |

**`source_artifact_id`** restricts results to rows linked to that source artifact. Source-artifact rows themselves are excluded from the response when this filter is set, because they carry no `source_artifact_id` back-pointer of their own.

**`superseded`** when `false`, excludes decisions with `status='superseded'` and commitments with `status='expired'`. When `true` or omitted, all statuses are returned.

**`before`** accepts the `next_before` value from a previous response for keyset pagination. Pass it verbatim — it is an ISO timestamp.

Response:

```json
{
  "results": [
    {
      "id": "dec_…",
      "kind": "decision",
      "title": "…",
      "body_text": "…",
      "updated_at": "…",
      "source_artifact_id": "art_…",
      "supersedes": "dec_…",
      "status": "active"
    }
  ],
  "next_before": "2026-06-09T14:32:00.000Z"
}
```

`next_before` is `null` when there are no more pages.

`status` is set on decisions and commitments; `null` for learnings and source_artifacts. `supersedes` is only set on decisions that replace an earlier decision.

### Example — list every decision, commitment, and learning extracted from a meeting

```
GET /v1/me/substrate/memory/list
  ?source_artifact_id=art_01JXYZ…
  &kinds=decisions,commitments,learnings
  &superseded=false
  &limit=50
```

Response:

```json
{
  "results": [
    {
      "id": "dec_01JXYZ…",
      "kind": "decision",
      "title": "Ship phase 6 by end of June",
      "body_text": "Agreed in the weekly sync. Alice owns the billing migration.",
      "updated_at": "2026-06-09T14:30:00.000Z",
      "source_artifact_id": "art_01JXYZ…",
      "supersedes": null,
      "status": "active"
    },
    {
      "id": "com_01JXYZ…",
      "kind": "commitment",
      "title": "Alice to deliver billing migration PR by 2026-06-13",
      "body_text": null,
      "updated_at": "2026-06-09T14:30:01.000Z",
      "source_artifact_id": "art_01JXYZ…",
      "supersedes": null,
      "status": "confirmed"
    }
  ],
  "next_before": null
}
```

## Capabilities

A few capabilities accept fields that aren't obvious from their name:

| Capability | Optional fields | Notes |
|---|---|---|
| `record_commitment` | `source_artifact_id`, `attrs` | `source_artifact_id` links the commitment back to the artifact it was extracted from (FK to `source_artifacts(id) ON DELETE SET NULL`). `attrs` is a free-form JSON bag for caller metadata. |
| `upsert_source_artifact` | `id`, `external_system`, `external_id`, `summary`, `content`, `storage_object_id`, `url`, `links`, `attrs` | Required: `kind`, `title`. Idempotent by `(external_system, external_id)` when `id` is omitted. `default_policy='auto'`, `reversible=true`, `yolo_eligible=true`. Returns `{ artifact_id, was_insert, before }`. |

## Daily snapshots

Snapshots are the basis for attention-rule `snapshot_predicate` conditions.

```
GET /v1/me/substrate/snapshots?days=7
```

Response:

```json
{
  "snapshots": [
    { "snapshot_date": "2026-05-31", "entity_count": 12, "decision_count": 8, "…": "…" }
  ]
}
```

## Attention rules

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/me/substrate/attention-rules | List rules |
| GET | /v1/me/substrate/attention-rules/\{rule_id} | Fetch one rule |
| POST | /v1/me/substrate/attention-rules | Create a rule |
| PUT | /v1/me/substrate/attention-rules/\{rule_id} | Update a rule |
| DELETE | /v1/me/substrate/attention-rules/\{rule_id} | Delete a rule |
| POST | /v1/me/substrate/attention-rules/\{rule_id}/enable | Enable |
| POST | /v1/me/substrate/attention-rules/\{rule_id}/disable | Disable |
| POST | /v1/me/substrate/attention-rules/preview | Dry-run a rule body against today's snapshot |
| GET | /v1/me/substrate/attention-rules/\{rule_id}/firings | List firings |

### Rule body

```json
{
  "name": "weekly digest",
  "description": "Monday morning summary",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [ { "var": "entity_count" }, 0 ] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities."
  },
  "enabled": true,
  "max_fires_per_day": 1
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name. |
| `trigger_cron` | yes | Standard 5-field cron expression (UTC). |
| `condition_mode` | yes | `snapshot_predicate` evaluates a JSON-Logic predicate against today's snapshot. `row_query` runs the condition as a row-query (advanced). |
| `condition` | yes | JSON-Logic object. Available variables depend on `condition_mode`. |
| `action_capability` | yes | The capability to propose when the rule fires. |
| `action_payload_template` | yes | Object with `{{var}}` placeholders interpolated from the matched binding. |
| `enabled` | no | Defaults to `true`. |
| `max_fires_per_day` | no | Caps daily proposals. |

### Preview

```json
POST /v1/me/substrate/attention-rules/preview
{ <same shape as rule body, name optional> }
```

Response:

```json
{
  "bindings_count": 3,
  "sample_proposals": [
    { "binding": { "entity_count": 12 }, "rendered_payload": { … }, "would_require_approval": false }
  ],
  "skip_reason": null
}
```

`skip_reason` is set (and `bindings_count` is 0) when the snapshot is missing or the condition can't be evaluated.

## Outbox targets

When an action with `capability X` executes, the substrate POSTs the rendered payload to the registered outbox target for `X` (if any). Deliveries are HMAC-signed and retried with backoff.

| Method | Path | Purpose |
|--------|------|---------|
| GET | /v1/me/substrate/outbox-targets | List all targets |
| PUT | /v1/me/substrate/outbox-targets/\{capability} | Register or replace a target |
| DELETE | /v1/me/substrate/outbox-targets/\{capability} | Remove the target |

```json
PUT /v1/me/substrate/outbox-targets/send_email_draft
{
  "webhook_url": "https://example.com/hooks/substrate",
  "signing_secret": "min-8-chars",
  "source_app_id": "app_optional_scope"
}
```

`source_app_id` is optional; when set, the target only fires for actions proposed by that app.

### Webhook delivery

```
POST https://example.com/hooks/substrate
Content-Type: application/json
X-Butterbase-Signature: sha256=<hex>
X-Butterbase-Delivery: <uuid>

{
  "action_id": "act_01…",
  "capability": "send_email_draft",
  "payload": { … the rendered action payload … },
  "executed_at": "2026-05-31T…"
}
```

Verify the signature with HMAC-SHA-256 over the raw body using `signing_secret`.

## WebSocket stream

Live push of every change to the caller's substrate.

```
GET /v1/me/substrate/stream
```

### Browser flow

Browsers can't send custom headers on a WebSocket upgrade, so the stream accepts a one-shot ticket.

1. Mint a ticket (Cognito or `bb_sub_` Bearer):

   ```
   POST /v1/me/substrate/ws-ticket
   ```

   ```json
   { "ticket": "wst_…", "expires_in": 60 }
   ```

2. Open the WS with `?ticket=`:

   ```
   wss://api.butterbase.ai/v1/me/substrate/stream?ticket=wst_…
   ```

Tickets are **single-use** and expire after 60 seconds. Reused or expired tickets close the WS with code `1008 unauthenticated`.

### Server-side flow

Programmatic / server clients can put the substrate-scoped key in the Authorization header on the upgrade:

```
GET /v1/me/substrate/stream
Upgrade: websocket
Authorization: Bearer bb_sub_…
```

Or as a fallback query string:

```
wss://api.butterbase.ai/v1/me/substrate/stream?token=bb_sub_…
```

### Frames

```json
// First frame on open:
{ "type": "hello", "ts": 1780198304 }

// Subsequent frames, one per change:
{ "tbl": "action_ledger",          "op": "insert", "id": "act_…", "user": "…" }
{ "tbl": "entities",               "op": "update", "id": "ent_…", "user": "…" }
{ "tbl": "attention_rules",        "op": "update", "id": "rule_…", "user": "…" }
{ "tbl": "attention_rule_firings", "op": "insert", "id": "fire_…", "user": "…" }
```

The stream does not include payloads — clients are expected to re-fetch the affected row by id.

### Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal close (initiated by client) |
| 1008 | Ticket missing, expired, reused, or token rejected |

## SDK / CLI

- **CLI**: see [`butterbase substrate`](/cli/substrate/) for every command.
- **TypeScript SDK**: substrate calls are namespaced under `butterbase.substrate.*` (mirror of the HTTP surface).
- **Inside a function**: `ctx.substrate.*` (`propose`, `getEntity`, `findEntities`, `searchMemory`, `listMemory`) — see [Substrate](/core-concepts/substrate/).
