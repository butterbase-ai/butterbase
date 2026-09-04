---
date: 2026-06-05
status: draft
owner: kenneth
topic: workspace-ai-agent
---

# Workspace AI Agent (onboarding + persistent copilot)

## 1. Goal

Add a workspace-aware AI agent to butterbaseCRM that:

1. **Drives onboarding** for a brand-new user: interviews them about their sales/relationship workflow AND drives integration-linking + initial data import in the same conversation.
2. **Sticks around as a persistent copilot** in a right-side drawer that's accessible from anywhere in the app. The copilot can read the entire workspace (RLS-enforced), reference what the user is currently looking at, and propose changes the user approves inline.

The agent never silently mutates CRM data. Reads run inline; writes are *proposals only*. The user approves each write via a card rendered in chat.

## 2. Architecture

```
   Browser (Vite/React SPA)             Butterbase platform
  ┌──────────────────────────┐         ┌─────────────────────────────┐
  │ AgentOnboarding page     │         │ POST /fn/agent-chat (SSE)   │
  │  (replaces /onboard)     │ ──POST──▶  - end-user JWT             │
  │ AgentDrawer (post-       │  SSE    │  - tool-use loop            │
  │  onboarding right sheet) │ ◀─────  │  - read tools: inline SQL   │
  │                          │         │  - write tools: INSERT      │
  │  ProposalCard inline     │         │      agent_proposals row    │
  │   ┌─ Approve ─┐          │         │  - emits SSE events         │
  │   └─ Reject  ─┘          │ ──REST─▶│  Existing CRM REST API      │
  │                          │ (Approve)│  (/companies, /people, etc) │
  │  Realtime subscribers:   │ ◀──WS── │  Realtime on:               │
  │   agent_messages,        │         │   agent_messages,           │
  │   agent_proposals        │         │   agent_proposals           │
  └──────────────────────────┘         │                             │
                                       │  ctx.kv  firstrun:{ws}:{usr}│
                                       │          agent_budget:...   │
                                       │          agent_thread_lock  │
                                       │  ctx.substrate (memory)     │
                                       └─────────────────────────────┘
```

Key invariants:

- **The agent loop never mutates CRM data.** Reads are inline `ctx.db.query` calls under the caller's JWT (`butterbase_user`, RLS enforced). Writes only INSERT into `agent_proposals`. The actual mutation happens client-side after Approve, against the existing RLS-enforced REST API.
- **One function, `agent-chat`,** holds the entire tool-use loop. Streams Server-Sent Events to the browser. Same function powers both onboarding and copilot — differentiated only by `mode` and system-prompt preset.
- **Memory has two layers:**
  - **Thread/messages** in the CRM database (RLS-scoped to the thread owner).
  - **Long-lived user facts** in **substrate** via `ctx.substrate.propose('record_decision', ...)` and recalled via `ctx.substrate.searchMemory(...)`.
- **Onboarding** is a full-screen variant of the same chat UI mounted at `/onboard`. Post-onboarding the same components mount inside the drawer. Same backend, same tools, different shell and different system-prompt preset.

## 3. Schema additions (3 new tables)

All three are workspace-scoped and RLS-enforced. They follow the existing project conventions: `gen_random_uuid()` PKs, `workspace_id` FK with `ON DELETE CASCADE`, `user_id` as a plain `uuid` (no FK — auth users live outside the app DB), SQL-quoted string defaults (`"default": "'pending'"`).

### `agent_threads`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `workspace_id` | `uuid` not null | FK → workspaces, ON DELETE CASCADE |
| `user_id` | `uuid` not null | Thread owner |
| `title` | `text` | Nullable; the agent fills it after turn 1 |
| `mode` | `text` not null default `'copilot'` | `'onboarding'` or `'copilot'` |
| `status` | `text` not null default `'active'` | `'active'` or `'archived'` |
| `last_message_at` | `timestamptz` not null default `now()` | |
| `created_at` | `timestamptz` not null default `now()` | |
| `updated_at` | `timestamptz` not null default `now()` | |

Index: `agent_threads_ws_user_idx (workspace_id, user_id, last_message_at desc)`.

