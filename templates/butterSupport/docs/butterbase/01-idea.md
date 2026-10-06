# 01 — Idea (user-supplied, verbatim)

> This document captures the founder-supplied recipe brief for the **Butterbase Support Recipe**. The journey's `idea` stage was skipped because a complete brief already existed; this file replaces the brainstorm output and is the source of truth for the `plan` stage.

## What we're building (and why it's different)

The support recipe is a Butterbase-compatible app that reads and writes the substrate. Existing AI support tools (Intercom Fin, My AskAI, etc.) answer questions by retrieving from help docs and hand off to a human when they get stuck. Their real-world resolution rates sit around 42–50% because they are sophisticated FAQ bots that cannot see the actual product.

Our support agent is different in one specific way that is the entire moat: **it diagnoses the user's actual situation by reading the real product, the real account state, and the real errors, because the app is deployed on Butterbase and we are its backend.** It then resolves by taking governed actions, and escalates the genuinely hard cases to a human with full context. No competitor can do this because no competitor is the app's backend.

Every design decision below exists to protect that capability and the safety model around it.

## Non-negotiable strategic constraints

1. **Build the founder-facing triage inbox first.** Do NOT start with a customer-facing autonomous bot. The agent drafts replies and suggests actions; the founder approves, edits, or sends. The customer-facing autonomous version comes later, reached by turning up an autonomy dial as trust builds.
2. **Every action goes through propose → policy → execute → log.** The agent NEVER writes directly to substrate tables or external systems.
3. **Safety lives in the architecture (capabilities and policy). Behavior lives in the editable skill. Never mix them.** Safety is enforced by the substrate refusing the action, not by asking the agent nicely in a prompt.
4. **Diagnose against REAL product data, not against documentation.** Docs can be a fallback for general questions, but the headline capability is reading the real product state.
5. **Read customer context from the substrate entity graph.** Do NOT build a separate support customer store.
6. **Close the loop back into the substrate.** Support is not a silo — one rolling `support_ticket` source_artifact per ticket holds the full transcript + structured ticket state (re-upserted on every state change); founder-confirmed commitments project on explicit action; founder-confirmed policies project as `record_decision { kind: 'policy_decision' }`; surfaced cross-ticket patterns project as learnings via the daily sweep. Person/company entities are NOT written by support — they're read from the shared graph (populated by CRM).
7. **The skill is structured and layered, not a freeform prompt blob.** Behavior expressed along named dimensions with bounded options + scoped freeform context. Layered: structural safety floor (ours, non-editable), default behavioral skill (ours, editable), company-specific overrides (theirs).
8. **Make the inbound channel abstraction channel-agnostic, even though v1 ships one channel.** v1 = in-app widget only; the internal representation must not assume the widget.
9. **Reproduction and actions must be safe.** The agent reads what already happened; it does not re-run destructive actions on the user's behalf without governance.
10. **External effects (escalation messages, any send) go through the substrate outbox with idempotency keys.** No direct Slack/email calls from the agent loop.

## Minimum Lovable Product (v1)

The lovable moment is: the agent reads the user's real situation, diagnoses it correctly, and drafts a resolution the founder just approves.

The irreducible core loop:

1. **Inbound capture (widget only).** Embeddable in-app support widget. Authenticated identity = free entity resolution.
2. **Automatic context enrichment from the entity graph.** Customer, plan, MRR, tenure, recent history — read from substrate entities.
3. **Diagnosis against real product data.** Read the customer's actual account state and actual errors from the app's data on the substrate. Correlate with recent activity. Form a real diagnosis.
4. **Contextual drafted reply for founder approval.** Founder approves, edits, or rejects. Nothing reaches the customer without the founder in v1.
5. **A small set of safe resolution actions, all via propose-policy-execute and logged to the action ledger.** Start with 3–4 genuinely safe, reversible actions.
6. **Configurable autonomy dial (default conservative).** Per-issue-type auto-resolve-and-respond vs draft-for-approval. v1 default: draft-for-approval for everything.
7. **Layered, editable behavioral skill.** Default support skill is structured + readable. Customer edits behavioral dimensions (incl. sales posture) or supplies their own. Safety floor underneath is structural and non-editable. Inspectable in UI.
8. **Escalation to one human channel, with full context.** When the agent can't or shouldn't resolve, escalate to one configured human via one channel (Slack or email) through the outbox. Full context package: who the customer is, what they pay, the diagnosis, what was tried, why it needs a human.
9. **Loop-closing into the substrate.** Per ticket: intake + diagnosis artifacts. On explicit founder action: commitments and policy decisions. Cross-ticket: basic pattern flagging (multiple users → same error → surface as a learning). Entity records are read-only from support's side.

