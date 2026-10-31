---
title: Office from MCP, CLI and SDK
description: Ask Office and work with organization decisions and business memory from external clients.
sidebar:
  order: 10
---

Office has one organization-scoped API across the Butterbase MCP server, CLI and TypeScript SDK. Select an organization explicitly. These clients use a platform credential; they do not use an app ID or app end-user session.

## Commands and methods

MCP exposes one cloud tool, `manage_office`, with `org_id` on every call. Prefix every CLI command below with `butterbase office` and supply `--org <uuid>`. Every command supports `--json`.

| MCP action | CLI command | OfficeClient method |
| --- | --- | --- |
| `status` | `status` | `getStatus()` |
| `enable` | `enable` | `enable(options?)` |
| `pause` | `pause` | `pause(options?)` |
| `resume` | `resume` | `resume(options?)` |
| `list_decisions` | `decisions list` | `decisions.list(options?)` |
| `get_decision` | `decisions get <id>` | `decisions.get(ref)` |
| `get_decision_context` | `decisions context <id>` | `decisions.getContext(ref, options?)` |
| `approve` | `decisions approve <id>` | `decisions.approve(ref, options?)` |
| `deny` | `decisions deny <id> --reason <text>` | `decisions.deny(ref, {reason})` |
| `create_conversation` | `conversations create` | `conversations.create(options?)` |
| `list_conversations` | `conversations list` | `conversations.list(options?)` |
| `get_conversation` | `conversations get <id>` | `conversations.get(id, options?)` |
| `ask` | `ask <message>` | `ask(message, options?)` |
| `list_memory` | `memory list` | `memory.list(options?)` |
| `search_memory` | `memory search <query>` | `memory.search(query, options?)` |
| `get_source_artifact` | `memory source get <id>` | `memory.getSourceArtifact(id)` |
| `record_decision` | `memory record-decision --file <json>` | `memory.recordDecision(input, options?)` |
| `record_commitment` | `memory record-commitment --file <json>` | `memory.recordCommitment(input, options?)` |
| `record_learning` | `memory record-learning --file <json>` | `memory.recordLearning(input, options?)` |
| `list_principles` | `principles list` | `principles.list(options?)` |
| `get_principle` | `principles get <id>` | `principles.get(id)` |
| `record_principle` | `principles record --file <json>` | `principles.record(input, options?)` |
| `list_agent_memories` | `agent-memories list` | `agentMemories.list(options?)` |
| `search_agent_memories` | `agent-memories search <query>` | `agentMemories.search(query, options?)` |
| `get_agent_memory` | `agent-memories get <id>` | `agentMemories.get(id)` |
| `record_agent_memory` | `agent-memories record --file <json>` | `agentMemories.record(input, options?)` |
| `amend_agent_memory` | `agent-memories amend --file <json>` | `agentMemories.amend(input, options?)` |
| `archive_agent_memory` | `agent-memories archive --file <json>` | `agentMemories.archive(input, options?)` |
| `list_skills` | `skills list` | `skills.list(options?)` |
| `get_skill` | `skills get <id>` | `skills.get(id)` |
| `list_skill_versions` | `skills versions <id>` | `skills.versions(id, options?)` |
| `list_skill_runs` | `skills runs <id>` | `skills.runs(id, options?)` |
| `draft_skill` | `skills draft <message>` | `skills.draft(message, {skillId?}, options?)` |
| `test_skill` | `skills test <id> <version>` | `skills.test(id, version, options?)` |
| `reject_skill` | `skills reject <id> <version> --reason <text>` | `skills.reject(id, version, reason, options?)` |
| `approve_skill` | `skills approve <id> <version>` | `skills.approve(id, version, options?)` |
| `set_skill_enabled` | `skills set-enabled <id> <true|false>` | `skills.setEnabled(id, enabled, options?)` |
| `rollback_skill` | `skills rollback <id> <version>` | `skills.rollback(id, version, options?)` |
| `run_skill` | `skills run <id>` | `skills.run(id, options?)` |
| `amend_principle` | `principles amend --file <json>` | `principles.amend(input, options?)` |
| `retire_principle` | `principles retire --file <json>` | `principles.retire(input, options?)` |
| `get_office_settings` | `settings get` | `settings.get()` |
| `update_office_settings` | `settings update <minutes> --expected-revision <n>` | `settings.update(minutes, revision, options?)` |
| `list_office_records` | `records list <resource>` | `records.list(resource, options?)` |

