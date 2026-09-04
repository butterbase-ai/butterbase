# Backend — Live State Mirror

This folder is a **read-only mirror** of what currently lives on the Butterbase platform for app `app_44zjayftl7b3` (https://butterbase-crm.butterbase.dev). The actual source of truth is the platform; this folder is here so contributors can read, review, and reason about the backend in git without needing dashboard or MCP access.

> Editing files in this folder does **not** change the live app. To change the live app, use the Butterbase MCP tools, the `butterbase` CLI, or the dashboard, then re-run `./sync.sh` to refresh this folder.

## Contents

```
backend/
├── README.md                       # this file
├── sync.sh                         # pulls live state into the files below
├── schema.json                     # 22 tables + indexes (manage_schema get)
├── auth/
│   └── config.json                 # JWT TTLs, OAuth providers, password rules
├── rls/
│   ├── policies.sql                # CREATE POLICY statements (auto-generated from policies.json)
│   └── policies.json               # raw output of manage_rls list / butterbase rls list
├── functions/                      # one folder per deployed function (32 today)
│   └── <name>/
│       ├── handler.ts              # the deployed source
│       └── function.json           # triggers, timeoutMs, memoryLimitMb, agent_tool flags
├── integrations/
│   └── integrations.json           # configured Composio toolkits
├── storage.json                    # storage limits + flags
├── realtime.json                   # which tables broadcast row changes
└── ai.json                         # default model + allowed models
```

## Architecture at a glance

| Surface | Where | Notes |
|---|---|---|
| **Database** | live Postgres on Butterbase, `app_44zjayftl7b3` | 22 tables, RLS on every table |
| **API** | auto-generated REST at `https://api.butterbase.ai/v1/app_44zjayftl7b3/<table>` | accessed from the frontend via `@butterbase/sdk` |
| **Auth** | `/auth/app_44zjayftl7b3/...` | email/password + Google OAuth |
| **Storage** | presigned-URL flow at `/storage/app_44zjayftl7b3/...` | 10 MB/file cap |
| **Realtime** | `wss://api.butterbase.ai/v1/app_44zjayftl7b3/realtime?token=<jwt>` | 7 tables broadcast INSERT/UPDATE/DELETE |
| **Functions** | `/v1/app_44zjayftl7b3/fn/<name>` | 32 functions (HTTP + cron) — see below |
| **Integrations** | via Composio (gmail) | end-users connect their own accounts |
| **AI gateway** | `/v1/app_44zjayftl7b3/chat/completions` | locked to `anthropic/claude-haiku-4.5` |
| **Substrate** | linked to owner's substrate user | `ctx.substrate` injected in every function |

## Data model — where each entity lives

The substrate-only refactor (see `docs/superpowers/specs/2026-06-10-substrate-only-refactor.md`) moved the core CRM entities — **companies, people, deals, meetings, meeting_attendees, notes-on-CRM-entities** — out of Postgres and into the Butterbase substrate. They no longer have tables in `schema.json`.

Postgres now holds only the things that don't fit substrate's entity model:

```
auth.users (managed by Butterbase, not in our schema)
  └─ user_id (uuid, JWT subject)

workspaces
  ├─ memberships          # user ↔ workspace
  ├─ pending_invites      # invite tokens (admin-only)
  ├─ app_allowlist        # login gate
  ├─ activities           # append-only polymorphic event log (substrate ent_ ids in payload)
  ├─ attachments          # file metadata; bytes in storage
  ├─ notes                # free-form notes (entity_type may reference a substrate id)
  ├─ custom_fields        # workspace-scoped field defs (values live in substrate attrs)
  ├─ saved_views          # per-user saved filters
  ├─ sync_settings        # Google autosync toggle + cursors
  ├─ workspace_integrations + integration_state + reconciler_cursor   # Composio bindings
  ├─ enrichment_settings  # which agent enriches what
  ├─ agent_threads + agent_messages + agent_proposals + deal_proposals
  └─ campaigns + campaign_lists + campaign_list_members + campaign_sends
```

Substrate entities (`ent_...`) are reached via `ctx.substrate` inside functions or via the `substrate-proxy` / `list-substrate-entities` functions from the browser. See `functions/crm-upsert-meeting/handler.ts`, `functions/ingest-gmail/handler.ts` etc. for the read/write patterns.

## RLS model — read this before touching policies

Every business table is **workspace-membership-scoped** via this predicate:

```sql
workspace_id IN (
  SELECT m.workspace_id FROM memberships m
   WHERE m.user_id = current_user_id()::uuid
)
```

The `::uuid` cast is required — `current_user_id()` returns `text`. Without the cast you'll get `RLS_TYPE_MISMATCH: operator does not exist: uuid = text`.

Edit/delete authority on `deals`, `notes`, `meetings`, `attachments` is **author-or-admin** (the row's `created_by`/`uploaded_by` matches the caller, OR the caller is `owner`/`admin` in the workspace).

`memberships` SELECT was narrowed to **your own membership row only** (not all teammates'). This was tightened during frontend debugging — see the deferred v1.1 note in `02-plan.md` about teammate-name lookup.

There are two carve-out INSERT policies to know about:

1. `workspaces_insert_self` — anyone can create a workspace where `owner_user_id = me`.
2. `memberships_insert_founding_owner` — when I've just created a workspace where I'm the owner, I can insert my own `role='owner'` membership. Without this, the workspace-creation flow has a chicken-and-egg (need to be admin to insert membership, but you're not yet).

Activities are append-only from the frontend: members can INSERT (with `actor_user_id = me`) but cannot UPDATE or DELETE.

Pending invites are admin-only — neither regular members nor invitees can SELECT them (the redeem path uses the `accept-invite` function which runs as service).

See `rls/policies.sql` for the full picture.

## Functions

The function set has grown well past the original three (`summarize-company` / `invite-member` / `accept-invite`). The list below is generated from the live `/functions` endpoint; the `function.json` file in each folder is the authoritative metadata (triggers, timeout, memory, agent-tool flags).

| Name | Trigger | Description |
|---|---|---|
| `accept-deal-proposal` | http | Accept a `deal_proposal`: propose substrate project (kind=deal), mark proposal accepted, log activity. |
| `accept-invite` | http | Redeem a `pending_invite` token: create the membership for the calling user and delete the invite. Runs as service (RLS bypassed). |
| `agent-chat` | http | Agent chat (substrate-native; `brief_meeting` tool removed). |
| `agent-proposals-expire` | cron | Expire pending `agent_proposals` rows whose `expires_at < now()`. |
| `ai-search` | http | Natural-language CRM search. AI emits a strict filter spec against whitelisted tables/columns/ops; server validates and executes. |
| `ai-suggest-filters` | http | NL prompt → Filter DSL for a given `object_type`. Returns `{ filters, suggested_name, sort }` for the client. |
| `auto-sync-google` | cron | Every 5 min: for each workspace with `sync_settings.google_autosync_enabled`, invoke `ingest-gmail` + `ingest-calendar` per (workspace, user), then fire `trigger-enrichment`. |
| `check-allowlist` | http | App-wide login gate. Returns `{allowed, reason, isFirstUser}`. Bootstraps the first authenticated user as an implicit owner. |
| `cleanup-orphan-integrations` | cron | Daily cleanup of integration bindings whose workspace/user no longer exists. |
| `create-campaign-list` | http | Create a saved audience list (SQL). Members are substrate entity ids, pre-resolved with email + vars snapshots. |
| `crm-record-activity` | http | Shared write path: dedupe + insert an activity row. Dedupes on `(workspace_id, kind, payload->>dedupe_key)`. |
| `crm-upsert-meeting` | http | Substrate-backed meeting upsert with `as_user_id` service mode + `_custom_fields_replace` flag. |
| `enrich-company` | http | **STUB** post-substrate migration. TODO: rewrite to enrich a substrate company entity via `updateEntityMerge`. |
| `enrich-person` | http | **STUB** post-substrate migration. TODO: rewrite to enrich a substrate person entity via `updateEntityMerge`. |
| `find-duplicates` | http | **STUB** post-substrate migration. Was SQL self-join dedup on people/companies. TODO: rewrite to scan substrate entities. |
| `get-meeting-notes` | http | Bundle meeting notetaker view: source_artifact (transcript) + decisions/commitments/learnings linked to the meeting. |
| `ingest-calendar` | http | Calendar ingest — substrate-native. Incremental via time-window keyed off `last_synced_at` (1h overlap). |
| `ingest-gmail` | http | Gmail ingest — substrate-native. Proposes company + person upserts to substrate; logs activities with `ent_` ids. |
| `ingest-meeting-transcript` | http | Persist meeting transcript as substrate `source_artifact`, mark event `status=done`, trigger extraction (Haiku fallback). |
| `invite-member` | http | Create a `pending_invite` for an email + send via inviter's Gmail (Composio). Auto-adds invitee to `app_allowlist`. |
| `list-substrate-entities` | http | Wrap `ctx.substrate.findEntities` for browser callers — no `bb_sub_` key needed in the browser. |
| `migrate-meetings-to-substrate` | http | One-shot idempotent migration: copy meetings + attendees + custom_field_values into substrate event entities. |
| `pause-campaign` | http | Toggle a campaign between active/paused, or cancel it. Cancel cascades to queued sends. |
| `process-campaign-sends` | cron | Cron worker that walks active campaigns and pushes due queued sends through Gmail. Caps per-tick + per-campaign 24h. |
| `propose-deals` | http | **STUB** post-substrate migration. TODO: rewrite to read substrate entities + emit `deal_proposals` rows. |
| `register-integration` | http | Bind a Composio integration (e.g. Gmail) to a (workspace, user). |
| `start-campaign` | http | Move a draft campaign to active; materialise `campaign_sends` from list members. |
| `start-meeting-bot` | http | Dispatches a Butterbase `/ai/meetings` bot to the Zoom/Meet/Teams/Webex URL parsed from `attrs.location` or notes. Mirrors `bot_id` onto the substrate event; cost-capped via `sync_settings.notetaker_cost_cap_usd`. Idempotent. Auto-fires from `ingest-calendar` when `sync_settings.notetaker_auto_enabled=true`. |
| `notetaker-webhook` | http (HMAC, no JWT) | Receives lifecycle events from `/ai/meetings`. On `transcript.done`, fetches the transcript and routes into `ingest-meeting-transcript`. Requires one-time webhook registration — see `docs/known-limitations.md`. |
| `substrate-proxy` | http | Substrate proxy for browser callers (limit ceiling 5000). |
| `summarize-company` | http | Generate a 2-sentence AI overview for a company. RLS-scoped: caller's JWT must have visibility on the company. |
| `trigger-enrichment` | http | **STUB** post-substrate migration. TODO: rewrite to scan substrate person/company entities for missing target columns. |
| `unregister-integration` | http | Tear down a Composio integration binding. |

Auth & runtime conventions:

- HTTP functions run as `butterbase_user` (RLS enforced) by default. The few that need to bypass RLS (`accept-invite`, cron workers, internal write paths) declare `auth: none` and run as `butterbase_service`. `accept-invite` does this deliberately so a new joiner doesn't need pre-existing admin to insert their membership row — the invite token IS the authorization.
- Cron functions all run as `butterbase_service`.
- Many functions use `ctx.substrate` (auto-injected because this app is substrate-linked) for entity reads/writes.

## Schema-design gotchas

- **String defaults must be SQL-quoted in the apply payload** (`"default": "'lead'"`), even though `manage_schema get` returns them without quotes (`"default": "lead"`). Applying the unquoted version triggers `cannot use column reference in DEFAULT expression`. The diff machinery treats them as different and will harmlessly re-normalize them on every apply if you don't quote them.
- **`manage_schema apply` is full-state diff, not additive.** To add one table, you must send all existing tables in the same payload, otherwise it returns `SCHEMA_DESTRUCTIVE_CHANGE` for everything not listed.
- We have no FK to a `users` table — Butterbase's auth users live outside the app DB. All `user_id` / `created_by` / `actor_user_id` columns are plain `uuid`.

## Other gotchas surfaced during the build

- Frontend zip for `create_frontend_deployment` **must use forward-slash entry paths** — the project uses `frontend/zip-dist.cjs` (Node `archiver`) to enforce this on macOS.
- Browser realtime auth is via **`?token=` query parameter**, not Authorization header (WS upgrades can't carry custom headers).
- Storage `getDownloadUrl()` expects the persisted `objectId` UUID, not the `objectKey` path (`objectKey` is internal-only and not a URL).
- The first time we tried installing PL/pgSQL triggers from inside a function we got `permission denied for schema public` — `butterbase_service` can't `CREATE FUNCTION` / `CREATE TRIGGER`. That's why activities are populated in **app code** after each mutation rather than via DB triggers.

## How to keep this folder in sync

```sh
cd backend
./sync.sh
```

This re-fetches everything live and overwrites the files in place. Inspect the diff before committing.

## Live URLs

- App: https://butterbase-crm.butterbase.dev
- API: https://api.butterbase.ai/v1/app_44zjayftl7b3
- OAuth callback (registered with Google): https://api.butterbase.ai/auth/app_44zjayftl7b3/oauth/google/callback
- Functions: https://api.butterbase.ai/v1/app_44zjayftl7b3/fn/{name} — see `functions/` for the full list
