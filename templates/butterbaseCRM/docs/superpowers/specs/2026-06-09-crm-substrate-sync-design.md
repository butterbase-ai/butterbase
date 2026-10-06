# CRM ↔ Substrate Sync — Design

**Date:** 2026-06-09
**Status:** Drafted, awaiting review
**Scope:** Bidirectional sync between the CRM and Butterbase substrate, with a single shared write path that also covers Google ingestion.

## Goal

Every change made in the CRM lands in substrate. Every change made in substrate (by any other app or agent) lands in the CRM on the next poll. Google ingestion (Gmail, Calendar) keeps its current user-triggered shape but flows through the same shared write path so its results also reach substrate and the activity log without duplicated logic. Both directions dedupe by construction.

## Non-goals

- Automatic background ingestion of Gmail/Calendar. Google → CRM remains user-triggered.
- A substrate change feed / websocket consumer. Substrate has no WS today (`docs/butterbase/03b-docs-cache.md:45`); poll is the only option.
- Realtime push from CRM to substrate. The outbox drainer is the chosen decoupling primitive.
- Conflict UI / merge tooling. Last-updated-wins is applied silently.

## Architecture

```
Gmail / Calendar  ──┐
Manual UI create ───┼──▶ lib/crm-write.ts ──▶ CRM tables ──▶ substrate_outbox ──▶ drain-substrate-outbox ──▶ substrate
Substrate pull   ───┘                                 (skipped on substrate-origin writes — echo guard)

substrate ──poll every 5 min──▶ pull-from-substrate ──▶ lib/crm-write.ts (source: 'substrate')
```

Three components are new or reshaped:

1. **`lib/crm-write.ts`** — the single write path. All CRM mutations (Gmail ingest, Calendar ingest, UI creates, AI proposals, substrate pull) call it. It dedupes, writes, and enqueues to the outbox.
2. **`substrate_outbox`** + **`drain-substrate-outbox`** worker — decouples CRM writes from substrate availability. Captures every change that should propagate.
3. **`pull-from-substrate`** — scheduled function (5 min default, workspace-configurable) that diffs substrate against the CRM and writes new/updated entities back through `lib/crm-write.ts`.

## `lib/crm-write.ts` — shared write path

Exports three idempotent functions. All callers in the codebase (including the existing `ingest-gmail`, `ingest-calendar`, and `sync-to-substrate` handlers) refactor to use these.

```
upsertCompany(ctx, input, { source })  →  { id, created, substrate_entity_id }
upsertPerson(ctx, input, { source })   →  { id, created, substrate_entity_id }
recordActivity(ctx, input)             →  { id, created }
```

Where `source` is one of `'gmail' | 'calendar' | 'ui' | 'agent' | 'substrate' | 'import'`.

### Order of operations (companies / people)

1. **Dedupe lookup** in priority order:
   - If `input.substrate_entity_id` provided → match on `(workspace_id, substrate_entity_id)`.
   - Else for company → match on `(workspace_id, domain)` (lowercased apex).
   - Else for person → match on `(workspace_id, lower(email))`.
2. **Insert or merge:**
   - If no match → `INSERT`, return `created: true`.
   - If match → `UPDATE` with non-null fields from `input`, **last-updated-wins** at the field level: a field is overwritten only if `input.updated_at > row.updated_at` (or `input.updated_at` is null and the field on the row is null).
3. **Echo guard + outbox enqueue:**
   - If `source === 'substrate'` AND the row was just linked via `substrate_entity_id` (either matched on it, or just received one from substrate) → **skip enqueue**. Substrate already has this exact state.
   - Otherwise → `INSERT INTO substrate_outbox (...)` with the row's current state and an idempotency key.
4. Return.

`recordActivity` is the same shape but keyed on `(workspace_id, kind, dedupe_key)`, where `dedupe_key` is the Gmail `message_id`, Calendar `event_id`, etc. No substrate enqueue — activities are not substrate entities.

### Conflict resolution detail

Row-level LWW with non-null field merge: compare the incoming `updated_at` against the stored `row.updated_at`. If incoming is newer, overwrite **only the non-null fields** the writer supplied — null fields are left alone. This avoids the failure mode where an enrichment writing only `industry` would clobber a recent `name` edit, without paying the bookkeeping cost of a per-field timestamp column. Trade-off: if both sides edit different fields of the same row at literally the same moment, the older `updated_at` loses all its changes that weren't redundantly carried by the winner. Acceptable for v1 — true field-level LWW (per-field timestamps) can be retrofitted by adding `attrs_updated_at jsonb` later without changing the public lib signature.

## `substrate_outbox` table

```
substrate_outbox(
  id              uuid pk,
  workspace_id    uuid not null,
  entity_type     text not null,         -- 'company' | 'person'
  entity_id       uuid not null,         -- CRM row id
  op              text not null,         -- 'upsert' | 'delete'
  idempotency_key text not null,         -- {entity_type}:{entity_id}:{row_updated_at_epoch_ms}
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_by       text,
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (workspace_id, idempotency_key)
)
```

Unique constraint on `idempotency_key` means: if the same `(row, updated_at)` is enqueued twice (e.g. by a retry), the second insert collides and is a silent no-op. Two distinct edits at different timestamps produce two distinct rows and both get pushed in order.

## `drain-substrate-outbox` worker

Scheduled (every 1 min) or queue-triggered. Per invocation:

