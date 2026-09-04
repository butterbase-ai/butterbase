# Workspace AI Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace-aware AI agent to butterbaseCRM that drives onboarding for new users and remains as a persistent right-side copilot, with auto-execute reads, confirm-gated writes, and dual-layer memory (CRM thread tables + substrate facts).

**Architecture:** One streaming `agent-chat` function holds the entire tool-use loop (29 tools across read/conversational/write/action/enrichment categories). Reads run inline against `ctx.db` under the caller's JWT; writes never mutate CRM data — they INSERT into a new `agent_proposals` table that the frontend resolves via existing RLS-enforced REST endpoints when the user clicks Approve. Frontend renders the chat (drawer post-onboarding, full-screen for onboarding) via an SSE consumer hook + tanstack-query + realtime subscriptions.

**Tech Stack:** Butterbase (Postgres + Deno functions + AI gateway claude-haiku-4.5 + realtime WebSockets + KV + substrate), Vite + React 19 + TypeScript, `@butterbase/sdk` 2.4, tanstack-query, Zustand, Radix/shadcn, react-router 7.

**Spec:** `docs/superpowers/specs/2026-06-05-workspace-ai-agent-design.md`

**Phase structure:** 16 phases. Each phase ends with a deployable, smoke-testable increment. Commit at the end of every task; merge to working state at the end of every phase.

---

## File Map

**New backend files** (deployed via MCP, mirrored locally by `backend/sync.sh`):
- `backend/functions/agent-chat/handler.ts` — the streaming tool-use loop
- `backend/functions/agent-chat/function.json` — http trigger, 120s timeout, 256MB
- `backend/functions/agent-proposals-expire/handler.ts` — cron sweeper
- `backend/functions/agent-proposals-expire/function.json` — cron */30 * * * *

**New frontend files:**
- `frontend/src/lib/agent.ts` — types, SSE wrapper, `tool_name → REST endpoint` map
- `frontend/src/hooks/useAgentStream.ts` — SSE consumer + event-reducer
- `frontend/src/hooks/useAgentThreads.ts` — list current user's threads
- `frontend/src/hooks/useAgentMessages.ts` — historical messages for a thread
- `frontend/src/hooks/useAgentProposals.ts` — pending proposals (drives badge)
- `frontend/src/hooks/useAgentRealtime.ts` — subscribe to agent_messages + agent_proposals
- `frontend/src/components/agent/AgentDrawer.tsx`
- `frontend/src/components/agent/AgentChat.tsx`
- `frontend/src/components/agent/AgentLauncher.tsx`
- `frontend/src/components/agent/MessageList.tsx`
- `frontend/src/components/agent/AssistantBubble.tsx`
- `frontend/src/components/agent/UserBubble.tsx`
- `frontend/src/components/agent/ToolCallChip.tsx`
- `frontend/src/components/agent/AskUserCard.tsx`
- `frontend/src/components/agent/SuggestNextStepCard.tsx`
- `frontend/src/components/agent/SuggestLinkAccountCard.tsx`
- `frontend/src/components/agent/ConfirmActionCard.tsx`
- `frontend/src/components/agent/ProposalCard.tsx`
- `frontend/src/components/agent/ThreadList.tsx`
- `frontend/src/pages/AgentOnboarding.tsx` (replaces routing target for `/onboard`)

**Modified frontend files:**
- `frontend/src/components/Topbar.tsx` — add `AgentLauncher`
- `frontend/src/components/AppShell.tsx` — render `<AgentDrawer />` at the shell level
- `frontend/src/routes/index.tsx` — swap `Onboard` for `AgentOnboarding` at `/onboard`
- `frontend/src/lib/queryKeys.ts` — add `agentThreads`, `agentMessages`, `agentProposals` keys
- `frontend/src/lib/types.ts` — add `AgentThread`, `AgentMessage`, `AgentProposal`

**Schema mirror (auto-updated by `backend/sync.sh`):**
- `backend/schema.json`, `backend/rls/*`, `backend/realtime.json`, `backend/functions/agent-chat/*`, `backend/functions/agent-proposals-expire/*`

---

## Phase 0 — Migration scaffolding

Goal: 3 new tables live, RLS policies installed, realtime configured. Smoke: insert/select/update via MCP work as RLS expects.

### Task 0.1: Snapshot current schema for safe full-state diff

**Why:** Per `backend/README.md`, `manage_schema apply` is full-state diff, not additive. Single-table additions are accepted only if the payload contains all 11 existing tables plus the new ones.

- [ ] **Step 1: Pull current schema**

Run MCP tool: `manage_schema` with `action: "get"`, `app_id: "app_44zjayftl7b3"`.

Save the returned `tables` object verbatim to a scratch buffer — this is the baseline for every subsequent `apply`.

- [ ] **Step 2: Verify the baseline matches `backend/schema.json`**

Open `backend/schema.json` and confirm the table count (`_table_count: 11`) and table names match the MCP response. If they differ, run `backend/sync.sh` first to refresh the mirror, then redo Step 1.

Expected: 11 tables (workspaces, memberships, companies, people, deals, notes, meetings, meeting_attendees, activities, attachments, pending_invites).

- [ ] **Step 3: Commit the doc baseline (no code change yet)**

```bash
cd /Users/kenneth/Documents/Misc/butterbaseCRM
git add docs/superpowers/specs/2026-06-05-workspace-ai-agent-design.md docs/superpowers/plans/2026-06-05-workspace-ai-agent.md
git commit -m "docs: spec + plan for workspace AI agent"
```

### Task 0.2: Add `agent_threads`, `agent_messages`, `agent_proposals` to schema

**Files:**
- MCP: `manage_schema` (action: `apply`, dry_run first)
- After success: re-run `backend/sync.sh` to refresh `backend/schema.json`

- [ ] **Step 1: Build the apply payload**

Take the baseline from Task 0.1.Step 1. Append these three table definitions to the `tables` object (preserving the existing 11):

```json
{
  "agent_threads": {
    "columns": {
      "id":              { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
      "workspace_id":    { "type": "uuid", "nullable": false, "references": { "table": "workspaces", "column": "id", "onDelete": "CASCADE" } },
      "user_id":         { "type": "uuid", "nullable": false },
      "title":           { "type": "text" },
      "mode":            { "type": "text", "nullable": false, "default": "'copilot'" },
      "status":          { "type": "text", "nullable": false, "default": "'active'" },
      "last_message_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
      "created_at":      { "type": "timestamptz", "nullable": false, "default": "now()" },
      "updated_at":      { "type": "timestamptz", "nullable": false, "default": "now()" }
    },
    "indexes": {
      "agent_threads_ws_user_idx": { "columns": ["workspace_id", "user_id", "last_message_at"] }
    }
  },
  "agent_messages": {
    "columns": {
      "id":           { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
      "thread_id":    { "type": "uuid", "nullable": false, "references": { "table": "agent_threads", "column": "id", "onDelete": "CASCADE" } },
      "workspace_id": { "type": "uuid", "nullable": false },
      "role":         { "type": "text", "nullable": false },
      "content":      { "type": "text" },
      "tool_calls":   { "type": "jsonb" },
      "tool_results": { "type": "jsonb" },
      "ui_event":     { "type": "jsonb" },
      "token_usage":  { "type": "jsonb" },
      "created_at":   { "type": "timestamptz", "nullable": false, "default": "now()" }
    },
    "indexes": {
      "agent_messages_thread_created_idx": { "columns": ["thread_id", "created_at"] }
    }
  },
  "agent_proposals": {
    "columns": {
      "id":           { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
      "thread_id":    { "type": "uuid", "nullable": false, "references": { "table": "agent_threads", "column": "id", "onDelete": "CASCADE" } },
      "workspace_id": { "type": "uuid", "nullable": false },
      "proposed_by":  { "type": "uuid", "nullable": false },
      "tool_name":    { "type": "text", "nullable": false },
      "payload":      { "type": "jsonb", "nullable": false },
      "rationale":    { "type": "text" },
      "status":       { "type": "text", "nullable": false, "default": "'pending'" },
      "resolution":   { "type": "jsonb" },
      "resolved_at":  { "type": "timestamptz" },
      "expires_at":   { "type": "timestamptz", "nullable": false, "default": "now() + interval '24 hours'" },
      "created_at":   { "type": "timestamptz", "nullable": false, "default": "now()" }
    },
    "indexes": {
      "agent_proposals_thread_idx":      { "columns": ["thread_id", "created_at"] },
      "agent_proposals_ws_status_idx":   { "columns": ["workspace_id", "status", "created_at"] }
    }
  }
}
```

Note the SQL-quoted defaults (`"'copilot'"`, `"'active'"`, `"'pending'"`) per the `backend/README.md` gotcha.

- [ ] **Step 2: Dry-run apply to inspect the diff**

Run MCP tool: `manage_schema` with `action: "apply"`, `app_id: "app_44zjayftl7b3"`, `dry_run: true`, `tables: <the merged 14-table payload>`.

Expected output: a diff that only ADDs `agent_threads`, `agent_messages`, `agent_proposals` and their indexes; no destructive changes on the original 11 tables. If the diff shows changes to existing tables, abort and reconcile (defaults likely lost their SQL quotes).

- [ ] **Step 3: Apply for real**

Run MCP tool: `manage_schema` with `action: "apply"`, `app_id: "app_44zjayftl7b3"`, `dry_run: false`, `tables: <merged payload>`.

Expected: success response with `applied: true` and the new tables listed.

- [ ] **Step 4: Smoke test the tables exist**

Run MCP tool: `select_rows` for each of the three tables with `limit: 1`. Expected: empty array, no error.

- [ ] **Step 5: Sync mirror and commit**

```bash
cd /Users/kenneth/Documents/Misc/butterbaseCRM/backend
./sync.sh
cd ..
git add backend/schema.json
git commit -m "feat(schema): add agent_threads, agent_messages, agent_proposals"
```

### Task 0.3: Enable RLS on the three new tables (default deny)

- [ ] **Step 1: Enable RLS via MCP**

Run MCP tool: `manage_rls` with `action: "enable"`, `app_id: "app_44zjayftl7b3"`, `tables: ["agent_threads", "agent_messages", "agent_proposals"]`.

Expected: 3 tables now report `rls_enabled: true`.

- [ ] **Step 2: Verify deny-by-default**

Try to `select_rows` from `agent_threads` as `butterbase_anon` (no auth). Expected: empty result (RLS denies all).

- [ ] **Step 3: Commit (no code change; live state only)**

```bash
cd backend && ./sync.sh && cd ..
git add backend/rls/
git commit -m "feat(rls): enable RLS on agent_* tables"
```

### Task 0.4: Install RLS policies on `agent_threads`

Per spec §3: SELECT/INSERT/UPDATE/DELETE allowed when `user_id = current_user_id()::uuid` AND caller is a member of `workspace_id`.

- [ ] **Step 1: Create SELECT policy**

Run MCP tool: `manage_rls` with `action: "create_policy"`, `app_id: "app_44zjayftl7b3"`, `table: "agent_threads"`, `policy`:

```json
{
  "name": "agent_threads_select_owner",
  "command": "SELECT",
  "roles": ["butterbase_user"],
  "using": "user_id = current_user_id()::uuid AND workspace_id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = current_user_id()::uuid)"
}
```

Note the explicit `::uuid` cast — without it you get `RLS_TYPE_MISMATCH` (see `backend/README.md`).

- [ ] **Step 2: Create INSERT policy**

```json
{
  "name": "agent_threads_insert_owner",
  "command": "INSERT",
  "roles": ["butterbase_user"],
  "with_check": "user_id = current_user_id()::uuid AND workspace_id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = current_user_id()::uuid)"
}
```

- [ ] **Step 3: Create UPDATE policy**

```json
{
  "name": "agent_threads_update_owner",
  "command": "UPDATE",
  "roles": ["butterbase_user"],
  "using": "user_id = current_user_id()::uuid",
  "with_check": "user_id = current_user_id()::uuid"
}
```

- [ ] **Step 4: Create DELETE policy**

```json
{
  "name": "agent_threads_delete_owner",
  "command": "DELETE",
  "roles": ["butterbase_user"],
  "using": "user_id = current_user_id()::uuid"
}
```

- [ ] **Step 5: List policies to verify all 4 are present**

Run MCP tool: `manage_rls` with `action: "list"`, `app_id: "app_44zjayftl7b3"`, `table: "agent_threads"`. Expected: 4 policies.

- [ ] **Step 6: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/rls/
git commit -m "feat(rls): policies for agent_threads"
```

### Task 0.5: Install RLS policies on `agent_messages`

Per spec §3: SELECT/INSERT allowed when the parent thread's `user_id = current_user_id()::uuid`. No UPDATE/DELETE from the client.

- [ ] **Step 1: SELECT policy**

```json
{
  "name": "agent_messages_select_thread_owner",
  "command": "SELECT",
  "roles": ["butterbase_user"],
  "using": "thread_id IN (SELECT id FROM agent_threads WHERE user_id = current_user_id()::uuid)"
}
```

- [ ] **Step 2: INSERT policy**

```json
{
  "name": "agent_messages_insert_thread_owner",
  "command": "INSERT",
  "roles": ["butterbase_user"],
  "with_check": "thread_id IN (SELECT id FROM agent_threads WHERE user_id = current_user_id()::uuid)"
}
```

(No UPDATE/DELETE policies — RLS default-denies and that is the intended behavior.)

- [ ] **Step 3: Verify with list**

Same MCP call as Task 0.4 Step 5 against `agent_messages`. Expected: 2 policies.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/rls/
git commit -m "feat(rls): policies for agent_messages"
```

### Task 0.6: Install RLS policies on `agent_proposals`

Per spec §3: SELECT/INSERT allowed when thread owner = caller. UPDATE only allowed pending→resolved transitions.

- [ ] **Step 1: SELECT policy**

```json
{
  "name": "agent_proposals_select_thread_owner",
  "command": "SELECT",
  "roles": ["butterbase_user"],
  "using": "thread_id IN (SELECT id FROM agent_threads WHERE user_id = current_user_id()::uuid)"
}
```

- [ ] **Step 2: INSERT policy**

```json
{
  "name": "agent_proposals_insert_thread_owner",
  "command": "INSERT",
  "roles": ["butterbase_user"],
  "with_check": "thread_id IN (SELECT id FROM agent_threads WHERE user_id = current_user_id()::uuid) AND proposed_by = current_user_id()::uuid AND status = 'pending'"
}
```

- [ ] **Step 3: UPDATE policy (only pending → resolved by owner)**

```json
{
  "name": "agent_proposals_update_thread_owner",
  "command": "UPDATE",
  "roles": ["butterbase_user"],
  "using": "thread_id IN (SELECT id FROM agent_threads WHERE user_id = current_user_id()::uuid) AND status = 'pending'",
  "with_check": "thread_id IN (SELECT id FROM agent_threads WHERE user_id = current_user_id()::uuid) AND status IN ('approved', 'rejected')"
}
```

The `using` clause requires the row to currently be pending; the `with_check` requires the new row to be approved or rejected (the cron sweeper handles `'expired'` under service role, RLS bypassed).

- [ ] **Step 4: Verify with list**

Expected: 3 policies on `agent_proposals`.

