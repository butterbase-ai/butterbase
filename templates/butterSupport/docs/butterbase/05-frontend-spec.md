# Frontend Build Spec — Butterbase Support Recipe

**Audience:** A fresh Claude Code session that will be spawned with this doc as its only context. Build the frontend in `frontend/` directory.

**Project root:** `/Users/kenneth/Documents/butterSupport`

**Backend status:** Already deployed. All 23 functions, the SupportTicketDO, the platform agent, schema (20 tables), RLS, auth, RAG collection, realtime — all live in `app_0ycj4ad7odud` (subdomain `butter-support.butterbase.dev`). You're building the UI that talks to it.

**Read first before building:**
- `docs/butterbase/02-plan.md` — full plan (skim the "Frontend" section in detail)
- `docs/butterbase/04-build-log.md` — what's deployed
- `docs/butterbase/06-v1-deferred.md` — known limitations to NOT try to fix

---

## 1. Stack (locked)

| Tool | Version target |
|---|---|
| Vite | latest 5.x |
| React + ReactDOM | 18.x |
| TypeScript | 5.x |
| @butterbase/sdk | latest stable |
| react-router | v7 |
| @tanstack/react-query | v5 |
| tailwindcss | v3 |
| lucide-react | latest |
| shadcn/ui components | **copy-in to `src/components/ui/`**, not as a dep |
| zustand | latest (for transient UI state like open WS connection) |
| date-fns | latest (for relative timestamps) |

No additional deps. Reject the urge to add ones not on this list.

## 2. Project structure

Create the project at `/Users/kenneth/Documents/butterSupport/frontend/`.

```
frontend/
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── vite.config.ts          # Multi-entry: console + widget
├── index.html              # Console SPA entry
├── widget.html             # Widget IIFE entry (built to widget.js)
├── zip-dist.js             # Node archiver script for deploy zip
├── .env.example
├── README.md
└── src/
    ├── console/
    │   ├── main.tsx        # Console root
    │   ├── App.tsx         # Router + AuthGate
    │   ├── lib/
    │   │   ├── bb.ts       # createClient + exported instance
    │   │   ├── api.ts      # Function wrappers (typed)
    │   │   ├── do-ws.ts    # DO WebSocket client hook
    │   │   └── types.ts    # Shared TS types matching schema
    │   ├── routes/
    │   │   ├── Login.tsx
    │   │   ├── Setup.tsx           # 3-step wizard
    │   │   ├── NoAccess.tsx
    │   │   ├── Inbox.tsx
    │   │   ├── TicketDetail.tsx
    │   │   ├── Patterns.tsx
    │   │   └── settings/
    │   │       ├── Team.tsx
    │   │       ├── Widget.tsx
    │   │       ├── Docs.tsx
    │   │       ├── Skill.tsx       # OK to stub for v1 — placeholder UI
    │   │       ├── Autonomy.tsx    # OK to stub
    │   │       ├── Escalation.tsx
    │   │       ├── Integrations.tsx # OK to stub
    │   │       └── AI.tsx
    │   ├── components/
    │   │   ├── AuthGate.tsx
    │   │   ├── AppLayout.tsx
    │   │   ├── TicketList.tsx
    │   │   ├── TicketDetailLayout.tsx
    │   │   ├── ConversationThread.tsx
    │   │   ├── LiveAgentStream.tsx
    │   │   ├── DiagnosisCard.tsx
    │   │   ├── DraftReplyEditor.tsx
    │   │   ├── ProposalCard.tsx
    │   │   ├── EscalationBar.tsx
    │   │   ├── PatternBanner.tsx
    │   │   └── ui/                  # shadcn primitives — copy from shadcn.com
    │   │       ├── button.tsx
    │   │       ├── card.tsx
    │   │       ├── dialog.tsx
    │   │       ├── input.tsx
    │   │       ├── textarea.tsx
    │   │       ├── badge.tsx
    │   │       ├── tabs.tsx
    │   │       ├── select.tsx
    │   │       └── separator.tsx
    │   └── styles.css      # Tailwind base
    └── widget/
        ├── main.tsx        # Widget IIFE entry
        ├── Widget.tsx      # Root component reading data-* attrs
        ├── components/
        │   ├── LauncherButton.tsx
        │   ├── WidgetPanel.tsx
        │   ├── MessageThread.tsx
        │   ├── MessageComposer.tsx
        │   └── CitationFooter.tsx
        └── styles.css      # Tailwind tree-shaken
```