### `agent_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `thread_id` | `uuid` not null | FK → agent_threads, ON DELETE CASCADE |
| `workspace_id` | `uuid` not null | Denormalized for RLS-perf |
| `role` | `text` not null | `'user'` \| `'assistant'` \| `'tool'` \| `'system_event'` |
| `content` | `text` | Natural-language text for `user`/`assistant` turns |
| `tool_calls` | `jsonb` | Assistant turn: `[{id, name, args}]` |
| `tool_results` | `jsonb` | Tool turn: `{tool_call_id, result \| error}` |
| `ui_event` | `jsonb` | System-event turn: `{kind, payload}` |
| `token_usage` | `jsonb` | `{input, output, model}` |
| `created_at` | `timestamptz` not null default `now()` | |

Index: `agent_messages_thread_created_idx (thread_id, created_at)`.

### `agent_proposals`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `thread_id` | `uuid` not null | FK → agent_threads, ON DELETE CASCADE |
| `workspace_id` | `uuid` not null | |
| `proposed_by` | `uuid` not null | Always equals the thread owner |
| `tool_name` | `text` not null | e.g. `'propose_create_company'` |
| `payload` | `jsonb` not null | Prefilled fields the user can edit |
| `rationale` | `text` | One-line agent justification |
| `status` | `text` not null default `'pending'` | `'pending'` \| `'approved'` \| `'rejected'` \| `'expired'` |
| `resolution` | `jsonb` | Approve: `{created_id, edited_payload}`; Reject: `{reason?}` |
| `resolved_at` | `timestamptz` | |
| `expires_at` | `timestamptz` not null default `now() + interval '24 hours'` | |
| `created_at` | `timestamptz` not null default `now()` | |

Indexes:
- `agent_proposals_thread_idx (thread_id, created_at desc)`
- `agent_proposals_ws_status_idx (workspace_id, status, created_at desc)`

### RLS policies (same workspace-membership predicate as the rest of the schema)

All three tables use `current_user_id()::uuid` with the explicit cast (per the README gotcha).

- `agent_threads`: SELECT/INSERT/UPDATE/DELETE allowed when `user_id = current_user_id()::uuid` AND the caller is a member of `workspace_id`. Threads are **per-user, not per-workspace** — teammates don't see each other's conversations.
- `agent_messages`: SELECT/INSERT allowed when the parent thread's `user_id = current_user_id()::uuid`. The `agent-chat` function (running as `butterbase_user` under the caller's JWT) inserts assistant + tool turns under the caller's identity — fine because the JWT subject *is* the thread owner. No UPDATE/DELETE from the client.
- `agent_proposals`: SELECT/INSERT allowed when the parent thread's `user_id = current_user_id()::uuid`. UPDATE is constrained to the columns `{status, resolution, resolved_at}` and only when transitioning from `status='pending'`. INSERT comes from inside the agent function; UPDATE comes from the client (Approve/Reject) and the cron sweeper.

### Realtime broadcast list

Add `agent_messages` and `agent_proposals` to the existing realtime configuration. `agent_threads` does not need realtime — the drawer refetches threads explicitly when it opens.

### Non-table state

- `ctx.kv` keys:
  - `firstrun:{workspace_id}:{user_id}` = `'1'` once the agent's `mark_onboarded` tool flips it. Read by the post-onboarding code path to decide whether to keep showing the welcome shell.
  - `agent_thread_lock:{thread_id}` — `setnx` with 130s TTL guards against two-tabs concurrent chat on the same thread.
  - `agent_budget:{user_id}:{yyyy-mm-dd}` — daily token-budget counter, default 200k input + 100k output.
- `ctx.substrate`:
  - `propose('record_decision', ...)` for the `remember_fact` conversational tool.
  - `searchMemory(...)` for the `search_substrate_memory` read tool.
  - `findEntities(...)` powers the substrate-import flow.

## 4. Tool catalog (29 tools across 5 categories)

All tool schemas are JSON-Schema definitions passed to the AI gateway with each `chat/completions` call. Tool names appear verbatim in the LLM contract.

### Read tools (inline; RLS-enforced via the caller's JWT)