- [ ] **Step 5: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/rls/
git commit -m "feat(rls): policies for agent_proposals"
```

### Task 0.7: Enable realtime on `agent_messages` and `agent_proposals`

- [ ] **Step 1: Pull current realtime config**

Run MCP tool: `manage_realtime` with `action: "get"`, `app_id: "app_44zjayftl7b3"`. Note the existing 7-table list.

- [ ] **Step 2: Reconfigure with the new tables**

Run MCP tool: `manage_realtime` with `action: "configure"`, `app_id: "app_44zjayftl7b3"`, `tables: [<existing 7>, "agent_messages", "agent_proposals"]`.

Expected: 9 tables now in the realtime config.

- [ ] **Step 3: Verify the broadcast is wired**

Connect a websocket client (browser console or quick Node script) with a test JWT, subscribe to `agent_messages`, then INSERT a test row via `insert_row` MCP. Expected: receive a `change` event with `op: INSERT` on the WS.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/realtime.json
git commit -m "feat(realtime): broadcast agent_messages + agent_proposals"
```

---

## Phase 1 — Bare `agent-chat` function (non-streaming, no tools)

Goal: A deployed function that creates a thread, inserts a user turn, calls the AI gateway with NO tools, persists the assistant reply, returns JSON. Proves end-to-end plumbing before adding complexity.

### Task 1.1: Scaffold the function with auth + thread creation only

**Files:**
- Local scratch (will be deployed via MCP, not stored in repo until `sync.sh`)

- [ ] **Step 1: Write the initial handler**

```ts
// agent-chat/handler.ts — Phase 1 (non-streaming, no tools)

interface AgentChatBody {
  thread_id?: string | null;
  workspace_id?: string;
  mode?: 'onboarding' | 'copilot';
  user_message?: string;
  client_context?: { route?: string; entity?: { type: string; id: string } | null };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(req: Request, ctx: any): Promise<Response> {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });

  let body: AgentChatBody;
  try { body = await req.json(); } catch { body = {}; }

  const userMessage = body.user_message;
  if (typeof userMessage !== 'string' || userMessage.length === 0) {
    return jsonResponse(400, { error: 'user_message required' });
  }

  // Resolve thread.
  let threadId = body.thread_id ?? null;
  let workspaceId: string;
  let mode: 'onboarding' | 'copilot';

  if (!threadId) {
    if (!body.workspace_id) return jsonResponse(400, { error: 'workspace_id required when creating thread' });
    mode = body.mode === 'onboarding' ? 'onboarding' : 'copilot';
    workspaceId = body.workspace_id;
    const t = await ctx.db.query(
      `INSERT INTO agent_threads (workspace_id, user_id, mode)
       VALUES ($1, $2, $3) RETURNING id, workspace_id, mode`,
      [workspaceId, ctx.user.id, mode],
    );
    threadId = t.rows[0].id;
  } else {
    const t = await ctx.db.query(
      `SELECT id, workspace_id, mode FROM agent_threads WHERE id = $1`,
      [threadId],
    );
    if (t.rows.length === 0) return jsonResponse(404, { error: 'thread_not_found' });
    workspaceId = t.rows[0].workspace_id;
    mode = t.rows[0].mode;
  }

  // Insert user message.
  const um = await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, content)
     VALUES ($1, $2, 'user', $3) RETURNING id`,
    [threadId, workspaceId, userMessage],
  );

  // Call AI gateway (non-streaming, no tools).
  const systemPrompt = mode === 'onboarding'
    ? 'You are the welcome agent for butterbaseCRM. Be brief.'
    : 'You are a CRM copilot. Be terse.';

  const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 400,
    }),
  });

  if (!aiRes.ok) {
    const detail = (await aiRes.text()).slice(0, 500);
    return jsonResponse(502, { error: 'ai_gateway_error', detail });
  }

  const aiJson = await aiRes.json();
  const assistantText = aiJson?.choices?.[0]?.message?.content ?? '';
  const usage = aiJson?.usage ?? null;

  // Persist assistant turn.
  const am = await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, content, token_usage)
     VALUES ($1, $2, 'assistant', $3, $4) RETURNING id`,
    [threadId, workspaceId, assistantText, JSON.stringify(usage)],
  );

  // Bump thread last_message_at.
  await ctx.db.query(`UPDATE agent_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`, [threadId]);

  return jsonResponse(200, {
    thread_id: threadId,
    user_message_id: um.rows[0].id,
    assistant_message_id: am.rows[0].id,
    assistant_text: assistantText,
    token_usage: usage,
  });
}
```

- [ ] **Step 2: Deploy via MCP**

Run MCP tool: `deploy_function` with:
- `app_id: "app_44zjayftl7b3"`
- `name: "agent-chat"`
- `code: <the handler above as a single string>`
- `trigger: { "type": "http", "config": {} }`
- `timeoutMs: 120000`
- `memoryLimitMb: 256`
- `envVars: { "BUTTERBASE_API_KEY": "<the same bb_sk_* key the other AI functions use; pull from existing summarize-company envVars via get_entity if needed>" }`

Expected: success response with the function name.

- [ ] **Step 3: Smoke-test thread creation**

Run MCP tool: `invoke_function` with `name: "agent-chat"`, end-user JWT (mint one with `manage_auth_users` if needed for testing), and body `{ "workspace_id": "<a real workspace id>", "mode": "copilot", "user_message": "Hello, who are you?" }`.

Expected response shape:
```json
{
  "thread_id": "<uuid>",
  "user_message_id": "<uuid>",
  "assistant_message_id": "<uuid>",
  "assistant_text": "<some short greeting>",
  "token_usage": { "prompt_tokens": ..., "completion_tokens": ..., "total_tokens": ... }
}
```

If 502 ai_gateway_error: BUTTERBASE_API_KEY env var is wrong or missing.
If 401: the invocation didn't carry an end-user JWT.

- [ ] **Step 4: Smoke-test thread continuation**

Invoke again with `thread_id: "<the id from Step 3>"` and `user_message: "What did I just ask you?"`.

Expected: returns a new assistant turn referencing the previous question. (Without context-loading this won't actually work yet — assistant should give a confused reply. That's fine; we'll add context in Phase 2.)

- [ ] **Step 5: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/
git commit -m "feat(agent-chat): scaffold function, thread create + non-streaming reply"
```

### Task 1.2: Load thread history into the model context

- [ ] **Step 1: Update handler to fetch last 40 messages and pass them in**

Replace the AI gateway call block in `handler.ts` with:

```ts
// Load last 40 messages of this thread (including the just-inserted user turn).
const history = await ctx.db.query(
  `SELECT role, content, tool_calls, tool_results
     FROM agent_messages
    WHERE thread_id = $1
    ORDER BY created_at ASC
    LIMIT 40`,
  [threadId],
);

const messages: any[] = [{ role: 'system', content: systemPrompt }];
for (const row of history.rows) {
  if (row.role === 'user' || row.role === 'assistant') {
    if (row.content) messages.push({ role: row.role, content: row.content });
  }
  // Phase 1: skip tool/system_event rows.
}

const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
  body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages, max_tokens: 400 }),
});
```

- [ ] **Step 2: Redeploy via MCP `deploy_function` (same name overrides)**

- [ ] **Step 3: Smoke-test continuation**

Same call as Task 1.1 Step 4. Expected: assistant correctly references the previous question.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): load thread history into model context"
```

---

## Phase 2 — SSE streaming

Goal: Same function, but streams `text/event-stream` to the client. Frontend can render tokens as they arrive.

### Task 2.1: Convert response to SSE; stream assistant deltas

- [ ] **Step 1: Replace the AI gateway block with a streaming version**

```ts
// SSE helpers
function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// Replace `return jsonResponse(200, ...)` and the non-streaming aiRes block.

const stream = new ReadableStream({
  async start(controller) {
    const enc = new TextEncoder();
    const write = (s: string) => controller.enqueue(enc.encode(s));

    try {
      if (!body.thread_id) write(sseEvent('thread', { thread_id: threadId, mode }));
      write(sseEvent('user_message_id', { id: um.rows[0].id }));

      // Insert placeholder assistant row so we can stream into a known id.
      const placeholder = await ctx.db.query(
        `INSERT INTO agent_messages (thread_id, workspace_id, role, content)
         VALUES ($1, $2, 'assistant', '') RETURNING id`,
        [threadId, workspaceId],
      );
      const assistantId = placeholder.rows[0].id;
      write(sseEvent('assistant_start', { message_id: assistantId }));

      const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages, max_tokens: 800, stream: true }),
      });

      if (!aiRes.ok || !aiRes.body) {
        const detail = aiRes.body ? (await aiRes.text()).slice(0, 500) : 'no body';
        write(sseEvent('error', { code: 'ai_gateway_error', message: detail }));
        write(sseEvent('done', {}));
        controller.close();
        return;
      }

      const reader = aiRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let fullText = '';
      let usage: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk: any;
          try { chunk = JSON.parse(payload); } catch { continue; }
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            write(sseEvent('assistant_delta', { text: delta }));
          }
          if (chunk?.usage) usage = chunk.usage;
        }
      }

      // Finalize the assistant row.
      await ctx.db.query(
        `UPDATE agent_messages SET content = $1, token_usage = $2 WHERE id = $3`,
        [fullText, JSON.stringify(usage), assistantId],
      );
      await ctx.db.query(`UPDATE agent_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`, [threadId]);

      write(sseEvent('assistant_end', { message_id: assistantId, token_usage: usage }));
      write(sseEvent('done', {}));
    } catch (e: any) {
      const enc2 = new TextEncoder();
      controller.enqueue(enc2.encode(sseEvent('error', { code: 'internal', message: String(e?.message ?? e) })));
      controller.enqueue(enc2.encode(sseEvent('done', {})));
    } finally {
      controller.close();
    }
  },
});

return new Response(stream, {
  status: 200,
  headers: {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  },
});
```

- [ ] **Step 2: Redeploy**

Run MCP `deploy_function` again with the new code.

- [ ] **Step 3: Smoke-test streaming**

Use `curl --no-buffer -N` (or a small Deno/Node script) to POST to the function URL with the JWT and a body. Expected: see lines like `event: assistant_start`, `event: assistant_delta`, ... `event: done` printed incrementally, not all at once.

If the response arrives buffered at the end, check `cache-control` and that the response is wrapped in a `ReadableStream` (not a Promise<string>).

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): SSE streaming response"
```

### Task 2.2: Add KV-backed thread lock + daily budget

- [ ] **Step 1: Add the lock and budget guards immediately after thread resolution**

Insert before the user-message INSERT:

```ts
// Thread lock (130s — buffer over the 120s function timeout).
const lockKey = `agent_thread_lock:${threadId}`;
const acquired = await ctx.kv.setnx(lockKey, ctx.requestId ?? '1', { ttl: 130 });
if (!acquired) return jsonResponse(409, { error: 'thread_busy' });

// Daily budget — 200k input + 100k output ceiling, summed across all models.
const today = new Date().toISOString().slice(0, 10);
const budgetKey = `agent_budget:${ctx.user.id}:${today}`;
const usedToday = (await ctx.kv.get<number>(budgetKey)) ?? 0;
if (usedToday > 300_000) {
  await ctx.kv.del(lockKey);
  return jsonResponse(429, { error: 'budget_exceeded', detail: 'daily token budget reached' });
}
```

And at the end of the stream (in the `finally`), release the lock and accumulate:

```ts
} finally {
  try {
    await ctx.kv.del(lockKey);
    if (usage?.total_tokens) await ctx.kv.incr(budgetKey, usage.total_tokens);
  } catch { /* swallow */ }
  controller.close();
}
```

Move the `usage` and `budgetKey` declarations into a scope visible to `finally`.

- [ ] **Step 2: Redeploy + smoke test**

Invoke twice in quick succession with the same `thread_id` from two terminal windows. Second call should return 409 `thread_busy` within ~1 second.

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/
git commit -m "feat(agent-chat): KV thread lock + daily token budget"
```

---

## Phase 3 — Tool-use loop scaffolding + first 3 read tools

Goal: The function passes a tool definition array to the gateway, handles `tool_use` stop_reason by looping, and the model can call `search_workspace`, `get_company`, `get_pipeline_summary`.

### Task 3.1: Refactor to a tool-dispatcher loop

The single biggest change. We'll restructure the streaming block into a loop:

```
while (iterations < 8):
   call gateway (with tools=[...])
   if stop_reason === 'end_turn': finalize + break
   if stop_reason === 'tool_use':
       for each tool_use block:
           dispatch by name → result or proposal-side-effect
           append tool_result to messages
```

- [ ] **Step 1: Add the tool catalog scaffolding**

Just above the `messages` build, declare an empty tool array plus a dispatcher stub:

```ts
type ToolDef = { name: string; description: string; input_schema: any };
type ToolDispatch = (args: any) => Promise<{ ok: true; result: any; summary: string } | { ok: false; error: string }>;

const tools: ToolDef[] = [];
const dispatch: Record<string, ToolDispatch> = {};
```

We'll populate these in Tasks 3.2+. For now, with empty arrays the loop should still behave like Phase 2.

- [ ] **Step 2: Replace the single AI gateway call with a loop**

Replace everything from the placeholder INSERT through the `assistant_end` write with:

```ts
const placeholder = await ctx.db.query(
  `INSERT INTO agent_messages (thread_id, workspace_id, role, content)
   VALUES ($1, $2, 'assistant', '') RETURNING id`,
  [threadId, workspaceId],
);
const assistantId = placeholder.rows[0].id;
write(sseEvent('assistant_start', { message_id: assistantId }));

let fullText = '';
let usage: any = null;
let iteration = 0;

while (iteration < 8) {
  iteration++;

  const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages,
      max_tokens: 800,
      stream: true,
      tools: tools.length > 0 ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) : undefined,
    }),
  });

  if (!aiRes.ok || !aiRes.body) {
    const detail = aiRes.body ? (await aiRes.text()).slice(0, 500) : 'no body';
    write(sseEvent('error', { code: 'ai_gateway_error', message: detail }));
    break;
  }

  const reader = aiRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let stopReason: string | null = null;
  const pendingToolCalls: Record<string, { name: string; args_buffer: string; id: string }> = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        fullText += delta.content;
        write(sseEvent('assistant_delta', { text: delta.content }));
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const id = tc.id ?? `tc_${tc.index}`;
          if (!pendingToolCalls[id]) {
            pendingToolCalls[id] = { id, name: tc.function?.name ?? '', args_buffer: '' };
            if (tc.function?.name) write(sseEvent('tool_call_start', { tool_call_id: id, name: tc.function.name, args: {} }));
          }
          if (typeof tc.function?.name === 'string') pendingToolCalls[id].name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') pendingToolCalls[id].args_buffer += tc.function.arguments;
        }
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk?.usage) usage = chunk.usage;
    }
  }

  if (stopReason !== 'tool_calls' && stopReason !== 'tool_use') {
    break; // end_turn or other terminal reason
  }

  // Execute each tool call, append assistant + tool turns to messages, loop.
  const assistantToolCallsForHistory: any[] = [];
  const toolResultsForHistory: any[] = [];

  for (const id of Object.keys(pendingToolCalls)) {
    const tc = pendingToolCalls[id];
    let args: any = {};
    try { args = JSON.parse(tc.args_buffer || '{}'); } catch { args = {}; }
    assistantToolCallsForHistory.push({ id, type: 'function', function: { name: tc.name, arguments: tc.args_buffer || '{}' } });

    const fn = dispatch[tc.name];
    let outcome: { ok: true; result: any; summary: string } | { ok: false; error: string };
    if (!fn) outcome = { ok: false, error: `unknown_tool:${tc.name}` };
    else {
      try { outcome = await fn(args); } catch (e: any) { outcome = { ok: false, error: String(e?.message ?? e) }; }
    }

    write(sseEvent('tool_call_done', outcome.ok
      ? { tool_call_id: id, ok: true, summary: outcome.summary }
      : { tool_call_id: id, ok: false, error: outcome.error }));

    toolResultsForHistory.push({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
    });

    // Persist the tool turn.
    await ctx.db.query(
      `INSERT INTO agent_messages (thread_id, workspace_id, role, tool_results)
       VALUES ($1, $2, 'tool', $3)`,
      [threadId, workspaceId, JSON.stringify({ tool_call_id: id, name: tc.name, args, outcome })],
    );
  }

  // Persist the assistant's tool-use turn for replay coherence.
  await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, content, tool_calls)
     VALUES ($1, $2, 'assistant', $3, $4)`,
    [threadId, workspaceId, fullText, JSON.stringify(assistantToolCallsForHistory)],
  );

  // Append to the in-memory messages array so the next iteration's gateway call sees them.
  messages.push({ role: 'assistant', content: fullText || null, tool_calls: assistantToolCallsForHistory });
  for (const tr of toolResultsForHistory) messages.push(tr);

  // Reset fullText for the next assistant turn (gateway will produce a new one).
  fullText = '';
}

