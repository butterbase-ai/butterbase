# Substrate-only refactor

Date: 2026-06-10
Status: Draft (research complete, probes done, awaiting approval before execution)
Supersedes: docs/superpowers/specs/2026-06-09-crm-substrate-sync-design.md
Related: docs/butterbase/04b-substrate.md

## Goal

Stop mirroring CRM data into app tables. Read and write directly to the per-user
substrate for everything that fits the entity / action-ledger shape. Collapse the
multi-user workspace model to a single shared substrate.

## Non-goals

- Multi-tenant workspaces. Single substrate, single tenant.
- Real-time live cursors / presence.
- Custom substrate entity types (the enum is fixed by the platform).

## Substrate constraints (probed, not assumed)

| Surface | What works | What doesn't |
|---|---|---|
| `GET /entities` | `type`, `q` (trigram), `limit` (≥500). Default sort `updated_at DESC`. | `order_by`, `offset`, `cursor`, `attrs.*`, `updated_after` — silently ignored. |
| `GET /actions` | `capability`, `status`, `before` (cursor), `limit`. Returns full payload + result + before-state. | `entity_id`, `from`, `to` — silently ignored. |
| `update_entity` | Replaces `attrs` wholesale. `before_attrs` is returned. | No merge, no patch. Read-modify-write is mandatory. |
| Mutation primitives | `upsert_entity`, `update_entity`, `record_decision`, `record_commitment`, `record_learning`, `revert_action`. | `append_to_attrs`, `patch_entity`, `delete_entity`, `undo` — do not exist. |
| Undo | `propose(revert_action, {action_id})` — sets target status to `reverted`. | Only `reversible: true` actions. |
| Action links | `links: [{entity_id, kind}]` on payload | Silently dropped (returned `null`). No first-class entity↔action relation. |

Consequences:
- Lists are fetch-all-then-filter client-side (no `attrs.*` query, no offset).
- Every attr write is a full read-modify-write — lost-write races between concurrent writers.
- Notes/activity-as-actions must stuff `entity_id` into payload and filter client-side.
- Entity deletion is via `revert_action` of the original `upsert_entity` (not a primitive).

## Destination map

### Substrate-resident as entities

| App table | Substrate type | Notes |
|---|---|---|
| companies | `entity(type=company)` | Already linked via `substrate_entity_id`. |
| people | `entity(type=person)` | Already linked. |
| deals | `entity(type=project)` | `attrs.stage`, `attrs.amount_cents`, `attrs.company_id`, `attrs.owner_entity_id`. |
| meetings | `entity(type=event)` | `attrs.starts_at`, `attrs.ends_at`, `attrs.attendee_entity_ids[]`. |
| campaigns (shell) | `entity(type=project)` + `attrs.kind='campaign'` | Definition only. Send rows stay app-local. |

### Substrate-resident as actions (action ledger)

| App table | Capability | entity_id home |
|---|---|---|
| notes | `record_learning` | `payload.about_entity_id` |
| activities | mixed (system writes already land here; user-emitted via `record_decision` for material changes) | `payload.about_entity_id` or `result.entity_id` |

Both must be queried by paginating the ledger and filtering client-side. To keep
ActivityFeed fast at scale, maintain a thin app-local `activity_index` (see below).

### Substrate-resident in entity `attrs`

| App table | Lives as | Owner entity |
|---|---|---|
| attachments | `attrs.attachments[]` | parent (company/person/deal). Storage object IDs only. |
| custom_field_values | `attrs.<field_key>` | the entity itself. |
| custom_fields (definitions) | `attrs.custom_fields_schema[]` | singleton `entity(type=self)` |
| saved_views | `attrs.saved_views[]` | singleton `self` |
| enrichment_settings | `attrs.enrichment` | singleton `self` |
| app_allowlist | `attrs.allowlist[]` | singleton `self` |

### Stays app-local (operational, wrong shape for substrate)

| Table | Why |
|---|---|
| agent_threads, agent_messages, agent_proposals | Chat runtime. Unbounded growth per thread; every message-as-action would spam the ledger. |
| campaign_sends, campaign_list_members | High cardinality per campaign. Counters + throttling are hostile to ledger semantics. |
| integration_state | High-churn cursors. OAuth tokens at rest — UNKNOWN if substrate encrypts. Keep encrypted in app DB. |
| activity_index (NEW) | `(entity_id, action_id, capability, ts)` index populated when functions propose. Replaces server-side `entity_id` filter on `/actions`. |

### Deleted entirely

| Table | Reason |
|---|---|
| workspaces, memberships, pending_invites | Single-user collapse. |
| workspace_integrations | Folded into integration_state. |
| substrate_outbox, reconciler_cursor | Sync plumbing — gone with the sync. |
| sync_settings | Sync gone. |
| deal_proposals | Folded into agent_proposals. |
| substrate_entity_id columns on companies/people | The substrate id IS the id now. |