If anything is cut, cut from #9 (loop-closing can start minimal) before #3 (diagnosis). Diagnosis + drafted resolution + safe-actions-with-governance is the irreducible core.

## Explicitly OUT of v1 (deliberately deferred)

- Customer-facing autonomous mode (Shape A) — the autonomy dial turned up; earned later.
- Additional inbound channels (email and others) — abstraction supports it; we add after v1.
- The conversion / sales angle — sales-posture dimension can exist as configuration in v1, but active conversion behavior is later.
- Live reproduction of user actions — v1 reads the error that already happened.
- Smart multi-human routing — v1 routes to one configured human.
- Rich pattern surfacing into business state / institutional memory — v1 does basic flagging.
- A skill test harness — later.
- Heavy ticketing machinery (SLAs, macros, team queues, CSAT surveys) — the agent resolves most things; we need far less of this.

## Suggested build sequence (from brief)

1. Confirm substrate dependencies (action ledger, capabilities/policy, outbox, app-data access).
2. Inbound widget + channel-agnostic inbound message representation. Get a message landing in a founder inbox panel with entity-graph enrichment showing.
3. Diagnosis capability: read real account state + real errors, correlate, produce a diagnosis. Prove this works end-to-end on seeded realistic data before anything else.
4. Drafted reply for founder approval.
5. Propose-policy-execute path for ONE safe action (e.g. resend verification email), logged to the action ledger.
6. Two or three more safe actions on the same path.
7. Configurable autonomy dial (default draft-for-approval).
8. Layered, structured, editable skill.
9. Escalation to one human channel via the outbox.
10. Loop-closing writes back to the entity record + basic pattern flagging.

By step 5: demonstrable governed loop. By step 10: lovable v1.

## Open decisions (carry into plan)

- Inbound channel for v1: **widget** (recommended — authenticated identity resolution is free).
- Escalation channel for v1: Slack OR email (founder's choice).
- Exact 3–4 safe actions to ship first. Confirmed naming convention by user: `support.resend_verification_email`, `support.retry_failed_webhook`, `support.flag_as_bug`, `support.apply_account_credit` (always-require-approval).
- Default sales posture in the shipped skill: help-first, mention upgrades only on clear fit or explicit ask, never push after one mention.

## Dependency posture (resolved during research)

| Substrate primitive needed | Status |
|---|---|
| Action ledger (`/v1/me/substrate/actions/*`) | Ready — built-in |
| Capabilities + policy verdict path (`propose` returns `auto_approved` / `requires_approval` / `rejected`) | Ready — built-in |
| Outbox + worker (HMAC-signed per-capability webhook targets, retries, dead-letter) | Ready — built-in |
| App-data access path (`ctx.db`, `ctx.db.asUser`) inside functions | Ready — built-in |
| Entity graph with plan/MRR/tenure/history attributes | Ready — populated by CRM `ingest-gmail` + `crm-upsert-meeting`, canonical_keys = `{ email, domain }`. We adopt these entity shapes as-is. |
| Autonomy dial | Ready — substrate `yolo_mode` toggle. Side-effect capabilities still require approval even with yolo on (structural safety floor). |
| Realtime founder inbox | Ready — substrate WS stream (`/v1/me/substrate/stream`) + Postgres Realtime on local tables. |
| Per-ticket stateful agent run | Ready — Durable Objects (one DO per ticket) OR `agent_threads`/`agent_messages` pattern from CRM. |
| LLM calls | Ready — `manage_ai` gateway. |
| Doc fallback retrieval | Ready — `manage_rag_content`. |
| Customer-facing widget hosting | Ready — frontend hosting + edge SSR. |

**One enforcement nuance:** Substrate enforces propose-policy-execute *for substrate writes*. App-level data writes (e.g. issuing an account credit in the customer's app DB) are NOT auto-governed — discipline-required. We must route those through `ctx.substrate.propose('support.apply_account_credit', …)` and let our outbox webhook handler execute the actual mutation. This is the architectural discipline we have to enforce in code; the substrate gives us the mechanism but won't physically prevent a function from calling `ctx.db.query("UPDATE …")` directly.