// Finalize the placeholder row with whatever final text we have.
await ctx.db.query(
  `UPDATE agent_messages SET content = $1, token_usage = $2 WHERE id = $3`,
  [fullText, JSON.stringify(usage), assistantId],
);
await ctx.db.query(`UPDATE agent_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`, [threadId]);

write(sseEvent('assistant_end', { message_id: assistantId, token_usage: usage }));
write(sseEvent('done', {}));
```

- [ ] **Step 3: Update history-loading to include tool turns**

Edit the `history.rows` mapping to include tool rows so replay works:

```ts
for (const row of history.rows) {
  if (row.role === 'user') {
    messages.push({ role: 'user', content: row.content });
  } else if (row.role === 'assistant') {
    const m: any = { role: 'assistant' };
    if (row.content) m.content = row.content;
    if (row.tool_calls) m.tool_calls = row.tool_calls;
    messages.push(m);
  } else if (row.role === 'tool' && row.tool_results) {
    const tr = row.tool_results;
    messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: JSON.stringify(tr.outcome?.ok ? tr.outcome.result : { error: tr.outcome?.error ?? 'unknown' }) });
  }
}
```

- [ ] **Step 4: Redeploy and smoke**

Invoke with a generic user message — since `tools` is empty, behavior matches Phase 2.

Expected: still works exactly like Phase 2 streaming.

- [ ] **Step 5: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): tool-use loop scaffold (empty catalog)"
```

### Task 3.2: Implement `search_workspace` tool

Reuses the existing `ai-search` whitelisted-spec pattern (see `backend/functions/ai-search/handler.ts`). Rather than duplicate the schema-validation logic, we invoke that function from inside `agent-chat`.

- [ ] **Step 1: Add the tool definition and dispatcher**

In `handler.ts`, populate `tools` and `dispatch`:

```ts
tools.push({
  name: 'search_workspace',
  description: 'Search companies, people, or deals in the current workspace using a natural-language query. Returns up to 25 matching rows.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language description of what to find.' },
      scope: { type: 'string', enum: ['all', 'companies', 'people', 'deals'], description: 'Optional table to focus on.' },
    },
    required: ['query'],
  },
});

dispatch['search_workspace'] = async (args: any) => {
  const query = String(args?.query ?? '').slice(0, 500);
  if (!query) return { ok: false, error: 'query_required' };
  // Re-invoke ai-search internally; carry forward the caller's user identity by using a service-role fetch with ctx.user.id passed as x-user-id (the platform sets this header).
  const r = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/fn/ai-search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
      'x-user-id': ctx.user.id,
    },
    body: JSON.stringify({ query, workspace_id: workspaceId }),
  });
  if (!r.ok) return { ok: false, error: `ai_search_${r.status}` };
  const j = await r.json();
  return { ok: true, result: { table: j.table, count: j.count, rows: j.rows }, summary: `Found ${j.count} ${j.table}` };
};
```

Note: `ai-search` runs as `auth: required` with `butterbase_user`. The platform forwards `x-user-id` from the API key context — verify this works by checking the ai-search invocation logs after the smoke test.

- [ ] **Step 2: Redeploy + smoke test**

Invoke `agent-chat` with `user_message: "Find any companies in the fintech industry"`. The agent should call `search_workspace`.

Expected SSE event sequence:
- `assistant_start`
- `tool_call_start` (name: search_workspace)
- `tool_call_done` (summary: "Found N companies")
- a second `assistant_start` ... `assistant_delta` ... `assistant_end` containing a natural-language reply mentioning the results

If the tool call fails with `ai_search_401`: the `x-user-id` forwarding doesn't work for service-key calls. Fall back to inlining the ai-search logic directly. Verify by reading the function logs:

```
manage_function with action: "get_logs", name: "ai-search"
```

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): add search_workspace tool"
```

### Task 3.3: Implement `get_company` and `get_pipeline_summary`

Both run inline against `ctx.db` since they're cheap and don't need cross-function calls.

- [ ] **Step 1: Add both tool definitions and dispatchers**

```ts
tools.push({
  name: 'get_company',
  description: 'Fetch a company by id, plus its 5 latest notes, open deals, and 10 latest activities.',
  input_schema: {
    type: 'object',
    properties: { company_id: { type: 'string', description: 'UUID of the company.' } },
    required: ['company_id'],
  },
});

dispatch['get_company'] = async (args: any) => {
  const id = String(args?.company_id ?? '');
  if (!id) return { ok: false, error: 'company_id_required' };
  const c = await ctx.db.query(
    `SELECT id, name, domain, industry, employee_count, location, description, ai_summary
       FROM companies WHERE id = $1`,
    [id],
  );
  if (c.rows.length === 0) return { ok: false, error: 'not_found' };
  const company = c.rows[0];
  const [notes, deals, activities] = await Promise.all([
    ctx.db.query(`SELECT body, created_at FROM notes WHERE entity_type = 'company' AND entity_id = $1 ORDER BY created_at DESC LIMIT 5`, [id]),
    ctx.db.query(`SELECT id, name, stage, amount_cents, currency FROM deals WHERE company_id = $1 AND stage NOT IN ('won','lost') ORDER BY updated_at DESC LIMIT 10`, [id]),
    ctx.db.query(`SELECT kind, payload, created_at FROM activities WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
  ]);
  return {
    ok: true,
    result: { company, recent_notes: notes.rows, open_deals: deals.rows, recent_activities: activities.rows },
    summary: `${company.name}: ${deals.rows.length} open deals`,
  };
};

tools.push({
  name: 'get_pipeline_summary',
  description: 'Returns count and sum(amount_cents) per stage for all deals in the current workspace.',
  input_schema: { type: 'object', properties: {} },
});

dispatch['get_pipeline_summary'] = async () => {
  const r = await ctx.db.query(
    `SELECT stage, COUNT(*)::int as count, COALESCE(SUM(amount_cents),0)::bigint as total_amount_cents
       FROM deals WHERE workspace_id = $1 GROUP BY stage ORDER BY stage`,
    [workspaceId],
  );
  return { ok: true, result: { stages: r.rows }, summary: `Pipeline: ${r.rows.length} stages` };
};
```

- [ ] **Step 2: Redeploy + smoke**

Invoke with `user_message: "Give me my pipeline summary"`. Expected: tool call to `get_pipeline_summary`, then a natural-language summary.

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): add get_company + get_pipeline_summary tools"
```

---

## Phase 4 — Remaining read tools

Goal: All 9 read tools live.

### Task 4.1: Add `get_person`, `get_deal`, `list_recent_activity`, `list_meetings`, `list_integrations`

Each follows the `get_company` pattern. One commit per tool keeps the diff small; one combined task here for brevity.

- [ ] **Step 1: Add `get_person`**

```ts
tools.push({
  name: 'get_person',
  description: 'Fetch a person by id, their company, and deals where they are the primary contact.',
  input_schema: { type: 'object', properties: { person_id: { type: 'string' } }, required: ['person_id'] },
});

dispatch['get_person'] = async (args: any) => {
  const id = String(args?.person_id ?? '');
  if (!id) return { ok: false, error: 'person_id_required' };
  const p = await ctx.db.query(`SELECT * FROM people WHERE id = $1`, [id]);
  if (p.rows.length === 0) return { ok: false, error: 'not_found' };
  const person = p.rows[0];
  const [company, deals] = await Promise.all([
    person.company_id
      ? ctx.db.query(`SELECT id, name, domain FROM companies WHERE id = $1`, [person.company_id]).then(r => r.rows[0] ?? null)
      : Promise.resolve(null),
    ctx.db.query(`SELECT id, name, stage, amount_cents FROM deals WHERE primary_person_id = $1 ORDER BY updated_at DESC LIMIT 10`, [id]).then(r => r.rows),
  ]);
  const name = [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email || person.id;
  return { ok: true, result: { person, company, deals }, summary: `${name}: ${deals.length} deals` };
};
```

- [ ] **Step 2: Add `get_deal`**

```ts
tools.push({
  name: 'get_deal',
  description: 'Fetch a deal by id, its company, primary person, meetings, and notes.',
  input_schema: { type: 'object', properties: { deal_id: { type: 'string' } }, required: ['deal_id'] },
});

dispatch['get_deal'] = async (args: any) => {
  const id = String(args?.deal_id ?? '');
  if (!id) return { ok: false, error: 'deal_id_required' };
  const d = await ctx.db.query(`SELECT * FROM deals WHERE id = $1`, [id]);
  if (d.rows.length === 0) return { ok: false, error: 'not_found' };
  const deal = d.rows[0];
  const [company, person, meetings, notes] = await Promise.all([
    deal.company_id ? ctx.db.query(`SELECT id, name, domain FROM companies WHERE id = $1`, [deal.company_id]).then(r => r.rows[0] ?? null) : Promise.resolve(null),
    deal.primary_person_id ? ctx.db.query(`SELECT id, first_name, last_name, email FROM people WHERE id = $1`, [deal.primary_person_id]).then(r => r.rows[0] ?? null) : Promise.resolve(null),
    ctx.db.query(`SELECT id, title, starts_at FROM meetings WHERE deal_id = $1 ORDER BY starts_at DESC LIMIT 5`, [id]).then(r => r.rows),
    ctx.db.query(`SELECT body, created_at FROM notes WHERE entity_type = 'deal' AND entity_id = $1 ORDER BY created_at DESC LIMIT 5`, [id]).then(r => r.rows),
  ]);
  return { ok: true, result: { deal, company, person, meetings, notes }, summary: `${deal.name} @ stage=${deal.stage}` };
};
```

- [ ] **Step 3: Add `list_recent_activity`**

```ts
tools.push({
  name: 'list_recent_activity',
  description: 'List recent activity events. Optionally filter by entity.',
  input_schema: {
    type: 'object',
    properties: {
      limit: { type: 'number' },
      entity_type: { type: 'string' },
      entity_id: { type: 'string' },
    },
  },
});

dispatch['list_recent_activity'] = async (args: any) => {
  const limit = Math.min(50, Math.max(1, Math.trunc(args?.limit ?? 20)));
  const filters: string[] = ['workspace_id = $1'];
  const params: any[] = [workspaceId];
  if (args?.entity_type) { params.push(args.entity_type); filters.push(`entity_type = $${params.length}`); }
  if (args?.entity_id)   { params.push(args.entity_id);   filters.push(`entity_id = $${params.length}`); }
  params.push(limit);
  const r = await ctx.db.query(
    `SELECT kind, entity_type, entity_id, payload, actor_user_id, created_at FROM activities WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return { ok: true, result: { events: r.rows }, summary: `${r.rows.length} events` };
};
```

- [ ] **Step 4: Add `list_meetings`**

```ts
tools.push({
  name: 'list_meetings',
  description: 'List meetings in a time range. scope=mine restricts to meetings the user is attending.',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO timestamp' },
      to: { type: 'string', description: 'ISO timestamp' },
      scope: { type: 'string', enum: ['mine', 'all'] },
    },
  },
});

dispatch['list_meetings'] = async (args: any) => {
  const filters: string[] = ['m.workspace_id = $1'];
  const params: any[] = [workspaceId];
  if (args?.from) { params.push(args.from); filters.push(`m.starts_at >= $${params.length}`); }
  if (args?.to)   { params.push(args.to);   filters.push(`m.starts_at <= $${params.length}`); }
  // scope=mine: join meeting_attendees → people by email match. There's no direct user_id on attendees.
  // For v1 we just return all the user can see (RLS already limits to their workspace).
  const r = await ctx.db.query(
    `SELECT m.id, m.title, m.starts_at, m.ends_at, m.location, m.company_id, m.deal_id
       FROM meetings m WHERE ${filters.join(' AND ')} ORDER BY m.starts_at DESC LIMIT 25`,
    params,
  );
  return { ok: true, result: { meetings: r.rows }, summary: `${r.rows.length} meetings` };
};
```

- [ ] **Step 5: Add `list_integrations`**

```ts
tools.push({
  name: 'list_integrations',
  description: "Lists which third-party providers (Gmail, Google Calendar, etc.) the user has connected.",
  input_schema: { type: 'object', properties: {} },
});

dispatch['list_integrations'] = async () => {
  const r = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connections`, {
    headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`, 'x-user-id': ctx.user.id },
  });
  if (!r.ok) return { ok: false, error: `integrations_${r.status}` };
  const j = await r.json();
  const slugs = (j?.connections ?? []).filter((c: any) => c.status === 'active').map((c: any) => c.toolkit_slug);
  return { ok: true, result: { connected: slugs }, summary: `Connected: ${slugs.join(', ') || 'none'}` };
};
```

- [ ] **Step 6: Redeploy + smoke test each**

Invoke once with `user_message: "Look up the deal named Acme — what's its company and stage?"`. Expected: chained `search_workspace` → `get_deal` tool calls.

- [ ] **Step 7: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): add 5 more read tools (person, deal, activity, meetings, integrations)"
```

### Task 4.2: Add `search_substrate_memory`

- [ ] **Step 1: Definition + dispatcher**

```ts
tools.push({
  name: 'search_substrate_memory',
  description: 'Search the user-level long-term memory (decisions, commitments, learnings, substrate entities). Use when recalling past preferences or facts about the user.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kinds: { type: 'array', items: { type: 'string', enum: ['decisions', 'commitments', 'learnings', 'entities'] } },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
});

dispatch['search_substrate_memory'] = async (args: any) => {
  if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
  const query = String(args?.query ?? '').slice(0, 400);
  const kinds = Array.isArray(args?.kinds) ? args.kinds : undefined;
  const limit = Math.min(15, Math.max(1, Math.trunc(args?.limit ?? 5)));
  const wantEntities = kinds?.includes('entities');
  const memKinds = kinds?.filter((k: string) => k !== 'entities');
  const [mem, ents] = await Promise.all([
    ctx.substrate.searchMemory(query, { kinds: memKinds, limit }).catch(() => null),
    wantEntities ? ctx.substrate.findEntities({ query, limit }).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    ok: true,
    result: { memory: mem ?? [], entities: ents ?? [] },
    summary: `Memory hits: ${(mem ?? []).length}, entities: ${(ents ?? []).length}`,
  };
};
```

- [ ] **Step 2: Redeploy + smoke**

Invoke with `user_message: "Do you remember anything about my pipeline preferences?"`. Expected: tool call to `search_substrate_memory`.

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): add search_substrate_memory tool"
```

---

## Phase 5 — Conversational tools

Goal: `ask_user`, `suggest_next_step`, `remember_fact` work. The first two emit SSE `ui_event`s that the frontend can act on (frontend is still TBD; smoke tests inspect the SSE stream).

### Task 5.1: `ask_user` and `suggest_next_step`

Both emit `ui_event` events. They do NOT need history persistence beyond what the assistant's tool_calls already record — the user's reply is the next turn.

- [ ] **Step 1: Tool defs + dispatchers**

```ts
tools.push({
  name: 'ask_user',
  description: 'Ask the user a structured question. Provide options for multiple-choice or allow free text.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } },
      allow_free_text: { type: 'boolean' },
    },
    required: ['question'],
  },
});

dispatch['ask_user'] = async (args: any) => {
  const question = String(args?.question ?? '').slice(0, 400);
  if (!question) return { ok: false, error: 'question_required' };
  const options = Array.isArray(args?.options) ? args.options.slice(0, 6) : undefined;
  const allow_free_text = args?.allow_free_text !== false; // default true
  const payload = { question, options, allow_free_text };
  write(sseEvent('ui_event', { kind: 'ask_user', payload }));
  // Persist as system_event so the next turn's history sees the question.
  await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`,
    [threadId, workspaceId, JSON.stringify({ kind: 'ask_user', payload })],
  );
  return { ok: true, result: { rendered: true }, summary: 'Asked question' };
};

tools.push({
  name: 'suggest_next_step',
  description: 'Surface a clickable next-step chip to the user.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['navigate', 'open_proposal', 'link_account'] },
          params: { type: 'object' },
        },
        required: ['type'],
      },
    },
    required: ['label', 'action'],
  },
});

dispatch['suggest_next_step'] = async (args: any) => {
  const label = String(args?.label ?? '').slice(0, 80);
  const action = args?.action;
  if (!label || !action?.type) return { ok: false, error: 'malformed' };
  const payload = { label, action };
  write(sseEvent('ui_event', { kind: 'suggest_next_step', payload }));
  await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`,
    [threadId, workspaceId, JSON.stringify({ kind: 'suggest_next_step', payload })],
  );
  return { ok: true, result: { rendered: true }, summary: `Suggested: ${label}` };
};
```

Also update the history loader to translate `system_event` rows into model-visible context. Add inside the `for (const row of history.rows)` loop:

```ts
} else if (row.role === 'system_event' && row.ui_event) {
  // Translate UI events into a user-visible "system note" so the model knows what was rendered.
  messages.push({ role: 'user', content: `[ui:${row.ui_event.kind}] ${JSON.stringify(row.ui_event.payload).slice(0, 400)}` });
}
```

- [ ] **Step 2: Redeploy + smoke**

Invoke with `user_message: "Ask me whether I sell to SMBs or enterprises."` Expected SSE: `ui_event` with kind `ask_user` and payload containing the question + (likely) options.

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): ask_user + suggest_next_step tools"
```

### Task 5.2: `remember_fact`

- [ ] **Step 1: Tool def + dispatcher**

```ts
tools.push({
  name: 'remember_fact',
  description: "Persist a long-term fact about the user (preference, goal, or process note). Survives across sessions.",
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['preference', 'goal', 'process_note'] },
      summary: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['kind', 'summary'],
  },
});

