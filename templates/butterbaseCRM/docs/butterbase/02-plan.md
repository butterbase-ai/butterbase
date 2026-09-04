# Plan

## Tables

Conventions: all PKs are `uuid default gen_random_uuid()`; all rows carry `workspace_id uuid not null references workspaces(id)` (the RLS pivot) except `workspaces` and `memberships` themselves; `created_at timestamptz default now()`, `updated_at timestamptz default now()` everywhere; index on every FK column.

### `workspaces`
- `id` uuid pk
- `name` text not null
- `slug` text unique not null
- `owner_user_id` uuid not null  *(the user who created it; not a FK because auth users live in the auth service)*
- `created_at` timestamptz

### `memberships`  *(drives RLS; user belongs to N workspaces)*
- `id` uuid pk
- `workspace_id` uuid not null → `workspaces.id`
- `user_id` uuid not null  *(matches the JWT subject)*
- `role` text not null  *(enum-as-text: `owner` | `admin` | `member`)*
- `created_at` timestamptz
- unique index on `(workspace_id, user_id)`

### `companies`
- `id` uuid pk
- `workspace_id` uuid not null
- `name` text not null
- `domain` text  *(e.g. `acme.com` — used for dedupe + favicon fallback)*
- `logo_object_id` text  *(storage object id; nullable)*
- `industry` text
- `employee_count` integer
- `location` text
- `description` text
- `ai_summary` text  *(cache of last summarize-company output)*
- `ai_summary_at` timestamptz
- `created_by` uuid not null
- `created_at`, `updated_at` timestamptz
- index on `(workspace_id, name)`, `(workspace_id, domain)`

### `people`
- `id` uuid pk
- `workspace_id` uuid not null
- `company_id` uuid → `companies.id` (nullable — a person may not be linked yet)
- `first_name` text
- `last_name` text
- `email` text
- `phone` text
- `title` text
- `avatar_object_id` text
- `linkedin_url` text
- `created_by` uuid not null
- `created_at`, `updated_at` timestamptz
- index on `(workspace_id, company_id)`, `(workspace_id, email)`

### `deals`
- `id` uuid pk
- `workspace_id` uuid not null
- `name` text not null
- `company_id` uuid → `companies.id` (nullable)
- `primary_person_id` uuid → `people.id` (nullable)
- `stage` text not null  *(enum-as-text: `lead` | `qualified` | `proposal` | `negotiation` | `won` | `lost`)*
- `amount_cents` bigint  *(money in minor units, nullable)*
- `currency` text default `'USD'`
- `close_date` date
- `owner_user_id` uuid not null  *(deal owner — typically the salesperson)*
- `created_by` uuid not null
- `created_at`, `updated_at` timestamptz
- index on `(workspace_id, stage)`, `(workspace_id, company_id)`, `(workspace_id, owner_user_id)`

### `notes`
- `id` uuid pk
- `workspace_id` uuid not null
- `entity_type` text not null  *(`company` | `person` | `deal`)*
- `entity_id` uuid not null
- `body` text not null  *(plain text / markdown — rich-text formatting is a v2 concern)*
- `created_by` uuid not null
- `created_at`, `updated_at` timestamptz
- index on `(workspace_id, entity_type, entity_id)`

### `meetings`
- `id` uuid pk
- `workspace_id` uuid not null
- `title` text not null
- `starts_at` timestamptz not null
- `ends_at` timestamptz
- `location` text  *(or video link)*
- `notes` text
- `company_id` uuid → `companies.id` (nullable)
- `deal_id` uuid → `deals.id` (nullable)
- `created_by` uuid not null
- `created_at`, `updated_at` timestamptz
- index on `(workspace_id, starts_at)`, `(workspace_id, company_id)`

### `meeting_attendees`  *(needed because meetings have many people — derived from "meetings should be in v1")*
- `id` uuid pk
- `workspace_id` uuid not null
- `meeting_id` uuid not null → `meetings.id`
- `person_id` uuid → `people.id` (nullable — for non-CRM attendees)
- `external_email` text  *(nullable — for attendees with no `people` record)*
- `response` text  *(`accepted` | `declined` | `tentative` | `pending`)*
- unique index on `(meeting_id, person_id)`