## Migration phases

Each phase is independently shippable. No big-bang.

### Phase 0 — Single-tenant collapse (prereq)
- Drop `workspace_id` from RLS, function payloads, frontend routes.
- Pin the app to one substrate user (the owner). Surface `bb_sub_*` key generation in onboarding.
- Delete invite/membership UI + functions.
- **Estimated**: 1–2 days. No data loss risk — single user already.

### Phase 1 — Read path swap (companies, people)
- New `frontend/src/lib/substrate.ts` wrapping `GET /entities` and exposing typed helpers.
- Swap `useCompanies`, `usePeople` from `bb.from('companies').select(...)` to `substrate.list('company')`.
- Keep existing tables writable as a fallback during phase; reads come from substrate.
- Realtime: subscribe to substrate WS stream, invalidate TanStack Query keys on `{tbl:'entity', op, id}`.
- **Verify**: list, detail, search (`q`), recency sort all work without app-table reads.

### Phase 2 — Write path swap (companies, people)
- All writes route through `propose(upsert_entity)` / `propose(update_entity)`.
- Replace `crm-upsert-company`, `crm-upsert-person` bodies with substrate-only versions (single propose, no outbox).
- Delete `sync-to-substrate`, `pull-from-substrate`, `drain-substrate-outbox`, `reconcile-substrate-outbox`, `cleanup-substrate-outbox`, `import-from-substrate`, `list-substrate-entities`, and the crons that drive them.
- Delete `substrate_outbox` and `reconciler_cursor` tables.
- Drop `substrate_entity_id` columns on `companies`/`people`.
- Drop the `companies`/`people` tables.
- **Verify**: smoke-sync.sh rewritten as smoke-substrate.sh; UI create/edit round-trips.

### Phase 3 — Deals & meetings (project / event entities)
- Define attr schemas in `lib/substrate.ts` (Zod):
  - Deal: `{ stage: string, amount_cents?: number, currency?: string, company_id?: string, owner_entity_id?: string, close_date?: string, ... }`
  - Meeting: `{ starts_at: string, ends_at?: string, attendee_entity_ids: string[], location?: string, ... }`
- Rewrite `useDeals`, `useMeetings` to fetch `type=project` / `type=event` and filter client-side.
- DealsKanban: group by `attrs.stage`, sum `attrs.amount_cents` in-memory.
- Upcoming meetings: filter by `attrs.starts_at >= now` in-memory.
- Drag-to-stage: `propose(update_entity, {id, attrs: {...merged, stage: newStage}})` — read-modify-write helper in lib/substrate.ts.
- Drop `deals`, `meetings`, `meeting_attendees` tables.

### Phase 4 — Notes & activity (as actions)
- New helper `lib/substrate.ts:appendNote(entityId, body)` → `propose(record_learning, { content, about_entity_id })`.
- New helper `lib/substrate.ts:listNotes(entityId)` → page `/actions?capability=record_learning&before=...`, filter `payload.about_entity_id===entityId` client-side.
- New `activity_index` table:
  ```
  CREATE TABLE activity_index (
    action_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    INDEX (entity_id, ts DESC),
    INDEX (ts DESC)
  );
  ```
- Functions that `propose()` write a matching row into `activity_index`. Single-app convention — no double-bookkeeping race because the same function does both within one request.
- ActivityFeed reads from `activity_index` for the entity-scoped feed, optionally `JOIN` against substrate `getEntity(id)` for display.
- Drop `notes`, `activities` tables.

### Phase 5 — Attrs-resident operational (attachments, custom fields, saved views)
- Migrate values into `attrs` via a one-off `migrate-to-substrate-attrs` function:
  - For each company/person with attachments: write `attrs.attachments[] = [{object_id, name, size, uploaded_at}]`.
  - For each custom_field_value row: write `attrs[field_key] = value` on the parent.
  - For custom_fields defs, saved_views, enrichment_settings, app_allowlist: stash on singleton `self` entity (create one if absent).
- New `lib/substrate.ts` helpers: `addAttachment(entityId, meta)`, `setCustomField(entityId, key, value)`. All do read-modify-write.
- **Race mitigation**: route all attrs-mutating calls through one backend function per entity per request when batched (e.g. agent enrichment that writes multiple attrs at once collapses into a single update). For UI-vs-Gmail concurrency on the same field, accept last-writer-wins — already the case today.
- Drop `attachments`, `custom_fields`, `custom_field_values`, `saved_views`, `enrichment_settings`, `app_allowlist`.