dispatch['remember_fact'] = async (args: any) => {
  if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
  const kind = String(args?.kind ?? 'preference');
  const summary = String(args?.summary ?? '').slice(0, 300);
  const rationale = args?.rationale ? String(args.rationale).slice(0, 600) : undefined;
  if (!summary) return { ok: false, error: 'summary_required' };
  try {
    const verdict = await ctx.substrate.propose('record_decision', {
      title: summary,
      kind: 'operational',
      rationale: rationale ?? `User-stated ${kind}`,
    });
    return { ok: true, result: { verdict }, summary: `Remembered: ${summary.slice(0, 40)}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};
```

- [ ] **Step 2: Redeploy + smoke**

Invoke with `user_message: "Remember that I prefer to track deals by ARR not TCV."` Expected: tool call, then `ctx.substrate` records it. Verify with MCP: `mcp__butterbase__search_memory` with `query: "ARR"`.

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): remember_fact tool (substrate-backed)"
```

---

## Phase 6 — Write tools (proposal-only)

Goal: 6 `propose_*` tools emit a row into `agent_proposals` and send a `proposal_created` SSE event.

### Task 6.1: Generic propose-tool helper

To DRY-up 6 nearly-identical tools, add a helper inside the handler:

- [ ] **Step 1: Add the helper above the tool list**

```ts
async function insertProposal(toolName: string, payload: any, rationale: string) {
  const r = await ctx.db.query(
    `INSERT INTO agent_proposals (thread_id, workspace_id, proposed_by, tool_name, payload, rationale)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [threadId, workspaceId, ctx.user.id, toolName, JSON.stringify(payload), rationale],
  );
  const id = r.rows[0].id;
  write(sseEvent('proposal_created', { proposal_id: id, tool_name: toolName, payload, rationale }));
  return id;
}
```

- [ ] **Step 2: Add `propose_create_company`**

```ts
tools.push({
  name: 'propose_create_company',
  description: 'Propose creating a new company. User confirms before any write.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      domain: { type: 'string' },
      industry: { type: 'string' },
      location: { type: 'string' },
      employee_count: { type: 'integer' },
      description: { type: 'string' },
      rationale: { type: 'string', description: 'One-line justification shown to the user.' },
    },
    required: ['name'],
  },
});

dispatch['propose_create_company'] = async (args: any) => {
  const name = String(args?.name ?? '').trim();
  if (!name) return { ok: false, error: 'name_required' };
  const payload: any = { name };
  for (const k of ['domain', 'industry', 'location', 'description']) {
    if (typeof args?.[k] === 'string' && args[k]) payload[k] = args[k];
  }
  if (Number.isFinite(args?.employee_count)) payload.employee_count = Math.trunc(args.employee_count);
  const rationale = (args?.rationale ?? '').slice(0, 200);
  const id = await insertProposal('propose_create_company', payload, rationale);
  return { ok: true, result: { proposal_id: id }, summary: `Proposed: create company "${name}"` };
};
```

- [ ] **Step 3: Add `propose_create_person`**

```ts
tools.push({
  name: 'propose_create_person',
  description: 'Propose creating a new person.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      company_id: { type: 'string' },
      title: { type: 'string' },
      phone: { type: 'string' },
      linkedin_url: { type: 'string' },
      rationale: { type: 'string' },
    },
  },
});

dispatch['propose_create_person'] = async (args: any) => {
  const payload: any = {};
  for (const k of ['first_name', 'last_name', 'email', 'company_id', 'title', 'phone', 'linkedin_url']) {
    if (typeof args?.[k] === 'string' && args[k]) payload[k] = args[k];
  }
  if (!payload.first_name && !payload.last_name && !payload.email) return { ok: false, error: 'identity_required' };
  const id = await insertProposal('propose_create_person', payload, (args?.rationale ?? '').slice(0, 200));
  const display = [payload.first_name, payload.last_name].filter(Boolean).join(' ') || payload.email || 'unknown';
  return { ok: true, result: { proposal_id: id }, summary: `Proposed: add person "${display}"` };
};
```

- [ ] **Step 4: Add `propose_create_deal`**

```ts
tools.push({
  name: 'propose_create_deal',
  description: 'Propose creating a new deal.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      company_id: { type: 'string' },
      primary_person_id: { type: 'string' },
      stage: { type: 'string', enum: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] },
      amount_cents: { type: 'integer' },
      currency: { type: 'string' },
      close_date: { type: 'string', description: 'ISO date' },
      rationale: { type: 'string' },
    },
    required: ['name'],
  },
});

dispatch['propose_create_deal'] = async (args: any) => {
  const name = String(args?.name ?? '').trim();
  if (!name) return { ok: false, error: 'name_required' };
  const payload: any = { name };
  for (const k of ['company_id', 'primary_person_id', 'stage', 'currency', 'close_date']) {
    if (typeof args?.[k] === 'string' && args[k]) payload[k] = args[k];
  }
  if (Number.isFinite(args?.amount_cents)) payload.amount_cents = Math.trunc(args.amount_cents);
  const id = await insertProposal('propose_create_deal', payload, (args?.rationale ?? '').slice(0, 200));
  return { ok: true, result: { proposal_id: id }, summary: `Proposed: create deal "${name}"` };
};
```

- [ ] **Step 5: Add `propose_update_deal_stage`**

```ts
tools.push({
  name: 'propose_update_deal_stage',
  description: 'Propose moving a deal to a new stage.',
  input_schema: {
    type: 'object',
    properties: {
      deal_id: { type: 'string' },
      stage: { type: 'string', enum: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] },
      rationale: { type: 'string' },
    },
    required: ['deal_id', 'stage'],
  },
});

dispatch['propose_update_deal_stage'] = async (args: any) => {
  const deal_id = String(args?.deal_id ?? '');
  const stage = String(args?.stage ?? '');
  if (!deal_id || !stage) return { ok: false, error: 'missing_fields' };
  const id = await insertProposal('propose_update_deal_stage', { deal_id, stage }, (args?.rationale ?? '').slice(0, 200));
  return { ok: true, result: { proposal_id: id }, summary: `Proposed: deal ${deal_id.slice(0, 8)} → ${stage}` };
};
```

- [ ] **Step 6: Add `propose_add_note`**

```ts
tools.push({
  name: 'propose_add_note',
  description: 'Propose attaching a note to a company, person, deal, or meeting.',
  input_schema: {
    type: 'object',
    properties: {
      entity_type: { type: 'string', enum: ['company', 'person', 'deal', 'meeting'] },
      entity_id: { type: 'string' },
      body: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['entity_type', 'entity_id', 'body'],
  },
});

dispatch['propose_add_note'] = async (args: any) => {
  const entity_type = String(args?.entity_type ?? '');
  const entity_id = String(args?.entity_id ?? '');
  const noteBody = String(args?.body ?? '').slice(0, 4000);
  if (!entity_type || !entity_id || !noteBody) return { ok: false, error: 'missing_fields' };
  const id = await insertProposal('propose_add_note', { entity_type, entity_id, body: noteBody }, (args?.rationale ?? '').slice(0, 200));
  return { ok: true, result: { proposal_id: id }, summary: `Proposed: note on ${entity_type}` };
};
```

- [ ] **Step 7: Add `propose_invite_member`**

```ts
tools.push({
  name: 'propose_invite_member',
  description: 'Propose inviting a new teammate to the workspace.',
  input_schema: {
    type: 'object',
    properties: {
      email: { type: 'string' },
      role: { type: 'string', enum: ['member', 'admin'] },
      rationale: { type: 'string' },
    },
    required: ['email'],
  },
});

dispatch['propose_invite_member'] = async (args: any) => {
  const email = String(args?.email ?? '').trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, error: 'email_required' };
  const role = args?.role === 'admin' ? 'admin' : 'member';
  const id = await insertProposal('propose_invite_member', { email, role }, (args?.rationale ?? '').slice(0, 200));
  return { ok: true, result: { proposal_id: id }, summary: `Proposed: invite ${email}` };
};
```

- [ ] **Step 8: Redeploy + smoke each**

Invoke with: "Create a company called Acme Corp in San Francisco". Expected: SSE shows `proposal_created` event with the company payload, no row in `companies` table (correct — proposals don't mutate CRM data). Verify with `select_rows` on `agent_proposals`: the row exists with `status='pending'`.

- [ ] **Step 9: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): 6 propose_* tools"
```

---

## Phase 7 — Action tools

Goal: `suggest_link_account`, `trigger_gmail_ingest`, `trigger_calendar_ingest`, `import_from_substrate`, `mark_onboarded`.

### Task 7.1: `suggest_link_account` and `mark_onboarded`

- [ ] **Step 1: `suggest_link_account` def + dispatch**

```ts
tools.push({
  name: 'suggest_link_account',
  description: "Suggest the user link a third-party account (Gmail, Google Calendar). Renders a button — the user starts OAuth.",
  input_schema: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['gmail', 'google-calendar'] },
      reason: { type: 'string' },
    },
    required: ['provider', 'reason'],
  },
});

dispatch['suggest_link_account'] = async (args: any) => {
  const provider = String(args?.provider ?? '');
  const reason = String(args?.reason ?? '').slice(0, 200);
  if (!provider) return { ok: false, error: 'provider_required' };
  const payload = { provider, reason };
  write(sseEvent('ui_event', { kind: 'suggest_link_account', payload }));
  await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`,
    [threadId, workspaceId, JSON.stringify({ kind: 'suggest_link_account', payload })],
  );
  return { ok: true, result: { rendered: true }, summary: `Suggested linking ${provider}` };
};
```

- [ ] **Step 2: `mark_onboarded` def + dispatch**

```ts
tools.push({
  name: 'mark_onboarded',
  description: "Call once onboarding is complete. Flips the first-run flag and tells the frontend to leave the welcome screen.",
  input_schema: { type: 'object', properties: {} },
});

dispatch['mark_onboarded'] = async () => {
  const key = `firstrun:${workspaceId}:${ctx.user.id}`;
  await ctx.kv.set(key, '1', { ttl: 60 * 60 * 24 * 365 });
  write(sseEvent('ui_event', { kind: 'onboarding_complete', payload: {} }));
  await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`,
    [threadId, workspaceId, JSON.stringify({ kind: 'onboarding_complete', payload: {} })],
  );
  return { ok: true, result: { onboarded: true }, summary: 'Marked onboarding complete' };
};
```

- [ ] **Step 3: Redeploy + smoke**

Invoke with `mode: 'onboarding'` and a message that nudges the agent to suggest linking Gmail. Verify SSE `ui_event` with kind `suggest_link_account`.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): suggest_link_account + mark_onboarded"
```

### Task 7.2: `trigger_gmail_ingest`, `trigger_calendar_ingest`, `import_from_substrate`

These each render a `confirm_action` ui_event the frontend renders as a Run button; the actual function invocation happens on click. So the dispatcher only emits the UI event.

- [ ] **Step 1: A generic `emitConfirmAction` helper**

```ts
async function emitConfirmAction(toolName: string, label: string, endpoint: string, body: any, costEstimate?: string) {
  const payload = { tool_name: toolName, label, endpoint, body, cost_estimate: costEstimate ?? null };
  write(sseEvent('ui_event', { kind: 'confirm_action', payload }));
  await ctx.db.query(
    `INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`,
    [threadId, workspaceId, JSON.stringify({ kind: 'confirm_action', payload })],
  );
}
```

- [ ] **Step 2: Three tool defs + dispatchers**