### `activities`  *(append-only event log → powers the global activity feed and live updates)*
- `id` uuid pk
- `workspace_id` uuid not null
- `actor_user_id` uuid not null
- `kind` text not null  *(`company.created` | `company.updated` | `person.created` | `deal.stage_changed` | `note.created` | `meeting.created` | …)*
- `entity_type` text not null
- `entity_id` uuid not null
- `payload` jsonb  *(diff or stage transition, freeform)*
- `created_at` timestamptz
- index on `(workspace_id, created_at desc)`, `(workspace_id, entity_type, entity_id, created_at desc)`

### `attachments`
- `id` uuid pk
- `workspace_id` uuid not null
- `entity_type` text not null  *(`deal` | `company` | `person` — deals first per Q6)*
- `entity_id` uuid not null
- `object_id` text not null  *(storage object id)*
- `filename` text not null
- `content_type` text
- `size_bytes` bigint
- `uploaded_by` uuid not null
- `created_at` timestamptz
- index on `(workspace_id, entity_type, entity_id)`

## RLS

**Model:** workspace-scoped. A row is visible iff the requesting user has a `memberships` row for that row's `workspace_id`. Implemented via custom SQL policies (the standard `create_user_isolation` helper is keyed on a single user column — we need a membership-join predicate, so each policy is hand-written).

**Membership-join in every policy** (revised from C1 during the rls stage). Predicates read `current_user_id()::uuid` (cast required — `current_user_id()` returns text) and join through `memberships` to scope the row. No custom JWT claim; no `mint-workspace-jwt` function needed (collapsed). No public `workspaces.slug` lookup exposed in v1.

**Edit/delete:** A2 — for `deals`, `notes`, `meetings`, `attachments`: rows can be edited/deleted only by the author (`created_by` / `uploaded_by`) OR by a workspace `admin`/`owner`. All workspace members can still INSERT.

