# Design: Live app-data reads for the diagnose+draft agent

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Component:** the per-ticket diagnose+draft agent (currently split between `SupportTicketDO` and `auto-reply-worker` in prod — see "v1→prod drift" below)

## Problem

The deployed diagnose+draft agent can only ground replies in documentation
(RAG). It cannot answer questions that depend on the customer's real data —
e.g. *"Why did you send me a white t-shirt?"* requires reading that customer's
actual order. We want the agent to diagnose against **live business data** —
the merchant's real `orders` / `customers` / `subscriptions` etc. — regardless
of whether the merchant's product is built on Butterbase or not.

## v1→prod drift (verified against `app_0ycj4ad7odud`, 2026-06-23)

Before specifying the change, two facts about the live system this spec
amends:

- **No outbound disclosure filter exists yet.** `send-draft-reply`'s deployed
  description: *"outbound disclosure filter lands in deep tier phase — v1
  commodity tier trusts founder-edited text."* The `outbound_disclosure_violations`
  table is provisioned, but the filter library and the `substrate_outbound`
  scoped accessor are not built. **This spec treats the filter as net-new
  work, not "reuse."**
- **The actual draft path in prod is `auto-reply-worker`**, a one-shot LLM
  call fired fire-and-forget by `widget-ingest`. `SupportTicketDO` is deployed
  (status READY) but its planned multi-tool agent loop is not the path serving
  live tickets today. The implementation plan must pick: revive the DO loop
  to host the new tool, or upgrade `auto-reply-worker` into a tool-calling
  agent. This spec describes the **target shape**; the implementation plan
  resolves the path.

## Audience

butterSupport must serve **two kinds of merchant equally**:

| Merchant kind | Main product app runs on… | Adapter |
|---|---|---|
| **Native** | Butterbase | Recipe-provided. Merchant pastes their `app_id` + a read-only key; the recipe runs the bridge for them as a thin wrapper around their app's auto-API. |
| **Non-native** | Anything else (Rails on Heroku, Django, Node, etc.) | Merchant-implemented. They host two HTTP endpoints conforming to the bridge protocol below. We ship reference implementations. |

Both transports speak the same wire shape — the agent's tool surface and
prompts are identical. Merchants who can't or won't run a bridge fall back to
the existing substrate + RAG path with no degradation.

## Non-goals

- No write access to the merchant's database, ever (read-only).
- **No raw database URLs.** Direct DB connections are rejected: their DB isn't
  internet-reachable, drivers/dialects are heterogeneous, and there is no
  layer for the merchant to log/audit/scope queries before they hit the DB.
  The bridge is the contract.
- No change to the commodity (RAG-only) tier or the founder approval flow.
- No "widen substrate reads" upgrade — the DO design already includes a
  full-read `substrate_internal` accessor (plan:823); the deep tier already
  has full substrate read.

## Architecture

The agent gains **one new tool**: `query_app_data`. The tool talks to a
**bridge** — an HTTP contract with two endpoints. Native and non-native
merchants implement the same contract; only the transport and who-hosts-it
differs.

```
GET  /describe → catalog: { tables: [{ name, description?, columns: [{ name, type, description?, sensitive? }], scoping_hint?, scoping_mode? }] }
POST /query    → { table, filters, columns?, limit, acting_user: { external_id, email } } → { rows: [...] }
```

The **catalog IS the allowlist.** If a table isn't in `/describe`, the agent
doesn't know it exists and can't query it. No separate "exposed tables"
config — merchants curate one thing.

### Catalog: merchant-curated, agent-injected

- **Native merchants** start from an auto-generated catalog derived from
  `manage_schema get`. They edit before it goes live: hide internal tables,
  add one-line descriptions, mark sensitive columns, pin scoping hints.
- **Non-native merchants** hand-write `/describe` once in their bridge —
  they know their schema.
- The agent fetches `/describe` at DO/agent boot and caches it. Merchants
  re-publish (native: edit + save; non-native: redeploy) to refresh.
- Table descriptions + column descriptions are injected into the agent's
  system prompt so it picks the right table + right filter without guessing.

### Scoping: mandatory by default, opt-down to advisory per table

Every `/query` request carries `acting_user` — the resolved ticket sender,
read from `support_tickets.customer_external_id` (already populated at ingest
in the live schema; `customer_email` is the fallback).

`scoping_mode` per table in the catalog:

- **`mandatory`** (default) — the bridge layer **enforces** the scoping hint.
  Example: `orders` with `scoping_hint: "customer_id = acting_user.external_id"`
  auto-injects that filter before hitting the DB. Requests without
  `acting_user` are rejected. Prompt-injection ("dump all customers") cannot
  exfiltrate because the constraint lives below the LLM.