Decisions have a source: `{source: "office" | "substrate", id}`. CLI decision commands accept `--source office|substrate` (default `office`); MCP uses `decision_source` and `decision_id`. An explicit bridge between an Office decision and native action has one canonical entry in the decision list.

## Confirm one saved action

Enable, pause, resume and approval first return a receipt with `state: "awaiting_confirmation"`, `confirmation_id`, `confirmation_url` and `expires_at`. Open that URL and sign in as the initiating owner. The page shows the organization and exact saved change. Confirm authorizes that change and reports its execution outcome. Cancel rejects this receipt; it does not deny the underlying decision. Closing the tab leaves it pending.

```sh
butterbase office enable --org <uuid> --json
butterbase office decisions approve <id> --source substrate --org <uuid> --open --wait
butterbase office status --confirmation <confirmation-id> --org <uuid> --json
```

`--open` is opt-in. If no browser is available, use the printed URL. Poll using SDK `getConfirmation(id)` / `waitForConfirmation(id, {timeoutMs, signal})`, MCP `status` with `confirmation_id`, or CLI `status --confirmation`. A pending receipt is accepted work, not completed execution. `executing` and `outcome_unknown` must be inspected before another action is requested. Never replay a potentially executed action merely because observation timed out.

Confirmation normally expires after ten minutes. The same initiating user must still own the organization; the initiating key, membership and entitlement are rechecked. Browser resolution requires the person's signed-in JWT. An API key cannot resolve the browser confirmation, and approval does not grant an agent standing authority.

## Ask once, then observe

```ts
import { OfficeClient } from '@butterbase/sdk';

const office = new OfficeClient({
  apiUrl: 'https://api.butterbase.ai',
  organizationId,
  getToken: () => platformCredential,
});
const result = await office.ask('What should we follow up from the meeting?', {
  idempotencyKey: requestId,
  waitMs: 15000,
});
if (result.error) throw result.error;
// Keep both IDs even when state is running or awaiting_approval.
const turn = result.data!;
const history = await office.conversations.get(turn.conversation_id, {turnId: turn.turn_id});
```

The bounded wait defaults to 15 seconds and cannot exceed 25 seconds. A running response may contain partial output. Poll the exact conversation and turn; do not send another Ask to check progress. Conversations belong to the initiating user and organization and have Office origin. One running or approval-suspended turn may be open per conversation.

Create a conversation through an Office client, or omit its ID on the first Ask. Client conversations use durable turn coordination and must be continued through MCP, CLI or SDK. Existing website conversations cannot be adopted for client Ask (`conversation_not_client_owned`); start a new client conversation. The website can read client history and decline a pending decision, but client approvals require the guarded browser-confirmation link. Declining never automatically starts another model turn.

`askStream(message, options)` submits one question and yields typed public events. To observe an already admitted turn, use `askStream('', {conversationId, turnId, afterSequence})`; this sends only a GET. Stream errors include `conversationId`, `turnId` and `lastSequence` for inspection or replay. Replayed events include a saved approval resolution without starting another model call.

```sh
butterbase office ask "Summarize the meeting" --org <uuid> --stream
butterbase office ask --org <uuid> --stream --conversation <id> --turn <id> --after-sequence 4
butterbase office conversations get <id> --turn <id> --org <uuid> --json
```

Disconnect, SIGINT or AbortSignal stops observation. It does not cancel admitted server work. Running work has a five-minute execution ceiling and durable interruption state; it is not a resumable background job. `awaiting_approval` has no running lease. Resolving that saved decision does not automatically run the model again. Event replay expires after 24 hours; `events_expired` includes exact history pointers, and the conversation/turn remains readable.

## Business memory and access

