# Social Broadcast Posting — Design Spec

**Date:** 2026-06-15
**Phase:** 1 of 3 (broadcast-only; per-record outreach and copilot proposals deferred)
**Status:** Design — pending implementation plan

## Goal

Add a workspace-level "Social posts" feature that lets any member compose a post once and publish (immediately or scheduled) to Twitter, LinkedIn, and Reddit. Posts use shared workspace accounts connected via Composio OAuth.

## Non-goals (Phase 1)

- **Per-record outreach** from Company/Person detail pages — tracked separately.
- **Copilot-proposed posts** via `agent-chat` confirm_action — tracked separately.
- **Image / video media uploads** — text + optional link URL only in Phase 1.
- **Auto-retry on provider failures.** Manual retry only.
- **Editing already-sent posts.** Providers don't reliably support cross-platform edit.
- **Substrate-shaped projections** (e.g., commitments derived from posts). Phase 1 is recipe-workflow only.

## Architecture overview

```
[ Compose dialog ] ──► create-social-post fn ──► public.social_posts (status=draft|scheduled|sending)
                                                        │
                                              ┌─────────┴─────────┐
                                       publish_now          scheduled_at set
                                              │                    │
                                              ▼                    ▼
                                   send-social-post fn   process-scheduled-social-posts cron (*/5m)
                                              │                    │
                                              └──────────┬─────────┘
                                                         ▼
                            For each selected channel: manage_integrations.execute_action
                                                         │
                                                         ▼
                            Write per-channel result → public.social_post_sends
                                                         │
                                                         ▼
                            Update parent posts.status: sent | partial | failed
                                                         │
                                                         ▼
                            Append activity row (workspace timeline)
```

## Schema

Both tables sit in the Postgres public schema with the standard workspace-RLS predicate:

```sql
workspace_id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = current_user_id()::uuid)
```

### `social_posts`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `workspace_id` | `uuid` FK→workspaces | RLS predicate |
| `created_by` | `uuid` FK→auth users | |
| `body` | `text` | Shared body across channels |
| `channels` | `text[]` | Non-empty subset of `{twitter, linkedin, reddit}` |
| `channel_overrides` | `jsonb` | `{ twitter?: {body?}, linkedin?: {body?, visibility?}, reddit?: {title, subreddit, flair_id?, body?} }`. Reddit key required when reddit ∈ channels. |
| `link_url` | `text?` | Optional URL — Twitter card / LinkedIn article share / Reddit link-post |
| `scheduled_at` | `timestamptz?` | `null` = publish now; set = cron picks up |
| `status` | `text` | `draft | scheduled | sending | sent | partial | failed | canceled` |
| `error` | `text?` | Top-level failure only |
| `published_at` | `timestamptz?` | First successful send |
| `created_at` / `updated_at` | `timestamptz` | |

**Indexes:**
- `(workspace_id, status, scheduled_at)` — cron query
- `(workspace_id, created_at DESC)` — list view

### `social_post_sends`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `workspace_id` | `uuid` | RLS (denormalized) |
| `post_id` | `uuid` FK→social_posts ON DELETE CASCADE | |
| `channel` | `text` | `twitter | linkedin | reddit` |
| `status` | `text` | `pending | sent | failed` |
| `external_post_id` | `text?` | Provider's post ID |
| `external_url` | `text?` | Permalink |
| `error` | `text?` | Per-channel error verbatim from provider |
| `attempts` | `int` default 0 | Manual retry counter |
| `sent_at` | `timestamptz?` | |
| `created_at` | `timestamptz` | |

**Constraints:**
- `UNIQUE (post_id, channel)`
- Index `(workspace_id, channel, sent_at DESC)`

### Status transitions on `social_posts`

```
draft ──(publish_now)──► sending ─► sent (all channels ok)
                                 ├► partial (some ok, some failed)
                                 └► failed (all failed)

draft ──(schedule)──► scheduled ──(cron)──► sending ─► [as above]

scheduled ──(user cancels)──► canceled
failed/partial ──(user retries)──► sending ──► [as above]
```

## Backend functions

All in `backend/functions/`, following the existing `handler.ts` pattern.

### `create-social-post` (HTTP, user-authenticated)

**Input:**
```ts
{
  body: string,
  channels: ('twitter' | 'linkedin' | 'reddit')[],
  channel_overrides?: {
    twitter?: { body?: string },
    linkedin?: { body?: string, visibility?: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN' },
    reddit?: { title: string, subreddit: string, flair_id?: string, body?: string }
  },
  link_url?: string,
  scheduled_at?: string  // ISO8601; null/absent = immediate
}
```

