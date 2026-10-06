# Substrate use cases — video recording guide

One page, eight shots. Tickets and substrate IDs below are already created and verified — record against them directly, or send fresh widget messages and reproduce.

## Setup

Open three panes side by side:

- **L:** Butterbase substrate browser (entities · actions ledger · source artifacts · learnings · decisions · commitments)
- **R:** Support console (`butter-support.butterbase.dev`)
- **Bottom strip:** widget on a test page (or Postman hitting `widget-ingest`)

Pre-created tickets and IDs to highlight:

| Use case | Ticket / ID | Substrate handle |
|---|---|---|
| 1, 2, 3, 4, 6 | `8bd75fbe-9920-4b50-81d5-447092334dd4` | person `ent_01KV2VQHG6W1M2SM7HQPY4QQK3` · diagnosis `917bd9ea-e27e-4806-96ee-2a9edb6be68e` · commitment `com_01KVXEAW2BSZAKWAGFR4YYDYSR` |
| 5 (escalation, real Slack/email) | `246c5ceb-b58e-4374-b398-14f39bbf0b80` | action `act_01KVXE6A5D3900RED62R9A4NAW` |
| 2/3 with live-resync demo | `e025fcb5-8fba-409d-83b7-38ec3172020e` | artifact `art_01KVXJH4EBHMNYEE7XGKE4S5Z5` (shows post-loop state, not stale snapshot) |

---

## 1. Customer entity resolved on ticket open

**What it proves:** the FTS-email fix — a returning customer's existing `person` entity is found, not duplicated.
**Substrate write:** none (read-side only).

**Question to send:**
> "Hi — quick question about my account, anything you can find on file?"
> *(use email `kcflexigbo@gmail.com` in the identity payload)*

**Where to check:**
1. Entity browser → search `kcflexigbo` → single `person` entity `ent_01KV2VQHG6W1M2SM7HQPY4QQK3`.
2. Console → open ticket → customer panel shows "Linked to substrate person `ent_01KV2VQH…`".

---

## 2. Ticket lifecycle projected to substrate (`upsert_source_artifact`, kind=`support_ticket`)