| Tool | Inputs | Behavior |
|---|---|---|
| `search_workspace` | `query: string, scope?: 'all'\|'companies'\|'people'\|'deals'` | Reuses the `ai-search` function's whitelisted-spec pattern: LLM emits a filter spec, the server validates and runs SELECT, returns ≤25 rows. |
| `get_company` | `company_id: uuid` | Company row + 5 latest notes + open deals + 10 latest activities. Same bundle `summarize-company` already constructs. |
| `get_person` | `person_id: uuid` | Person row + their company + deals where they're the primary contact. |
| `get_deal` | `deal_id: uuid` | Deal row + company + primary person + meetings + notes. |
| `list_recent_activity` | `limit?: number, entity_type?: text, entity_id?: uuid` | Reads `activities`, ordered by `created_at` desc. |
| `list_meetings` | `from?: timestamptz, to?: timestamptz, scope?: 'mine'\|'all'` | Upcoming/recent meetings, optionally restricted to ones the caller attends. |
| `get_pipeline_summary` | none | Per-stage `COUNT(*)` and `SUM(amount_cents)` over `deals` in the current workspace. |
| `list_integrations` | none | Wraps `GET /v1/{app}/integrations/connections` for the caller. Tells the agent which providers are linked. |
| `search_substrate_memory` | `query: string, kinds?: string[], limit?: number` | `ctx.substrate.searchMemory(...)`. `kinds` may include `'entities'`, which folds in `findEntities` results. |

### Conversational tools (no DB side-effect; emit SSE `ui_event`s)

| Tool | Inputs | Behavior |
|---|---|---|
| `ask_user` | `question: string, options?: {label, value}[], allow_free_text?: boolean` | Emits a `ui_event` of kind `'ask_user'`. Frontend renders a structured question card. The user's reply becomes the next user turn. |
| `suggest_next_step` | `label: string, action: { type: 'navigate'\|'open_proposal'\|'link_account', params: any }` | Renders a clickable chip for a quick follow-up. |
| `remember_fact` | `kind: 'preference'\|'goal'\|'process_note', summary: string, rationale?: string` | Calls `ctx.substrate.propose('record_decision', {kind:'operational', title:summary, rationale})`. Memory writes are auto-approved by substrate. |

### Write tools (proposal-only; each INSERTs an `agent_proposals` row)

Each emits a `proposal_created` SSE event so the frontend renders the card immediately, plus the row is durable for tab-switches / reloads.

| Tool | Inputs | On Approve, frontend calls |
|---|---|---|
| `propose_create_company` | `name, domain?, industry?, location?, employee_count?, description?` | `POST /companies` (auto REST) |
| `propose_create_person` | `first_name?, last_name?, email?, company_id?, title?, phone?, linkedin_url?` | `POST /people` |
| `propose_create_deal` | `name, company_id?, primary_person_id?, stage?, amount_cents?, currency?, close_date?` | `POST /deals` |
| `propose_update_deal_stage` | `deal_id, stage` | `PATCH /deals/:id` |
| `propose_add_note` | `entity_type, entity_id, body` | `POST /notes` |
| `propose_invite_member` | `email, role: 'member'\|'admin'` | `POST /fn/invite-member` (existing) |

### Action tools (external side-effects; gated by user click; no proposal row)

| Tool | Inputs | Behavior |
|---|---|---|
| `suggest_link_account` | `provider: 'gmail'\|'google-calendar', reason: string` | Emits `ui_event` kind `'suggest_link_account'`. Click → `bb.integrations.connect(provider, {redirectUrl})` (OAuth in popup). On callback the drawer posts a `system_event` "connected" turn so the agent can continue. |
| `trigger_gmail_ingest` | `lookback_days?: number` | `ui_event` kind `'confirm_action'`. On Approve → `POST /fn/ingest-gmail`. |
| `trigger_calendar_ingest` | `lookback_days?, lookahead_days?` | Same shape → `POST /fn/ingest-calendar`. |
| `import_from_substrate` | `entity_type: 'company'\|'person', substrate_entity_id: string` | Confirm-card → `POST /fn/import-from-substrate` (existing). |
| `mark_onboarded` | none | Sets `firstrun:{ws}:{user}` in `ctx.kv` and emits a `ui_event` kind `'onboarding_complete'` so the frontend can navigate to `/companies`. |

### Enrichment & AI wrappers (read-ish, but cost AI credits — confirm-gated)

| Tool | Inputs | Behavior on Approve |
|---|---|---|
| `enrich_company` | `company_id` | `POST /fn/enrich-company` |
| `enrich_person` | `person_id` | `POST /fn/enrich-person` |
| `summarize_company` | `company_id` | `POST /fn/summarize-company` |
| `brief_meeting` | `meeting_id` | `POST /fn/brief-meeting` |
| `find_duplicates` | `scope: 'companies'\|'people'` | `POST /fn/find-duplicates` |
| `propose_deals` | none | `POST /fn/propose-deals` (uses the existing accept-deal-proposal pattern) |