**Validation:**
1. `channels` non-empty, subset of `{twitter, linkedin, reddit}`.
2. If `reddit ∈ channels`: `channel_overrides.reddit.title` and `.subreddit` required.
3. Effective body per channel (override || shared) ≤ Twitter 280, LinkedIn 3000, Reddit title 300 / body 40 000.
4. `manage_integrations.list_connected` for the workspace must include every chosen channel. Else 4xx `{ missing_channels: [...] }`.
5. `scheduled_at` if present must be in the future (>30 s from now).

**Behavior:**
- Insert `social_posts` row plus one `social_post_sends` per channel with `status='pending'`.
- If `scheduled_at` set: post `status='scheduled'`, return.
- Else: post `status='sending'`, fire-and-forget call to `send-social-post`, return.

**Returns:** `{ id, status }`.

### `send-social-post` (HTTP, internal — service key required)

**Input:** `{ post_id: uuid, retry?: boolean }`. When `retry=true`, `failed` sends are reset to `pending` (and `attempts++`) before dispatch; `sent` sends are left untouched.

**Behavior:**
1. Load `social_posts` + all `pending` sends. Bail if `posts.status NOT IN ('sending', 'scheduled')` (idempotency guard for races).
2. Mark `posts.status='sending'`.
3. For each pending send, in parallel, call `manage_integrations.execute_action`:
   - **twitter** → `TWITTER_CREATION_OF_A_POST` `{ text: effectiveBody }`. On success: `external_url = https://twitter.com/i/web/status/{id}`.
   - **linkedin** → `LINKEDIN_CREATE_LINKED_IN_POST` (or `LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE` if `link_url`). Author URN cached in `workspace_integrations.metadata.linkedin_author_urn` (populated lazily via `LINKEDIN_GET_MY_INFO` on first send).
   - **reddit** → `REDDIT_CREATE_REDDIT_POST` `{ subreddit, title, kind, text||url, flair_id? }`. `kind='link'` if using `link_url` as the body, else `'self'`.
4. Per channel: on success, write `external_post_id`, `external_url`, `status='sent'`, `sent_at=now()`. On failure: `status='failed'`, `error=<raw provider msg>`, `attempts++`.
5. After all channels resolve, recompute parent:
   - all sent → `sent` + `published_at=now()`
   - mix → `partial`
   - none → `failed`
6. Append `activities` row: `kind='social_post_published'` (sent/partial) or `'social_post_failed'` (failed), with `details: { post_id, channels: {…} }`.

**Retries:** None automatic. User triggers via UI by re-invoking with the same `post_id` after a failure (only `pending`/`failed` sends are re-dispatched on retry — see § Retry endpoint).

### `process-scheduled-social-posts` (cron, `*/5 * * * *`)

**Behavior:**
1. `SELECT id FROM social_posts WHERE status='scheduled' AND scheduled_at <= now() LIMIT 50`
2. For each: fire-and-forget invoke `send-social-post({post_id})`.
3. Mirrors `process-campaign-sends` exactly.

### Retry / cancel surface area

Implemented as small variants of `send-social-post`:

- **Retry failed**: `send-social-post({post_id, retry: true})` — re-dispatches only `failed` sends (sets them back to `pending` first, increments `attempts`).
- **Cancel scheduled**: direct UPDATE `social_posts SET status='canceled' WHERE id=? AND status='scheduled'` — no function needed; happens client-side via the SDK with RLS gating it.
- **Delete from provider**: optional explicit `delete-social-post-from-platform` HTTP fn, input `{ send_id: uuid }`. Looks up the `social_post_sends` row, calls the channel-appropriate delete (`TWITTER_POST_DELETE_BY_POST_ID` / `LINKEDIN_DELETE_LINKED_IN_POST` / `REDDIT_DELETE_REDDIT_POST`) using `external_post_id`, and on success sets `sends.external_post_id=NULL`, `sends.external_url=NULL`, leaves `status='sent'` and appends a note in the activity feed. Independent of local row deletion.

### No new "connect account" function

OAuth is entirely handled by the existing `manage_integrations.configure` + Composio's hosted auth flow. The frontend Connections panel reuses whatever pattern the Settings page already uses for Gmail/Calendar (confirmed during implementation).

## Frontend

All under `frontend/src/`.

### Routes

Add to `routes/index.tsx`:
```ts
{ path: '/social', element: <SocialPosts /> }
```

Sidebar nav link between "Campaigns" and "Activity": `📢 Social`.

### Pages

`pages/SocialPosts.tsx` — list + side-panel detail view.

Toolbar: search box, status filter chips (`All | Draft | Scheduled | Sent | Failed`), channel filter chips, `+ New Post` button.

Table columns: Post (body truncated), Channels (emoji pills), When (scheduled_at or published_at relative), Status (colored dot + label), Author (avatar + name).

Row click → side panel: full body, per-channel send results (with "view on platform" links to `external_url`), per-channel error display (for failed sends), `Retry failed channels` + `Delete` + (for drafts) `Edit` buttons.