## 3. Vite multi-entry config

`vite.config.ts` must build:
- Console as SPA from `index.html` → `dist/` with hashed assets
- Widget as IIFE from `widget.html` → `dist/widget.js` (single file, with CSS inlined)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        console: resolve(__dirname, 'index.html'),
        widget: resolve(__dirname, 'widget.html'),
      },
      output: {
        // Widget gets stable filename for the embed snippet
        entryFileNames: (chunk) => chunk.name === 'widget' ? 'widget.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
```

Also write a `_redirects` file in `public/` containing:
```
/widget.js  /widget.js  200
/widget.css /widget.css 200
/*          /index.html 200
```
So Cloudflare Pages doesn't fallback `/widget.js` to the SPA.

## 4. Env vars

`.env.example` (and `.env.local` for dev):
```
VITE_BUTTERBASE_APP_ID=app_0ycj4ad7odud
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
VITE_BUTTERBASE_SUBDOMAIN=butter-support
```

Console uses these to construct API + WS URLs.

## 5. The Butterbase client (`src/console/lib/bb.ts`)

```ts
import { createClient } from '@butterbase/sdk';

export const bb = createClient({
  appId: import.meta.env.VITE_BUTTERBASE_APP_ID,
  apiUrl: import.meta.env.VITE_BUTTERBASE_API_URL,
});

export const API_URL = import.meta.env.VITE_BUTTERBASE_API_URL;
export const APP_ID = import.meta.env.VITE_BUTTERBASE_APP_ID;
export const SUBDOMAIN = import.meta.env.VITE_BUTTERBASE_SUBDOMAIN;
```

## 6. Auth flow

`AuthGate.tsx` wraps the entire console. Logic:
1. On mount: `bb.auth.getUser()` → if no user, route to `/login`.
2. If user: call `bb.from('memberships').select('role').eq('user_id', user.id).limit(1)`. If no row → `/no-access`. If row → set role in context.
3. Subscribe `bb.onAuthStateChange` to keep state fresh.

`Login.tsx`: input email → `bb.auth.sendMagicLink(email)` → show "check email" screen with 6-digit code input → `bb.auth.verifyMagicLink(email, code)` → on success, route to `/`.

`NoAccess.tsx`: friendly message "You're authenticated but not on the support team. Ask your admin to invite you."

## 7. Routes

| Route | Component | Purpose |
|---|---|---|
| `/login` | Login | Magic-link entry |
| `/setup` | Setup | 3-step wizard (route here if user is owner AND memberships count = 1 AND no docs_sources rows) |
| `/no-access` | NoAccess | For authenticated-but-unmembered |
| `/` | redirect to `/inbox` | — |
| `/inbox` | Inbox | Ticket list |
| `/inbox/:ticket_id` | TicketDetail | Per-ticket workspace |
| `/patterns` | Patterns | Surfaced cross-cutting patterns |
| `/settings/team` | settings/Team | Invite + list + remove members |
| `/settings/widget` | settings/Widget | Show install snippet + rotate-widget-secret button |
| `/settings/docs` | settings/Docs | List sources + paste URL + upload file |
| `/settings/skill` | settings/Skill | **Stub OK** — placeholder "coming soon" with the read-only current skill JSON visible |
| `/settings/autonomy` | settings/Autonomy | **Stub OK** — show current autonomy_settings rows read-only |
| `/settings/escalation` | settings/Escalation | List + add escalation_targets |
| `/settings/integrations` | settings/Integrations | **Stub OK** — read-only list of team_integrations |
| `/settings/ai` | settings/AI | Call `fetch-ai-usage` function, render usage |

## 8. API surface (function endpoints)

All calls go through `bb.functions.invoke(name, { body })` (which POSTs to `/v1/{app_id}/fn/{name}` with the user's JWT).

| Function | Body | Where used |
|---|---|---|
| `widget-ingest`, `widget-followup`, `widget-fetch-history`, `widget-poll-replies` | Public/HMAC | Widget only |
| `rotate-widget-secret` | `{}` | `/settings/widget` |
| `request-doc-upload-url` | `{filename, content_type, size_bytes}` | `/settings/docs` upload flow |
| `ingest-docs` | `{url?, source_kind, display_name?, object_id?, text?}` | `/settings/docs` |
| `delete-docs-source` | `{source_id}` | `/settings/docs` |
| `invite-teammate` | `{email, default_role, send_email?}` | `/settings/team` |
| `remove-teammate` | `{user_id, remove_from_allowlist?}` | `/settings/team` |
| `fetch-ai-usage` | (query: `?startDate=&endDate=`) | `/settings/ai` |
| `substrate-proxy` | `{action: "findEntities"|"searchMemory"|..., params: {...}}` | TicketDetail customer card |
| `approve-proposal` | `{proposal_id}` | TicketDetail ProposalCard |
| `reject-proposal` | `{proposal_id, reason?}` | TicketDetail ProposalCard |
| `send-draft-reply` | `{ticket_id, draft_message_id?, edited_body?, mark_as_resolved?}` | TicketDetail DraftReplyEditor send button |
| `mark-as-commitment` | `{ticket_id, message_id, due_date?, title?, content?}` | TicketDetail message context menu |
| `convert-to-policy` | `{title, content, scope?, rationale?, source_ticket_id?}` | TicketDetail "save as policy" affordance |

## 9. Realtime subscriptions (in `Inbox.tsx` + `TicketDetail.tsx`)

Use `bb.realtime.subscribe(table, callback)`. RLS-enforced — team members see all team rows.

In `Inbox.tsx`: subscribe to `support_tickets` and `agent_proposals`. On any change, invalidate the TanStack Query key for the ticket list.

In `TicketDetail.tsx`: subscribe to `support_messages`, `diagnoses`, `escalations`, `agent_proposals` filtered by `ticket_id=<current>`. Invalidate the per-ticket queries.

WebSocket URL: `wss://api.butterbase.ai/v1/${APP_ID}/realtime?token=${userJwt}`.

## 10. Durable Object WebSocket (`do-ws.ts` hook)

Opened from `TicketDetail.tsx` mount; closed on unmount.

URL: `wss://${SUBDOMAIN}.butterbase.dev/_do/support-ticket-do/${ticket_id}?token=${userJwt}`

Server frames (from `SupportTicketDO`):
| Type | Shape |
|---|---|
| `hello` | `{type:'hello', ticket_id, session_id, agent_state}` |
| `state` | `{type:'state', agent_state}` |
| `agent_message` | `{type:'agent_message', role:'assistant', content, tool_calls?}` |
| `tool_call_start` | `{type:'tool_call_start', tool, args}` |
| `tool_call_result` | `{type:'tool_call_result', tool, result}` |
| `diagnosis` | `{type:'diagnosis', diagnosis: {...row}}` |
| `draft_proposed` | `{type:'draft_proposed', message: {...row}, confidence}` |
| `followup_question_proposed` | `{type:'followup_question_proposed', message}` |
| `escalation` | `{type:'escalation', reason, urgency, substrate_action_id}` |
| `error` | `{type:'error', reason, message?, current_driver?}` |
| `heartbeat_ack` | `{type:'heartbeat_ack'}` |

Client frames (commands to DO):
- `{cmd:'diagnose', hint?}`
- `{cmd:'draft', hint?}`
- `{cmd:'rerun_with_hint', hint}`
- `{cmd:'escalate', reason}`
- `{cmd:'heartbeat'}` — send every 30s

On `error reason='driven_by_other_user'`: render the read-only banner. Listen to Postgres Realtime for ticket state instead.

`useTicketDoWs(ticket_id)` hook returns `{state, events, send(cmd), connected}`.

## 11. Component specs

### `AppLayout`
Sidebar: Inbox / Patterns / Settings / user menu (avatar, sign out).
Top bar: workspace name (`butter-support`), search (not implemented yet — placeholder), keyboard-shortcut helper (later).
Main: `<Outlet />`.

### `TicketList` (Inbox.tsx)
Virtualized table (use TanStack Virtual or just CSS overflow + reasonable pagination — virtualization optional for v1).
Columns: status badge, customer email, subject (or first line of last message), last_message_at relative, priority, pending-proposal badge count.
Sort: `last_message_at desc`. Filter by status (chips at top).
Row click → `/inbox/:ticket_id`.

### `TicketDetail`
Split-pane (CSS grid):
- **Left (60%):** Conversation thread (top, scrollable) + draft editor / approval bar (bottom, sticky).
- **Right (40%):** Tabs — "Agent activity" (live WS stream) | "Diagnosis" | "Customer" | "Proposals".

Top: ticket meta (subject, customer email, status badge, "Open in widget" link). Buttons: Diagnose / Draft / Escalate / Rerun-with-hint / Resolve.

### `ConversationThread`
Renders `support_messages` ordered by `created_at`. Visual differentiation by `role`:
- `customer`: left-aligned, light background
- `agent_draft`: orange/amber tinted with "AWAITING APPROVAL" tag
- `founder`: right-aligned, blue tinted
- `system`: muted, italic, center

Each message: body (markdown via `react-markdown`), timestamp, sender, role-context menu (mark-as-commitment).

### `LiveAgentStream`
Renders WS events as a chronological feed:
- `tool_call_start` → expandable card "Calling search_docs with query: ..."
- `tool_call_result` → "Returned 8 chunks, top score 0.83"
- `agent_message` → assistant turn (collapsible body)
- `state` → state-change badge
- `error` → red error block

### `DiagnosisCard`
Pulls latest `diagnoses` row where `superseded_at IS NULL` for current ticket. Confidence badge color (high=green, med=amber, low=red). Evidence list (collapsible). "Rerun with hint" textarea + button → sends DO command.

### `DraftReplyEditor`
If a `support_messages` row exists for current ticket with `role='agent_draft'` and no founder-sent message after it:
- Show the draft body in a markdown editor (textarea + preview tab).
- Buttons: Send | Send + Mark Resolved | Reject (deletes draft row) | Re-prompt.
- "Send" calls `send-draft-reply` with `{ticket_id, draft_message_id, edited_body, mark_as_resolved}`.
- "Send + Mark Resolved" calls the same with `mark_as_resolved=true`. No distillation prompt — cross-ticket learnings are projected by the `sweep-pattern-signals` cron, not at resolution time.

### `ProposalCard`
Per row in `agent_proposals` where status=`pending` for current ticket.
Shows: capability, payload (formatted), rationale, "Approve" / "Reject" buttons.
Approve calls `approve-proposal`. Reject opens reason input + `reject-proposal`.

### `EscalationBar`
If ticket has an open escalation, show top-of-page banner: target + sent_at + status. Failed escalations show a red "retry" button (calls execute-escalation via substrate — TODO marked, v1 OK to leave as "contact admin").

### `Setup` (the 3-step wizard)
1. **Paste your help-center URL.** Input + button → `ingest-docs({url, source_kind:'web', display_name})`. Poll `docs_sources` for completion.
2. **Install the widget.** Big button "Generate widget secret" → calls `rotate-widget-secret`, reveals secret ONCE in a copy-able box with the embed snippet:
   ```html
   <script src="https://butter-support.butterbase.dev/widget.js"
     data-recipe-base="https://butter-support.butterbase.dev"
     data-user-payload="<base64 JSON server-side>"
     data-user-signature="<HMAC-SHA256 server-side>"></script>
   <div id="butter-support-widget"></div>
   ```
3. **Configure escalation.** Channel select (Slack/email) + config inputs → POST to `escalation_targets` via the auto-API (SDK insert) with `is_default=true`.

After step 3 → redirect to `/inbox`.

## 12. Customer widget (`src/widget/`)

`widget.html` is a tiny shell:
```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
  <script type="module" src="/src/widget/main.tsx"></script>
</body>
</html>
```

`main.tsx` reads the `<script data-*>` attrs that the customer's server rendered. Mounts `<Widget />` into `#butter-support-widget`. Bundle target <100KB gzipped.

```tsx
// main.tsx
import { createRoot } from 'react-dom/client';
import { Widget } from './Widget';

const script = document.currentScript as HTMLScriptElement | null;
const dataset = script?.dataset || {};
const root = document.getElementById('butter-support-widget');
if (root) {
  createRoot(root).render(
    <Widget
      recipeBase={dataset.recipeBase || ''}
      userPayload={dataset.userPayload || ''}
      userSignature={dataset.userSignature || ''}
    />
  );
}
```

`Widget.tsx`: state machine: launcher (floating button bottom-right) → panel (slide-up) → ticket-list view + active-ticket view.

API calls from the widget use plain `fetch` to `${recipeBase}/v1/${APP_ID}/fn/widget-*` with body `{user_payload, signature, ts, ...}`. Use `ts = Date.now()`. **The widget does NOT compute the HMAC signature itself** — it just relays whatever the customer's server passed in `data-user-signature`. Each widget action uses the same signature attached to a fresh `ts` — but wait, the HMAC is computed against `${ts}.${payload}`. Since the widget can't re-sign on a fresh `ts`, the customer's server must re-render the script tag with a fresh signature on each page load. OR: the widget's HMAC is over a long-lived `ts` window — 5 minutes per our function impl. So `ts` is the page-load timestamp, signature is computed against THAT ts, and as long as the user submits within 5 min the call succeeds.

**For follow-up actions beyond the 5-min window**, the widget must refresh — re-render the snippet. v1 acceptable.

### Widget polling
While an active ticket is open, call `widget-poll-replies` every 5s. Show new founder/system messages as they arrive. New messages chime (optional — silent OK for v1).

## 13. Styling

Tailwind. shadcn primitives copied in (run `npx shadcn-ui@latest init` once and add: button, card, dialog, input, textarea, badge, tabs, select, separator). Color scheme: neutral base, blue accent for primary, amber for "awaiting approval" / draft, red for errors and escalation states, green for confident / resolved.

No fancy animations — focus on clarity. Console looks like Linear or Height. Widget looks like Intercom (minimal, light).

## 14. Build + deploy

`package.json` scripts:
```json
"build": "tsc --noEmit && vite build",
"build:console": "vite build --mode console",
"build:widget": "vite build --mode widget",
"zip": "node zip-dist.js",
"deploy": "npm run build && npm run zip"
```

`zip-dist.js`: use `archiver` to zip `dist/` contents (paths must use forward slashes). Write zip to `frontend.zip` at project root.

Then the human will run:
```
mcp__butterbase__create_frontend_deployment app_id=app_0ycj4ad7odud framework=react-vite
# → returns uploadUrl + deployment_id
curl -X PUT "<uploadUrl>" -H "Content-Type: application/zip" --data-binary @frontend.zip
mcp__butterbase__manage_frontend action=start_deployment deployment_id=<id>
```

(You do not need to run these — leave a note in the README that the deploy stage will handle it.)

## 15. CORS

After deploy, the project owner will call `manage_app update_cors` with the deployed subdomain. **You don't need to handle CORS in the frontend.**

## 16. Acceptance criteria (when you can stop)

You're done when:
1. `npm run build` succeeds with no TS errors.
2. `dist/` contains `index.html`, an `assets/` folder with hashed JS/CSS, and a top-level `widget.js`.
3. `index.html` boots into `<Login>` if not authed, `<Inbox>` if authed.
4. From `<Inbox>` you can click a ticket and reach `<TicketDetail>` which connects to the DO via WebSocket.
5. The widget bundle loads in a static HTML test page (you can write `test-widget.html` for manual verification).
6. The README documents env vars + build + deploy commands.
7. A short `frontend/HANDOFF.md` is written summarizing: what's built, what's stubbed, any decisions you made, and what the next stage (deploy) needs.

## 17. Things you should NOT do

- Don't add libraries not on the locked list.
- Don't try to fix backend issues — that's done. If a function doesn't work the way the spec suggests, leave a TODO in the frontend code with the discrepancy and move on.
- Don't build the deep-tier UI (the four `support.*` action capability surface — see `06-v1-deferred.md`). That's Phase 3.
- Don't build Skill / Autonomy / Integrations settings beyond a stub. Read-only views are fine.
- Don't try to deploy. That's the next stage.
- Don't use the `Skill` tool — it returns empty in this environment. Read SKILL.md files directly if you need them.

## 18. Final note

The journey state file is `docs/butterbase/00-state.md`. Don't tick the `frontend` checkbox yet — the human will do that after reviewing your handoff.
