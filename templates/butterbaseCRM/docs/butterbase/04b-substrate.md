---
linked_at: 2026-06-02T09:25:12Z
app_id: app_44zjayftl7b3
substrate_user_id: (linked via dashboard — id not surfaced by manage_app get_config; see bug 13c6dd9f-a3f4-4a47-95db-e0d203bcd369)
---

# Substrate Linkage

- App linked at 2026-06-02 via the Butterbase dashboard.
- Smoke (probe function `substrate-probe`, since deleted):
  - `hasSubstrate: true`
  - Methods on `ctx.substrate`: `propose`, `getEntity`, `findEntities`, `searchMemory`
  - `ctx.substrate.findEntities({limit:3})` returned 3 real entities from the user's substrate (Insforge company, Butterbase company, "Snowflake to BigQuery migration" project) — proving cross-app identity is live.

## What this unlocks

The CRM's HTTP functions now have `ctx.substrate` injected automatically. Any function can:

- `await ctx.substrate.findEntities({ type: 'person', q: '<query>' })` — find people the user already knows about in other Butterbase apps.
- `await ctx.substrate.getEntity(entityId)` — fetch a specific entity.
- `await ctx.substrate.propose('record_decision', { ... })` — write to the substrate ledger.
- `await ctx.substrate.searchMemory('billing', { kinds: ['decisions'], limit: 5 })` — full-text search across past decisions/commitments/learnings.

Browser code uses the user's `bb_sub_*` key against `/v1/me/substrate/...` — but in this template, all substrate writes go through functions (so end users never need to hold a substrate key).

## Sync wiring — deferred to v1.1

Surfacing CRM Companies/People as substrate entities (and vice-versa) is the actual product value of the link. That requires:

1. **Schema add:** `companies.substrate_entity_id text` and `people.substrate_entity_id text` columns + index.
2. **Function:** `sync-to-substrate` — given a CRM `company_id` or `person_id`, calls `ctx.substrate.propose(...)` to create/update the corresponding substrate entity, then writes back the `entity_id`. Idempotent.
3. **Function:** `import-from-substrate` — given a substrate `entity_id`, creates a matching CRM company/person row in the active workspace.
4. **UI:** in `CompanyDetail` / `PersonDetail`, show "Linked to substrate" badge + "Import from your substrate" picker.
5. **Trigger semantics:** decide whether every CRM mutation auto-syncs (heavier, simpler) or only on explicit user action (lighter, more control). Recommend: explicit on first link, auto-update thereafter.

Capabilities needed from substrate side (verify before building):
- Whether `propose` supports a `record_entity` capability (or equivalent) for creating/updating entities, OR whether entities are only created via other apps' own ledger actions.
- The shape of `entity.attrs` — what we should populate from CRM rows.

This deserves a small design pass (~30 minutes) before implementation. Skip if you want to ship as-is and treat the substrate link as foundation-only.

## Status

- ✅ Substrate linked.
- ✅ `ctx.substrate` injection confirmed.
- ✅ Two-way CRM↔substrate entity sync (v1.1, shipped 2026-06-02):
  - Schema: `companies.substrate_entity_id`, `people.substrate_entity_id` (+ ws/substrate composite index). Migration #38.
  - Functions: `sync-to-substrate` (push, idempotent on link), `import-from-substrate` (pull, idempotent on `(workspace_id, substrate_entity_id)`), `list-substrate-entities` (browser wrapper around `findEntities`).
  - UI: `SubstrateLinkedBadge` on CompanyDetail / CompaniesList / PeopleList rows; `SyncToSubstrateButton` in CompanyDetail header and PeopleList row actions; `ImportFromSubstrateDialog` picker in CompaniesList + PeopleList toolbars.
  - Activity kinds emitted: `company.substrate_linked`, `company.substrate_updated`, `company.imported_from_substrate`, and the matching `person.*` variants.