### Phase 6 — Campaigns (split shell vs sends)
- Campaign shell → `entity(type=project)` + `attrs.kind='campaign'`, `attrs.status`, `attrs.daily_limit`, `attrs.template_id`.
- `campaign_sends`, `campaign_list_members`, `campaign_lists` stay app-local — they reference the campaign by the substrate entity id.
- Sender functions (`start-campaign`, `process-campaign-sends`, `pause-campaign`) read campaign shell from substrate, read recipients from `campaign_list_members` (app), write `campaign_sends` (app). Each material status change emits one `record_decision` action linked to the campaign entity (for activity feed).
- Drop `campaigns` table; keep the rest.

### Phase 7 — Cleanup
- Delete `lib/crm-write.ts` (never built; was the sync abstraction).
- Delete `dev/smoke-sync.sh`, replace with `dev/smoke-substrate.sh`.
- Update `backend/README.md`, `docs/butterbase/02-plan.md`, `docs/butterbase/04b-substrate.md`.
- Delete or repurpose: `sync-to-substrate`, `pull-from-substrate`, `drain-substrate-outbox`, `reconcile-substrate-outbox`, `cleanup-substrate-outbox`, `import-from-substrate`, `list-substrate-entities`, `crm-upsert-*` (replaced by substrate.ts), `crm-record-activity` (replaced by `propose` + activity_index).
- Delete `deal_proposals` (fold into agent_proposals).

## Key architectural choices

### `lib/substrate.ts` is the only write path
Frontend never calls `propose()` directly — always through this lib, which:
- Generates idempotency keys
- Does read-modify-write for `update_entity` (fetches latest, merges, writes)
- Updates the local TanStack Query cache optimistically
- Mirrors writes that touch `activity_index` (via backend function, not frontend)

### Backend functions become thin
Anything the SDK can do from the browser, the browser does. Functions remain only for:
- Things requiring secrets (Gmail ingest, Composio webhooks, email send)
- Cross-entity transactions (campaign sender)
- The `activity_index` writeback (called from within other functions, never from frontend)
- Substrate `revert_action` UX

### Realtime via substrate WS
- One global subscription to `/v1/me/substrate/stream`.
- On `{tbl:'entity', op, id}`: invalidate `['entity', id]` + the type-bucket list query.
- On `{tbl:'action_ledger', op:'insert', id}`: invalidate activity_index reads (refetch the affected entity's feed).
- Realtime on `realtime.json` for app-local tables (campaign_sends, agent_*, integration_state) stays as-is via Butterbase row-level realtime.

### `self` singleton entity for app config
- Pattern: on first run, `findEntities({type:'self', limit:1})`; if empty, `upsert_entity({type:'self', display_name:'app config'})`.
- Stash all global config in `attrs`. Read-modify-write semantics are tolerable because only an admin writes.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Lost-write race on entity `attrs` between UI and agent enrichment | Medium | Use `before_attrs` from the propose response to detect drift, retry once with merged state. Surface a toast on second failure. |
| Action ledger growth blows past usable pagination | Low (small CRM) | Periodic compaction proposal to substrate team; `activity_index` insulates the UI. |
| Substrate API rate limits (unprobed) | Unknown | Add a per-IP token bucket in `lib/substrate.ts`; surface 429s. |
| Realtime WS drops + reconnect storms | Medium | Exponential backoff, refetch-all on resume, suppress duplicates within 500ms. |
| Migration backfill takes too long (large existing data) | Low | Batched in chunks of 100, resumable via a marker on the `self` entity. |
| `revert_action` chain creates dangling state (revert of a revert) | Low | Lib always reverts the *original* action, not the revert. Guarded in helper. |

## Open unknowns to confirm in execution

1. Does the substrate WS stream emit events for actions/decisions in addition to entities? (Determines whether `activity_index` needs a polling fallback.)
2. Is there a hard upper bound on `attrs` blob size?
3. Are OAuth tokens at-rest encrypted in substrate `attrs`? (If yes, attrs.integration_tokens is viable; if no, keep in `integration_state` app table.)
4. Does the substrate API have rate limits that affect a 100-entity fetch-then-render flow?
5. Can `display_name` be changed on `update_entity` (or only `attrs`)?

## Acceptance criteria

- Zero references to `bb.from('companies' | 'people' | 'deals' | 'meetings' | 'notes' | 'activities' | 'attachments' | 'custom_fields' | 'custom_field_values' | 'saved_views')` in frontend.
- Zero rows in the dropped tables before the table drop migrations run.
- smoke-substrate.sh passes end-to-end against the deployed app.
- CompaniesList, PeopleList, DealsKanban, Meetings, ActivityFeed (entity-scoped + global) all render and update via substrate.
- Realtime invalidation works for entity edits and new notes/actions.
- Undo from the activity feed reverses the action and invalidates the affected entity in the cache.

## Out of scope (deferred)

- Server-side `attrs.*` indexing (platform-side feature request).
- Multi-tenant workspaces (would require shared-substrate primitive).
- Bulk entity import beyond Gmail/Calendar.
- Full-text search across notes (only fuzzy `q` on display_name available today).
