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
| `GET /conversations/:id` | Optional `turn_id`, `after_sequence`, `limit`, `activity_version=1` or `activity_version=2`; sequence requires turn ID |
| `GET /conversations/:id/activity/:invocationId` | Latest recorded sanitized tool details; no execution |
| `POST /ask` | `{message, idempotency_key, conversation_id?, wait_ms?}` |
| `GET /conversations/:id/turns/:turnId/events` | SSE; optional `after_sequence` or matching `Last-Event-ID`, and `activity_version=1` or `activity_version=2` |
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

## Optional tool activity

REST observers can opt into bounded tool observations with `activity_version=1` on the conversation-detail and exact-turn event GETs above. No additional Ask submission is needed. Existing MCP, CLI and SDK observation options keep their defaults; they do not currently expose this opt-in argument.

Opted-in conversation details add `activity: [{user_message_id, steps}]`. Opted-in streams and event replay can include `{sequence, type: "activity", step}`. Activity is filtered before the event page limit for default observers, so stored activity cannot displace their final answer. Keep the returned sequence for replay; visible sequences can have gaps.

Each step has a stable `id`, `tool_name`, optional `action`, a plain-language `label`, `status`, nullable `summary`, `started_at`, `finished_at` and `duration_ms`, and bounded `details: [{label,value}]`. A confirmed memory result can add `result: {kind: "agent_memory", id, revision?}`. These are observations, not raw tool arguments or result bodies. Missing timing stays null. Status is `running`, `completed`, `failed`, `awaiting_approval`, `denied`, `interrupted` or `unknown`. Completed tools do not establish that the enclosing turn completed, and an approval receipt is not execution evidence. Use the saved turn state and output for the enclosing outcome.

### Input and Result previews (activity version 2)

After upgrading, opt into `activity_version=2` on the same REST observation GETs to receive captured invocation references. Default requests, activity version 1, strict stored events and their existing byte budgets stay unchanged. The SDK, CLI and MCP do not expose an activity-version flag or a tool-detail action; use REST for version 2.

A captured step uses a server-issued invocation UUID as its `id` and optional `detail_ref`. Provider call IDs may repeat and are not detail identities. Missing or ambiguous correlation omits the reference. Fetch one invocation with either authorized route:

- `GET /v1/me/office/conversations/:id/activity/:invocationId` for the external Office facade.
- `GET /v1/dashboard-agent/conversations/:id/activity/:invocationId` for the website protocol.

The standalone response is `OfficeActivityDetails` with its own `version: 1`:

```ts
type OfficeActivityDetails = {
  version: 1;
  invocation_id: string; // UUID from detail_ref
  provider_call_id: string | null;
  tool_name: string;
  action?: string;
  input: OfficeToolValuePreview;
  result: OfficeToolValuePreview;
  input_observed_at: string | null;
  result_observed_at: string | null;
  result_phase: 'tool_result' | 'approval_resolution' | null;
  result_status: 'running' | 'completed' | 'failed' | 'awaiting_approval' |
    'denied' | 'interrupted' | 'unknown' | null;
};
type OfficeToolValuePreview = {
  state: 'available' | 'pending' | 'unavailable';
  format: 'json' | 'text';
  text?: string; // only when available; json text is valid JSON
  redacted: boolean;
  truncated: boolean;
  reason?: 'not_recorded' | 'not_executed' | 'sensitive' |
    'unsupported' | 'too_large' | 'capture_failed';
};
```

Both routes check current authentication, exact organization and initiating-user conversation ownership before lookup, with the existing key/revocation restrictions. Unknown or inaccessible conversations/invocations return 404 under those restrictions; captured invocations with missing phases return typed pending/unavailable previews. No public-demo route is provided. A stored reference grants no authority.

These are latest recorded details, with observation timestamps. A final authoritative approval resolution is separate from the original pending receipt; `result_phase` and `result_status` distinguish it. Replay retains the event's original status. A receipt is not proof of execution, and a transient approval failure that leaves the gate pending is not a final resolution. Exact `false`, `0`, `""`, `null`, `[]` and `{}` remain distinct from missing results. Submitted field names are retained where policy permits; for example a tool's `q` is not relabeled to its HTTP adapter's `query`.

Only captured, sanitized values are stored and served. Credential aliases, environment values, signed/credential-bearing URLs, unreviewed code/SQL/logs/HTML/media and opaque or unknown values are withheld. Unclassified business-row columns are withheld too; a field's presence does not classify its value as safe. Reviewed structured fields may remain alongside explicit omission markers. Safe URL metadata never becomes a clickable capability link. Display `text` as escaped text, never HTML or executable content. No raw export or transcript backfill exists. Old steps without a reference show **Details were not recorded for this step.**