### Explicit non-tools (cut from v1)

- `propose_schedule_meeting` — kanban interactions matter more than agent scheduling.
- `list_team_members` — depends on the deferred RLS-widening noted in `02-plan.md` for memberships SELECT.
- `find_substrate_entities` as a separate tool — folded into `search_substrate_memory` with `kinds: ['entities']`.

### Tool-execution rules

1. **Reads are silent.** The agent calls read tools freely without telling the user "I'm searching." Only the final natural-language reply is rendered. (Optional collapsible "what I looked at" disclosure for debugging — implementation choice in §5, not contractual.)
2. **Every other category renders a card.** Proposals show editable fields and Approve/Reject. Actions show a button. Confirm-gated enrichments show a Run button. No silent writes, no silent external calls.

## 5. `agent-chat` function contract

Single deployed function. Trigger: `http`. Auth: end-user JWT required (runs as `butterbase_user`). Timeout: `120000` ms. Memory: `256` MB. Env: `BUTTERBASE_API_KEY` (for the AI gateway, like the other AI functions).

### Request

```
POST /v1/{app}/fn/agent-chat
Authorization: Bearer <user-jwt>
Content-Type: application/json
Accept: text/event-stream

{
  "thread_id": "uuid" | null,        // null → create a new thread
  "workspace_id": "uuid",            // required when creating; ignored when continuing
  "mode": "onboarding" | "copilot",  // only meaningful at thread creation
  "user_message": "string",          // the user turn that triggers this call
  "client_context": {                // optional; sent every call
    "route": "/companies/abc-123",
    "entity": { "type": "company", "id": "abc-123" } | null
  }
}
```

### Response — Server-Sent Events

Content-Type: `text/event-stream`. Each event is one JSON object on a `data:` line, with an `event:` field naming the kind.

| `event:` | Payload | Meaning |
|---|---|---|
| `thread` | `{ thread_id, mode }` | First event when a new thread was created. |
| `user_message_id` | `{ id }` | The persisted user turn's id. |
| `assistant_start` | `{ message_id }` | Beginning of an assistant turn. |
| `assistant_delta` | `{ text }` | Token chunk; frontend appends to current bubble. |
| `tool_call_start` | `{ tool_call_id, name, args }` | Agent invoked a tool. |
| `tool_call_done` | `{ tool_call_id, ok, summary, error? }` | Tool returned. `summary` is a short UI label ("Found 12 companies"). |
| `ui_event` | `{ kind, payload }` | One of `'ask_user'`, `'suggest_link_account'`, `'suggest_next_step'`, `'confirm_action'`, `'onboarding_complete'`. |
| `proposal_created` | `{ proposal_id, tool_name, payload, rationale }` | A write tool produced a proposal row. |
| `assistant_end` | `{ message_id, token_usage }` | Assistant turn complete (`stop_reason = end_turn`). |
| `error` | `{ code, message }` | Fatal error. Stream ends. |
| `done` | `{}` | Final event. Stream closes. |

### Turn lifecycle

```
1. Validate JWT → ctx.user. Reject 401 if absent.
2. If thread_id is null:
     - INSERT agent_threads(workspace_id, user_id=ctx.user.id, mode).
     - Emit `thread`.
   Else load thread; rely on RLS to enforce thread.user_id === ctx.user.id (zero rows → 404).
3. KV setnx agent_thread_lock:{thread_id} with 130s TTL.
     - If false → 409 thread_busy.
4. KV check + increment agent_budget:{user_id}:{yyyy-mm-dd}.
     - Over budget → 429 budget_exceeded; release lock.
5. INSERT user message → emit user_message_id.
6. Build LLM context:
     - system prompt (mode-aware preset; see below)
     - last N messages from agent_messages (default N=40, trimmed by token budget)
     - client_context block
     - tool definitions (the 29 from §4 as JSON schema)
7. Call POST /v1/{app}/chat/completions with stream=true, model='anthropic/claude-haiku-4.5', tools=[...].
8. Begin assistant message buffer. INSERT placeholder agent_messages row; emit assistant_start.
9. As SSE chunks arrive from the gateway:
     - text deltas → emit assistant_delta, append to buffer
     - tool_use blocks → for each:
         a. emit tool_call_start
         b. dispatch by name (read = inline ctx.db; conversational = emit ui_event;
            write = INSERT agent_proposals + emit proposal_created;
            action/enrichment = emit ui_event of kind 'confirm_action')
         c. INSERT a tool turn into agent_messages with tool_results
         d. emit tool_call_done
     - stop_reason='tool_use' → append tool_result blocks to messages; loop from step 7
     - stop_reason='end_turn' → finalize buffered assistant message row; emit assistant_end
10. Emit done. Close stream. Release thread lock.
11. Cap: max 8 tool-use iterations per request. After that, force a final natural-language response and stop.
```