**Substrate write:** `upsert_source_artifact` kind=`support_ticket` — **fires on every state change** (today's sync fix). The artifact reflects current status, message_count, diagnosis, escalations, etc.

**Question:** any widget message — sync fires on creation, then again after every agent loop, escalation, follow-up, draft-sent, proposal approve/reject.

**Where to check:**
1. Source artifacts → filter `kind = support_ticket`, newest first.
2. Open the row → content header reads `Status: escalated` (or `resolved`, etc.) and `Message count: 2+` — NOT the stale snapshot from before the fix.
3. Best demo: ticket `e025fcb5-…`, artifact `art_01KVXJH4EBHMNYEE7XGKE4S5Z5` — shows status `escalated`, 2 escalation rows, current diagnosis populated. Compare to the older artifact above it in the list (still `status: open, message_count: 1`) — that one was created before today's fix.

---

## 3. Agent diagnosis projected (`upsert_source_artifact`, kind=`support_diagnosis`)

**Substrate write:** `upsert_source_artifact` kind=`support_diagnosis`, supersede-on-rerun semantics.

**Question to send:**
> "Where do I find the quickstart guide for Butterbase?"

Forces the docs-found → diagnose path.

**Where to check:**
1. Source artifacts → filter `kind = support_diagnosis`.
2. Find row with `external_id = 8bd75fbe-…:917bd9ea-…`.
3. Content = diagnosis summary + cited doc evidence with similarity scores.
4. Console → ticket → "Diagnosis" tab on the right shows the same summary linked to this artifact.

---

## 4. Auto-resolved reply — behavior change, no substrate write

**Substrate write:** none — but this is the headline behavior fix.

**Question:** same as use case 3 (how-to / onboarding question — not force-escalate).

**Where to check:**
1. Console → ticket `8bd75fbe-…` → status badge `resolved` (not `awaiting_approval`).
2. Reply role = `founder`, auto-sent (no "Approve & Send" button).
3. *Proof it's config-driven:* open Autonomy Settings → `default = auto_resolve`. Flip to `draft_for_approval`, send a fresh ticket → now you get a draft. (Optional flex.)

---

## 5. Escalation projected + delivered (`upsert_source_artifact`, kind=`support_escalation`) ⚠️ real Slack/email

**Substrate write:** `upsert_source_artifact` kind=`support_escalation` + delivery action via `execute-escalation`.

**Question to send:**
> "Hi, I think I was charged twice for last month's invoice — can you look into it?"

`billing` issue type → `force_escalate` per autonomy_settings.

**Where to check:**
1. Source artifacts → filter `kind = support_escalation`. Top row → external_id contains ticket_id + timestamp.
2. Actions ledger → filter `action_id = act_01KVXE6A5D3900RED62R9A4NAW` for substrate verdict trail.
3. Console → ticket status `escalated`, customer sees handoff message, `escalations` table row `status=sent`.
4. Slack/email channel → actual delivered escalation.

---

## 6. Founder marks a message as a commitment (`record_commitment`)

**Substrate write:** `record_commitment` capability → creates a `commitment` entity (different shelf from source_artifacts).

**Action:** In console, open any ticket, hover over a message, click **"Mark as commitment"**. Fill title/content/due-date, submit.

**Where to check:**
1. Actions ledger → filter `capability = record_commitment`, newest first. Top row → status `auto_approved`.
2. Entity browser → filter `type = commitment`. Entity has the title, `from_entity` (founder), `to_entity` (customer).
3. Demo commitment already created: `com_01KVXEAW2BSZAKWAGFR4YYDYSR`, action `act_01KVXEAW281W5X27FJEAG3BM2E` — linked to ticket `8bd75fbe-…`.

---

## 7. Pattern surfaced as substrate learning (`record_learning`)

**What it proves:** the agent doesn't just respond to tickets one at a time — it watches the corpus for patterns and writes them back to substrate as learnings the team / future agents can read.

**Substrate write:** `record_learning` capability — fires when `sweep-pattern-signals` detects either:
- **`recurring_topic`** — ≥3 tickets with the same `topic_tag` in 24h
- **`docs_gap`** — ≥3 tickets with same topic_tag *and* low-quality diagnoses (low confidence or weak doc scores) in 24h

Thresholds in `backend/functions/sweep-pattern-signals/handler.ts:1-3`.

**How to trigger:** the function runs on a cron, but you can also invoke it manually from the console function tester. To get a real surfacing you need 3+ tickets with the same `topic_tag` in the last 24h — easiest path is to send 3 widget messages on the same topic (e.g. "How do I export data?" ×3) and then invoke `sweep-pattern-signals`.

**Where to check:**
1. Local table: `pattern_signals` → rows with `surfaced = true` and `surfaced_at` set after invocation.
2. Substrate **learnings** shelf → entries titled `Recurring customer topic: <tag>` or `Docs gap surfaced: <tag>`, description includes the count, time window, and sample ticket IDs.
3. Actions ledger → filter `capability = record_learning`.

---

## 8. Founder promotes a ticket resolution into a policy (`record_decision`)

**What it proves:** insights from individual tickets get codified into permanent operating policy — substrate becomes the institutional memory layer.

**Substrate write:** `record_decision` capability, `kind: policy_decision`. Different shelf again (decisions, not learnings or commitments).

**Action:** In console (admin/owner only), open a ticket → "Convert to policy" → fill title + content + optional scope/rationale → submit.

**Where to check:**
1. Actions ledger → filter `capability = record_decision`, newest first.
2. Substrate **decisions** shelf → entry with the title you entered, `kind: policy_decision`, rationale includes the policy text + source ticket reference.
3. Local `activities` table → `kind = policy.created` row with the substrate_action_id.

---

## Side-by-side substrate "shelves" cheat sheet

| Capability | Lands in | Use cases |
|---|---|---|
| `upsert_source_artifact` | source_artifacts shelf | 2 (ticket), 3 (diagnosis), 5 (escalation) |
| `record_commitment` | commitments shelf | 6 |
| `record_learning` | learnings shelf | 7 |
| `record_decision` | decisions shelf | 8 |
| (read-only) | entities shelf | 1 |

Four different shelves to flip through during the recording — gives the head of engineering a clear "substrate is the structured memory across all of this" picture.