Limits per preview: 4,096 UTF-8 bytes of formatted text and 12,288 bytes of serialized envelope; processing stops at 65,536 input bytes, 2,048 nodes, depth 6, 50 object entries or 20 array entries. A server run records at most 512 invocation UUIDs, with at most eight durable reference entries per invocation. Optional capture failure must not fail or repeat business work. The website fetches on disclosure expansion, refreshes on observed status changes, fences stale reads and caches at most 32 entries in the selected conversation. Retry, refresh and layout changes only read details; they never submit another Ask.

Apply additive control-plane `150_office_tool_activity_previews.sql` before upgrading capture/readers, then upgrade customer Office and docs. Existing migrations `146_office_turn_evidence.sql` and `149_agent_model_preferences.sql` remain prerequisites for the corresponding application features. The two new tables are `office_tool_activity_invocations` and `office_tool_activity_previews`; deletion of their source user row/conversation cascades, including regeneration. Application rollback retains additive tables. No new environment variable, model call or metering change is introduced.

### Website conversation protocol

The website's separate assistant protocol accepts `activity_version: 1` or `activity_version: 2` in `POST /v1/dashboard-agent/messages` and `activity_version=1&limit=100` or `activity_version=2&limit=100` on `GET /v1/dashboard-agent/conversations/:id`. The optional history limit is 1–100, default 25. These requests retain their existing user, organization and conversation authorization. Website conversations are not adopted into external client execution.

Opted-in website streams replace raw tool calls/results with `{type: "activity", step}` observations and retain answer/lifecycle events. History returns safe prose messages, grouped `activity`, and `turns: [{user_message_id, outcome, final_answer_id}]`. Website outcomes are `running`, `completed`, `awaiting_approval`, `failed`, `interrupted` or `unknown`; only a runtime-recorded completed outcome with its exact final assistant row establishes a final answer. Older unrecorded history remains unknown. A process crash can leave the last observed running state. History is bounded, so a final answer outside the loaded window cannot establish completion in that view. Omit the opt-in to retain the existing protocol.

Self-hosters must apply additive control-plane migration `146_office_turn_evidence.sql` before upgrading the control API. It adds website turn evidence without backfilling old conversations; rolling back application code can leave the extra table in place.

## Model preferences

Signed-in people can choose a personal default in Dashboard Settings or Office
Settings → Conversation defaults. It applies to new chats in both products. Office's
message-bar picker changes only the current conversation, including a choice before
the first message. New conversation starts from the personal default again. Each
saved conversation retains its chosen model; changing the personal default does not
rewrite existing conversations.

Organization owners can separately choose the model for scheduled/event-driven
Office checks and skill runs in Office Settings → Office background model or Dashboard
organization settings. Members can read that setting. The next admitted run uses
the organization choice; personal chat preferences do not control background work.

These website settings use authenticated JWT requests:

| Endpoint | Purpose |
| --- | --- |
| `GET/PATCH /v1/dashboard-agent/preferences` | Signed-in person's chat default |
| `GET/PATCH /v1/dashboard-agent/operator/model` | Active organization's background model; PATCH requires an owner |
| `PATCH /v1/dashboard-agent/conversations/:id` | Set the owned conversation's model |

The organization and Office conversation requests require the matching
`x-organization-id` header. Preference PATCH bodies use `{ "model": "provider/model" }`;
`{ "model": null }` resets a personal/organization preference to the platform
default. Conversation PATCH requires a nonempty model ID. Preference responses
contain `model`, `effective_model`, and `platform_default_model`. Personal and
organization preference choices are validated against the chat catalog. API keys cannot access the personal or
organization preference endpoints. These routes are separate from the Office
MCP/CLI/SDK facade; their action counts and existing request shapes are unchanged.

Self-hosters must apply additive control migration
`149_agent_model_preferences.sql` before upgrading. Both defaults fall back to
`deepseek/deepseek-v4.1-flash`. `DASHBOARD_ASSISTANT_MODEL` configures the new-chat
platform fallback; `OPERATOR_MODEL` configures the organization background
fallback. Saved choices take precedence. The Dashboard's initial picker fallback
may use `VITE_ASSISTANT_MODEL` at build time. Settings reads and saves make no
model call.

## Errors and policy

New facade errors use `{error: {code,message,decision?,history?}}`. Codes distinguish authorization (`owner_required`, `managed_credential_forbidden`, `credential_revoked`), eligibility/work gates (`paid_plan_required`, `account_suspended`, `credits_required`, `paused_by_owner`, `credential_repair_required`), admission/retry conflicts (`idempotency_conflict`, `conversation_busy`, `conversation_awaiting_approval`, `conversation_not_client_owned`), confirmation drift/expiry, policy conflicts, interrupted work and expired replay. For `conversation_not_client_owned`, create a new conversation through an Office client or omit `conversation_id` on the first Ask; existing website conversations are not adopted for client execution.

Native memory writes return the real `action_id`, `verdict`, saved `result` when executed, and a source-aware pending `decision` when approval is required. Office approval uses the saved native capability and payload and checks policy again under its action lock. It cannot override unresolved conflicts or a changed principle. No duplicate memory store or alternate policy engine is introduced.
