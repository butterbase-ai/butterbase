# Design: Outbound disclosure filter

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Component:** new shared library used by the diagnose+draft agent, `send-draft-reply`, and the escalation outbound path
**Prerequisite for:** [2026-06-23-live-app-db-substrate-reads-design.md](./2026-06-23-live-app-db-substrate-reads-design.md)

## Problem

The agent must not leak data the customer shouldn't see — other customers'
records, internal-only fields (MRR, plan tier, founder notes, internal flags),
unconfirmed commitments. Today there is no defense:

- `send-draft-reply`'s deployed description literally states: *"outbound
  disclosure filter lands in deep tier phase — v1 commodity tier trusts
  founder-edited text."*
- The `outbound_disclosure_violations` table exists but no code writes to it.
- The planned `substrate_outbound` scoped accessor (`02-plan.md:824`) is not
  implemented.

Adding live app-DB reads (live-app-reads spec) widens the leak surface
dramatically: every column of every row the agent reads is now a potential
disclosure. The filter must ship **before or alongside** live reads.

## Approach: structural, not text-scanning

The filter is **structural** — the LLM never sees sensitive values in the
first place. Sensitive columns are stripped from read results *before* they
cross into the agent's context. A residual text scan on the draft output is
kept as belt-and-suspenders, but it is no longer the load-bearing guard.

This replaces the planned approach (`02-plan.md:836+`) which was primarily
substring-scanning the draft. Substring scanning fails the moment the agent
paraphrases a sensitive value; structural stripping makes paraphrasing
impossible because the value never reached the model.

## Architecture

The filter sits at three points in the path of any read → reasoning → output
cycle:

```
                ┌──────────────────────────────────────────────────────┐
read result ───►│ (1) ON-RECEIPT STRIP   recipe-side, before LLM       │
                │ - replace sensitive column values with typed tokens   │
                │ - drop rows attributed to other customers             │
                └──────────────────────┬───────────────────────────────┘
                                       ▼
                              LLM reasoning (sees tokens only)
                                       │
                                       ▼
                draft reply ───►┌──────────────────────────────────────┐
                                │ (2) RESIDUAL SCAN   on the draft text │
                                │ - look for value-shaped strings that  │
                                │   should never appear (placeholders   │
                                │   leaked literally, known internal    │
                                │   values from substrate)              │
                                │ - severity: info|warn|block           │
                                └──────────────────┬───────────────────┘
                                                   ▼
                              send-draft-reply / escalation outbound
                                                   │
                                                   ▼
                                            customer-visible
```

A `block`-severity violation in (2) withholds the draft and re-prompts the
agent with a "do not reference the redacted field" hint. `warn` strips the
offending substring and proceeds. `info` logs and proceeds.

## Mechanism

### (1) On-receipt strip

The filter is a wrapper applied to every read tool result before it lands in
the agent's tool-result message. Two transformations:

**Sensitive-column tokenization.**
Read the catalog (for app-DB reads) and the substrate sensitive registry (for
substrate reads). For every column flagged `sensitive: true`, replace the
value with a typed placeholder:

```
mrr_usd:        4200            →  "[sensitive:mrr_usd]"
plan_tier:      "enterprise"    →  "[sensitive:plan_tier]"
internal_note:  "asshole"       →  "[sensitive:internal_note]"
```