### Synthetic user turns

Three flows where the frontend re-invokes `agent-chat` *on behalf of the user* without literal typed input. Each is a normal POST with `user_message` containing a short canonical string (e.g. `"<approved proposal {id}>"`); the relevant `system_event` row was already inserted by the frontend so the prior turn the agent sees describes the outcome.

| Trigger | Synthetic user message |
|---|---|
| User answered an `ask_user` card | The chosen option's `label` (the `value` is stored on the message in `ui_event`). |
| User Approved a proposal | A `system_event` row goes into `agent_messages` ("Proposal X approved → created company id=…"), then a synthetic turn re-invokes the agent so it can react. |
| User connected a Gmail integration | Same shape: `system_event` row + synthetic trigger turn. |

### System prompt presets

**Onboarding:**
> You are the welcome agent for a CRM called butterbaseCRM. The workspace was just created and is empty. Your job is two things at once: (1) interview the user about their sales/relationship workflow — who they sell to, their pipeline stages, the cadence they want; (2) get real data into the workspace by suggesting they link Gmail and Calendar, importing entities from their substrate if any, and creating their first company/person/deal. Move fast, ask one question at a time, prefer `ask_user` with structured options over open-ended questions. Always call `remember_fact` for preferences worth keeping. End by calling `mark_onboarded` when the workspace has at least one company AND one of: linked integration, imported substrate entity, or first deal.

**Copilot:**
> You are a CRM copilot embedded inside butterbaseCRM. The user is on `{route}` looking at `{entity}` (if any). Be terse, do the work, surface what you find. Search the workspace freely. Propose writes; don't lecture. When the user asks "who…" / "what's the status of…" / "summarize…" prefer read tools + a short direct answer. When the user asks "create…" / "remind me…" / "log…" use the propose_* tool then briefly confirm.

Both are appended to a small shared "tool-use etiquette" block: cite which tool you used in 5 words max; never invent ids; if a read returns nothing, say so plainly.

### Error model

| Code | When | Effect |
|---|---|---|
| `unauthorized` | No `ctx.user` | 401 before stream starts |
| `thread_not_found` | thread_id present but not visible under RLS | 404 |
| `not_a_member` | Creating a thread in a workspace the user isn't in | 403 |
| `thread_busy` | KV lock already held | 409 |
| `budget_exceeded` | Over daily token budget | 429 with structured message |
| `ai_gateway_error` | Non-2xx from `/chat/completions` | `error` event + `done` |
| `tool_failed` | A tool threw | `tool_call_done.ok=false`; loop continues so the model can recover |
| `iteration_cap` | More than 8 tool loops | `assistant_end` with graceful summary message |
| `timeout_soft` | Approaching the 120s timeout | Same as iteration_cap: clean close |

### Cron sidecar

A second deployed function: **`agent-proposals-expire`**. Trigger: cron `*/30 * * * *`. Service-role. Body:

```sql
UPDATE agent_proposals
   SET status = 'expired', resolved_at = now()
 WHERE status = 'pending' AND expires_at < now();
```

Eliminates stale Approve buttons. No emit; the realtime broadcast on `agent_proposals` causes the frontend to refresh cards.

## 6. Frontend

### File layout (additions only)

```
frontend/src/
├── components/
│   ├── agent/
│   │   ├── AgentDrawer.tsx
│   │   ├── AgentChat.tsx
│   │   ├── MessageList.tsx
│   │   ├── AssistantBubble.tsx
│   │   ├── UserBubble.tsx
│   │   ├── ToolCallChip.tsx
│   │   ├── AskUserCard.tsx
│   │   ├── SuggestNextStepCard.tsx
│   │   ├── SuggestLinkAccountCard.tsx
│   │   ├── ConfirmActionCard.tsx
│   │   ├── ProposalCard.tsx
│   │   ├── AgentLauncher.tsx
│   │   └── ThreadList.tsx
├── pages/
│   └── AgentOnboarding.tsx                  # replaces Onboard.tsx in routes
├── hooks/
│   ├── useAgentStream.ts
│   ├── useAgentThreads.ts
│   ├── useAgentMessages.ts
│   ├── useAgentProposals.ts
│   └── useAgentRealtime.ts
└── lib/
    └── agent.ts                              # types, openAgentStream, proposal → endpoint map
```