Curated agent context has its own `agentMemories` namespace and `agent-memories` CLI group. An entry contains `title` (up to 160 characters), `relevance_summary` (320), `body` (16000), `capture_origin` and optional source references. Lists and searches return summaries; `get` returns the full body and saved evidence. Amend/archive require `memory_id` and `expected_revision`. The shared corpus belongs to the organization; private per-person memory is not available. Memory never grants permissions or replaces enforced rules. Default agent retrieval uses only curated context; other business categories require an explicit read. Repeated exact active captures reuse the entry without silently merging evidence.

Skill detail, versions and runs are independent page reads. API clients see approved content and non-test runs; signed-in owners inspect private drafts/tests in Office. Draft returns one Ask turn to observe. Test pins one read-only run. Reject preserves a reason. Approve, enable/disable, rollback and run prepare owner browser confirmations. Rule amendments and retirements always propose native approval-required actions. Their previews show saved current/requested facts; a changed target invalidates review.

Routine interval settings accept 10, 15, 30 or 60 minutes and require the current `revision` when updating. The update returns a confirmation and never resumes paused work. Every-loop skills follow each admitted full timer or event sweep, within one shared ten-minute cycle budget. Unchanged checks, Ask, tests, manual/scheduled skills and recovery-only turns do not create loops. Extra skill runs can spend credits.

`records.list` reads `entities`, `business_memory`, `source_artifacts`, `actions`, `principles`, `skills`, `skill_versions` or `skill_runs`; the two histories require `skillId` (MCP `skill_id`, CLI `--skill`). Optional `kind` and `status` filters depend on the resource. Pages default to 25 and allow at most 100. Continue `next_cursor` with identical organization, resource and filters. New page cursors bind a traversal cutoff and stable timestamp/ID ordering; they do not guarantee a transaction-wide snapshot. Existing memory/decision endpoints preserve their prior cursor contracts. Loaded counts are not total counts.

Memory uses the existing Substrate ledger and readers. Native payloads are validated rather than copied into another store. For example:

```json
{"title":"Prefer written follow-ups","description":"Keep the source evidence with each commitment."}
```

Pass this as MCP `record_learning.payload`, SDK `memory.recordLearning(input)`, or a JSON file to CLI `memory record-learning --file`. Decision payloads require `title` and `kind`; commitments require `description` and `status`; principles require `title`, `applies_to` and `constraint_spec`. Optional source artifacts and entity references must belong to this organization. The SDK exports the four `OfficeRecord*Input` types.

Principles remain native proposals requiring approval. Confirmation cannot override unresolved or newly discovered principle conflicts; resolve them through the existing audited policy workflow. Lists expose `next_cursor`; CLI lists accept `--cursor` and `--limit`. Search returns a bounded `items` result with no continuation cursor. Memory and principle cursors preserve full timestamp precision and include record IDs (plus source kind for mixed memory), so tied timestamps do not omit records. Treat cursors as opaque and reuse them with the same organization and filters.

Current members can read and deny saved decisions while Office is paused, unfunded or ineligible. New Ask, conversation creation and memory writes require the current owner and active paid access. Managed background keys cannot mutate through these external client APIs. Browser approval is always bound to the initiating owner.

## Retry and output contract

Enable/pause/resume/approve, Ask, conversation creation and memory/principle recording use idempotency keys. For these actions, the SDK generates one key per intended write and reuses it for a safe network retry. Supply `idempotencyKey` to retry across invocations; failed keyed-write errors retain the generated key. MCP requires `idempotency_key`; CLI accepts `--idempotency-key`. Reusing a key with changed input returns `idempotency_conflict`. Denial addresses an existing decision and accepts no idempotency key; inspect its saved state before retrying.

SDK requests return `{data, error}`. Waiting may return the last receipt in `data` alongside an `observation_timeout` error. CLI JSON output is one `{data,error}` value; diagnostics go to stderr. `--json --stream` collects public events into that single final result; ordinary streaming prints text as it arrives.

CLI exits: **0** accepted/read, including pending confirmation; **1** request or terminal failure, rejected/expired/unknown receipt, observation timeout or interruption; **2** usage/input error. The [Office HTTP reference](/api-reference/office-api/) describes the REST and event contracts.