The agent can still *reason* about the field's existence — "this customer has
an MRR" or "they're on a paid plan" — and that reasoning is genuinely useful
(e.g., don't suggest the free plan). It cannot quote the value.

**Cross-customer row drop.**
Any row in the result whose attributed `acting_user.external_id` differs from
the ticket sender's is dropped. For app-DB reads this is largely redundant
with mandatory `acting_user` scoping in the bridge (live-app-reads spec) but
defends against an advisory-mode table accidentally returning multi-tenant
rows. For substrate reads, the substrate sensitive registry's per-entity
ownership tags drive this — anything not owned by or about the ticket sender
is dropped.

### (2) Residual scan

After the agent emits a draft, scan the text for:

- **Placeholder literals.** Any string matching `[sensitive:*]` or
  `[redacted:*]` appearing in the draft = `block`. The agent let a token
  leak verbatim.
- **Known internal-only values from substrate.** Pull the small enumerable
  set of currently-sensitive values for this customer (MRR figure, internal
  flag values, untagged commitments) and substring-scan. Match = `warn` (strip
  and proceed) by default, `block` for a high-severity field-path list
  (founder notes, other customers' identifiers).
- **Other-customer identifiers.** Any email, name, or external_id from
  recently-read rows that doesn't belong to the ticket sender = `block`.

Every match writes a row to `outbound_disclosure_violations` with severity,
the `attempted_field_path`, the `redaction_applied`, and the
`agent_thread_id`. Audit trail per the existing table schema.

### Sensitive registry: where the flags come from

| Source | Mechanism |
|---|---|
| **App-DB columns** (live-app-reads) | `sensitive: true` on the column in the merchant's catalog (`/describe` response). Merchant-curated. |
| **Substrate entity attributes** | A new `substrate_sensitive_attrs` config table (or a JSONB blob in `capability_config`) listing attr paths the merchant tags as internal-only — e.g. `person.attrs.mrr_usd`, `person.attrs.plan_tier`. Defaults shipped by the recipe; merchant can extend. |
| **Substrate memory** | `decisions` tagged `kind: 'policy'` AND `public: true` pass through. All other decisions/commitments/learnings are stripped from outbound. |
| **Recipe-internal fields** | Founder notes, internal `support_skill` freeform, any row in `outbound_disclosure_violations` itself — hardcoded internal in the filter source. |

## Integration points

The filter library is imported and applied at three places:

1. **Inside the agent loop** — wraps every read tool's return value before it
   becomes an `agent_messages` row. This is the (1) on-receipt strip.
2. **Inside `send-draft-reply`** — runs the (2) residual scan on the draft
   the founder is about to send (with or without their edits). This catches
   both agent-authored leaks and founder edits that accidentally re-introduce
   a sensitive value.
3. **Inside the escalation outbound handler** (`execute-escalation`) — runs
   (2) on any text that fans out to the end-customer. (Internal escalation
   payloads — Slack to the founder, email to the support team — skip this;
   the safety floor is for end-customer-bound content.)

Substrate reads go through a dedicated `substrate_outbound` scoped accessor
that applies (1) at read time. This is the long-planned accessor (`02-plan.md:824`),
now implemented as part of this filter.

## Severity policy

| Severity | When | Behavior |
|---|---|---|
| `info` | Stripping happened cleanly (e.g. catalog said `sensitive`, value was tokenized, no draft impact) | Log to `outbound_disclosure_violations`. Proceed. |
| `warn` | Residual scan found a substring match that was stripped non-destructively | Strip → substitute "[redacted]" → proceed. Log row. |
| `block` | Placeholder literal leaked, or a hardcoded-high-severity field path was matched, or a cross-customer identifier was found | Withhold draft. Re-prompt agent with the field path hint. Counts against `MAX_LLM_CALLS_PER_TICKET`. After N=2 consecutive blocks, escalate to human. |

## Decisions

- **Structural over text-scanning.** LLM never sees sensitive values; scan is
  belt-and-suspenders.
- **Recipe-side enforcement on receipt.** Bridges may also strip (defense in
  depth), but the recipe is the authoritative point.
- **Typed placeholders** (`[sensitive:<column_name>]`) over fully-removed
  fields — preserves reasoning utility, makes residual scan trivial.
- **The filter covers BOTH substrate reads and app-DB reads** through one
  shared library. `substrate_outbound` is implemented as a thin wrapper that
  applies (1) to substrate read paths.
- **Three severities** (`info`/`warn`/`block`) — matches the existing
  `outbound_disclosure_violations.severity` column.

## Non-goals

- Not a generic PII detector. The filter is rule-driven (catalog flags +
  registry), not model-driven. We don't run another LLM to "detect leaks."
- Not a write-path firewall. Side-effect capabilities go through the
  propose-policy-execute discipline (`02-plan.md:52`) — this filter only
  covers outbound *text*.
- Not a substitute for the catalog's mandatory scoping. Mandatory
  `acting_user` scoping happens at the bridge layer; this filter is what
  catches the cases where it didn't.

## Open questions for the implementation plan

- **Where the substrate sensitive registry lives** — new
  `substrate_sensitive_attrs` table, JSONB in `capability_config`, or
  inferred from substrate-side tags. Affects merchant UX for managing it.
- **Default registry contents** — what does the recipe ship as
  "sensitive by default" so merchants don't have to think about it on day
  one? Suggestion: `person.attrs.mrr_*`, `person.attrs.plan_tier`,
  `person.attrs.internal_*`, `decisions` not tagged `public: true`, all
  `commitments` and `learnings` by default.
- **Residual-scan known-value retrieval** — pulling the customer's sensitive
  substrate values once at filter-init vs. per-scan. Cache lifetime.
- **Re-prompt loop semantics on `block`** — wording of the hint, whether the
  agent sees the original tokenized read result again or a further-redacted
  view.
- **Founder-edit re-scan** — does `send-draft-reply` re-scan after a founder
  edit, and what UX does a `block` produce in the founder console?
- **Tests** — concrete leak scenarios to assert against (the test suite is
  what makes "no leaks" a real claim, not an aspiration).
