---
title: Office API
description: Organization-scoped Office status, confirmations, decisions, conversations, events and business memory.
---

Use a platform credential in `Authorization: Bearer <credential>` and an explicit organization UUID in `x-organization-id`. No app ID or app end-user token is used. Current membership, key state and role are checked on each request. See [all client commands and access rules](/core-concepts/office-clients/).

All paths below start with `/v1/me/office`.

| Method and path | Body or query |
| --- | --- |
| `GET /` | Existing REST response: `{status: OfficeStatus}` |
| `POST /confirmations` | `{action: "enable" | "pause" | "resume" | "approve", idempotency_key, decision?: {source,id}}`; decision required only for approve |
| `GET /confirmations/:id` | Read the initiating credential's receipt |
| `GET /confirmations/:id/review` | Signed-in initiating owner's safe review; stored request determines organization |
| `POST /confirmations/:id/resolve` | `{decision: "confirm" | "reject"}`; initiating owner's JWT and configured dashboard `Origin` required |
| `GET /decisions` | `status=pending|resolved|all`, `cursor`, `limit` |
| `GET /decisions/:source/:id` | `source=office|substrate` |
| `GET /decisions/:source/:id/context` | Optional `limit` |
| `POST /decisions/:source/:id/deny` | `{reason}` |
| `POST /conversations` | `{idempotency_key, title?}` |
| `GET /conversations` | `cursor`, `limit` |
| `GET /conversations/:id` | Optional `turn_id`, `after_sequence`, `limit`; sequence requires turn ID |
| `POST /ask` | `{message, idempotency_key, conversation_id?, wait_ms?}` |
| `GET /conversations/:id/turns/:turnId/events` | SSE; optional `after_sequence` or matching `Last-Event-ID` |
| `GET /memory` | `kind=decision|commitment|learning`, `cursor`, `limit` |
| `GET /memory/search` | Required `query`, optional `limit`; no cursor |
| `GET /memory/sources/:id` | Read an organization source artifact |
| `POST /memory/:kind` | `{payload, idempotency_key}`; kind is `record_decision`, `record_commitment`, `record_learning` or `record_principle` |
| `GET /principles` | `cursor`, `limit` |
| `GET /principles/:id` | Read a native principle |
| `POST /principles/amend` or `/principles/retire` | `{payload,idempotency_key}`; native approval-required proposal |
| `GET /agent-memories` or `/agent-memories/search` | `query?`, `cursor`, `limit`; compact summaries |
| `GET /agent-memories/:id` | Full curated entry and saved evidence |
| `POST /agent-memories/record`, `/amend` or `/archive` | `{payload,idempotency_key}`; amend/archive require `expected_revision` |
| `GET /skills` | `cursor`, `limit`; approved content for API-key/member readers |
| `GET /skills/:id` | Skill and current version; histories fetched separately |
| `GET /skills/:id/versions` or `/skills/:id/runs` | `cursor`, `limit`; API clients exclude drafts/tests |
| `POST /skills/draft` | `{message,skill_id?,idempotency_key}`; returns a durable Ask turn |
| `POST /skills/:id/versions/:version/test` | `{idempotency_key}`; pinned read-only test run |
| `POST /skills/:id/versions/:version/reject` | `{reason,idempotency_key}` |
| `GET /settings` | Interval, revision and full-sweep clock/blocked status |
| `GET /pages/:resource` | `cursor`, `limit`, resource-specific `kind`, `status`, `skill_id` |

Additional confirmation actions are `skill_approve`, `skill_set_enabled`, `skill_rollback`, `skill_run_now` and `settings_update`; they carry the exact skill/version/enabled state or `interval_minutes` plus `expected_revision`. Use the typed client methods to construct these requests. Skills remain immutable versions; approval, activation and run receipts require the initiating owner's browser confirmation. Settings intervals are 10, 15, 30 or 60 minutes; updating a paused Office does not resume it.

Page resources are `entities`, `business_memory`, `source_artifacts`, `actions`, `principles`, `skills`, `skill_versions` and `skill_runs`. The two histories require `skill_id`. Pages default to 25 and allow at most 100. Cursors bind organization, resource, filters, visibility and traversal cutoff. They preserve timestamp precision and stable tie-breakers but do not promise a transaction-wide snapshot. The public demo exposes only its fixed-scope redacted business pages, never private skill or curated-memory pages.

Human review/resolution determines scope from the saved confirmation; it does not trust a dashboard-selected organization. A review GET never executes anything. The SDK and MCP unwrap the existing `{status}` envelope into the public status value. Existing dashboard lifecycle endpoints remain compatible; external clients use confirmation preparation for protected actions.

## Receipts and turns

Confirmation states are `awaiting_confirmation`, `executing`, `succeeded`, `rejected`, `expired`, `failed`, and `outcome_unknown`. A succeeded receipt contains the saved outcome. Failed/unknown receipts contain a typed error. Unknown outcomes are reconciled only from authoritative saved execution evidence and are never blindly replayed.

Ask returns `{turn_id, conversation_id, state, output, ...}`. States are `running`, `awaiting_approval` (with a source-aware `decision`), `completed`, `blocked`, `failed`, or `interrupted`. The bounded wait is 0–25,000 milliseconds, default 15,000. Retrying the same admitted request returns its exact existing turn; a different body under the same key is a conflict. Conversation origin and user/organization identity are server-owned.

Events use `id` equal to the positive public sequence and `event` equal to the JSON payload's `type`:

```text
id: 2
event: text_delta
data: {"sequence":2,"type":"text_delta","text":"Follow up with the team."}

```

Public event types: `started`, `text_delta`, `message`, `approval_required`, `decision_resolved`, `blocked`, `completed`, `failed`, `interrupted`. Completed events carry turn/conversation IDs; fetch the turn for its exact output. Streams never expose credentials, raw tool arguments, reasoning, or worker internals. A disconnect does not cancel execution. Once replay has expired, HTTP 410 returns `error.code: "events_expired"` and `error.history` with the exact turn, conversation and state. Use conversation history for the retained business record.

## Errors and policy

New facade errors use `{error: {code,message,decision?,history?}}`. Codes distinguish authorization (`owner_required`, `managed_credential_forbidden`, `credential_revoked`), eligibility/work gates (`paid_plan_required`, `account_suspended`, `credits_required`, `paused_by_owner`, `credential_repair_required`), admission/retry conflicts (`idempotency_conflict`, `conversation_busy`, `conversation_awaiting_approval`, `conversation_not_client_owned`), confirmation drift/expiry, policy conflicts, interrupted work and expired replay. For `conversation_not_client_owned`, create a new conversation through an Office client or omit `conversation_id` on the first Ask; existing website conversations are not adopted for client execution.

Native memory writes return the real `action_id`, `verdict`, saved `result` when executed, and a source-aware pending `decision` when approval is required. Office approval uses the saved native capability and payload and checks policy again under its action lock. It cannot override unresolved conflicts or a changed principle. No duplicate memory store or alternate policy engine is introduced.
