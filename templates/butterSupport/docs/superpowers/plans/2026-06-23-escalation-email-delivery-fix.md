# Escalation Email Delivery Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get an email reliably delivered to the configured escalation target when a ticket is escalated — currently the entire pipeline silently no-ops.

**Architecture:** Four independent breakages in the escalation pipeline (DO → substrate propose → substrate outbox webhook → `execute-escalation` fn → Composio Gmail). We fix each one bottom-up: (1) make the DO surface substrate propose failures instead of swallowing them, (2) capture `connected_user_id` + correct config shape when adding an email target, (3) write the config in the shape `execute-escalation` actually reads, (4) register the substrate outbox webhook + HMAC secret so substrate actually calls the function. Each task is testable on its own.

**Tech Stack:** Butterbase platform (Postgres + Functions + DOs + Composio integrations), React 18 + TanStack Query frontend, Cloudflare DurableObject backend (JS, no TS).

## Global Constraints

- App id: `app_0ycj4ad7odud`. Subdomain: `butter-support.butterbase.dev`.
- The DO source lives ONLY on the Butterbase platform — `mcp__butterbase__manage_durable_objects` (`action: "deploy"`) is the only way to update it. There is no copy of `support-ticket-do` in this repo.
- The `execute-escalation` function also lives only on the platform — use `mcp__butterbase__deploy_function` to update it. There is no source-of-truth file in the repo to edit; the function code in Task 4 is the new full source.
- The widget/frontend writes against the auto-generated REST API; the DO uses `BUTTERBASE_API_KEY` (service role). RLS is enabled on `escalation_targets` for admins only — UI writes pass because the founder is an `owner` per `memberships`.
- The `escalation_targets.config` jsonb shape MUST be `{ to: string, cc?: string, connected_user_id: uuid }` for `channel='email'` and `{ channel_id: string, mention_user_id?: string, connected_user_id: uuid }` for `channel='slack'`. This is the contract `execute-escalation` reads — both writer (UI) and reader (function) must agree.
- The substrate outbox webhook URL for capability `support.escalate_to_human` is `https://butter-support.butterbase.dev/execute-escalation`. The shared HMAC secret is stored in env var `SUBSTRATE_OUTBOX_SECRET` on the function.
- Do not change the DO's tool surface (`propose_escalation` signature stays `{ reason, urgency }`); we only change error-handling inside `toolPropose_escalation`.
- Existing rows: there is ONE existing `escalation_targets` row with bad config (`{ email: "kcflexigbo@gmail.com" }`) — Task 3 includes a one-shot data migration to fix it in place rather than asking the user to re-add.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/console/routes/settings/Escalation.tsx` | UI for adding/listing escalation targets; Task 2 + 3 changes |
| Platform DO `support-ticket-do` (deployed via MCP) | Task 1: `toolPropose_escalation` surfaces substrate failures |
| Platform function `execute-escalation` (deployed via MCP) | Task 4: deployed code is unchanged from current; env var added + Task 5 reviews end-to-end |
| Platform substrate outbox config (Butterbase console action — not a repo file) | Task 4: register webhook + secret for `support.escalate_to_human` |
| `escalation_targets` row (data migration via MCP `select_rows` + `bb` UPDATE) | Task 3: rewrite existing bad row's config |

Tasks are ordered for safe rollout: error-surfacing first (so subsequent testing isn't silent), UI/data shape next, substrate webhook last (the moment substrate starts firing, the rest must already be correct).

---

## Task 1: Surface substrate-propose failures in `toolPropose_escalation`

**Files:**
- Modify: Platform DO `support-ticket-do` — `toolPropose_escalation` method (current source returned by `mcp__butterbase__manage_durable_objects get name=support-ticket-do`)
- Deploy via: `mcp__butterbase__manage_durable_objects` action=`deploy`

**Interfaces:**
- Consumes: nothing new; reads `this.env.BUTTERBASE_API_URL`, `this.env.BUTTERBASE_APP_ID`, the same `/v1/me/substrate/actions/propose` endpoint.
- Produces: `toolPropose_escalation(args)` now returns `{ ok: boolean, substrate_action_id: string|null, error?: string }`. When the substrate propose call fails (non-2xx OR network error), `ok=false`, `error` is set, the DO emits `{ type: 'error', reason: 'escalation_propose_failed', message }` on the WS, writes a `system`-role row to `support_messages` via `logSystemError('escalation','propose_failed', msg)`, and **does NOT** flip the ticket to `escalated`. When it succeeds, behavior is identical to today (`status='escalated'`, emit `escalation` event).

- [ ] **Step 1: Fetch the current DO source**

Run via MCP: `mcp__butterbase__manage_durable_objects` with `{ app_id: "app_0ycj4ad7odud", action: "get", name: "support-ticket-do" }`. Copy the `code` field verbatim into a scratch buffer — this is the file you will edit. You only need to change `toolPropose_escalation`.

- [ ] **Step 2: Replace `toolPropose_escalation` with the error-surfacing version**

Find this method in the source (search for `async toolPropose_escalation(args) {`). Replace the WHOLE method body with:

```js
  async toolPropose_escalation(args) {
    const tctx = await this.loadTicketContext();
    let diagnosisSummary = null;
    let diagnosisConfidence = null;
    try {
      const diagnoses = await this.apiGet(`diagnoses?ticket_id=eq.${this.ticketId}&superseded_at=is.null&order=produced_at.desc&limit=1&select=summary,confidence`);
      diagnosisSummary = diagnoses?.[0]?.summary;
      diagnosisConfidence = diagnoses?.[0]?.confidence;
    } catch {}

    const ctxSnap = {
      who: tctx.ticket?.customer_email,
      subject: tctx.ticket?.subject,
      diagnosis: diagnosisSummary,
      diagnosis_confidence: diagnosisConfidence,
      reason: args.reason,
      urgency: args.urgency || 'normal'
    };

    let actionId = null;
    let proposeError = null;
    try {
      const subRes = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/me/substrate/actions/propose`, {
        method: 'POST', headers: this.apiHeaders(),
        body: JSON.stringify({
          capability: 'support.escalate_to_human',
          payload: { ticket_id: this.ticketId, reason: args.reason, urgency: args.urgency || 'normal', context_snapshot: ctxSnap },
          idempotency_key: `escalate:${this.ticketId}:${Date.now()}`
        })
      });
      if (subRes.ok) {
        const d = await subRes.json();
        actionId = d.action_id || null;
      } else {
        const txt = await subRes.text().catch(() => '');
        proposeError = `substrate ${subRes.status}: ${txt.slice(0, 300)}`;
      }
    } catch (err) {
      proposeError = `substrate_propose_threw: ${err?.message || err}`;
    }

    if (proposeError) {
      console.error('[SupportTicketDO] toolPropose_escalation failed', proposeError);
      await this.logSystemError('escalation', 'propose_failed', proposeError);
      this.emit({ type: 'error', reason: 'escalation_propose_failed', message: proposeError });
      return { ok: false, substrate_action_id: null, error: proposeError };
    }

    await this.apiPatch('support_tickets', this.ticketId, { status: 'escalated' }).catch((e) => {
      console.error('[SupportTicketDO] patch ticket escalated failed', e?.message);
    });
    this.emit({ type: 'escalation', reason: args.reason, urgency: args.urgency || 'normal', substrate_action_id: actionId });
    return { ok: true, substrate_action_id: actionId };
  }
```

Key changes from current code: (a) capture `proposeError` instead of silently `console.warn`; (b) on error, do NOT patch ticket to `escalated`, emit a WS error frame, write a `system` message; (c) return `{ ok, error? }` so the calling tool-runner records a real failure in `agent_messages`.

- [ ] **Step 3: Deploy the updated DO**

Run via MCP: `mcp__butterbase__manage_durable_objects` with `{ app_id: "app_0ycj4ad7odud", action: "deploy", name: "support-ticket-do", code: <full edited source> }`. Expected: response `status: "READY"`, `class_name: "SupportTicketDO"`.

- [ ] **Step 4: Smoke-test failure surfacing (no substrate webhook yet — propose WILL fail)**

Open the console UI in a browser, open any existing ticket (`status='resolved'` is fine — re-trigger from the inbox), click the "Escalate" affordance OR send WS command `{cmd:'escalate', reason:'plan smoke test'}` from devtools. Expected: a `system`-role message appears under the ticket reading `Agent errored at escalation: propose_failed — substrate …`; ticket status stays whatever it was (NOT flipped to `escalated`); an `error` toast/log appears in the LiveAgentStream component.

Verify via MCP: `mcp__butterbase__select_rows` `{ app_id: "app_0ycj4ad7odud", table: "support_messages", filters: { role: "eq.system" }, order: "created_at.desc", limit: 3 }` — should show the new `Agent errored at escalation` row.

- [ ] **Step 5: Commit (no repo changes for this task — DO code lives only on platform)**

Skip — this task changes platform state only. Note the deployed `updated_at` timestamp from Step 3 in `docs/butterbase/04-build-log.md` instead:

```bash
# append to docs/butterbase/04-build-log.md
# | <ISO timestamp> | durable | manage_durable_objects deploy name=support-ticket-do | ok — toolPropose_escalation now surfaces substrate failures (no longer swallows; WS error + system message + does not flip ticket to escalated). |
```

Then commit the build-log change:

```bash
git add docs/butterbase/04-build-log.md
git commit -m "chore(build-log): record DO redeploy — escalation failures now surface"
```

---

## Task 2: Capture connected Gmail account when adding an email escalation target

**Files:**
- Modify: `frontend/src/console/routes/settings/Escalation.tsx` (whole file, focused changes around `add()`, `useState`s, the form JSX)

**Interfaces:**
- Consumes: `bb.auth.getUser()` returns `{ id: uuid, email?: string, ... }` (proven by `frontend/src/console/components/AuthGate.tsx:27`). `bb.integrations.listConnections()` returns `{ data: Array<{ id, toolkit_slug, status?, connected_at? }> }` (proven by `frontend/src/console/routes/settings/Integrations.tsx:35`). The connecting team-member's `user_id` for the gmail toolkit equals the currently signed-in user's id, because connections are per-user (per Integrations.tsx: "Each connection is scoped to you").
- Produces: For Task 3 — `Escalation.tsx` form state now also tracks `gmailConnected: boolean` (derived from `bb.integrations.listConnections()`), and `add()` reads `bb.auth.getUser()` synchronously inside the handler to capture `connected_user_id`.

- [ ] **Step 1: Read the current file to confirm starting point**

```bash
cat frontend/src/console/routes/settings/Escalation.tsx | head -50
```

Confirm `add()` body at lines 25–38 still matches the version this plan was written against (config built as `channel === 'email' ? { email: target } : ...`).

- [ ] **Step 2: Add the gmail-connection lookup query at the top of the component**

Edit `frontend/src/console/routes/settings/Escalation.tsx`. After the existing `useQuery({ queryKey: ['escalation_targets'], ... })` block (line ~23), insert a second query:

```tsx
  const { data: gmailConn } = useQuery({
    queryKey: ['integration_connections', 'gmail'],
    queryFn: async () => {
      const res: any = await bb.integrations.listConnections();
      const conns = (res?.data ?? []) as Array<{ id: string; toolkit_slug: string; status?: string }>;
      const active = conns.find((c) => c.toolkit_slug === 'gmail' && (c.status === 'ACTIVE' || !c.status));
      return active || null;
    },
  });
  const gmailConnected = !!gmailConn;
```

- [ ] **Step 3: Block adding an email target when Gmail isn't connected**

Replace the existing `add()` function (currently lines 25–38) with this version. It (a) refuses to add an email target until Gmail is connected, (b) captures the current user id for `connected_user_id`, (c) writes config in the shape `execute-escalation` reads:

```tsx
  async function add() {
    setBusy(true);
    try {
      if (channel === 'email' && !gmailConnected) {
        alert('Connect Gmail in Settings → Integrations before adding an email target. The escalation will be sent from your Google account.');
        return;
      }
      const userRes: any = await bb.auth.getUser();
      const connectedUserId = userRes?.data?.id || userRes?.id || userRes?.user?.id || null;
      if ((channel === 'email' || channel === 'slack') && !connectedUserId) {
        alert('Could not resolve your user id — try signing out and back in.');
        return;
      }
      let config: Record<string, unknown>;
      if (channel === 'slack') config = { channel_id: target, connected_user_id: connectedUserId };
      else if (channel === 'email') config = { to: target, connected_user_id: connectedUserId };
      else config = { url: target };
      await bb.from('escalation_targets').insert({ channel, config, is_default: targets.length === 0 });
      setTarget('');
      qc.invalidateQueries({ queryKey: ['escalation_targets'] });
    } catch (e: any) {
      alert(e?.message || 'Add failed');
    } finally {
      setBusy(false);
    }
  }
```

(Note: the existing Slack target shape was `{ slack_channel: target }` — `execute-escalation` reads `channel_id` instead. We harmonize Slack too so the future Slack path also works.)

- [ ] **Step 4: Add a banner explaining the Gmail dependency**

In the JSX return, find the `<Card>` for "Add target" (currently around line 68). Replace the `<CardContent className="space-y-2">` opening block with one that includes a banner ABOVE the form when channel=email and gmail is not connected:

```tsx
        <CardContent className="space-y-2">
          {channel === 'email' && !gmailConnected && (
            <div className="rounded border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber-foreground">
              Email escalation sends through your connected Gmail account. <a href="/settings/integrations" className="underline">Connect Gmail</a> first.
            </div>
          )}
          <div className="flex gap-2">
```

(Leave the rest of the `CardContent` content unchanged.)

- [ ] **Step 5: Manually verify in the browser**

```bash
cd frontend && npm run dev
```

Navigate to `/settings/escalation`. Verify: (a) with Gmail NOT connected, selecting "Email" channel shows the amber banner; clicking Add with an email shows the "Connect Gmail" alert and does not insert a row; (b) connect Gmail at `/settings/integrations`, return to `/settings/escalation`, banner disappears, Add inserts a row with config `{ to: "...", connected_user_id: "<your-user-id>" }`. Confirm via MCP:

`mcp__butterbase__select_rows { app_id: "app_0ycj4ad7odud", table: "escalation_targets", order: "created_at.desc", limit: 3 }`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/console/routes/settings/Escalation.tsx
git commit -m "feat(escalation): require connected Gmail + write config in execute-escalation shape"
```

---

## Task 3: Migrate the existing bad `escalation_targets` row

**Files:**
- Data only (no repo file). Run via MCP.

**Interfaces:**
- Consumes: the current user (founder) IS the team member who will connect Gmail; their `user_id` becomes the `connected_user_id` for the migrated row.
- Produces: the existing default email target now has config in the new shape so `execute-escalation` can read it.

- [ ] **Step 1: Find the current user's id (the founder who set up the app)**

The escalation_targets row was inserted with `created_by: null`, so we can't recover the user id from the row itself. Read it from the `memberships` table — there's exactly one `role='owner'`:

`mcp__butterbase__select_rows { app_id: "app_0ycj4ad7odud", table: "memberships", filters: { role: "eq.owner" }, limit: 1 }`

Record the returned `user_id`. Call it `<OWNER_USER_ID>` below.

- [ ] **Step 2: Confirm Gmail is connected for that user**

After Task 2 step 5 the founder will have connected Gmail. Verify via MCP:

`mcp__butterbase__select_rows { app_id: "app_0ycj4ad7odud", table: "team_integrations", filters: { toolkit_slug: "eq.gmail" }, limit: 5 }`

Expect at least one row with `user_id = <OWNER_USER_ID>`. If empty, the founder must connect Gmail before this task can proceed.

- [ ] **Step 3: Update the existing row's config**

Use the auto-API via curl, since MCP doesn't expose a generic PATCH. The existing target id is `e0fd22d8-65ca-4b6d-aa6b-6c98f62dc4c2` (from research). Run:

```bash
curl -X PATCH \
  "https://api.butterbase.ai/v1/app_0ycj4ad7odud/escalation_targets/e0fd22d8-65ca-4b6d-aa6b-6c98f62dc4c2" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"config":{"to":"kcflexigbo@gmail.com","connected_user_id":"<OWNER_USER_ID>"}}'
```

Substitute the real `<OWNER_USER_ID>` from Step 1.

- [ ] **Step 4: Verify the migration**

`mcp__butterbase__select_rows { app_id: "app_0ycj4ad7odud", table: "escalation_targets", limit: 5 }`

Expect: row `e0fd22d8…` now has `config: { to: "kcflexigbo@gmail.com", connected_user_id: "<OWNER_USER_ID>" }`, `is_default: true`, `active: true`.

- [ ] **Step 5: Commit (build-log only)**

Append a line to `docs/butterbase/04-build-log.md`:

```
| <ISO timestamp> | data | PATCH escalation_targets e0fd22d8… config | ok — migrated to {to, connected_user_id} shape required by execute-escalation. |
```

```bash
git add docs/butterbase/04-build-log.md
git commit -m "chore(data): migrate escalation_targets row to new config shape"
```

---

## Task 4: Register the substrate outbox webhook + set HMAC secret

**Files:**
- Platform substrate config (substrate owner: `249d87fa-a4a9-4456-b647-f05221472bc8`, same substrate as `butterbase-crm`).
- Modify env on platform function `execute-escalation` via `mcp__butterbase__manage_function` action=`update_env`.

**Interfaces:**
- Consumes: nothing in code; this is platform plumbing.
- Produces: when the DO POSTs `support.escalate_to_human` to `/v1/me/substrate/actions/propose`, substrate's outbox now calls `https://butter-support.butterbase.dev/execute-escalation` with an `X-Butterbase-Signature: sha256=…` header signed using `SUBSTRATE_OUTBOX_SECRET`. The function validates HMAC, looks up the target, sends Gmail, writes the `escalations` row.

- [ ] **Step 1: Generate a strong secret**

```bash
openssl rand -hex 32
```

Copy the output — call it `<SECRET>`. This is the shared secret between substrate and the function.

- [ ] **Step 2: Set the secret on the `execute-escalation` function**

Run via MCP: `mcp__butterbase__manage_function` with:

```json
{ "app_id": "app_0ycj4ad7odud", "action": "update_env", "function_name": "execute-escalation", "env": { "SUBSTRATE_OUTBOX_SECRET": "<SECRET>" } }
```

Verify by running `mcp__butterbase__manage_function get function_name=execute-escalation` and confirming `envKeys` now contains `SUBSTRATE_OUTBOX_SECRET`.

- [ ] **Step 3: Register the outbox target on substrate**

This is a substrate-owner action — there is NO MCP wrapper for substrate outbox-target registration in our tool set. Use `mcp__butterbase__manage_substrate` if it supports outbox-target registration; otherwise hit the substrate REST API directly with the substrate service key. The registration payload:

```json
{
  "capability": "support.escalate_to_human",
  "target": {
    "kind": "webhook",
    "url": "https://butter-support.butterbase.dev/execute-escalation",
    "secret": "<SECRET>",
    "hmac_header": "X-Butterbase-Signature",
    "hmac_format": "sha256=hex"
  },
  "idempotency_scope": "substrate_outbox"
}
```

First check available actions: `mcp__butterbase__manage_substrate` with `{ action: "list" }` (or whatever the introspection action is) — find the outbox-target action. If it does not exist, the substrate owner must register the target via the substrate admin UI manually — capture the URL + paste the secret there.

- [ ] **Step 4: Verify the substrate target is live by triggering an end-to-end escalation**

In the console UI, open ANY existing ticket and force escalation (click escalate, or `cmd:'escalate'` over WS). Expected sequence:
1. DO logs `[SupportTicketDO] toolPropose_escalation` call.
2. Substrate accepts the propose, returns `{ action_id: "act_…" }`.
3. Substrate outbox fires within seconds.
4. `execute-escalation` logs the inbound request (verify with `mcp__butterbase__manage_function get_logs function_name=execute-escalation limit=20`).
5. `escalations` table gains one row with `status='sent'`, `sent_at=<now>`.
6. Email lands in `kcflexigbo@gmail.com` inbox with subject `Support escalation: <ticket subject>`.
7. `support_tickets.status` for the ticket becomes `'escalated'`.

If step 4 shows `bad_signature`, the secret in substrate ≠ env. If step 4 shows `target missing connected_user_id`, Task 3 wasn't applied — re-check the row. If step 4 shows `Gmail integration error`, the founder's Gmail Composio token expired — reconnect at `/settings/integrations`.

- [ ] **Step 5: Append the build-log entry and commit**

```
| <ISO timestamp> | substrate | outbox-target register cap=support.escalate_to_human url=…/execute-escalation | ok — HMAC secret set on function env; end-to-end smoke delivered email to kcflexigbo@gmail.com (escalations.id=<id>, status=sent). |
```

```bash
git add docs/butterbase/04-build-log.md
git commit -m "chore(build-log): record substrate outbox registration for escalate_to_human"
```

---

## Task 5: End-to-end sanity test + failure-mode coverage

**Files:**
- No code. Pure verification.

**Interfaces:** none.

- [ ] **Step 1: Happy path**

Open a new fake ticket via the widget (or insert a `support_tickets` row via MCP). Send a customer message via WS. Let the agent run — when it calls `propose_escalation` (or when you force it), verify the email arrives within ~30s and the ticket flips to `escalated`. Capture the `escalations` row id.

- [ ] **Step 2: Bad-target failure mode**

Temporarily flip the existing target's `active=false`:

```bash
curl -X PATCH "https://api.butterbase.ai/v1/app_0ycj4ad7odud/escalation_targets/e0fd22d8-65ca-4b6d-aa6b-6c98f62dc4c2" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"active":false}'
```

Force-escalate another ticket. Expected: `execute-escalation` falls through to the safety-floor path — writes an `escalations` row with `status='failed'`, error `no_escalation_target_configured`, AND writes an `activities` row with `kind='unescalated_block'`. Verify both via `select_rows`. Restore `active=true` after.

- [ ] **Step 3: HMAC failure mode**

Hit `execute-escalation` directly with a garbage signature:

```bash
curl -i -X POST https://butter-support.butterbase.dev/execute-escalation \
  -H "X-Butterbase-Signature: sha256=deadbeef" \
  -H "Content-Type: application/json" \
  -d '{"action_id":"test","payload":{"ticket_id":"00000000-0000-0000-0000-000000000000"}}'
```

Expected: HTTP 401 `{"error":"bad_signature"}`. Confirms HMAC is enforced.

- [ ] **Step 4: Substrate propose failure mode (regression check on Task 1)**

Temporarily break the substrate path by stopping substrate auth (or rename the capability in the DO source to a bogus name and redeploy). Force-escalate. Expected (per Task 1): WS `error` frame `escalation_propose_failed`, `support_messages` system row, ticket NOT flipped to `escalated`. Revert the rename after.

- [ ] **Step 5: Commit final build-log entry**

```
| <ISO timestamp> | verify | end-to-end escalation E2E + 3 failure-mode smokes | ok — happy path sends Gmail, no-target writes unescalated_block, bad HMAC 401s, substrate-down surfaces error. |
```

```bash
git add docs/butterbase/04-build-log.md
git commit -m "chore(build-log): verify escalation pipeline end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** All four breakages identified in the research call (silent propose failure, missing connected_user_id, wrong config key, missing substrate webhook) are mapped to Tasks 1, 2, 3, and 4 respectively. Task 5 catches regressions.
- **Type consistency:** `escalation_targets.config` shape `{ to, connected_user_id, cc? }` is identical across `Escalation.tsx` (Task 2), the data migration (Task 3), and the reader in `execute-escalation` (verified against the deployed source).
- **Ordering hazard:** Task 4 (substrate webhook) MUST come after Tasks 2+3, or the very first escalation that fires will hit an active substrate path but a bad target row and write a `status='failed'` escalation that's harder to retry. Task 1 also goes first so that any substrate failures during Task 4 verification are loud.
- **Out of scope (deliberate):** no owner-as-implicit-fallback target — the existing `escalation_targets` row already names the owner's email, so the explicit-target path is sufficient for v1. If future work wants "always email the owner even if no target row exists," that's a separate task to add a `memberships` lookup inside the `if (!target)` branch of `execute-escalation`.