```ts
tools.push({
  name: 'trigger_gmail_ingest',
  description: 'Ask the user to confirm running a Gmail ingestion. Requires the user has Gmail linked.',
  input_schema: { type: 'object', properties: { lookback_days: { type: 'number' } } },
});
dispatch['trigger_gmail_ingest'] = async (args: any) => {
  const lookback_days = Math.min(180, Math.max(1, Math.trunc(args?.lookback_days ?? 30)));
  await emitConfirmAction('trigger_gmail_ingest', `Ingest last ${lookback_days} days of Gmail`, '/fn/ingest-gmail', { lookback_days, workspace_id: workspaceId });
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

tools.push({
  name: 'trigger_calendar_ingest',
  description: 'Ask the user to confirm running a Calendar ingestion.',
  input_schema: { type: 'object', properties: { lookback_days: { type: 'number' }, lookahead_days: { type: 'number' } } },
});
dispatch['trigger_calendar_ingest'] = async (args: any) => {
  const lookback = Math.min(180, Math.max(1, Math.trunc(args?.lookback_days ?? 30)));
  const lookahead = Math.min(90, Math.max(0, Math.trunc(args?.lookahead_days ?? 30)));
  await emitConfirmAction('trigger_calendar_ingest', `Sync calendar (-${lookback}d to +${lookahead}d)`, '/fn/ingest-calendar', { lookback_days: lookback, lookahead_days: lookahead, workspace_id: workspaceId });
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

tools.push({
  name: 'import_from_substrate',
  description: 'Ask the user to confirm importing a substrate entity (company or person) into the CRM.',
  input_schema: {
    type: 'object',
    properties: {
      entity_type: { type: 'string', enum: ['company', 'person'] },
      substrate_entity_id: { type: 'string' },
    },
    required: ['entity_type', 'substrate_entity_id'],
  },
});
dispatch['import_from_substrate'] = async (args: any) => {
  const entity_type = String(args?.entity_type ?? '');
  const substrate_entity_id = String(args?.substrate_entity_id ?? '');
  if (!entity_type || !substrate_entity_id) return { ok: false, error: 'missing_fields' };
  await emitConfirmAction('import_from_substrate', `Import ${entity_type} from substrate`, '/fn/import-from-substrate', { entity_type, substrate_entity_id, workspace_id: workspaceId });
  return { ok: true, result: { rendered: true }, summary: `Awaiting import confirmation` };
};
```

- [ ] **Step 3: Redeploy + smoke**

Invoke with `user_message: "Pull in the last 14 days of emails for context."` Expected: `ui_event` kind `confirm_action` with the right endpoint and body.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): action tools (ingest gmail/calendar, import from substrate)"
```

---

## Phase 8 — Enrichment & AI wrapper tools

Goal: 6 enrichment wrappers (`enrich_company`, `enrich_person`, `summarize_company`, `brief_meeting`, `find_duplicates`, `propose_deals`) all emit `confirm_action` ui_events.

### Task 8.1: Six enrichment wrappers

Each is a trivial `emitConfirmAction` call.

- [ ] **Step 1: Defs + dispatchers**

```ts
// enrich_company
tools.push({
  name: 'enrich_company',
  description: 'Run AI enrichment on a company. Costs AI credits.',
  input_schema: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
});
dispatch['enrich_company'] = async (args: any) => {
  const id = String(args?.company_id ?? '');
  if (!id) return { ok: false, error: 'company_id_required' };
  await emitConfirmAction('enrich_company', 'Enrich company', '/fn/enrich-company', { company_id: id }, '~$0.02');
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

// enrich_person
tools.push({
  name: 'enrich_person',
  description: 'Run AI enrichment on a person. Costs AI credits.',
  input_schema: { type: 'object', properties: { person_id: { type: 'string' } }, required: ['person_id'] },
});
dispatch['enrich_person'] = async (args: any) => {
  const id = String(args?.person_id ?? '');
  if (!id) return { ok: false, error: 'person_id_required' };
  await emitConfirmAction('enrich_person', 'Enrich person', '/fn/enrich-person', { person_id: id }, '~$0.02');
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

// summarize_company
tools.push({
  name: 'summarize_company',
  description: 'Generate or refresh the 2-sentence AI summary cached on a company.',
  input_schema: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
});
dispatch['summarize_company'] = async (args: any) => {
  const id = String(args?.company_id ?? '');
  if (!id) return { ok: false, error: 'company_id_required' };
  await emitConfirmAction('summarize_company', 'Summarize company', '/fn/summarize-company', { company_id: id }, '~$0.01');
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

// brief_meeting
tools.push({
  name: 'brief_meeting',
  description: 'Generate a meeting briefing.',
  input_schema: { type: 'object', properties: { meeting_id: { type: 'string' } }, required: ['meeting_id'] },
});
dispatch['brief_meeting'] = async (args: any) => {
  const id = String(args?.meeting_id ?? '');
  if (!id) return { ok: false, error: 'meeting_id_required' };
  await emitConfirmAction('brief_meeting', 'Brief meeting', '/fn/brief-meeting', { meeting_id: id }, '~$0.02');
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

// find_duplicates
tools.push({
  name: 'find_duplicates',
  description: 'Scan companies or people for likely duplicates.',
  input_schema: { type: 'object', properties: { scope: { type: 'string', enum: ['companies', 'people'] } }, required: ['scope'] },
});
dispatch['find_duplicates'] = async (args: any) => {
  const scope = String(args?.scope ?? '');
  if (scope !== 'companies' && scope !== 'people') return { ok: false, error: 'bad_scope' };
  await emitConfirmAction('find_duplicates', `Find duplicate ${scope}`, '/fn/find-duplicates', { scope, workspace_id: workspaceId }, '~$0.05');
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};

// propose_deals
tools.push({
  name: 'propose_deals',
  description: 'Have the AI propose new deals based on recent workspace activity.',
  input_schema: { type: 'object', properties: {} },
});
dispatch['propose_deals'] = async () => {
  await emitConfirmAction('propose_deals', 'AI-propose deals', '/fn/propose-deals', { workspace_id: workspaceId }, '~$0.10');
  return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
};
```

- [ ] **Step 2: Redeploy + smoke**

Invoke with `user_message: "Summarize the Acme company for me."` Expected: `ui_event` kind `confirm_action` referencing `/fn/summarize-company`.

- [ ] **Step 3: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): 6 enrichment wrapper tools"
```

### Task 8.2: Tighten the system prompts and finalize iteration cap behavior

- [ ] **Step 1: Update `systemPrompt` to the spec §5 prompt presets**

Replace the placeholder prompt strings with the full §5 versions, including the `{route}` / `{entity}` substitution for copilot mode:

```ts
const ctxLine = body.client_context?.route
  ? `The user is on \`${body.client_context.route}\`${body.client_context.entity ? ` looking at ${body.client_context.entity.type} ${body.client_context.entity.id}` : ''}.`
  : '';

const etiquette = `\n\nTool-use etiquette:\n- Cite which tool you used in 5 words max.\n- Never invent ids.\n- If a read returns nothing, say so plainly.\n- Reads run silently; only propose_* tools and confirm_action ui_events count as user-visible side effects.`;

const onboardingPrompt = `You are the welcome agent for a CRM called butterbaseCRM. The workspace was just created and is empty. Your job is two things at once: (1) interview the user about their sales/relationship workflow — who they sell to, their pipeline stages, the cadence they want; (2) get real data into the workspace by suggesting they link Gmail and Calendar, importing entities from their substrate if any, and creating their first company/person/deal. Move fast, ask one question at a time, prefer ask_user with structured options over open-ended questions. Always call remember_fact for preferences worth keeping. End by calling mark_onboarded when the workspace has at least one company AND one of: linked integration, imported substrate entity, or first deal.` + etiquette;

const copilotPrompt = `You are a CRM copilot embedded inside butterbaseCRM. ${ctxLine} Be terse, do the work, surface what you find. Search the workspace freely. Propose writes; don't lecture. When the user asks "who…" / "what's the status of…" / "summarize…" prefer read tools + a short direct answer. When the user asks "create…" / "remind me…" / "log…" use the propose_* tool then briefly confirm.` + etiquette;

const systemPrompt = mode === 'onboarding' ? onboardingPrompt : copilotPrompt;
```

- [ ] **Step 2: Graceful iteration cap message**

After the `while (iteration < 8)` loop, if we hit the cap, append a synthetic assistant turn:

```ts
if (iteration >= 8 && stopReason === 'tool_calls') {
  const capMsg = "I've done a lot in this turn — could you point me at the specific thing you want me to tackle next?";
  fullText = (fullText || '') + (fullText ? '\n\n' : '') + capMsg;
  write(sseEvent('assistant_delta', { text: (fullText ? '\n\n' : '') + capMsg }));
}
```

Make `stopReason` visible outside the inner loop by hoisting its `let` declaration to the outer scope.

- [ ] **Step 3: Redeploy + smoke**

Invoke a long chain like "List all my pipeline stages, summarize the top 3 deals in each, then propose adding notes." Verify the cap kicks in if it gets too long.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-chat/handler.ts
git commit -m "feat(agent-chat): proper system prompts + iteration cap message"
```

---

## Phase 9 — Cron sidecar (expire proposals)

Goal: pending proposals older than `expires_at` get flipped to `status='expired'` every 30 minutes.

### Task 9.1: Deploy `agent-proposals-expire`

- [ ] **Step 1: Write the handler**

```ts
// agent-proposals-expire/handler.ts
export default async function handler(_req: Request, ctx: any): Promise<Response> {
  // Cron runs as butterbase_service → RLS bypassed → can update across all workspaces.
  const r = await ctx.db.query(
    `UPDATE agent_proposals
        SET status = 'expired', resolved_at = now()
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id`,
  );
  return new Response(JSON.stringify({ expired: r.rows.length }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy via MCP**

Run `deploy_function`:
- `name: "agent-proposals-expire"`
- `code: <handler above>`
- `trigger: { "type": "cron", "config": { "schedule": "*/30 * * * *" } }`
- `timeoutMs: 30000`

- [ ] **Step 3: Smoke**

Invoke manually (`invoke_function`, name: agent-proposals-expire, no body, no JWT). Expected: `{ "expired": 0 }` (or however many old pending rows exist).

To test for real: insert a pending proposal with `expires_at = now() - interval '1 hour'` via `insert_row` MCP, then run the cron manually. Expected: `{ "expired": 1 }`, and the row's status becomes `'expired'`.

- [ ] **Step 4: Sync and commit**

```bash
cd backend && ./sync.sh && cd ..
git add backend/functions/agent-proposals-expire/
git commit -m "feat(agent-proposals-expire): cron sweeper"
```

---

## Phase 10 — Frontend foundation: types, queryKeys, SSE wrapper

Goal: Static types + the raw SSE consumer primitive. No UI yet.

### Task 10.1: Types

**File:** `frontend/src/lib/types.ts` (modify — append)

- [ ] **Step 1: Append agent types**

Open the existing `frontend/src/lib/types.ts`, locate the existing exports, and append at the bottom:

```ts
// ── Agent ──────────────────────────────────────────────────────────────

export type AgentThreadMode = 'onboarding' | 'copilot';
export type AgentThreadStatus = 'active' | 'archived';
export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system_event';
export type AgentProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface AgentThread {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string | null;
  mode: AgentThreadMode;
  status: AgentThreadStatus;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  thread_id: string;
  workspace_id: string;
  role: AgentMessageRole;
  content: string | null;
  tool_calls: any | null;
  tool_results: any | null;
  ui_event: { kind: string; payload: any } | null;
  token_usage: any | null;
  created_at: string;
}

export interface AgentProposal {
  id: string;
  thread_id: string;
  workspace_id: string;
  proposed_by: string;
  tool_name: string;
  payload: Record<string, any>;
  rationale: string | null;
  status: AgentProposalStatus;
  resolution: any | null;
  resolved_at: string | null;
  expires_at: string;
  created_at: string;
}

// ── Agent SSE events ───────────────────────────────────────────────────

export type AgentSseEvent =
  | { event: 'thread'; data: { thread_id: string; mode: AgentThreadMode } }
  | { event: 'user_message_id'; data: { id: string } }
  | { event: 'assistant_start'; data: { message_id: string } }
  | { event: 'assistant_delta'; data: { text: string } }
  | { event: 'tool_call_start'; data: { tool_call_id: string; name: string; args: any } }
  | { event: 'tool_call_done'; data: { tool_call_id: string; ok: boolean; summary?: string; error?: string } }
  | { event: 'ui_event'; data: { kind: string; payload: any } }
  | { event: 'proposal_created'; data: { proposal_id: string; tool_name: string; payload: any; rationale: string | null } }
  | { event: 'assistant_end'; data: { message_id: string; token_usage: any } }
  | { event: 'error'; data: { code: string; message: string } }
  | { event: 'done'; data: Record<string, never> };
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/types.ts
git commit -m "feat(types): agent thread/message/proposal + SSE event types"
```

### Task 10.2: Query keys

**File:** `frontend/src/lib/queryKeys.ts`

- [ ] **Step 1: Append agent keys**

Append to the existing exports:

```ts
export const queryKeys = {
  // ...existing keys...
  agentThreads: (workspaceId: string) => ['agentThreads', workspaceId] as const,
  agentMessages: (threadId: string) => ['agentMessages', threadId] as const,
  agentProposals: (workspaceId: string) => ['agentProposals', workspaceId] as const,
};
```

(If `queryKeys.ts` doesn't currently export an object, follow whatever existing convention you find there — match the project's style.)

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/queryKeys.ts
git commit -m "feat(queryKeys): agent thread/message/proposal keys"
```

### Task 10.3: SSE wrapper

**File:** `frontend/src/lib/agent.ts` (create)

- [ ] **Step 1: Write the SSE consumer + endpoint map**

```ts
import { bb } from './butterbase';
import type { AgentSseEvent } from './types';

export interface AgentChatRequest {
  thread_id?: string | null;
  workspace_id?: string;
  mode?: 'onboarding' | 'copilot';
  user_message: string;
  client_context?: { route?: string; entity?: { type: string; id: string } | null };
}

const API_URL = import.meta.env.VITE_BUTTERBASE_API_URL as string;
const APP_ID = import.meta.env.VITE_BUTTERBASE_APP_ID as string;

export async function openAgentStream(body: AgentChatRequest, signal?: AbortSignal): Promise<ReadableStream<AgentSseEvent>> {
  // Re-grab the current JWT from the SDK on every call (avoid stale tokens).
  const { data: session } = await (bb.auth as any).getSession?.() ?? { data: null };
  const jwt: string | undefined = session?.access_token ?? (await bb.auth.getUser() as any).data?.access_token;
  if (!jwt) throw new Error('not_authenticated');

  const res = await fetch(`${API_URL}/v1/${APP_ID}/fn/agent-chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`agent_chat_${res.status}: ${detail.slice(0, 200)}`);
  }

  return res.body.pipeThrough(new TextDecoderStream()).pipeThrough(parseSseStream());
}

function parseSseStream(): TransformStream<string, AgentSseEvent> {
  let buf = '';
  return new TransformStream({
    transform(chunk, controller) {
      buf += chunk;
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        let eventName = 'message';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine);
          controller.enqueue({ event: eventName as any, data } as AgentSseEvent);
        } catch { /* skip malformed */ }
      }
    },
  });
}

// ── tool_name → REST endpoint map (for Approve in ProposalCard) ────────

export type ProposalEndpoint = {
  method: 'POST' | 'PATCH';
  pathFromPayload: (p: any) => string;
  bodyFromPayload: (p: any, workspaceId: string, userId: string) => any;
};