### `useAgentStream` reducer (event → UI state)

```ts
type StreamState = {
  status: 'idle' | 'streaming' | 'done' | 'error';
  currentAssistantId: string | null;
  textBuffer: string;
  toolCalls: Record<string, { name: string; args: any; status: 'running'|'done'|'error'; summary?: string }>;
  uiEvents: UiEvent[];        // ephemeral; persisted ones come back via realtime
  proposalIds: string[];      // new this turn; cards fetched via useAgentProposals
  error: { code: string; message: string } | null;
};
```

The hook returns `{ state, send(userMessage) }`. `send` opens a `fetch(.../fn/agent-chat, { method:'POST', headers:{Accept:'text/event-stream'} })`, reads the body as a `ReadableStream`, splits on `\n\n`, dispatches events into the reducer. Aborts on unmount or drawer-close.

The SDK's `bb.functions.invoke` buffers the full response, so it can't be used here. `openAgentStream(body, jwt)` in `lib/agent.ts` is the thin raw-`fetch` wrapper.

### Realtime layering

Two channels reuse existing `lib/realtime.ts`:

1. `agent_messages` filtered by `thread_id` — keeps `MessageList` in sync across tabs.
2. `agent_proposals` filtered by `workspace_id` — drives the `AgentLauncher` unread badge AND inserts new cards into the thread view in real time. The Approve UPDATE fires a realtime event the drawer sees, and the drawer auto-sends the synthetic trigger turn from §5.

**Tiebreak rule:** realtime is the source of truth for persisted state; SSE drives in-flight UI. When both arrive for the same proposal, the realtime row wins on conflicts.

### `AgentLauncher` (in `Topbar.tsx`)

`<Sparkles>` icon + numeric badge counting `agent_proposals` rows where `status='pending'` AND the parent thread's `user_id` is the caller. Click → opens drawer with the most recent thread; first ever click → opens a fresh copilot thread. Shortcut: `⌘J` (the existing `AISearchDialog` is on `⌘K`; no collision).

### `AgentDrawer.tsx`

Fixed-position right sheet, ~440 px wide (resizable, persisted to localStorage per workspace). Header: thread title (editable), thread switcher (`ThreadList` popover), new-thread button, close. Body: `AgentChat`. Overlays the page without a backdrop — the user can keep clicking around.

### `AgentChat.tsx`

Shared core used by both `AgentDrawer` and `AgentOnboarding`. Props: `threadId | null`, `mode`, `clientContext`, `fullscreen?`. Fullscreen variant changes outer padding and shows a friendlier empty state. Same composer, same hook, same components.

### `AgentOnboarding.tsx` (replaces `Onboard.tsx`)

Two-step in-page flow (no second navigation):

1. **Pre-thread (~10s):** Small inline form — workspace name + slug — same logic as today's `Onboard.tsx`. On submit, create workspace + founding-owner membership using existing carve-out INSERT policies, then immediately render the agent UI underneath with a new thread in `mode: 'onboarding'` and a `client_context` saying "brand-new workspace named X." Vertical fade transition (~250 ms).
2. **Once the agent calls `mark_onboarded`,** the frontend listens for the `ui_event` of kind `'onboarding_complete'` and navigates to `/companies`.

`WorkspaceGuard`'s existing redirect to `/onboard` for memberless users stays unchanged.

### `ProposalCard.tsx`

```
┌─ rationale: "Acme appeared in 3 recent emails this week" ────┐
│  [icon] Create company                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ name        [ Acme Inc              ]                  │  │
│  │ domain      [ acme.com              ]                  │  │
│  │ industry    [ SaaS                  ]                  │  │
│  │ location    [ San Francisco, CA     ]                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                       [ Reject ] [ Approve ] │
└──────────────────────────────────────────────────────────────┘
```

**Approve:** PATCH `agent_proposals` (`status='approved'`, `resolution.edited_payload`) THEN POST to the right CRM endpoint with the edited payload. On success, PATCH again with `resolution.created_id`. On failure, revert proposal to `pending` and toast the error.