- **`advisory`** — opt-in per table by the merchant. Hint is shown to the
  agent but not enforced. Use for genuinely public tables (e.g. a product
  catalog).

This is the cleaner replacement for the "RLS by `user_id`" idea from the
earlier draft: works identically for native (the recipe-provided bridge
auto-injects) and non-native (the merchant's handler does), without
depending on RLS existing in the underlying DB.

### Setup: how a clone "plugs in"

Connecting the product app is a **deep-tier onboarding step**, alongside
linking substrate. It is NOT a v1 setup-wizard step (the wizard today is
just paste-docs-URL + paste-widget-snippet).

| Step | Merchant action | Powers |
|---|---|---|
| Existing: paste docs URL | URL | Commodity tier (RAG) |
| Existing: paste widget snippet | snippet | Widget delivery |
| Deep-tier (existing): link substrate | one SDK call | Substrate reads |
| **Deep-tier (new): connect product app** | Native: paste `app_id` + read-only key, then edit auto-generated catalog. Non-native: paste bridge URL + shared secret, point us at `/describe`. | Live app-data reads |

Connection config (key/secret, URL, catalog overlay) is stored
**recipe-local** in the support clone, encrypted, revocable.

### Diagnosis loop (white-t-shirt example)

1. Ticket arrives from `alice@example.com`. `widget-ingest` resolves and
   writes `customer_external_id` to `support_tickets`.
2. Agent loads the cached catalog. Catalog says `orders` has columns
   `(id, customer_id, sku, ship_date)`, scoping_mode=mandatory,
   scoping_hint=`"customer_id = acting_user.external_id"`.
3. Agent calls `query_app_data(table: "orders", filters: {})` — the bridge
   auto-injects `customer_id = <alice.external_id>` and returns Alice's
   orders only.
4. `propose_diagnosis` + `propose_draft_reply` grounded in the real order.

## Safety (load-bearing)

LLM-drafted customer-facing replies with live read access to a production DB
is the risk surface. Guards:

1. **Read-only by contract.** `/query` is `select`-only by definition; no
   verb for writes exists in the protocol. Native bridge uses a read-only
   key. Non-native bridge is the merchant's own code — *they* enforce
   read-only on their side, which they want to anyway.
2. **Catalog as allowlist.** Tables not in `/describe` are invisible. No
   ambient schema discovery.
3. **Mandatory scoping by `acting_user`** (above). Prompt-injection can't
   change what the bridge filters on. The merchant opts a table down to
   advisory only when the table is genuinely public.
4. **Outbound disclosure filter — NET-NEW.** Every draft reply passes
   through a filter that strips fields marked `sensitive: true` in the
   catalog and blocks data attributed to anyone other than the ticket
   sender. The filter reads its allowlist directly from catalog metadata
   (column `sensitive` flags + `acting_user` from the request that sourced
   the row). This is the load-bearing build, not a reuse — the
   `substrate_outbound` accessor and `outbound_disclosure_violations` audit
   path do not exist in production yet.

Every `/query` call is written to the audit log (recipe-local).
A hard row-limit caps result size fed back into the model (interacts with
`MAX_INPUT_TOKENS_PER_TICKET`).

## Decisions

- **Audience:** native and non-native merchants both supported, same wire
  protocol, different transports.
- **Transport:** HTTP bridge — never a raw DB URL.
- **Catalog:** merchant-curated. Catalog IS the allowlist.
- **Scoping:** mandatory by default, advisory per-table opt-down.
- **Identity:** `support_tickets.customer_external_id` is the `acting_user`
  source. Already exists in the live schema; populated at widget-ingest.
- **Outbound safety:** the disclosure filter is **net-new work**, not reuse.
  Its first job is also its hardest job — apps that read live data must
  ship the filter alongside the read tool.

## Open questions for the implementation plan

- **Which agent hosts `query_app_data`** — revive the planned
  `SupportTicketDO` tool loop, or upgrade `auto-reply-worker` from a
  one-shot into a tool-calling agent? Touches the v1→prod drift.
- **Catalog storage in the clone** — a new `app_data_catalog` table
  (merchant overlay on top of the live or remote schema), or a single
  JSONB blob in `capability_config`-style.
- **Reference bridge implementations** for non-native merchants
  (Node/Python/Ruby starters) and how/where they're published.
- **Catalog refresh UX** — when the merchant's product schema changes, how
  does the support clone notice (manual re-publish vs. periodic poll of
  `/describe`).
- **Row/token caps for `query_app_data` results vs.
  `MAX_INPUT_TOKENS_PER_TICKET`.**
- **Outbound disclosure filter** — full design is its own spec; this one
  declares it a prerequisite and a build-now item.