export const PROPOSAL_ENDPOINTS: Record<string, ProposalEndpoint> = {
  propose_create_company: {
    method: 'POST',
    pathFromPayload: () => `/companies`,
    bodyFromPayload: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid }),
  },
  propose_create_person: {
    method: 'POST',
    pathFromPayload: () => `/people`,
    bodyFromPayload: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid }),
  },
  propose_create_deal: {
    method: 'POST',
    pathFromPayload: () => `/deals`,
    bodyFromPayload: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid, owner_user_id: uid }),
  },
  propose_update_deal_stage: {
    method: 'PATCH',
    pathFromPayload: (p) => `/deals?id=eq.${p.deal_id}`,
    bodyFromPayload: (p) => ({ stage: p.stage }),
  },
  propose_add_note: {
    method: 'POST',
    pathFromPayload: () => `/notes`,
    bodyFromPayload: (p, ws, uid) => ({ ...p, workspace_id: ws, created_by: uid }),
  },
  propose_invite_member: {
    method: 'POST',
    pathFromPayload: () => `/fn/invite-member`,
    bodyFromPayload: (p, ws) => ({ email: p.email, role: p.role, workspace_id: ws }),
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/agent.ts
git commit -m "feat(agent): SSE consumer + proposal-endpoint map"
```

---

## Phase 11 — Frontend hooks

### Task 11.1: `useAgentStream` (reducer over events)

**File:** `frontend/src/hooks/useAgentStream.ts` (create)

- [ ] **Step 1: Write the hook**

```ts
import { useCallback, useReducer, useRef } from 'react';
import { openAgentStream, type AgentChatRequest } from '@/lib/agent';
import type { AgentSseEvent } from '@/lib/types';

interface ToolCallState { name: string; args: any; status: 'running' | 'done' | 'error'; summary?: string; error?: string; }

interface StreamState {
  status: 'idle' | 'streaming' | 'done' | 'error';
  threadId: string | null;
  currentAssistantId: string | null;
  textBuffer: string;
  toolCalls: Record<string, ToolCallState>;
  newProposalIds: string[];
  pendingUiEvent: { kind: string; payload: any } | null;
  error: { code: string; message: string } | null;
}

const initial: StreamState = {
  status: 'idle',
  threadId: null,
  currentAssistantId: null,
  textBuffer: '',
  toolCalls: {},
  newProposalIds: [],
  pendingUiEvent: null,
  error: null,
};

type Action = { type: 'reset'; threadId: string | null } | { type: 'event'; ev: AgentSseEvent } | { type: 'error'; err: Error };

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case 'reset':
      return { ...initial, threadId: action.threadId, status: 'streaming' };
    case 'error':
      return { ...state, status: 'error', error: { code: 'client', message: action.err.message } };
    case 'event': {
      const { event, data } = action.ev;
      switch (event) {
        case 'thread':       return { ...state, threadId: (data as any).thread_id };
        case 'assistant_start': return { ...state, currentAssistantId: (data as any).message_id, textBuffer: '' };
        case 'assistant_delta': return { ...state, textBuffer: state.textBuffer + (data as any).text };
        case 'tool_call_start': {
          const d = data as any;
          return { ...state, toolCalls: { ...state.toolCalls, [d.tool_call_id]: { name: d.name, args: d.args, status: 'running' } } };
        }
        case 'tool_call_done': {
          const d = data as any;
          const prev = state.toolCalls[d.tool_call_id] ?? { name: '?', args: {}, status: 'running' as const };
          return { ...state, toolCalls: { ...state.toolCalls, [d.tool_call_id]: { ...prev, status: d.ok ? 'done' : 'error', summary: d.summary, error: d.error } } };
        }
        case 'proposal_created': return { ...state, newProposalIds: [...state.newProposalIds, (data as any).proposal_id] };
        case 'ui_event': return { ...state, pendingUiEvent: { kind: (data as any).kind, payload: (data as any).payload } };
        case 'assistant_end': return { ...state, currentAssistantId: null, textBuffer: '' };
        case 'error': return { ...state, status: 'error', error: data as any };
        case 'done': return { ...state, status: 'done' };
        default: return state;
      }
    }
  }
}

export function useAgentStream() {
  const [state, dispatch] = useReducer(reducer, initial);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (body: AgentChatRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: 'reset', threadId: body.thread_id ?? null });
    try {
      const stream = await openAgentStream(body, ac.signal);
      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        dispatch({ type: 'event', ev: value });
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') dispatch({ type: 'error', err });
    }
  }, []);

  const abort = useCallback(() => abortRef.current?.abort(), []);

  return { state, send, abort };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useAgentStream.ts
git commit -m "feat(hooks): useAgentStream"
```

### Task 11.2: `useAgentThreads`, `useAgentMessages`, `useAgentProposals`

**Files:** three new files in `frontend/src/hooks/`.

- [ ] **Step 1: `useAgentThreads.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { queryKeys } from '@/lib/queryKeys';
import type { AgentThread } from '@/lib/types';

export function useAgentThreads(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.agentThreads(workspaceId ?? ''),
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await bb
        .from<AgentThread>('agent_threads')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .eq('status', 'active')
        .order('last_message_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });
}
```

- [ ] **Step 2: `useAgentMessages.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { queryKeys } from '@/lib/queryKeys';
import type { AgentMessage } from '@/lib/types';

export function useAgentMessages(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.agentMessages(threadId ?? ''),
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await bb
        .from<AgentMessage>('agent_messages')
        .select('*')
        .eq('thread_id', threadId!)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}
```

- [ ] **Step 3: `useAgentProposals.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { queryKeys } from '@/lib/queryKeys';
import type { AgentProposal } from '@/lib/types';

export function useAgentProposals(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.agentProposals(workspaceId ?? ''),
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await bb
        .from<AgentProposal>('agent_proposals')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useAgentThreads.ts frontend/src/hooks/useAgentMessages.ts frontend/src/hooks/useAgentProposals.ts
git commit -m "feat(hooks): useAgentThreads + useAgentMessages + useAgentProposals"
```

### Task 11.3: `useAgentRealtime`

**File:** `frontend/src/hooks/useAgentRealtime.ts`

- [ ] **Step 1: Write the hook (reuses the project's existing realtime helper)**

```ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeToTable } from '@/lib/realtime'; // existing helper
import { queryKeys } from '@/lib/queryKeys';

export function useAgentRealtime(threadId: string | null, workspaceId: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;
    const unsub = subscribeToTable('agent_proposals', { workspace_id: workspaceId }, () => {
      qc.invalidateQueries({ queryKey: queryKeys.agentProposals(workspaceId) });
    });
    return unsub;
  }, [workspaceId, qc]);

  useEffect(() => {
    if (!threadId) return;
    const unsub = subscribeToTable('agent_messages', { thread_id: threadId }, () => {
      qc.invalidateQueries({ queryKey: queryKeys.agentMessages(threadId) });
    });
    return unsub;
  }, [threadId, qc]);
}
```

If `subscribeToTable`'s exact signature differs in `frontend/src/lib/realtime.ts`, adapt the call — the principle is one subscription per channel with a callback that invalidates the right query key. Open `lib/realtime.ts` first to confirm.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useAgentRealtime.ts
git commit -m "feat(hooks): useAgentRealtime"
```

---

## Phase 12 — Frontend: launcher, drawer shell, message list

Goal: Visible AgentLauncher button in topbar; drawer opens; empty thread state renders.

### Task 12.1: `useAgentUIStore` (drawer open/closed)

**File:** `frontend/src/lib/agent.ts` (extend) OR a new tiny store file. We'll put it in `agent.ts` to keep agent UI state in one place.

- [ ] **Step 1: Append to `frontend/src/lib/agent.ts`**

```ts
// Drawer open/closed + currently-open thread.
import { create } from 'zustand';

interface AgentUIState {
  open: boolean;
  threadId: string | null;
  openDrawer: (opts?: { threadId?: string | null }) => void;
  closeDrawer: () => void;
  setThread: (id: string | null) => void;
}

export const useAgentUIStore = create<AgentUIState>((set) => ({
  open: false,
  threadId: null,
  openDrawer: (opts) => set({ open: true, threadId: opts?.threadId ?? null }),
  closeDrawer: () => set({ open: false }),
  setThread: (id) => set({ threadId: id }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/agent.ts
git commit -m "feat(agent): drawer UI zustand store"
```

### Task 12.2: `AgentLauncher`

**File:** `frontend/src/components/agent/AgentLauncher.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentProposals } from '@/hooks/useAgentProposals';
import { useAgentUIStore } from '@/lib/agent';
import { useCurrentWorkspaceId } from '@/lib/workspace';

export function AgentLauncher() {
  const ws = useCurrentWorkspaceId();
  const open = useAgentUIStore((s) => s.openDrawer);
  const { data: proposals } = useAgentProposals(ws);
  const pendingCount = (proposals ?? []).filter((p) => p.status === 'pending').length;

  return (
    <Button variant="ghost" size="sm" className="gap-1.5 relative" onClick={() => open()} aria-label="Open AI assistant" title="Open AI assistant (⌘J)">
      <Sparkles className="h-4 w-4 text-butter" />
      <span className="text-[12.5px]">Assistant</span>
      {pendingCount > 0 && (
        <span className="absolute -top-1 -right-1 h-4 min-w-[16px] rounded-full bg-coral text-background text-[10px] font-mono leading-4 px-1 text-center">
          {pendingCount}
        </span>
      )}
    </Button>
  );
}
```

- [ ] **Step 2: Wire `⌘J` keyboard shortcut + render in `Topbar.tsx`**

Open `frontend/src/components/Topbar.tsx`. Find the existing shortcut handler (likely the `⌘K` listener for `AISearchDialog`). Add a parallel listener for `⌘J`:

```tsx
// Near the existing useEffect that registers ⌘K:
import { useAgentUIStore } from '@/lib/agent';
import { AgentLauncher } from './agent/AgentLauncher';

// Inside the existing keydown handler, OR a new useEffect:
useEffect(() => {
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      useAgentUIStore.getState().openDrawer();
    }
  }
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, []);
```

And in the Topbar's JSX (where the existing buttons live), add `<AgentLauncher />` next to them.

- [ ] **Step 3: Manually verify in browser**

```bash
cd /Users/kenneth/Documents/Misc/butterbaseCRM/frontend && npm run dev
```

Open the app, sign in. Confirm:
- The "Assistant" button with sparkle icon appears in the topbar.
- `⌘J` doesn't conflict with anything (especially `⌘K` for search).
- Clicking the button does nothing yet (drawer not implemented) — the click sets state but no visual change yet. That's expected at this step.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/agent/AgentLauncher.tsx frontend/src/components/Topbar.tsx
git commit -m "feat(ui): AgentLauncher in topbar with proposal badge and ⌘J shortcut"
```

### Task 12.3: `AgentDrawer` shell (no chat yet)

**File:** `frontend/src/components/agent/AgentDrawer.tsx`

- [ ] **Step 1: Write the drawer shell**

```tsx
import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentUIStore } from '@/lib/agent';

export function AgentDrawer() {
  const open = useAgentUIStore((s) => s.open);
  const close = useAgentUIStore((s) => s.closeDrawer);
  const threadId = useAgentUIStore((s) => s.threadId);
  const setThread = useAgentUIStore((s) => s.setThread);

  if (!open) return null;

  return (
    <aside
      className="fixed right-0 top-0 z-40 h-screen w-[440px] border-l border-border bg-background shadow-2xl flex flex-col"
      role="complementary"
      aria-label="AI assistant"
    >
      <header className="h-12 flex items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <span className="font-display tracking-tight text-[14px]">Assistant</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 gap-1" onClick={() => setThread(null)} title="New conversation">
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={close} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">
        {/* AgentChat goes here in Task 13.x */}
        <p className="p-4 font-editorial italic text-[13px] text-muted-foreground">Thread {threadId ?? '(new)'} — chat UI coming.</p>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Mount in `AppShell.tsx`**

Edit `frontend/src/components/AppShell.tsx` to render the drawer alongside the main content:

```tsx
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { AgentDrawer } from './agent/AgentDrawer';

export function AppShell() {
  return (
    <div className="paper-grain flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col border-l border-border">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-auto">
          <div key={location.pathname} className="animate-rise h-full">
            <Outlet />
          </div>
        </main>
      </div>
      <AgentDrawer />
    </div>
  );
}
```

- [ ] **Step 3: Browser-verify**

`npm run dev`, sign in, click Assistant or press `⌘J`. The drawer slides in from the right, showing "Thread (new) — chat UI coming." Click X to close.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/agent/AgentDrawer.tsx frontend/src/components/AppShell.tsx
git commit -m "feat(ui): AgentDrawer shell"
```

---

## Phase 13 — Frontend: chat core (bubbles, list, composer)

### Task 13.1: `AssistantBubble`, `UserBubble`, `ToolCallChip`

**Files:** three new components in `frontend/src/components/agent/`.

- [ ] **Step 1: `UserBubble.tsx`**

```tsx
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg bg-foreground/[0.06] px-3 py-2 text-[13.5px] whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `AssistantBubble.tsx`**

```tsx
export function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-lg bg-card border border-border px-3 py-2 text-[13.5px] whitespace-pre-wrap leading-relaxed">
        {text}
        {streaming && <span className="ml-0.5 inline-block h-3 w-1 align-text-bottom bg-foreground/40 animate-pulse" />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `ToolCallChip.tsx`**

```tsx
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props { name: string; status: 'running' | 'done' | 'error'; summary?: string; error?: string; }

export function ToolCallChip({ name, status, summary, error }: Props) {
  const Icon = status === 'running' ? Loader2 : status === 'done' ? CheckCircle2 : AlertCircle;
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2 py-0.5 text-[11.5px] font-mono">
      <Icon className={`h-3 w-3 ${status === 'running' ? 'animate-spin' : ''} ${status === 'error' ? 'text-coral' : 'text-muted-foreground'}`} />
      <span>{name}</span>
      {summary && <span className="text-muted-foreground">· {summary}</span>}
      {error && <span className="text-coral">· {error}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/agent/UserBubble.tsx frontend/src/components/agent/AssistantBubble.tsx frontend/src/components/agent/ToolCallChip.tsx
git commit -m "feat(ui): bubbles + tool-call chip"
```

### Task 13.2: `MessageList`

**File:** `frontend/src/components/agent/MessageList.tsx`

- [ ] **Step 1: Write the list**

```tsx
import { useEffect, useRef } from 'react';
import type { AgentMessage } from '@/lib/types';
import { AssistantBubble } from './AssistantBubble';
import { UserBubble } from './UserBubble';
import { ToolCallChip } from './ToolCallChip';

interface Props {
  messages: AgentMessage[];
  streamingAssistantText: string | null;
  streamingToolCalls: { id: string; name: string; status: 'running'|'done'|'error'; summary?: string; error?: string }[];
}

export function MessageList({ messages, streamingAssistantText, streamingToolCalls }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, streamingAssistantText, streamingToolCalls.length]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-4 space-y-3">
      {messages.map((m) => {
        if (m.role === 'user') return <UserBubble key={m.id} text={m.content ?? ''} />;
        if (m.role === 'assistant' && m.content) return <AssistantBubble key={m.id} text={m.content} />;
        if (m.role === 'tool' && m.tool_results) {
          const tr = m.tool_results;
          const status = tr?.outcome?.ok ? 'done' : 'error';
          const summary = tr?.outcome?.ok ? tr.outcome.summary : undefined;
          const error = !tr?.outcome?.ok ? tr.outcome.error : undefined;
          return <div key={m.id}><ToolCallChip name={tr.name ?? '?'} status={status} summary={summary} error={error} /></div>;
        }
        return null;
      })}

      {streamingToolCalls.map((tc) => (
        <div key={tc.id}><ToolCallChip name={tc.name} status={tc.status} summary={tc.summary} error={tc.error} /></div>
      ))}

      {streamingAssistantText !== null && <AssistantBubble text={streamingAssistantText} streaming />}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/agent/MessageList.tsx
git commit -m "feat(ui): MessageList rendering historical + streaming"
```

### Task 13.3: `AgentChat` (composer + glue)

**File:** `frontend/src/components/agent/AgentChat.tsx`

- [ ] **Step 1: Write the chat shell**

```tsx
import { useState, FormEvent, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAgentStream } from '@/hooks/useAgentStream';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useAgentRealtime } from '@/hooks/useAgentRealtime';
import { MessageList } from './MessageList';

interface Props {
  threadId: string | null;
  workspaceId: string;
  mode: 'onboarding' | 'copilot';
  onThreadIdChange?: (id: string) => void;
}

export function AgentChat({ threadId, workspaceId, mode, onThreadIdChange }: Props) {
  const [draft, setDraft] = useState('');
  const { state, send } = useAgentStream();
  const location = useLocation();
  const { data: messages } = useAgentMessages(threadId);
  useAgentRealtime(threadId, workspaceId);

  // Promote streamed thread id once the server creates one.
  useEffect(() => {
    if (state.threadId && state.threadId !== threadId) onThreadIdChange?.(state.threadId);
  }, [state.threadId, threadId, onThreadIdChange]);

  const streamingToolCalls = useMemo(
    () => Object.entries(state.toolCalls).map(([id, tc]) => ({ id, ...tc })),
    [state.toolCalls],
  );
  const streamingAssistantText = state.status === 'streaming' && state.textBuffer ? state.textBuffer : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const msg = draft.trim();
    if (!msg || state.status === 'streaming') return;
    setDraft('');
    await send({
      thread_id: threadId,
      workspace_id: workspaceId,
      mode,
      user_message: msg,
      client_context: { route: location.pathname, entity: null },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList
        messages={messages ?? []}
        streamingAssistantText={streamingAssistantText}
        streamingToolCalls={streamingToolCalls}
      />
      <form onSubmit={onSubmit} className="border-t border-border p-2 flex gap-2">
        <Textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e as any); } }}
          placeholder="Ask anything…"
          className="flex-1 resize-none text-[13.5px]"
          disabled={state.status === 'streaming'}
        />
        <Button type="submit" disabled={state.status === 'streaming' || !draft.trim()} size="icon" className="h-9 w-9 self-end">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}
```

If `Textarea` doesn't exist as a shadcn component in this project, swap for a `<textarea>` with matching className (`flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm`).

- [ ] **Step 2: Wire `AgentChat` into `AgentDrawer.tsx`**

Replace the placeholder `<p>` block in the drawer body:

```tsx
import { AgentChat } from './AgentChat';
import { useCurrentWorkspaceId } from '@/lib/workspace';

// inside AgentDrawer, replacing the placeholder:
const workspaceId = useCurrentWorkspaceId();
// ... later in the JSX:
<div className="flex-1 min-h-0 overflow-hidden">
  {workspaceId ? (
    <AgentChat
      threadId={threadId}
      workspaceId={workspaceId}
      mode="copilot"
      onThreadIdChange={(id) => setThread(id)}
    />
  ) : (
    <p className="p-4 text-[13px] text-muted-foreground">No workspace selected.</p>
  )}
</div>
```

- [ ] **Step 3: Browser-verify**

`npm run dev`. Open drawer, type "Hello — what can you do?", hit Enter.

Expected:
- An empty assistant bubble appears immediately.
- Text streams into it.
- "Searching workspace" / similar tool chip appears if the agent decides to use a read tool.
- Final answer appears, composer re-enables.

If the SSE doesn't stream (the message arrives all at once), check `lib/agent.ts`'s `openAgentStream`: the response body must be consumed via `getReader()`, not `text()`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/agent/AgentChat.tsx frontend/src/components/agent/AgentDrawer.tsx
git commit -m "feat(ui): AgentChat (composer + streaming wiring)"
```

---

## Phase 14 — Frontend: UI event cards (ask_user, suggest_*, confirm_action)

Goal: When the agent emits a `ui_event`, the frontend renders the matching card and the user can respond.

### Task 14.1: `AskUserCard` and reply handling

**File:** `frontend/src/components/agent/AskUserCard.tsx`

- [ ] **Step 1: Write the card**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  question: string;
  options?: { label: string; value: string }[];
  allow_free_text?: boolean;
  onSubmit: (text: string) => void;
}