**Reject:** PATCH `agent_proposals` (`status='rejected'`). No CRM call.

**Expired:** rendered disabled with "Expired — ask the agent again."

The mapping `tool_name → endpoint + payload shape` lives in `lib/agent.ts`.

### State stores

No new Zustand stores beyond a tiny `useAgentUIStore` (drawer open/closed + last thread id) so other components can `openDrawer({ threadId? })` from anywhere. Everything else is React-local (`useAgentStream` reducer) or server state via tanstack-query.

## 7. Edge cases & error handling

### Stream interruption

- **Drawer closed mid-stream:** `useAgentStream` calls `AbortController.abort()`. Server detects the closed writer at the next iteration boundary and exits; partial assistant rows are kept. Reopening shows a faded "…interrupted" tag and a "Continue" inline button that sends an empty user turn.
- **Network drop:** same. No auto-resume; user clicks Continue.
- **Function timeout (120 s):** server emits `error{code:'timeout_soft'}` + `done`. Same Continue affordance.

### Concurrency

- **Same user, two tabs, one thread:** the KV `agent_thread_lock:{thread_id}` `setnx` blocks the second tab. The second tab toasts "Another tab is talking to the agent" and disables the composer until the lock clears (signaled via realtime `assistant_end`).
- **Iteration cap exhausted:** surfaced as a regular assistant turn ("I did a lot — what specifically should I tackle?"). Not an error.

### Proposal lifecycle edges

- **Approve, but the CRM POST fails:** revert proposal to `pending`, toast the error, keep the card editable.
- **Approve in tab A, second tab still showing the card:** tab B's Approve no-ops (status guard) and refreshes.
- **Approve races `expires_at`:** Approve PATCH uses `WHERE status='pending'`. Whichever lands first wins; the loser refreshes its card.
- **Proposal references a not-yet-existent entity:** soft warning on the card if a referenced FK id isn't present at click time. User can Reject or Approve-and-let-the-FK-fail-and-revert.

### Auth & RLS

- **Stale JWT at request start:** 401. Frontend calls `bb.auth.refreshSession()` and retries once.
- **User loses membership while a thread is open:** RLS starts returning empty for messages and proposals. The drawer shows "You no longer have access to this workspace."

### Cost guardrails

- Per-thread per-day token budget: 200k input + 100k output. Enforced via KV counter; over budget → 429.
- Confirm-gated AI tools render an estimated AI credit charge on the card. v1 estimates are hardcoded per tool.

### Privacy

- The system prompt explicitly states that reads are RLS-scoped to "what the current user can see," so the agent doesn't claim broader access.
- `client_context` is treated as an LLM hint only; the server never trusts it for permission checks.

### Observability

- Every turn writes `agent_messages.token_usage` for later cost queries.
- Tool failures land in the function's invocation logs via `console.error`.

## 8. Scope cuts (explicit non-goals for v1)

1. **No multi-user threads** — every thread is single-owner.
2. **No agent-initiated outbound** — no proactive pings, no scheduled briefings; the only background loop is `agent-proposals-expire`. Substrate attention-rules integration is post-v1.
3. **No voice or file attachments in chat.**
4. **No parallel tool calls** — if the model emits parallel `tool_use` blocks, we execute them sequentially and log it.
5. **No editing past messages / no forking threads** — append-only.
6. **No granular per-tool permissions** — every workspace member gets the same toolset; gating is via RLS at execution time.
7. **Cut tools:** `propose_schedule_meeting`, `list_team_members`, `find_substrate_entities` (folded into `search_substrate_memory`).
8. **No transcript export.**
9. **`propose_invite_member`** is kept but only callable for users whose membership role is owner/admin — enforced at Approve time by the existing `invite-member` function's RLS, not in the agent loop.
10. **Onboarding "done" detection is heuristic** (workspace has ≥1 company AND one of {integration linked, substrate entity imported, deal created}). Not a hard gate; the user can close and leave at any time.

## 9. Open questions deferred to implementation planning

- Final wording of the two system prompts (drafts in §5 are starting points).
- Exact JSON-schema shapes for each tool — derived mechanically from §4 in the plan.
- Whether `agent_messages.tool_calls/tool_results` jsonb is enough or we want a separate `agent_tool_calls` table for queryability. Default: jsonb is fine; revisit if log-querying becomes a pain.
- Telemetry dashboard for token usage — out of scope for v1; data is captured.