**Activity log:** B2 (revised from B1 during the rls stage — `butterbase_service` lacks `CREATE` on the `public` schema, so PL/pgSQL triggers can't be installed via the function path). The frontend writes `activities` rows after each mutation. Trade-off: non-frontend writes won't fan out — acceptable for v1 since all client writes go through the SDK.

**Workspace bootstrap:** when a user creates a workspace, they self-insert a `memberships` row with `role='owner'` via a carve-out INSERT policy that checks `workspaces.owner_user_id = current_user_id()`. No trigger required.

| Table | SELECT | INSERT | UPDATE / DELETE |
|---|---|---|---|
| `workspaces` | member of workspace | (admin via app code) | owner/admin only |
| `memberships` | member of same workspace | owner/admin only (+ founding-owner self-insert carve-out) | owner/admin only |
| `companies` | workspace member | workspace member | workspace member |
| `people` | workspace member | workspace member | workspace member |
| `deals` | workspace member | workspace member | **author or admin** |
| `notes` | workspace member | workspace member | **author or admin** |
| `meetings` | workspace member | workspace member | **author or admin** |
| `meeting_attendees` | workspace member | workspace member | workspace member (follows parent meeting) |
| `activities` | workspace member | workspace member with actor_user_id = current user | none (append-only) |
| `attachments` | workspace member | workspace member | **uploader or admin** |

## Auth

- **Providers:** Google OAuth + email/password.
- **Email verification:** required on the email/password path (default Butterbase behavior).
- **Workspace selection post-login:** client-side state in zustand (persisted to localStorage). No workspace claim in JWT (revised from C1 during rls stage); RLS reads workspace via membership join.
- **Seed data:** template ships with a demo workspace ("Acme Inc") containing sample companies, people, deals, notes, meetings, and activity history, so a fresh clone is browseable without signup. Seeded via a one-shot script run during preflight/deploy.

## Functions

**One HTTP function in v1.** No cron, no webhooks. (`mint-workspace-jwt` was collapsed during the rls stage — membership-join RLS doesn't need a workspace claim.)

### `summarize-company`
- **Trigger:** HTTP `POST`, authenticated.
- **Input:** `{ company_id: string }`.
- **Logic:** authorize via RLS (re-query the company through the user's token, fail if not visible); fetch recent notes + open deals + recent activities; call `ctx.ai` (or the AI gateway) with a fixed prompt; return `{ summary: string }`. Optional: cache result on `companies.ai_summary` + `ai_summary_at` (added in schema stage as `text` + `timestamptz`).
- **Idempotency:** not needed — read-only from the user's perspective.

## Storage

All objects workspace-scoped, uploaded via SDK presigned-URL flow.

| Object kind | Per-row | Access | Size cap | Content-type |
|---|---|---|---|---|
| Company logos | one per `companies` row (`logo_object_id`) | workspace-private (presigned download) | 2 MB | `image/*` |
| Person avatars | one per `people` row (`avatar_object_id`) | workspace-private | 2 MB | `image/*` |
| Deal / company / person attachments | many per parent row (via `attachments` table) | workspace-private | 10 MB (platform default; raise via dashboard) | any |

**Seed-workspace exception (D1):** logos uploaded to the demo "Acme Inc" workspace are flagged public-read so they can render on a marketing/landing page without auth. Implementation: per-upload `public:true` flag at seed time.

## AI / RAG / realtime / durable

### AI (`manage_ai`)
- One feature: "Summarise this company" via the `summarize-company` HTTP function.
- **Model:** `anthropic/claude-haiku-4.5` (fast + cheap; sufficient for a 2-sentence overview).
- **Key:** uses the platform's shared key by default; template README notes how each clone can switch to BYOK.

### Realtime (`manage_realtime`)
Subscribe to row-level inserts/updates/deletes on: `companies`, `people`, `deals`, `notes`, `meetings`, `activities`, `attachments`. `meeting_attendees` rides on `meetings`. `workspaces` / `memberships` are not subscribed (rare changes — refresh on next nav).

### RAG — not used (Q8).
### Durable Objects — not used (Q10).

## Frontend

- **Stack:** Vite + React (TypeScript). Deployed via Butterbase frontend deployment (`framework: react-vite`).
- **UI:** shadcn/ui + Tailwind CSS. Components copy-pasted into the repo so each clone owns and can customize them.
- **Routing:** React Router (`/companies`, `/companies/:id`, `/people`, `/deals`, `/activity`, `/settings/...`).
- **State:** TanStack Query for server state (works cleanly with realtime invalidation); Zustand for any small global UI state (workspace switcher, modal open/close).
- **Data layer:** `@butterbase/sdk` client; one shared `butterbase` instance; realtime subscriptions invalidate TanStack Query caches.

## Toolchain

- **SDK surfaces:** both.
  - **Client-side:** `@butterbase/sdk` in the Vite frontend — `auth` (login, OAuth callback, session refresh), `db.from(...)` for CRUD against `companies` / `people` / `deals` / etc., `storage` for logo/avatar/attachment uploads, `realtime` subscriptions, `functions.invoke` for `summarize-company`.
  - **Server-side:** `@butterbase/sdk` inside the function for elevated reads (e.g. cross-row checks for AI summary context) and to call the AI gateway via the service-key flow.
- **CLI usage:** yes. Used during preflight for `butterbase login`, `butterbase apps create`, `butterbase apps use`; during build for `butterbase schema apply --dry-run`, `butterbase functions deploy`, `butterbase functions logs`; during deploy for frontend deployment commands; ad hoc for `butterbase keys generate --substrate` (substrate stage).
- **Why both:** MCP tools provision and orchestrate (good for the agent). SDK is what the runtime code actually uses. CLI is the human dev-loop fallback when MCP isn't running.

## Build order

1. **preflight** — install CLI, login, create app, capture `app_id` + `api_base`.
2. **docs** — prime `butterbase_docs` for the capabilities this plan uses (schema, rls, auth, storage, functions, ai, realtime, frontend, substrate).
3. **schema** — apply all 10 tables + indexes + the `companies.ai_summary` / `ai_summary_at` columns.
4. **rls** — write the workspace-membership-scoped policies (custom SQL via `manage_rls`) covering the SELECT/INSERT/UPDATE/DELETE matrix.
5. **auth** — configure Google OAuth + email/password.
6. **storage** — confirm defaults; document the 10 MB attachment cap.
7. **functions** — deploy `summarize-company`.
8. **ai** — wire the AI gateway and confirm the haiku-4.5 call from `summarize-company`.
9. **realtime** — enable subscriptions on the 7 subscribed tables.
10. **frontend** — scaffold Vite + React + shadcn; build the Companies list (default screen), Company detail, Deals kanban, Activity feed, workspace switcher, login + OAuth callback.
11. **deploy** — deploy frontend, run the seed-data script for the "Acme Inc" demo workspace, smoke-test the live URL.
12. **substrate** — wire Companies/People as substrate entities; expose hooks so other Butterbase apps can read/write them for the same user. (Optional — user explicitly asked for this.)

## Post-hackathon
_n/a — not a hackathon_