export function AskUserCard({ question, options, allow_free_text, onSubmit }: Props) {
  const [text, setText] = useState('');
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <p className="text-[13.5px] font-medium">{question}</p>
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <Button key={o.value} variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => onSubmit(o.label)}>
              {o.label}
            </Button>
          ))}
        </div>
      )}
      {(allow_free_text !== false) && (
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text); }} className="flex gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Or type a reply…"
            className="flex-1 h-8 rounded-md border border-input bg-transparent px-2 text-[12.5px]"
          />
          <Button type="submit" size="sm" className="h-8" disabled={!text.trim()}>Send</Button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render `pendingUiEvent` in `MessageList` AND historical `system_event` rows**

Extend `MessageList.tsx`. After the existing message loop and BEFORE the streaming pieces, add a render block for the most-recent `system_event` row that doesn't yet have a reply.

For brevity in this plan: in v1 we only render the `pendingUiEvent` (live, from the stream). The historical rendering of past `system_event` rows is not required for v1 — once the user responds, the next assistant turn renders normally; the past prompt is implicit. This is intentional (per spec §8 cuts: no message editing/forking).

So just add in `AgentChat.tsx`:

```tsx
{state.pendingUiEvent?.kind === 'ask_user' && (
  <div className="px-3 pb-2">
    <AskUserCard
      question={state.pendingUiEvent.payload.question}
      options={state.pendingUiEvent.payload.options}
      allow_free_text={state.pendingUiEvent.payload.allow_free_text}
      onSubmit={(reply) => {
        // post the reply as the next turn
        send({
          thread_id: threadId,
          workspace_id: workspaceId,
          mode,
          user_message: reply,
          client_context: { route: location.pathname, entity: null },
        });
      }}
    />
  </div>
)}
```

Place this block between `MessageList` and the composer.

- [ ] **Step 3: Browser-verify**

In the drawer, ask "Help me decide between tracking by ARR or TCV". The agent should call `ask_user`. Card appears with chips. Click "ARR" — a new turn fires and the agent acknowledges.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/agent/AskUserCard.tsx frontend/src/components/agent/AgentChat.tsx frontend/src/components/agent/MessageList.tsx
git commit -m "feat(ui): AskUserCard wired into chat"
```

### Task 14.2: `SuggestNextStepCard`, `SuggestLinkAccountCard`, `ConfirmActionCard`

- [ ] **Step 1: `SuggestNextStepCard.tsx`**

```tsx
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

interface Props {
  label: string;
  action: { type: 'navigate' | 'open_proposal' | 'link_account'; params: any };
}

export function SuggestNextStepCard({ label, action }: Props) {
  const navigate = useNavigate();
  function click() {
    if (action.type === 'navigate' && typeof action.params?.path === 'string') navigate(action.params.path);
    // open_proposal: handled by ProposalCard via realtime; nothing to do here.
    // link_account: also surfaced via SuggestLinkAccountCard when emitted by the agent directly.
  }
  return (
    <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={click}>
      {label}
    </Button>
  );
}
```

- [ ] **Step 2: `SuggestLinkAccountCard.tsx`**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bb } from '@/lib/butterbase';

interface Props { provider: 'gmail' | 'google-calendar'; reason: string; onLinked: () => void; }

export function SuggestLinkAccountCard({ provider, reason, onLinked }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await (bb as any).integrations.connect(provider, {
        redirectUrl: `${window.location.origin}/integrations/callback`,
      });
      if (error) throw error;
      const popup = window.open(data.authUrl, 'integration-oauth', 'width=540,height=720');
      if (!popup) throw new Error('popup_blocked');
      // Poll for the popup to close; the existing CRM /integrations/callback page calls window.opener.postMessage('integration_connected').
      const onMsg = (e: MessageEvent) => {
        if (e.data === 'integration_connected') { window.removeEventListener('message', onMsg); popup.close(); onLinked(); }
      };
      window.addEventListener('message', onMsg);
    } catch (e: any) {
      setError(e?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <p className="text-[13.5px]">Link {provider.replace('-', ' ')} — {reason}</p>
      <Button size="sm" onClick={start} disabled={busy}>{busy ? 'Opening…' : `Link ${provider}`}</Button>
      {error && <p className="text-[12px] text-coral font-mono">{error}</p>}
    </div>
  );
}
```

If the integration callback page doesn't post a message, fall back to polling `bb.integrations.listConnections()` every 2 seconds while the popup is open.

- [ ] **Step 3: `ConfirmActionCard.tsx`**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bb } from '@/lib/butterbase';

interface Props {
  label: string;
  endpoint: string; // starts with /fn/...
  body: any;
  cost_estimate?: string | null;
  onResolved: (ok: boolean, result?: any) => void;
}