1. `SELECT ... FROM substrate_outbox WHERE completed_at IS NULL AND next_attempt_at <= now() ORDER BY workspace_id, created_at FOR UPDATE SKIP LOCKED LIMIT N`.
2. For each row: re-read the current CRM record (state may have advanced since enqueue), call the substrate `propose()` logic extracted from `sync-to-substrate/handler.ts`.
3. On success: `UPDATE substrate_outbox SET completed_at = now(), last_error = NULL`.
4. On failure: `UPDATE substrate_outbox SET attempts = attempts + 1, next_attempt_at = now() + backoff(attempts), last_error = ...`. After 8 attempts, leave it queued with a `circuit_state` marker on `integration_state` so the UI surfaces it.

The existing `sync-to-substrate` HTTP endpoint stays as a thin wrapper around the same extracted `pushEntityToSubstrate(ctx, entity_type, row)` function. It becomes the "force resync this row now" button.

## `pull-from-substrate` — periodic substrate → CRM

Scheduled function, default every **5 minutes** per workspace. Interval configurable via `sync_settings.substrate_poll_interval_minutes`.

Cursor: stored in `integration_state` under `kind = 'substrate'`. Stores a `last_synced_at` timestamp; substrate-side filtering is `findEntities({type, updated_after: cursor})`.

Per run, per workspace:

1. Read cursor.
2. For each entity_type in `['company', 'person']`:
   - `ctx.substrate.findEntities({ type, updated_after: cursor })`.
   - For each entity: call `upsertCompany`/`upsertPerson` with `{source: 'substrate', substrate_entity_id, ...attrs}`. The echo guard in step 3 of the shared lib prevents re-push.
3. Advance cursor to `max(entity.updated_at)` only if the entire batch committed cleanly.

## Schema additions

```
sync_settings(
  workspace_id    uuid pk references workspaces(id) on delete cascade,
  substrate_autosync_enabled        boolean not null default true,
  substrate_poll_interval_minutes   int not null default 5,
  updated_at      timestamptz not null default now()
)

substrate_outbox  (defined above)

-- companies, people: add updated_at column if not already present (used by LWW)
-- already exist on these tables per schema.json
```

RLS: `sync_settings` and `substrate_outbox` both scoped by `workspace_id` membership, matching the pattern in `backend/rls/`.

## Refactors required

- **`backend/functions/sync-to-substrate/handler.ts`** — extract `pushEntityToSubstrate(ctx, entity_type, row)`. HTTP handler becomes a 10-line wrapper.
- **`backend/functions/ingest-gmail/handler.ts`** — the per-message loop (lines 113–198) replaces inline `SELECT id FROM companies` / `INSERT INTO companies` / `INSERT INTO activities` with calls to `upsertCompany`, `upsertPerson`, `recordActivity`. Dedupe-by-message-id moves into `recordActivity`'s dedupe_key logic.
- **`backend/functions/ingest-calendar/handler.ts`** — same refactor pattern.
- **`backend/functions/import-from-substrate/handler.ts`** — becomes a call to `upsertCompany`/`upsertPerson` with `source: 'substrate'`. The echo guard takes over the role of "don't push back."

## Echo loop guarantees

The chain that must not loop:

```
substrate change → pull-from-substrate → upsertPerson(source: 'substrate')
                                              │
                                              ▼
                                       echo guard: skip outbox enqueue
                                              │
                                              ▼
                                          no push back
```

Guard condition: `source === 'substrate' && (matched_on_substrate_entity_id || row.substrate_entity_id_was_just_set)`. A pure CRM edit that happens to come in milliseconds after a substrate pull is still pushed (different code path, `source !== 'substrate'`).

## Dedupe guarantees

| Direction | Layer | Key |
|---|---|---|
| Gmail → CRM | `recordActivity` | `(workspace_id, 'email.received'|'email.sent', message_id)` |
| Calendar → CRM | `recordActivity` | `(workspace_id, 'meeting', event_id)` |
| Any → company | `upsertCompany` | `(workspace_id, substrate_entity_id)` ∨ `(workspace_id, domain)` |
| Any → person | `upsertPerson` | `(workspace_id, substrate_entity_id)` ∨ `(workspace_id, lower(email))` |
| CRM → substrate | `substrate_outbox` | unique `(workspace_id, idempotency_key)` |
| Substrate → CRM | echo guard | `source === 'substrate'` skips re-push |

No layer relies on a layer below it for correctness; each is sufficient on its own.

## Conflict policy

Field-level last-updated-wins. A row's `updated_at` is the timestamp of its most recent successful write through `lib/crm-write.ts`. A field is overwritten only when the incoming `updated_at` exceeds the stored value. Ties go to the incoming write (substrate's clock and ours will sometimes match to the millisecond on bursty edits; treating the newer arrival as canonical avoids stalling).

## Failure modes covered

- **Substrate down:** outbox accumulates; CRM writes succeed; drainer retries with backoff.
- **CRM write succeeds, outbox insert fails:** same transaction — both succeed or both fail.
- **Drainer crashes mid-batch:** `FOR UPDATE SKIP LOCKED` + `locked_until` reclaims the row after timeout.
- **Substrate poll misses a change:** next poll cursor query catches it (assuming substrate's `updated_after` is inclusive of the cursor edge — verify against substrate behavior).
- **Concurrent edits same field, same millisecond:** LWW picks the later arrival; not deterministic across runs, but converges.

## Observability

- `substrate_outbox` row counts by `(completed_at IS NULL, attempts)` — surfaces depth and stuck items.
- `integration_state.last_error` extended to capture drainer + poller failures.
- Per-workspace audit log (existing `activities` table can carry `kind = 'sync.outbox_failed'` rows for terminal failures).

## Open items deferred

- Deletes (`op = 'delete'` in the outbox). Not in initial scope; add when CRM gains delete UI.
- Workspace-level pause UI for `sync_settings.substrate_autosync_enabled`.
- DLQ/UI surface for outbox rows past max attempts.
