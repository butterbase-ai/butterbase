# Butter Support

**An open-source, Butterbase-native AI support agent that diagnoses against your real product data — not just your docs.**

[![Clone on Butterbase](https://img.shields.io/badge/clone%20on-butterbase-F5C24C?style=flat-square)](https://docs.butterbase.ai/templates)

Most AI support tools are RAG bots over a help center. They resolve ~45% of tickets. This one's different in exactly one way: **it reads your real product state through substrate** — the failed payment, the expired card, the 14 customers hitting the same error — and proposes governed actions the founder approves with one click. The agent runs in a Durable Object per ticket, streams reasoning live to the founder console, and writes back to substrate so the rest of your stack (CRM, billing, your own Claude) can see what happened.

It ships in two depths, **same recipe**:
- **Commodity tier** (day-0, ≤60s magic moment): paste a help-center URL → working agent. Works for any company, Butterbase or not.
- **Deep tier** (incremental, you opt in): the agent reads substrate-projected product signals and proposes `support.*` action capabilities that your main product app executes via substrate outbox. The moat.

> **Status:** v1 — single-tenant per clone, founder-approval required for every customer-visible reply. Customer-facing autonomous mode is post-v1.

---

## What's inside

| Subsystem | What it is |
|---|---|
| **20 Postgres tables** | Tickets, messages, agent threads + messages + proposals, diagnoses, pattern signals, escalations, RAG docs, escalation targets, autonomy settings, capability config, widget secrets, the structured `support_skill`, activity log, integration plumbing, memberships, app allowlist |
| **23 functions** | Auth hook · widget intake (5) · per-ticket ops (5) · admin/setup (7) · escalation outbox · 4 crons |
| **1 Durable Object** (`SupportTicketDO`) | Per-ticket live agent loop with 5 tools (`search_docs`, `propose_diagnosis`, `propose_draft_reply`, `propose_escalation`, `request_followup_question`); WebSocket stream to founder UI; single-driver lock |
| **1 RAG collection** (`support-docs`) | Customer's help center, scraped from URLs or uploaded files (PDF/MD/TXT/HTML/CSV/JSON/DOCX/XLSX/PPTX) |
| **1 platform agent** (`support-overview`) | Read-only summary your Claude can call: open tickets, oldest waiting, surfaced patterns |
| **2 frontend artifacts** | Vite + React founder console + embeddable widget (53KB gzipped) |
| **Native magic-link auth** | + email/password fallback. First user is auto-owner; admins invite the rest via `app_allowlist`. |

## Architecture in one diagram

```
Customer's product                              YOUR cloned support recipe
─────────────────                              ────────────────────────────
                                               ┌──────────────────────────┐
[end user]                                     │  founder console (SPA)   │
   │                                           │  - inbox, ticket detail  │
   ▼                                           │  - draft approval        │
[<script src=widget.js                         │  - settings, setup       │
   data-user-payload=                          └──────┬───────────────────┘
   data-user-signature=…>]                            │ realtime + DO WS
   │ HMAC POST                                        │
   ▼                                           ┌──────▼───────────────────┐
[widget-ingest] ─────►  Postgres ◄─── realtime ──────┤ SupportTicketDO    │
   │                       │                         │ (1 per ticket)     │
   ▼                       │                         │  • search_docs ────┼──► RAG
[upsert_source_artifact]   │                         │  • propose_*       │
   │                       │                         └────────────────────┘
   ▼                       │                                  │
┌──────────┐    propose    │                                  │ propose
│ substrate│◄──────────────┘                                  │
└────┬─────┘                                                  │
     │ outbox webhook                                         │
     │ (HMAC, idempotency)                                    │
     ▼                                                        ▼
[your product's            ┌─────────────────────────┐
 action handlers]          │ execute-escalation       │  ← lives in recipe
   resend_verification     │  via Composio Slack/Gmail│
   retry_webhook           └─────────────────────────┘
   flag_as_bug
   apply_account_credit
```

## Quickstart (commodity tier — ≤60 seconds)

1. **Clone the recipe.** Either from the Butterbase template gallery, or via MCP / CLI:
   ```
   butterbase clone <this_app_id> ./my-support
   cd my-support
   ```
   On clone, Butterbase auto-mints a service API key into the functions that need one (see [Env vars](#env-vars)).

2. **Open your new console.** Visit `https://<your-new-subdomain>.butterbase.dev` (Butterbase prints it on clone). Sign in via magic link with your email — the post-auth hook bootstraps you as `owner`.

3. **Setup wizard, step 1:** paste your help-center URL. The recipe crawls + ingests into the `support-docs` RAG collection.

4. **Setup wizard, step 2:** click "Generate widget secret." Copy the secret — **shown once.** Paste the embed snippet into your product's HTML (server-renders the HMAC signature):
   ```html
   <script src="https://api.butterbase.ai/widget.js"
     data-recipe-base="https://<your-subdomain>.butterbase.dev"
     data-user-payload="<base64 of {user_id,email,name?,plan?}>"
     data-user-signature="<HMAC-SHA256 of ts.payload with widget secret>"></script>
   <div id="butter-support-widget"></div>
   ```
   See [Widget signing](#widget-signing) for the HMAC computation.

5. **Setup wizard, step 3:** choose escalation channel (Slack or Gmail via Composio).

Done. Open a test ticket via the widget. The agent will search docs, draft a reply, and post it as a draft in your inbox. Approve to send.

## Deep tier (incremental — opt in when ready)

Commodity tier ships value day-zero. Deep tier requires your **main product app** to project signals into substrate and (optionally) host action handlers.

### 1. Link substrates

Run on your main product app:
```bash
butterbase app link-substrate <main_app_id> --user <your_substrate_user_id>
```
Now this support recipe and your main app share the same substrate entity graph.

### 2. Project signals (in your main product app)

The support agent reads these from substrate when diagnosing:

| Signal | How to project | Why |
|---|---|---|
| **Person/company entities** | `ctx.substrate.propose('upsert_entity', {type:'person', canonical_keys:{email}, attrs:{plan, mrr_usd, is_trial, …}})` | Customer identity + account state. Use `{_internal_only: true}` on sensitive fields. |
| **Failed auth events** | `ctx.substrate.propose('upsert_source_artifact', {kind:'failed_auth_event', content, related_entity_ids:[…]})` | Diagnose "I can't sign in" without bluffing |
| **Failed payments** | `kind: 'failed_payment'` | Diagnose upgrade / billing failures |
| **Webhook failures** | `kind: 'webhook_failure'` | Diagnose integration outages |
| **Major product events** | `kind: 'product_event'` (sampled) | Real recent activity for context |

All projection is fire-and-forget. The support agent never auto-creates entities from support contact — it only reads what your main app has projected.

### 3. Enable action capabilities

Per capability, in the founder console → Settings → Action capabilities:

| Capability | When to enable | What you implement |
|---|---|---|
| `support.resend_verification_email` | If you have email verification | Your auth API resend endpoint |
| `support.retry_failed_webhook` | If you have outbound webhooks | Re-fire from your queue |
| `support.flag_as_bug` | Always useful | Write to Linear / GitHub / your bug tracker |
| `support.apply_account_credit` | If you charge customers | Your billing system credit endpoint. **Always requires approval — non-overridable.** |

For each enabled capability, the console reveals:
1. A signing secret (shown once)
2. An adapter snippet you paste into a function in your main product app
3. A registration command to run from your main app:
   ```
   butterbase substrate register-outbox-target support.resend_verification_email \
     --webhook-url https://<your-main-app>.butterbase.dev/fn/support-resend-verification \
     --signing-secret "<from console>"
   ```

See [`adapter-snippets/`](./adapter-snippets/) for ready-to-paste reference handlers. Stay in commodity tier as long as you want — enabling capabilities is optional.

## Env vars

Auto-minted on clone (the cloner doesn't need to set these manually):

| Function / DO | Env vars |
|---|---|
| `request-doc-upload-url`, `ingest-docs`, `delete-docs-source`, `fetch-ai-usage`, `refresh-docs` | `BUTTERBASE_API_KEY` (service key, app-scoped) — `auto_mint_api_key` at clone time |
| `SupportTicketDO` | `BUTTERBASE_API_KEY`, `BUTTERBASE_API_URL`, `BUTTERBASE_APP_ID`, `RAG_COLLECTION`, `DEFAULT_MODEL`, `HAIKU_MODEL` |
| `execute-escalation` | `SUBSTRATE_OUTBOX_SECRET` — **you must set this** after registering the outbox target (the substrate gives you the signing secret) |

Vite frontend (set at deploy build time):
```
VITE_BUTTERBASE_APP_ID=<your_clone_app_id>
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
VITE_BUTTERBASE_SUBDOMAIN=<your_subdomain>
```

## Widget signing

Server-side (NOT in browser), on every page load that renders the widget snippet:

```typescript
import { createHmac } from 'crypto';

const payload = Buffer.from(JSON.stringify({
  user_id: currentUser.id,
  email: currentUser.email,
  name: currentUser.displayName,
  plan: currentUser.plan,
})).toString('base64');

const ts = Date.now();
const signature = createHmac('sha256', WIDGET_SECRET)
  .update(`${ts}.${payload}`)
  .digest('hex');
```

Then render:
```html
<script src="..."
  data-user-payload="<%= payload %>"
  data-user-signature="<%= signature %>"></script>
```

Window: 24 hours from `ts`. The widget detects expiry via a 401 response, dispatches a `widget:auth-expired` `CustomEvent` on `window`, and pauses polling until the host calls `window.ButterSupport.updateCreds({ userPayload, signature, userTs })` with freshly-minted values. Refresh proactively (e.g. every ~12h) from a server endpoint that holds the widget secret — don't expose the secret to the browser.

## Safety floor (non-editable)

These are structural — your `support_skill` config can't override them:

1. **Propose → policy → execute → log.** Side-effect actions go through `ctx.substrate.propose`. The agent literally cannot call action endpoints directly — its tool surface in code doesn't expose that.
2. **Always-require-approval capabilities never auto-execute.** `support.apply_account_credit` (and any future capability with `requires_human_approval: true`) is approval-gated regardless of `yolo_mode` or autonomy settings.
3. **Audience-scoped disclosure** (Phase 3 — coming, not in v1 yet): outbound replies pass through a structural filter that strips internal-only fields. v1: founder edits manually; filter library lands with deep tier.
4. **Always-escalate path.** No code path disables escalation. If the agent runs out of options it escalates — even if no target is configured (writes an `unescalated_block` to the inbox in red).

## Writing additional RLS policies

If you hand-write RLS policies beyond what the recipe ships, **cast `current_user_id()` to `uuid`**:

```sql
USING (user_id = current_user_id()::uuid)
```

`current_user_id()` returns `text`; most of our user-keyed columns (`memberships.user_id`, `support_tickets.assigned_to`, etc.) are `uuid`. Without the cast you'll hit `RLS_TYPE_MISMATCH` at query time. Every existing policy in this recipe follows this convention — match it.

## Limitations / what's NOT in v1

See [`docs/butterbase/06-v1-deferred.md`](./docs/butterbase/06-v1-deferred.md) for the full list. Highlights:

- **Customer-facing autonomous mode** — v1 is founder-approve-every-reply. Autonomy dial exists; default is `draft_for_approval` for every issue type.
- **Outbound disclosure filter** — placeholder in `send-draft-reply`. Deep-tier work.
- **Multi-page web crawler** — `ingest-docs` web mode is single-page. Customers call it per URL.
- **Widget WebSocket** — v1 widget polls every 5s. Public WS endpoint is post-v1.
- **Skill / Autonomy / Integrations settings UI** — read-only stubs in v1. The data is editable via the auto-API; UI polish is post-v1.
- **Subdomain `/fn/` routing for auth:none functions** — there's a Butterbase platform bug. Widget hits `api.butterbase.ai/v1/{app_id}/fn/*` directly. See `06-v1-deferred.md` DEP1.

## Repo layout

```
.
├── README.md                   # this file
├── agents/
│   └── support-overview.json   # platform-agent spec — re-imported on clone
├── adapter-snippets/           # paste-into-your-main-app handlers (deep tier)
│   ├── support-resend-verification.ts
│   ├── support-retry-webhook.ts
│   ├── support-flag-bug.ts
│   ├── support-apply-credit.ts
│   ├── _lib/verify-sig.ts
│   └── _types/support-actions.d.ts
├── frontend/                   # Vite + React console + widget
│   ├── src/console/            # Founder console SPA
│   ├── src/widget/             # Embeddable customer widget
│   └── HANDOFF.md              # Decisions & known issues from frontend build
└── docs/butterbase/            # Build journey artifacts
    ├── 00-state.md             # Journey state (cursor + stages)
    ├── 01-idea.md              # The strategic brief
    ├── 02-plan.md              # Full architectural plan
    ├── 03-preflight.md         # Account / app provisioning
    ├── 03b-docs-cache.md       # Cached Butterbase docs
    ├── 04-build-log.md         # Stage-by-stage build log
    ├── 05-frontend-spec.md     # Spec the spawned Claude built from
    └── 06-v1-deferred.md       # Known limitations + post-v1 work
```

## Local development

```bash
# Frontend
cd frontend
cp .env.example .env.local
# fill in VITE_BUTTERBASE_APP_ID etc.
npm install
npm run dev    # http://localhost:5173

# Functions, DO, schema — use MCP via Claude / Cursor, or the CLI:
butterbase functions deploy ./src/fns/<name>.ts
butterbase do deploy ./src/do/SupportTicketDO.ts
butterbase schema apply ./schema.json
```

## Contributing

Bug reports / feature requests / PRs welcome. If you ship a meaningful change, please update `02-plan.md` (and `06-v1-deferred.md` if you closed an item) so the journey stays self-documenting.

The strategic constraints in `01-idea.md` are load-bearing — particularly the safety floor (constraints 2, 3, 9, 10). Please don't relax them without discussion.

## License

Apache-2.0, inherited from the Butterbase repository — see the [root LICENSE](../../LICENSE).