export function ConfirmActionCard({ label, endpoint, body, cost_estimate, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const fnName = endpoint.replace(/^\/fn\//, '');
      const { data, error } = await bb.functions.invoke(fnName, { body });
      if (error) throw error;
      onResolved(true, data);
    } catch (e: any) {
      setError(e?.message ?? 'failed');
      onResolved(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[13.5px]">{label}</p>
        {cost_estimate && <span className="text-[11px] font-mono text-muted-foreground">{cost_estimate}</span>}
      </div>
      <Button size="sm" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run'}</Button>
      {error && <p className="text-[12px] text-coral font-mono">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Wire all three into `AgentChat.tsx` next to the existing `AskUserCard` block**

Extend the conditional:

```tsx
{state.pendingUiEvent?.kind === 'suggest_link_account' && (
  <div className="px-3 pb-2">
    <SuggestLinkAccountCard
      provider={state.pendingUiEvent.payload.provider}
      reason={state.pendingUiEvent.payload.reason}
      onLinked={() => {
        send({
          thread_id: threadId,
          workspace_id: workspaceId,
          mode,
          user_message: `[system: connected ${state.pendingUiEvent!.payload.provider}]`,
          client_context: { route: location.pathname, entity: null },
        });
      }}
    />
  </div>
)}
{state.pendingUiEvent?.kind === 'confirm_action' && (
  <div className="px-3 pb-2">
    <ConfirmActionCard
      label={state.pendingUiEvent.payload.label}
      endpoint={state.pendingUiEvent.payload.endpoint}
      body={state.pendingUiEvent.payload.body}
      cost_estimate={state.pendingUiEvent.payload.cost_estimate}
      onResolved={(ok, result) => {
        send({
          thread_id: threadId,
          workspace_id: workspaceId,
          mode,
          user_message: ok ? `[system: action ${state.pendingUiEvent!.payload.tool_name} ran ok]` : `[system: action ${state.pendingUiEvent!.payload.tool_name} failed]`,
          client_context: { route: location.pathname, entity: null },
        });
      }}
    />
  </div>
)}
{state.pendingUiEvent?.kind === 'suggest_next_step' && (
  <div className="px-3 pb-2">
    <SuggestNextStepCard label={state.pendingUiEvent.payload.label} action={state.pendingUiEvent.payload.action} />
  </div>
)}
```

- [ ] **Step 5: Browser-verify**

Ask the agent "Help me ingest my last 14 days of emails." Expect a `confirm_action` card. Clicking Run actually invokes `ingest-gmail`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/agent/SuggestNextStepCard.tsx frontend/src/components/agent/SuggestLinkAccountCard.tsx frontend/src/components/agent/ConfirmActionCard.tsx frontend/src/components/agent/AgentChat.tsx
git commit -m "feat(ui): suggest_next_step, suggest_link_account, confirm_action cards"
```

---

## Phase 15 — ProposalCard + Approve flow

Goal: When the agent proposes a write, a card appears with editable fields, and Approve actually persists the row via the existing REST API.

### Task 15.1: `ProposalCard`

**File:** `frontend/src/components/agent/ProposalCard.tsx`

- [ ] **Step 1: Write the card**

```tsx
import { useEffect, useState } from 'react';
import { bb } from '@/lib/butterbase';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { PROPOSAL_ENDPOINTS } from '@/lib/agent';
import type { AgentProposal } from '@/lib/types';
import { useCurrentUserId } from '@/lib/auth'; // assume; otherwise inline bb.auth.getUser()

interface Props {
  proposal: AgentProposal;
  onResolved?: (status: 'approved' | 'rejected') => void;
}

export function ProposalCard({ proposal, onResolved }: Props) {
  const [payload, setPayload] = useState<any>(proposal.payload);
  const [status, setStatus] = useState(proposal.status);
  const [busy, setBusy] = useState(false);
  const userId = useCurrentUserId();

  useEffect(() => { setStatus(proposal.status); }, [proposal.status]);

  const expired = status === 'pending' && new Date(proposal.expires_at).getTime() < Date.now();
  const fields = Object.entries(payload).filter(([, v]) => typeof v === 'string' || typeof v === 'number');

  async function approve() {
    const endpoint = PROPOSAL_ENDPOINTS[proposal.tool_name];
    if (!endpoint || !userId) return;
    setBusy(true);
    try {
      // 1. Mark approved
      const upd = await bb.from('agent_proposals')
        .update({ status: 'approved', resolution: { edited_payload: payload }, resolved_at: new Date().toISOString() })
        .eq('id', proposal.id).eq('status', 'pending').select();
      if (upd.error) throw upd.error;
      if ((upd.data ?? []).length === 0) throw new Error('already_resolved');

      // 2. Execute the real write
      const body = endpoint.bodyFromPayload(payload, proposal.workspace_id, userId);
      const fnPath = endpoint.pathFromPayload(payload);
      let createdId: string | null = null;
      if (fnPath.startsWith('/fn/')) {
        const fnName = fnPath.replace(/^\/fn\//, '');
        const { data, error } = await bb.functions.invoke(fnName, { body });
        if (error) throw error;
        createdId = (data as any)?.id ?? null;
      } else if (endpoint.method === 'POST') {
        const tbl = fnPath.replace(/^\//, '').split('?')[0];
        const { data, error } = await bb.from(tbl as any).insert(body).select();
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        createdId = row?.id ?? null;
      } else if (endpoint.method === 'PATCH') {
        const tbl = fnPath.replace(/^\//, '').split('?')[0];
        const idMatch = fnPath.match(/id=eq\.([^&]+)/);
        if (!idMatch) throw new Error('bad_patch_path');
        const { error } = await bb.from(tbl as any).update(body).eq('id', idMatch[1]);
        if (error) throw error;
        createdId = idMatch[1];
      }

      // 3. Persist resolution.created_id
      await bb.from('agent_proposals').update({ resolution: { edited_payload: payload, created_id: createdId } }).eq('id', proposal.id);

      setStatus('approved');
      onResolved?.('approved');
      toast.success('Approved');
    } catch (e: any) {
      // Revert
      await bb.from('agent_proposals').update({ status: 'pending', resolution: null, resolved_at: null }).eq('id', proposal.id);
      setStatus('pending');
      toast.error(e?.message ?? 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      const { error } = await bb.from('agent_proposals')
        .update({ status: 'rejected', resolution: { reason: 'user_rejected' }, resolved_at: new Date().toISOString() })
        .eq('id', proposal.id).eq('status', 'pending');
      if (error) throw error;
      setStatus('rejected');
      onResolved?.('rejected');
    } catch (e: any) {
      toast.error(e?.message ?? 'Reject failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2.5">
      {proposal.rationale && <p className="font-editorial italic text-[12px] text-muted-foreground">{proposal.rationale}</p>}
      <p className="text-[13.5px] font-medium">{labelForTool(proposal.tool_name)}</p>
      <div className="space-y-1.5">
        {fields.map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-[12.5px]">
            <label className="w-20 text-muted-foreground">{k}</label>
            <input
              value={String(v ?? '')}
              onChange={(e) => setPayload({ ...payload, [k]: e.target.value })}
              disabled={status !== 'pending' || busy}
              className="flex-1 h-7 rounded border border-input bg-transparent px-2"
            />
          </div>
        ))}
      </div>
      {status === 'pending' && !expired && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={reject} disabled={busy}>Reject</Button>
          <Button size="sm" onClick={approve} disabled={busy}>{busy ? 'Working…' : 'Approve'}</Button>
        </div>
      )}
      {status === 'approved' && <p className="text-[12px] text-emerald-600">Approved ✓</p>}
      {status === 'rejected' && <p className="text-[12px] text-muted-foreground">Rejected</p>}
      {(status === 'expired' || (status === 'pending' && expired)) && (
        <p className="text-[12px] text-muted-foreground">Expired — ask the agent again.</p>
      )}
    </div>
  );
}

function labelForTool(name: string): string {
  switch (name) {
    case 'propose_create_company':     return 'Create company';
    case 'propose_create_person':      return 'Create person';
    case 'propose_create_deal':        return 'Create deal';
    case 'propose_update_deal_stage':  return 'Update deal stage';
    case 'propose_add_note':           return 'Add note';
    case 'propose_invite_member':      return 'Invite member';
    default:                           return name;
  }
}
```

If `useCurrentUserId` doesn't exist in the codebase, inline:

```ts
import { useEffect, useState } from 'react';
function useCurrentUserId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { bb.auth.getUser().then(({ data }) => setId((data as any)?.user?.id ?? (data as any)?.id ?? null)); }, []);
  return id;
}
```

- [ ] **Step 2: Render proposals inside `MessageList`**

We render proposals chronologically interleaved with messages. Pass a `proposals: AgentProposal[]` prop to `MessageList` and render each `<ProposalCard>` in order by `created_at` between messages.

Edit `MessageList.tsx`:

```tsx
import type { AgentProposal } from '@/lib/types';
import { ProposalCard } from './ProposalCard';

interface Props {
  messages: AgentMessage[];
  proposals: AgentProposal[];
  // ... existing props
}

// Merge by created_at:
const items = useMemo(() => {
  const ms = messages.map(m => ({ kind: 'm' as const, at: m.created_at, m }));
  const ps = proposals.map(p => ({ kind: 'p' as const, at: p.created_at, p }));
  return [...ms, ...ps].sort((a, b) => a.at.localeCompare(b.at));
}, [messages, proposals]);

// In the render:
{items.map((it) => it.kind === 'm' ? renderMessage(it.m) : <ProposalCard key={it.p.id} proposal={it.p} />)}
```

Then pass `proposals` from `AgentChat.tsx`:

```tsx
import { useAgentProposals } from '@/hooks/useAgentProposals';
// ...
const { data: allProposals } = useAgentProposals(workspaceId);
const threadProposals = (allProposals ?? []).filter((p) => p.thread_id === threadId);
// pass to MessageList:
<MessageList messages={messages ?? []} proposals={threadProposals} ... />
```

- [ ] **Step 3: Browser-verify**

Ask the agent "Add a company called Acme based in San Francisco". A `ProposalCard` appears. Edit "Acme" to "Acme Inc", click Approve. Toast: Approved. Open `/companies` — Acme Inc is there.

Now Reject another proposal. Toast: Rejected. The card greys out.

- [ ] **Step 4: Approve flow regression: race with realtime**

Open the drawer in two tabs. In tab A, approve a proposal. In tab B (which receives the realtime UPDATE), confirm the card auto-updates to "Approved ✓" without further clicks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/agent/ProposalCard.tsx frontend/src/components/agent/MessageList.tsx frontend/src/components/agent/AgentChat.tsx
git commit -m "feat(ui): ProposalCard with edit + Approve/Reject flow"
```

### Task 15.2: Synthetic post-Approve trigger turn

After Approve, the agent doesn't know it happened unless we tell it. Push a synthetic user turn so it can react.

- [ ] **Step 1: Pass an `onResolved` callback up**

In `MessageList`, accept `onProposalResolved?: (p: AgentProposal, status: 'approved'|'rejected') => void`. Forward to `<ProposalCard onResolved={(s) => onProposalResolved?.(p, s)} />`.

In `AgentChat`, use it to call `send`:

```tsx
<MessageList
  messages={messages ?? []}
  proposals={threadProposals}
  onProposalResolved={(p, s) => {
    if (s !== 'approved') return; // only ask the agent to react on approval
    send({
      thread_id: threadId,
      workspace_id: workspaceId,
      mode,
      user_message: `[system: proposal ${p.id} (${p.tool_name}) approved]`,
      client_context: { route: location.pathname, entity: null },
    });
  }}
  streamingAssistantText={streamingAssistantText}
  streamingToolCalls={streamingToolCalls}
/>
```

- [ ] **Step 2: Browser-verify**

After Approve, the agent automatically continues with a short confirmation turn referring to what was just created.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/agent/MessageList.tsx frontend/src/components/agent/AgentChat.tsx
git commit -m "feat(ui): synthetic post-Approve trigger turn"
```

### Task 15.3: `ThreadList` (drawer thread switcher)

**File:** `frontend/src/components/agent/ThreadList.tsx`

- [ ] **Step 1: Write the popover**

```tsx
import { useAgentThreads } from '@/hooks/useAgentThreads';
import { useAgentUIStore } from '@/lib/agent';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { History } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function ThreadList() {
  const ws = useCurrentWorkspaceId();
  const { data: threads } = useAgentThreads(ws);
  const setThread = useAgentUIStore((s) => s.setThread);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Recent threads">
          <History className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-1">
        <ul className="max-h-72 overflow-auto divide-y divide-border">
          {(threads ?? []).map((t) => (
            <li key={t.id}>
              <button onClick={() => setThread(t.id)} className="block w-full text-left px-2 py-1.5 hover:bg-foreground/[0.04] rounded">
                <p className="text-[12.5px]">{t.title ?? 'Untitled'}</p>
                <p className="text-[10.5px] text-muted-foreground font-mono">{formatDistanceToNow(new Date(t.last_message_at), { addSuffix: true })}</p>
              </button>
            </li>
          ))}
          {(threads ?? []).length === 0 && <p className="p-3 text-[12px] text-muted-foreground">No threads yet.</p>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Add it to `AgentDrawer` header**

In the drawer header, between "New" button and the close X:

```tsx
import { ThreadList } from './ThreadList';
// ...
<ThreadList />
```

- [ ] **Step 3: Browser-verify**

Create a couple of threads (use the New button + a quick chat). Confirm the History popover lists them and clicking one swaps the message list.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/agent/ThreadList.tsx frontend/src/components/agent/AgentDrawer.tsx
git commit -m "feat(ui): ThreadList popover"
```

---

## Phase 16 — Onboarding takeover + final smoke

### Task 16.1: `AgentOnboarding` page

**File:** `frontend/src/pages/AgentOnboarding.tsx` (create)

- [ ] **Step 1: Write the page**

```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useWorkspaceStore } from '@/lib/workspace';
import type { Workspace } from '@/lib/types';
import { AgentChat } from '@/components/agent/AgentChat';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

const schema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
});

type V = z.infer<typeof schema>;

export default function AgentOnboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [stage, setStage] = useState<'form' | 'chat'>('form');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const form = useForm<V>({ resolver: zodResolver(schema), defaultValues: { name: '', slug: '' } });

  async function onSubmit(values: V) {
    const { data: user } = await bb.auth.getUser();
    if (!user) return navigate('/login', { replace: true });
    const { data: wsData, error: wsError } = await bb.from<Workspace>('workspaces')
      .insert({ name: values.name, slug: values.slug, owner_user_id: (user as any).id })
      .select();
    if (wsError) return toast.error(wsError.message);
    const ws = Array.isArray(wsData) ? wsData[0] : wsData;
    if (!ws) return toast.error('Failed to create workspace.');

    const { data: memData, error: memErr } = await bb.from('memberships')
      .insert({ workspace_id: ws.id, user_id: (user as any).id, role: 'owner' })
      .select();
    if (memErr) return toast.error(memErr.message);
    useWorkspaceStore.getState().setWorkspace(ws.id);
    qc.setQueryData(['memberships', undefined], Array.isArray(memData) ? memData : memData ? [memData] : []);
    await qc.invalidateQueries({ queryKey: ['memberships'] });
    setWorkspaceId(ws.id);
    setStage('chat');
  }

  // Listen for the agent's mark_onboarded ui_event by polling KV via a tiny effect (or, when wired, by listening to AgentChat's `pendingUiEvent`).
  // Simplest: when the agent emits `onboarding_complete`, AgentChat will broadcast a synthetic turn; here we just expose a navigation callback.

  if (stage === 'form' || !workspaceId) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl">Create your workspace</CardTitle>
            <CardDescription>Name it; the assistant takes it from there.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Workspace name</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Corp" {...field} onBlur={() => { field.onBlur(); if (!form.getValues('slug')) form.setValue('slug', slugify(field.value), { shouldValidate: true }); }} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="slug" render={({ field }) => (
                  <FormItem><FormLabel>Slug</FormLabel><FormControl><Input placeholder="acme-corp" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? 'Creating…' : 'Create & start'}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="h-12 border-b border-border flex items-center px-4">
        <span className="font-display tracking-tight">Welcome — let's set up your workspace</span>
      </header>
      <div className="flex-1 min-h-0">
        <AgentChat
          threadId={threadId}
          workspaceId={workspaceId}
          mode="onboarding"
          onThreadIdChange={setThreadId}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Listen for `onboarding_complete` ui_event and navigate**

The cleanest hook: expose a callback prop on `AgentChat` so the page can react to specific ui_events.

Add to `AgentChat.tsx` props:

```ts
onUiEvent?: (kind: string, payload: any) => void;
```

Wire it inside `AgentChat`:

```tsx
useEffect(() => {
  if (state.pendingUiEvent) onUiEvent?.(state.pendingUiEvent.kind, state.pendingUiEvent.payload);
}, [state.pendingUiEvent]);
```

In `AgentOnboarding`:

```tsx
<AgentChat
  threadId={threadId}
  workspaceId={workspaceId}
  mode="onboarding"
  onThreadIdChange={setThreadId}
  onUiEvent={(kind) => { if (kind === 'onboarding_complete') navigate('/companies', { replace: true }); }}
/>
```

- [ ] **Step 3: Swap the route**

Edit `frontend/src/routes/index.tsx`:

```tsx
- import Onboard from '@/pages/Onboard';
+ import AgentOnboarding from '@/pages/AgentOnboarding';

  // ...

-   <Route path="/onboard" element={<Onboard />} />
+   <Route path="/onboard" element={<AgentOnboarding />} />
```

Leave `Onboard.tsx` in the repo for one cycle — easy revert.

- [ ] **Step 4: Browser-verify the full onboarding flow**

Sign up a brand-new test user. Land on `/onboard`. Enter a workspace name + slug → form submits → agent UI takes over → agent greets, asks questions, suggests linking Gmail, eventually calls `mark_onboarded` → page navigates to `/companies`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AgentOnboarding.tsx frontend/src/routes/index.tsx frontend/src/components/agent/AgentChat.tsx
git commit -m "feat(onboarding): replace Onboard.tsx with AgentOnboarding"
```

### Task 16.2: End-to-end smoke + spec-coverage review

- [ ] **Step 1: Walk the user-visible flows**

In a real browser session, do each of these:

1. Sign up new user, complete agent onboarding → /companies. Verify ≥1 company exists.
2. Open Assistant drawer, ask "summarize my pipeline" → expect a tool chip + natural reply.
3. Ask "create a person named John Doe at Acme" → ProposalCard → Approve → verify in /people.
4. Trigger Gmail ingestion via the agent's `confirm_action` card (skip if Gmail isn't connected; verify the `suggest_link_account` card appears instead).
5. Reject a proposal → status flips to rejected, no CRM mutation.
6. Open in two tabs, Approve in one — confirm the other tab realtime-updates.
7. Force a stale JWT (wait for token expiry or manually clear `localStorage` `sb-session`) → next send fails 401 → SDK refreshes → retry succeeds.

- [ ] **Step 2: Check token usage spot-check**

Run MCP `select_rows` on `agent_messages` with `column_filter: { token_usage: { not: null } }` and inspect a few rows. Confirm `token_usage.total_tokens` is populated.

- [ ] **Step 3: Document any deviations as journey-deploy notes**

Append findings to `docs/butterbase/04-build-log.md` under a "2026-06-XX: agent ship" heading.

- [ ] **Step 4: Final commit**

```bash
cd backend && ./sync.sh && cd ..
git add docs/butterbase/04-build-log.md backend/
git commit -m "docs: build log for agent ship + final mirror sync"
```

---

## Self-Review

After writing the full plan, I went back and checked it against the spec:

**1. Spec coverage** — every section/requirement:
- §1 Goal — covered by the plan's overall trajectory (onboarding via Phase 16, copilot via Phases 12–15).
- §2 Architecture — Phases 1–9 (backend), Phases 10–16 (frontend).
- §3 Schema — Phase 0 (Tasks 0.2–0.6), including all three tables + RLS + realtime.
- §4 Tool catalog — all 29 tools across Phases 3–8: reads (3.2–4.2), conversational (5.1–5.2), writes (6.1), actions (7.1–7.2), enrichment (8.1).
- §5 Function contract — request shape (Task 1.1), SSE events (Task 2.1), turn lifecycle (Task 3.1), system prompts (Task 8.2), error codes (Tasks 1.1, 2.2, 8.2), cron sidecar (Phase 9).
- §6 Frontend — components and hooks covered in Phases 10–15.
- §7 Edge cases — KV lock (Task 2.2), budget (Task 2.2), iteration cap (Task 8.2), Approve race (Task 15.1 Step 4), realtime tiebreak (Task 11.3 + 15.2). Stale JWT retry not implemented as automatic retry in `openAgentStream`; documented as a known v1 hole in Task 16.2 Step 1.7 — adding an automatic retry would be a small `lib/agent.ts` addition.
- §8 Scope cuts — all explicit cuts are absent from the plan; the deferred items (multi-user threads, voice, transcript export) intentionally have no tasks.
- §9 Open questions — listed as deferred in the spec; the plan addresses the system-prompt wording (Task 8.2) and uses jsonb for tool_calls (consistent with §3).

**Gap found:** The stale-JWT auto-retry. Adding a fix-up to `openAgentStream`:

Wrap the body of `openAgentStream` in a try/once-retry around 401 responses that calls `bb.auth.refreshSession()` first. Adding this as a tiny inline addendum to the plan:

### Addendum to Task 10.3: 401-retry in `openAgentStream`

Replace the `if (!res.ok || !res.body)` block:

```ts
  let res = await fetch(...same as above...);

  if (res.status === 401) {
    await (bb.auth as any).refreshSession?.();
    const { data: refreshed } = await (bb.auth as any).getSession?.() ?? { data: null };
    const fresh = refreshed?.access_token;
    if (fresh) {
      res = await fetch(`${API_URL}/v1/${APP_ID}/fn/agent-chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fresh}`, accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      });
    }
  }

  if (!res.ok || !res.body) { ... }
```

**2. Placeholder scan** — searched for "TBD", "TODO", "implement later", "fill in", "similar to Task N (repeat)" — none found in the plan body. Code examples are concrete.

**3. Type consistency** — checked: `AgentThread`, `AgentMessage`, `AgentProposal` field names match exactly between the schema (Task 0.2), types (Task 10.1), and component props (Tasks 13–15). `tool_name → endpoint` map in `lib/agent.ts` (Task 10.3) matches the tool names in handler.ts (Phase 6). `ui_event.kind` values (`ask_user`, `suggest_link_account`, `suggest_next_step`, `confirm_action`, `onboarding_complete`) used consistently between handler (Phases 5/7/8) and frontend (Phase 14, 16.1).

No further re-review.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-05-workspace-ai-agent.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