### Components

- `components/NewSocialPostDialog.tsx` — composer. Modeled on `NewCompanyDialog.tsx`. Channel toggles (disabled with tooltip when not connected), shared body editor with live per-channel char counts (override-aware), collapsible per-channel override editors, conditional Reddit block (title + subreddit + flair dropdown), schedule toggle (`Publish now | Schedule for`), date/time/TZ inputs. Action buttons: `Cancel | Save Draft | Publish/Schedule`.
- `components/SocialPostDetailPanel.tsx` — the side-panel content (extracted for reuse).
- `pages/Settings.tsx` — add a "Social accounts" subsection with three `ConnectionRow` items (Twitter / LinkedIn / Reddit) showing icon + name + handle + status badge + connect/disconnect button.

### Hooks (new files in `frontend/src/hooks/`)

- `useSocialPosts.ts` — React Query list + CDC subscription on `social_posts` and `social_post_sends`.
- `useSocialConnections.ts` — wraps `list_connected` for channel-toggle gating and Settings display.
- `useCreateSocialPost.ts` — mutation calling `create-social-post`.
- `useRetrySocialPost.ts` — mutation calling `send-social-post` with `retry: true`.
- `useCancelSocialPost.ts` — direct SDK UPDATE.
- `useDeleteFromPlatform.ts` — optional provider-side delete.

### Realtime

Add `social_posts` and `social_post_sends` to the subscribed tables in `frontend/src/lib/realtime.ts`. Status changes from `sending → sent` etc. push live without polling.

## Error handling

| Failure | Where caught | User sees |
|---|---|---|
| Validation (empty channels, missing Reddit title, oversized body) | `create-social-post` pre-insert | 4xx; inline field error in dialog |
| Channel not connected | `create-social-post` | 4xx with `missing_channels`; dialog disables toggle |
| OAuth token revoked at send | `send-social-post` per-channel | `sends.error="auth: token revoked"`; banner on Settings |
| Provider rate limit (429, Reddit RATELIMIT) | `send-social-post` per-channel | `sends.error` with cooldown text; manual retry |
| Provider validation (Reddit flair, LinkedIn URN) | `send-social-post` per-channel | `sends.error` raw provider message in side panel |
| Cron lock contention | `send-social-post` status guard | Second invocation no-ops |

**Retry policy:** No automatic retries — explicit user action only. Rationale: a silent retry of a 429 could duplicate a public post if the provider already accepted the request.

## Activity feed integration

Two new `activities.kind` values:
- `social_post_published` — emitted on `sent` or `partial` transition; `details: { post_id, body_preview, channels: {twitter:'sent', linkedin:'failed'} }`
- `social_post_failed` — emitted when all channels fail

Filter chips in `ActivityFeed.tsx` get two new entries.

## Observability

`send-social-post` logs one structured line per `execute_action` call: `{ post_id, channel, tool_name, success, error_code?, latency_ms }`. No dashboard in Phase 1; future metric: per-channel send latency.

## Data lifecycle

- `social_posts` rows live forever (audit). Drafts have a "Delete" button. No soft delete in Phase 1.
- `social_post_sends` cascade-delete with their parent.
- OAuth disconnect via Settings revokes the Composio connection but leaves all post history intact. Scheduled posts targeting a disconnected channel fail at publish time with `auth: token revoked`.

## Open items deferred to implementation

- **Composio OAuth UI flow specifics** — confirm whether existing Gmail/Calendar connect uses redirect or popup, reuse same pattern.
- **LinkedIn organization vs person posting** — Phase 1 assumes `urn:li:person`. If the user wants to post AS a company page, that's a follow-up (different OAuth scope, different URN format).
- **Reddit's per-subreddit posting rules** — the API may reject a post for reasons not surfaced in validation (automoderator). User sees the raw error; no special handling.
- **Timezone for scheduling** — dialog uses browser TZ for display; `scheduled_at` stored as `timestamptz`. No special TZ picker.

## Out-of-scope (already tracked as task TODOs)

- Per-record social outreach from Company/Person detail pages
- Copilot-proposed social posts in `agent-chat`
- Full media support (multi-image, video)

## Implementation order (to be expanded in the plan)

1. Schema migration (`social_posts`, `social_post_sends`, RLS policies)
2. `create-social-post` + `send-social-post` (immediate path)
3. `manage_integrations.configure` for `twitter`, `linkedin`, `reddit` + Settings UI
4. `NewSocialPostDialog` (immediate publish only first)
5. `SocialPosts` list page + side panel
6. Scheduling: `scheduled_at` flow + `process-scheduled-social-posts` cron
7. Retry endpoint + UI
8. Realtime subscription wiring
9. Activity feed integration
10. Optional: provider-side delete action
