# Instagram + TikTok Social Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Instagram (feed / reel / story / carousel) and TikTok (video / photo) as post channels alongside Twitter/LinkedIn/Reddit, with a media-upload pipeline that also enables media on Twitter and LinkedIn.

**Architecture:** Extend the existing Composio-backed dispatch pattern in `send-social-post`. New `media` jsonb column on `social_posts` holds storage object references; at send-time, `presignMedia` mints Butterbase presigned download URLs (1h TTL) that Composio fetches. Two new senders (`sendInstagram`, `sendTiktok`) join the `SENDERS` map. Frontend gains a media picker in the composer and per-channel post-type controls.

**Tech Stack:** Butterbase (Postgres + functions + storage + integrations/Composio), TypeScript, React, TanStack Query, shadcn UI, sonner toasts.

## Global Constraints

- **No git repo** — the project is not under git. Skip `git commit`, `git add`, `git status` steps. Deploys are the atomic unit.
- **App id:** `app_44zjayftl7b3`.
- **Storage caps already raised** via MCP: `maxFileSizeMb=250`, `storageLimitBytes=5368709120` (5 GB). No further storage-config changes required.
- **Env var:** `send-social-post` and `delete-social-post-from-platform` already have `BUTTERBASE_API_KEY` set (memory: `project-social-functions-need-api-key-env`). New helper `presignMedia` reuses it. Redeploys must preserve it — use `manage_function` action `update_env` if a redeploy clears it.
- **Composio call convention:** functions use `ctx.integrations.asUser(userId).execute(tool, params)` via the auto-injected `BUTTERBASE_FUNCTION_SERVICE_KEY`. Do not switch to a different auth path.
- **Deployments:** backend functions via `mcp__butterbase__deploy_function`; schema via `mcp__butterbase__manage_schema` (dry_run then apply); frontend via `manage_frontend` start_deployment.
- **No new tests infra.** The project has no vitest/jest. Verification is manual smoke via `mcp__butterbase__invoke_function` and browser E2E; write assertions inline in the plan.
- **Channel-slug spelling:** Composio slug for X is `twitter` (not `x`); Instagram is `instagram`; TikTok is `tiktok`. Match exactly in DB, code, and UI.
- **No new external dependencies.** Do not add npm packages — use existing shadcn/lucide/sonner.

---

## File Structure

**Backend (`backend/`)**
- `schema.json` — add `media` column on `social_posts`.
- `functions/configure-social-toolkit/handler.ts` — add `instagram` (no-BYO) and `tiktok` (BYO) branches.
- `functions/create-social-post/handler.ts` — extend `VALID_CHANNELS`, add per-channel validation with a shared `validateChannel(...)` helper.
- `functions/publish-social-post/handler.ts` — mirror the same `VALID_CHANNELS` and validation helper.
- `functions/edit-social-post/handler.ts` — no logic change; verify it tolerates new channel slugs (spot-fix if it hard-codes twitter/linkedin/reddit).
- `functions/send-social-post/handler.ts` — add `presignMedia`, `waitForFinished`, `pollTiktokStatus`, `sendInstagram`, `sendTiktok`, register in `SENDERS`, update `sendTwitter` and `sendLinkedIn` for media, extend `externalIdFor` / `externalUrlFor`.
- `functions/delete-social-post-from-platform/handler.ts` — add Instagram delete + Story short-circuit + TikTok unsupported-delete branch. Route by `channel` (already present) + read stored `post_type` from `channel_overrides` for the story branch.

**Frontend (`frontend/src/`)**
- `lib/socialApi.ts` — extend `SocialChannel` union, `ChannelOverrides`, add `MediaRef` type, add `SocialPost.media` field.
- `components/SocialIcons.tsx` — add `InstagramIcon`, `TikTokIcon`.
- `components/SocialPostComposer.tsx` — media picker with thumbnails + reorder + delete, per-channel override panels, per-channel toggle enablement based on current media shape.
- `components/SocialConnectionsPanel.tsx` — two new channel rows (Instagram no-cred, TikTok BYO).
- `components/SocialSetupWizard.tsx` — TikTok step (same shape as Twitter/LinkedIn/Reddit); Instagram short-circuits to direct connect.
- `components/SocialPostDetailPanel.tsx` — render new channel results, delete banner for TikTok, informational banner for expired IG story deletes.

---

## Deploy commands referenced throughout

```
# Schema
mcp__butterbase__manage_schema app_id=app_44zjayftl7b3 action=apply dry_run=true
mcp__butterbase__manage_schema app_id=app_44zjayftl7b3 action=apply dry_run=false

# Functions (one per fn — repeat)
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=<name>

# After a redeploy — re-set env if it was cleared
mcp__butterbase__manage_function app_id=app_44zjayftl7b3 action=update_env fn_name=<name> \
  env={"BUTTERBASE_API_KEY":"bb_sk_..."}

# Frontend
mcp__butterbase__create_frontend_deployment app_id=app_44zjayftl7b3
mcp__butterbase__manage_frontend app_id=app_44zjayftl7b3 action=start_deployment deployment_id=<id>
```

---

## Task 1: Schema — add `social_posts.media` column

**Files:**
- Modify: `backend/schema.json` (add `media` under `tables.social_posts.columns`)

**Interfaces:**
- Produces: `social_posts.media jsonb NOT NULL DEFAULT '[]'::jsonb` — array of `{ object_id, kind, mime, size_bytes }`. Downstream tasks assume `post.media` is always an array (never `null`).

- [ ] **Step 1: Add the column to `schema.json`**

Locate `social_posts.columns` (around line 1276 of `backend/schema.json`) and insert after the `channel_overrides` entry:

```json
"media": {
  "type": "jsonb",
  "nullable": false,
  "default": "'[]'::jsonb"
},
```

- [ ] **Step 2: Dry-run the migration**

```
mcp__butterbase__manage_schema app_id=app_44zjayftl7b3 action=apply dry_run=true
```

Expected: diff shows a single `ALTER TABLE social_posts ADD COLUMN media jsonb NOT NULL DEFAULT '[]'::jsonb`. No other changes. If more changes appear, stop and reconcile — the schema.json may have drifted from prod.

- [ ] **Step 3: Apply the migration**

```
mcp__butterbase__manage_schema app_id=app_44zjayftl7b3 action=apply dry_run=false
```

Expected: `{ ok: true }` (or equivalent success shape).

- [ ] **Step 4: Verify default backfills existing rows**

```
mcp__butterbase__select_rows app_id=app_44zjayftl7b3 table=social_posts limit=5 columns=id,media
```

Expected: every row's `media` = `[]`.

---

## Task 2: `configure-social-toolkit` — support Instagram + TikTok

**Files:**
- Modify: `backend/functions/configure-social-toolkit/handler.ts`

**Interfaces:**
- Consumes: existing `TOOLKIT_SCOPES` map + upstream `POST /v1/{app_id}/integrations/configure` behavior (which accepts optional `oauth_credentials` for Composio-managed toolkits).
- Produces: two new supported `toolkit` values, `instagram` and `tiktok`.

- [ ] **Step 1: Extend `TOOLKIT_SCOPES`**

Replace the existing map:

```ts
const TOOLKIT_SCOPES: Record<string, string[]> = {
  twitter: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  linkedin: ['openid', 'profile', 'email', 'w_member_social'],
  reddit: ['identity', 'submit', 'read', 'flair'],
  instagram: [],                                                         // Composio-managed defaults
  tiktok: ['user.info.basic', 'video.upload', 'video.publish'],
};
```

- [ ] **Step 2: Loosen the BYO-credentials requirement for Instagram**

Find the block:

```ts
if (!workspace_id || !toolkit || !client_id || !client_secret) {
  return json({ error: 'missing_fields', detail: '...' }, 400);
}
```

Replace with:

```ts
const requiresByo = toolkit !== 'instagram';
if (!workspace_id || !toolkit || (requiresByo && (!client_id || !client_secret))) {
  return json({ error: 'missing_fields', detail: 'workspace_id, toolkit, client_id and client_secret are required (Instagram excepted)' }, 400);
}
```

- [ ] **Step 3: Skip `oauth_credentials` for Instagram in the upstream body**

Find:

```ts
const oauth_credentials: Record<string, string> = { client_id, client_secret };
if (toolkit === 'twitter') oauth_credentials.generic_id = bearer_token;
```

Replace with:

```ts
const oauth_credentials: Record<string, string> | undefined =
  toolkit === 'instagram' ? undefined : { client_id, client_secret };
if (toolkit === 'twitter') oauth_credentials!.generic_id = bearer_token!;
```

Then in the `fetch` body, change:

```ts
oauth_credentials,
```

to:

```ts
...(oauth_credentials ? { oauth_credentials } : {}),
```

- [ ] **Step 4: Deploy**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=configure-social-toolkit
```

- [ ] **Step 5: Smoke Instagram (as owner)**

```
mcp__butterbase__invoke_function app_id=app_44zjayftl7b3 fn_name=configure-social-toolkit \
  body={"workspace_id":"<your-ws-id>","toolkit":"instagram"}
```

Expected: `{ ok: true, toolkit: 'instagram', composio_auth_config_id: '...' }`.

- [ ] **Step 6: Smoke TikTok validation error path**

```
mcp__butterbase__invoke_function app_id=app_44zjayftl7b3 fn_name=configure-social-toolkit \
  body={"workspace_id":"<your-ws-id>","toolkit":"tiktok"}
```

Expected: 400 `missing_fields` (client_id/secret required for TikTok). Confirms the loosening only affects Instagram.

---

## Task 3: `create-social-post` — media validation matrix

**Files:**
- Modify: `backend/functions/create-social-post/handler.ts`

**Interfaces:**
- Consumes: `input.media` (from request body; array of `{ object_id, kind, mime, size_bytes }`); optional. Default `[]`.
- Produces: 4xx responses with `error` strings following the pattern `'<channel>: <reason>'` for consistent frontend surfacing. Also produces the invariant: any row inserted with `channels` including `'instagram'` or `'tiktok'` has valid `media`.

- [ ] **Step 1: Extend `VALID_CHANNELS` and `LIMITS`**

Replace the top constants:

```ts
const LIMITS = {
  twitter: { body: 280 },
  linkedin: { body: 3000 },
  reddit: { title: 300, body: 40000 },
  instagram: { body: 2200 },
  tiktok: { body: 2200 },
};

const VALID_CHANNELS = ['twitter', 'linkedin', 'reddit', 'instagram', 'tiktok'];
```

- [ ] **Step 2: Add media validation helpers**

Insert below `eff`:

```ts
const MB = 1024 * 1024;

function inferInstagramType(media) {
  if (media.length >= 2) return 'carousel';
  if (media.length === 1 && media[0].kind === 'video') return 'feed';
  return 'feed';
}

function validateMediaShape(media) {
  if (!Array.isArray(media)) return 'media must be an array';
  for (const m of media) {
    if (!m || typeof m.object_id !== 'string') return 'media entry missing object_id';
    if (m.kind !== 'image' && m.kind !== 'video') return `media kind must be image|video (got ${m.kind})`;
    if (typeof m.size_bytes !== 'number' || m.size_bytes <= 0) return 'media entry missing size_bytes';
  }
  return null;
}

function validateChannel(channel, post) {
  const { body, media, channel_overrides = {} } = post;
  const override = channel_overrides[channel] ?? {};
  const bodyLen = (override.caption ?? override.body ?? body ?? '').length;

  if (channel === 'twitter') {
    if (bodyLen > LIMITS.twitter.body) return 'twitter body exceeds 280 chars';
    const hasVideo = media.some(m => m.kind === 'video');
    const images = media.filter(m => m.kind === 'image').length;
    if (hasVideo && media.length !== 1) return 'twitter: video posts must have exactly 1 video';
    if (!hasVideo && images > 4) return 'twitter: up to 4 images per post';
    if (hasVideo && media[0].size_bytes > 512 * MB) return 'twitter: video exceeds 512 MB';
    return null;
  }
  if (channel === 'linkedin') {
    if (bodyLen > LIMITS.linkedin.body) return 'linkedin body exceeds 3000 chars';
    if (media.length > 1) return 'linkedin: max 1 media item';
    if (media.length === 1 && media[0].kind === 'video' && media[0].size_bytes > 200 * MB) return 'linkedin: video exceeds 200 MB';
    return null;
  }
  if (channel === 'reddit') {
    const r = channel_overrides.reddit ?? {};
    if (!r.title || typeof r.title !== 'string') return 'reddit requires title';
    if (!r.subreddit || typeof r.subreddit !== 'string') return 'reddit requires subreddit';
    if (r.title.length > LIMITS.reddit.title) return 'reddit title exceeds 300 chars';
    if (bodyLen > LIMITS.reddit.body) return 'reddit body exceeds 40000 chars';
    return null;
  }
  if (channel === 'instagram') {
    if (media.length === 0) return 'instagram: requires media';
    if (bodyLen > LIMITS.instagram.body) return 'instagram caption exceeds 2200 chars';
    const postType = override.post_type ?? inferInstagramType(media);
    if (!['feed', 'reel', 'story', 'carousel'].includes(postType)) return `instagram: invalid post_type ${postType}`;
    if (postType === 'carousel') {
      if (media.length < 2 || media.length > 10) return 'instagram carousel: 2–10 media required';
    } else {
      if (media.length !== 1) return `instagram ${postType}: exactly 1 media required`;
    }
    if (postType === 'reel' && media[0].kind !== 'video') return 'instagram reel: video required';
    for (const m of media) {
      if (m.kind === 'video' && m.size_bytes > 100 * MB) return 'instagram: video exceeds 100 MB';
    }
    return null;
  }
  if (channel === 'tiktok') {
    if (media.length === 0) return 'tiktok: requires media';
    if (bodyLen > LIMITS.tiktok.body) return 'tiktok caption exceeds 2200 chars';
    const postType = override.post_type ?? (media[0].kind === 'video' ? 'video' : 'photo');
    if (postType === 'video') {
      if (media.length !== 1 || media[0].kind !== 'video') return 'tiktok video: exactly 1 video required';
      if (media[0].size_bytes > 250 * MB) return 'tiktok: video exceeds 250 MB';
    } else {
      if (media.length < 1 || media.length > 35) return 'tiktok photo: 1–35 images required';
      if (media.some(m => m.kind !== 'image')) return 'tiktok photo: all media must be images';
    }
    return null;
  }
  return null;
}
```

- [ ] **Step 3: Pull `media` from request body and validate shape**

Replace the destructure line:

```ts
const { workspace_id, body, channels, channel_overrides = {}, link_url, scheduled_at, save_as_draft = false } = input || {};
```

With:

```ts
const { workspace_id, body, channels, channel_overrides = {}, link_url, media = [], scheduled_at, save_as_draft = false } = input || {};

const mediaErr = validateMediaShape(media);
if (mediaErr) return json(400, { error: mediaErr });
```

- [ ] **Step 4: Replace the per-channel validation block (below `for (const c of channels)`)**

Delete the four hard-coded blocks (twitter/linkedin/reddit limits) and replace with:

```ts
const validationPost = { body, media, channel_overrides };
for (const channel of channels) {
  const err = validateChannel(channel, validationPost);
  if (err) return json(400, { error: err });
}
```

- [ ] **Step 5: Persist `media` in both INSERT branches (draft + publish)**

Both `INSERT INTO social_posts (...)` calls: add `media` to the column list and `$N::jsonb` to the values.

Draft branch:

```ts
`INSERT INTO social_posts (workspace_id, created_by, body, channels, channel_overrides, link_url, media, scheduled_at, status)
 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, 'draft')
 RETURNING id`,
[workspace_id, ctx.user.id, body, channels ?? [], JSON.stringify(channel_overrides), link_url ?? null, JSON.stringify(media), scheduled_at ?? null],
```

Publish branch (mirror the same shape, keeping the trailing `$N` for status).

- [ ] **Step 6: Deploy + smoke**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=create-social-post
```

Smoke a rejected case:
```
mcp__butterbase__invoke_function app_id=app_44zjayftl7b3 fn_name=create-social-post \
  body={"workspace_id":"<ws>","body":"hi","channels":["instagram"]}
```
Expected: 400 `{ error: 'instagram: requires media' }`.

---

## Task 4: `publish-social-post` — mirror validation

**Files:**
- Modify: `backend/functions/publish-social-post/handler.ts`

**Interfaces:**
- Consumes: same `validateChannel` logic as Task 3 (copy/paste to keep functions self-contained — the project does not share modules between functions).
- Produces: 4xx before dispatch when a saved draft violates channel rules.

- [ ] **Step 1: Update constants + helpers**

Replace the top `LIMITS` and `VALID_CHANNELS` with the same shape as Task 3. Add the same `inferInstagramType`, `validateMediaShape`, `validateChannel` functions.

- [ ] **Step 2: Read `media` from the loaded post**

In the SELECT that reads `social_posts` before validation (find the `SELECT * FROM social_posts WHERE id = $1`), `media` is already returned via `*`. No SQL change.

- [ ] **Step 3: Replace the per-channel validation block**

Find the hard-coded twitter/linkedin/reddit body-length checks (around line 47). Replace with:

```ts
const validationPost = {
  body: post.body,
  media: post.media ?? [],
  channel_overrides: overrides,
};
for (const channel of channels) {
  const err = validateChannel(channel, validationPost);
  if (err) return json(400, { error: err });
}
```

- [ ] **Step 4: Deploy**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=publish-social-post
```

- [ ] **Step 5: Smoke**

Create a draft with `channels=['instagram']` and empty `media` (Task 3 will reject this at create-time, so instead: create a draft via direct SQL insert with `channels=['instagram']` and `media=[]`, then invoke publish-social-post — should 400 with `instagram: requires media`).

---

## Task 5: `send-social-post` — `presignMedia` + poll helpers

**Files:**
- Modify: `backend/functions/send-social-post/handler.ts`

**Interfaces:**
- Consumes: `ctx.env.BUTTERBASE_API_KEY`, `ctx.env.BUTTERBASE_APP_ID`.
- Produces:
  - `async function presignMedia(ctx, media): Promise<string[]>` — parallel presign; throws on any 404 with error `'media object missing: <object_id>'`.
  - `async function waitForFinished(ctx, userId, creationId): Promise<{ ok: boolean; error?: string }>` — polls `INSTAGRAM_GET_MEDIA` (or the container status action) until FINISHED / ERROR or 90 s timeout.
  - `async function pollTiktokStatus(ctx, userId, publishId, initial): Promise<{ ok: boolean; data?: any; error?: string }>` — polls `TIKTOK_FETCH_PUBLISH_STATUS` until FINISHED (returns updated `data` including `share_url`), FAILED, or 90 s timeout.

- [ ] **Step 1: Insert `presignMedia` above `sendTwitter`**

```ts
async function presignMedia(ctx, media) {
  if (!media || media.length === 0) return [];
  const key = ctx.env.BUTTERBASE_API_KEY;
  const appId = ctx.env.BUTTERBASE_APP_ID;
  if (!key || !appId) throw new Error('presignMedia: missing BUTTERBASE_API_KEY or BUTTERBASE_APP_ID');
  const urls = await Promise.all(media.map(async (m) => {
    const r = await fetch(`https://api.butterbase.ai/v1/${appId}/storage/download/${m.object_id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`media object missing: ${m.object_id}`);
    const body = await r.json().catch(() => ({}));
    if (!body.downloadUrl) throw new Error(`media object missing downloadUrl: ${m.object_id}`);
    return body.downloadUrl;
  }));
  return urls;
}
```

- [ ] **Step 2: Insert `waitForFinished` (Instagram container poll)**

```ts
async function waitForFinished(ctx, userId, creationId) {
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await composio(ctx, 'INSTAGRAM_GET_MEDIA', { fields: 'status_code', media_id: creationId }, userId);
    if (!r.ok) return r;
    const status = r.data?.status_code ?? r.data?.data?.status_code ?? deepKey(r.data, ['status_code']);
    if (status === 'FINISHED') return { ok: true };
    if (status === 'ERROR' || status === 'EXPIRED') return { ok: false, error: `instagram: container ${status}` };
  }
  return { ok: false, error: 'instagram: container processing timed out (90s)' };
}
```

- [ ] **Step 3: Insert `pollTiktokStatus`**

```ts
async function pollTiktokStatus(ctx, userId, publishId, initial) {
  if (!publishId) return initial;
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await composio(ctx, 'TIKTOK_FETCH_PUBLISH_STATUS', { publish_id: publishId }, userId);
    if (!r.ok) continue;
    const status = r.data?.status ?? deepKey(r.data, ['status']);
    if (status === 'PUBLISH_COMPLETE' || status === 'FINISHED') return { ok: true, data: r.data };
    if (status === 'FAILED' || status === 'PUBLISH_FAILED') {
      return { ok: false, error: `tiktok: publish failed (${r.data?.fail_reason ?? 'unknown'})` };
    }
  }
  return { ok: false, error: 'tiktok: processing timed out — check TikTok inbox', data: { publish_id: publishId } };
}
```

- [ ] **Step 4: Deploy (env preserved test)**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=send-social-post
mcp__butterbase__manage_function app_id=app_44zjayftl7b3 action=get_env fn_name=send-social-post
```

Expected `get_env` output includes `BUTTERBASE_API_KEY`. If missing (redeploy wiped it):

```
mcp__butterbase__manage_function app_id=app_44zjayftl7b3 action=update_env fn_name=send-social-post env={"BUTTERBASE_API_KEY":"bb_sk_<from previous env>"}
```

---

## Task 6: `send-social-post` — Instagram + TikTok senders

**Files:**
- Modify: `backend/functions/send-social-post/handler.ts`

**Interfaces:**
- Consumes: `presignMedia`, `waitForFinished`, `pollTiktokStatus`, `composio`, `resolveWorkspaceIntegration`, `effectiveBody` (all in-file).
- Produces: new entries in `SENDERS`; new branches in `externalIdFor` / `externalUrlFor`. Result shape unchanged (`{ ok, data?, error? }`).

- [ ] **Step 1: Add `inferInstagramType` helper**

Above `sendTwitter`:

```ts
function inferInstagramType(media) {
  if (media.length >= 2) return 'carousel';
  return 'feed';
}
```

- [ ] **Step 2: Insert `sendInstagram`**

```ts
async function sendInstagram(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'instagram');
  if (!row) return { ok: false, error: 'instagram: workspace has no connected account' };
  if (!post.media || post.media.length === 0) return { ok: false, error: 'instagram: no media on post' };

  const postType = post.channel_overrides?.instagram?.post_type ?? inferInstagramType(post.media);
  const caption = effectiveBody(post, 'instagram');
  const urls = await presignMedia(ctx, post.media);
  const userId = row.user_id;

  let creationId;
  if (postType === 'carousel') {
    const childIds = [];
    for (let i = 0; i < post.media.length; i++) {
      const m = post.media[i];
      const r = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', {
        [m.kind === 'video' ? 'video_url' : 'image_url']: urls[i],
        media_type: m.kind === 'video' ? 'VIDEO' : 'IMAGE',
        is_carousel_item: true,
      }, userId);
      if (!r.ok) return r;
      const id = r.data?.id ?? deepKey(r.data, ['id']);
      if (!id) return { ok: false, error: 'instagram: carousel child creation returned no id' };
      if (m.kind === 'video') {
        const wait = await waitForFinished(ctx, userId, id);
        if (!wait.ok) return wait;
      }
      childIds.push(id);
    }
    const parent = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', {
      media_type: 'CAROUSEL', caption, children: childIds,
    }, userId);
    if (!parent.ok) return parent;
    creationId = parent.data?.id ?? deepKey(parent.data, ['id']);
  } else {
    const m = post.media[0];
    const params = { caption };
    if (postType === 'story') params.media_type = 'STORIES';
    else if (postType === 'reel') params.media_type = 'REELS';
    else params.media_type = m.kind === 'video' ? 'VIDEO' : 'IMAGE';
    params[m.kind === 'video' ? 'video_url' : 'image_url'] = urls[0];

    const r = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', params, userId);
    if (!r.ok) return r;
    creationId = r.data?.id ?? deepKey(r.data, ['id']);
    if (!creationId) return { ok: false, error: 'instagram: creation returned no id' };
    if (m.kind === 'video') {
      const wait = await waitForFinished(ctx, userId, creationId);
      if (!wait.ok) return wait;
    }
  }

  const publish = await composio(ctx, 'INSTAGRAM_PUBLISH_IG_USER_MEDIA', { creation_id: creationId }, userId);
  if (!publish.ok) return publish;

  // Enrich with shortcode for external_url.
  const publishedId = publish.data?.id ?? deepKey(publish.data, ['id']);
  if (publishedId) {
    const enrich = await composio(ctx, 'INSTAGRAM_GET_MEDIA', { media_id: publishedId, fields: 'id,shortcode,permalink' }, userId);
    if (enrich.ok && enrich.data) {
      publish.data = { ...publish.data, shortcode: enrich.data.shortcode ?? deepKey(enrich.data, ['shortcode']), permalink: enrich.data.permalink ?? deepKey(enrich.data, ['permalink']) };
    }
  }
  return publish;
}
```

- [ ] **Step 3: Insert `sendTiktok`**

```ts
async function sendTiktok(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'tiktok');
  if (!row) return { ok: false, error: 'tiktok: workspace has no connected account' };
  if (!post.media || post.media.length === 0) return { ok: false, error: 'tiktok: no media on post' };

  const overrides = post.channel_overrides?.tiktok ?? {};
  const postType = overrides.post_type ?? (post.media[0].kind === 'video' ? 'video' : 'photo');
  const caption = effectiveBody(post, 'tiktok');
  const privacy = overrides.privacy ?? 'PUBLIC_TO_EVERYONE';
  const title = overrides.title ?? '';
  const urls = await presignMedia(ctx, post.media);
  const userId = row.user_id;

  const publish = postType === 'photo'
    ? await composio(ctx, 'TIKTOK_POST_PHOTO', {
        photo_urls: urls,
        post_info: { title, description: caption, privacy_level: privacy },
      }, userId)
    : await composio(ctx, 'TIKTOK_PUBLISH_VIDEO', {
        video_url: urls[0],
        post_info: { title, description: caption, privacy_level: privacy },
      }, userId);

  if (!publish.ok) return publish;
  const publishId = publish.data?.publish_id ?? deepKey(publish.data, ['publish_id']);
  return pollTiktokStatus(ctx, userId, publishId, publish);
}
```

- [ ] **Step 4: Register new senders**

Replace:

```ts
const SENDERS = { twitter: sendTwitter, linkedin: sendLinkedIn, reddit: sendReddit };
```

With:

```ts
const SENDERS = {
  twitter: sendTwitter, linkedin: sendLinkedIn, reddit: sendReddit,
  instagram: sendInstagram, tiktok: sendTiktok,
};
```

- [ ] **Step 5: Extend `externalIdFor` and `externalUrlFor`**

Append the new branches inside each function, before the trailing `return null`:

```ts
// externalIdFor
if (channel === 'instagram') {
  return data?.id ?? data?.data?.id ?? deepKey(data, ['id']) ?? null;
}
if (channel === 'tiktok') {
  return data?.post_id ?? data?.publish_id ?? deepKey(data, ['post_id', 'publish_id']) ?? null;
}
```

```ts
// externalUrlFor
if (channel === 'instagram') {
  const permalink = data?.permalink ?? deepKey(data, ['permalink']);
  if (permalink) return permalink;
  const sc = data?.shortcode ?? deepKey(data, ['shortcode']);
  return sc ? `https://www.instagram.com/p/${sc}` : null;
}
if (channel === 'tiktok') {
  return data?.share_url ?? deepKey(data, ['share_url']) ?? null;
}
```

- [ ] **Step 6: Deploy + re-set env if needed**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=send-social-post
mcp__butterbase__manage_function app_id=app_44zjayftl7b3 action=get_env fn_name=send-social-post
```

Re-apply `BUTTERBASE_API_KEY` if missing.

---

## Task 7: `send-social-post` — Twitter + LinkedIn media

**Files:**
- Modify: `backend/functions/send-social-post/handler.ts` (only `sendTwitter` and `sendLinkedIn`)

**Interfaces:**
- Consumes: `presignMedia`; existing `composio` behavior.
- Produces: text-only calls unchanged when `post.media` is empty; when non-empty, media is attached per platform rules.

- [ ] **Step 1: Update `sendTwitter`**

Replace the current one-line body-only version with:

```ts
async function sendTwitter(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'twitter');
  if (!row) return { ok: false, error: 'twitter: workspace has no connected account' };
  const text = effectiveBody(post, 'twitter');
  const userId = row.user_id;
  if (!post.media || post.media.length === 0) {
    return composio(ctx, 'TWITTER_CREATION_OF_A_POST', { text }, userId);
  }
  const urls = await presignMedia(ctx, post.media);
  const mediaIds = [];
  for (let i = 0; i < post.media.length; i++) {
    const m = post.media[i];
    const up = await composio(ctx, 'TWITTER_MEDIA_UPLOAD', {
      media_url: urls[i],
      media_category: m.kind === 'video' ? 'tweet_video' : 'tweet_image',
    }, userId);
    if (!up.ok) return up;
    const id = up.data?.media_id_string ?? up.data?.media_id ?? deepKey(up.data, ['media_id_string', 'media_id']);
    if (!id) return { ok: false, error: 'twitter: media upload returned no id' };
    mediaIds.push(String(id));
  }
  return composio(ctx, 'TWITTER_CREATION_OF_A_POST', { text, media: { media_ids: mediaIds } }, userId);
}
```

- [ ] **Step 2: Update `sendLinkedIn` (media branch only)**

In `sendLinkedIn`, after resolving `urn` and computing `body` + `visibility`, replace the tail `if (post.link_url) { ... } return composio(...)` with:

```ts
  if (post.media && post.media.length > 0) {
    const m = post.media[0];
    const [mediaUrl] = await presignMedia(ctx, [m]);
    const reg = await composio(ctx, 'LINKEDIN_REGISTER_UPLOAD', {
      owner: urn,
      recipes: [m.kind === 'video' ? 'urn:li:digitalmediaRecipe:feedshare-video' : 'urn:li:digitalmediaRecipe:feedshare-image'],
      serviceRelationships: [{ identifier: 'urn:li:userGeneratedContent', relationshipType: 'OWNER' }],
      supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD'],
    }, userId);
    if (!reg.ok) return reg;
    const asset = reg.data?.asset ?? deepKey(reg.data, ['asset']);
    const uploadUrl = deepUrl(reg.data, 'linkedin.com') ?? deepKey(reg.data, ['uploadUrl']);
    if (!asset || !uploadUrl) return { ok: false, error: 'linkedin: register upload returned no asset/uploadUrl' };
    // Server-side proxy the file: fetch presigned, PUT to LinkedIn.
    const file = await fetch(mediaUrl);
    if (!file.ok) return { ok: false, error: `linkedin: fetching presigned media failed: ${file.status}` };
    const put = await fetch(uploadUrl, { method: 'PUT', body: await file.arrayBuffer(), headers: { 'content-type': m.mime || 'application/octet-stream' } });
    if (!put.ok) return { ok: false, error: `linkedin: upload PUT failed: ${put.status}` };
    return composio(ctx, 'LINKEDIN_CREATE_LINKED_IN_POST', {
      author: urn, commentary: body, visibility,
      media: [{ status: 'READY', mediaKind: m.kind === 'video' ? 'VIDEO' : 'IMAGE', asset }],
    }, userId);
  }
  if (post.link_url) {
    return composio(ctx, 'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE', {
      author: urn,
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: body },
          shareMediaCategory: 'ARTICLE',
          media: [{ status: 'READY', originalUrl: post.link_url }],
        },
      },
    }, userId);
  }
  return composio(ctx, 'LINKEDIN_CREATE_LINKED_IN_POST', { author: urn, commentary: body, visibility }, userId);
```

- [ ] **Step 3: Deploy**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=send-social-post
```

Re-check env with `get_env`; re-apply `BUTTERBASE_API_KEY` if missing.

- [ ] **Step 4: Smoke text-only regression (Twitter)**

Publish a text-only Twitter post via the existing composer flow. Expected: unchanged behavior, `external_url` still resolves to `https://twitter.com/i/web/status/…`.

---

## Task 8: `delete-social-post-from-platform`

**Files:**
- Modify: `backend/functions/delete-social-post-from-platform/handler.ts`

**Interfaces:**
- Consumes: `send.channel`, `send.external_post_id`, `send.post_id` → to fetch `channel_overrides` for the IG story branch.
- Produces: 200 `{ ok: true, note?: string }` on Instagram-story (auto-expiry) branch; 200 `{ ok: false, error: '...' }` on TikTok (unsupported); existing 502 shape on real delete failures.

- [ ] **Step 1: Extend `DELETE_TOOL` map**

```ts
const DELETE_TOOL = {
  twitter: 'TWITTER_POST_DELETE_BY_POST_ID',
  linkedin: 'LINKEDIN_DELETE_LINKED_IN_POST',
  reddit: 'REDDIT_DELETE_REDDIT_POST',
  instagram: 'INSTAGRAM_DELETE_MEDIA',
  // tiktok handled separately (no API).
};
```

- [ ] **Step 2: Insert TikTok short-circuit**

Immediately after resolving `send` and the membership check, before the `DELETE_TOOL[send.channel]` lookup:

```ts
if (send.channel === 'tiktok') {
  return json(200, { ok: false, error: 'tiktok: platform does not support programmatic delete' });
}
```

- [ ] **Step 3: Insert Instagram Story short-circuit**

Below the TikTok branch:

```ts
if (send.channel === 'instagram') {
  const postRes = await ctx.db.query(
    `SELECT channel_overrides FROM social_posts WHERE id = $1`,
    [send.post_id],
  );
  const postType = postRes.rows?.[0]?.channel_overrides?.instagram?.post_type;
  if (postType === 'story') {
    // Story auto-expired or will expire in 24h; local cleanup only.
    await ctx.db.query(
      `UPDATE social_post_sends SET external_post_id = NULL, external_url = NULL WHERE id = $1`,
      [send_id],
    );
    return json(200, { ok: true, note: 'stories auto-expire in 24h; nothing to delete on Instagram' });
  }
}
```

- [ ] **Step 4: Instagram delete tool param shape**

`INSTAGRAM_DELETE_MEDIA` uses `media_id`, not `id`. Change the composio call param builder to route by channel:

Find:

```ts
const result = await composio(ctx, tool, { id: send.external_post_id }, connectedUserId);
```

Replace with:

```ts
const params = send.channel === 'instagram'
  ? { media_id: send.external_post_id }
  : { id: send.external_post_id };
const result = await composio(ctx, tool, params, connectedUserId);
```

- [ ] **Step 5: Deploy + smoke unsupported path**

```
mcp__butterbase__deploy_function app_id=app_44zjayftl7b3 fn_name=delete-social-post-from-platform
```

Invoke with a fabricated tiktok send_id (or manually route through the UI once frontend lands). Expected 200 body: `{ ok: false, error: 'tiktok: platform does not support programmatic delete' }`.

---

## Task 9: Frontend — types + icons

**Files:**
- Modify: `frontend/src/lib/socialApi.ts`
- Modify: `frontend/src/components/SocialIcons.tsx`

**Interfaces:**
- Produces:
  - `SocialChannel` union extended with `'instagram' | 'tiktok'`.
  - `MediaRef` type: `{ object_id: string; kind: 'image' | 'video'; mime: string; size_bytes: number }`.
  - `ChannelOverrides` extended per spec.
  - `SocialPost.media: MediaRef[]`.
  - Exported React components `InstagramIcon`, `TikTokIcon` matching the existing icon signature `(props: React.SVGProps<SVGSVGElement>) => JSX.Element`.

- [ ] **Step 1: Update `socialApi.ts`**

Replace the top type block:

```ts
export type SocialChannel = 'twitter' | 'linkedin' | 'reddit' | 'instagram' | 'tiktok'

export interface MediaRef {
  object_id: string
  kind: 'image' | 'video'
  mime: string
  size_bytes: number
}

export interface ChannelOverrides {
  twitter?: { body?: string }
  linkedin?: { body?: string; visibility?: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN' }
  reddit?: { title: string; subreddit: string; flair_id?: string; body?: string }
  instagram?: { caption?: string; post_type?: 'feed' | 'reel' | 'story' | 'carousel' }
  tiktok?: {
    caption?: string
    title?: string
    post_type?: 'video' | 'photo'
    privacy?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY'
  }
}
```

Then add `media: MediaRef[]` to `SocialPost`:

```ts
export interface SocialPost {
  id: string
  workspace_id: string
  created_by: string
  body: string
  channels: SocialChannel[]
  channel_overrides: ChannelOverrides
  media: MediaRef[]
  link_url: string | null
  scheduled_at: string | null
  status: SocialPostStatus
  error: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}
```

And update `CreatePayload`:

```ts
export interface CreatePayload {
  workspace_id: string
  body: string
  channels: SocialChannel[]
  channel_overrides?: ChannelOverrides
  media?: MediaRef[]
  link_url?: string
  scheduled_at?: string
  save_as_draft?: boolean
}
```

Also add to `EditPatch`:

```ts
  media?: MediaRef[]
```

- [ ] **Step 2: Add icons to `SocialIcons.tsx`**

Append:

```tsx
export function InstagramIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.334 3.608 1.309.975.975 1.247 2.242 1.309 3.608.058 1.266.07 1.646.07 4.85s-.012 3.584-.07 4.85c-.062 1.366-.334 2.633-1.309 3.608-.975.975-2.242 1.247-3.608 1.309-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.366-.062-2.633-.334-3.608-1.309-.975-.975-1.247-2.242-1.309-3.608C2.175 15.647 2.163 15.267 2.163 12s.012-3.584.07-4.85c.062-1.366.334-2.633 1.309-3.608.975-.975 2.242-1.247 3.608-1.309C8.416 2.175 8.796 2.163 12 2.163zm0 1.837c-3.155 0-3.507.012-4.744.068-.973.045-1.504.207-1.857.344-.467.181-.8.398-1.15.748-.35.35-.567.683-.748 1.15-.137.353-.3.884-.344 1.857-.056 1.237-.068 1.589-.068 4.744s.012 3.507.068 4.744c.045.973.207 1.504.344 1.857.181.467.398.8.748 1.15.35.35.683.567 1.15.748.353.137.884.3 1.857.344 1.237.056 1.589.068 4.744.068s3.507-.012 4.744-.068c.973-.045 1.504-.207 1.857-.344.467-.181.8-.398 1.15-.748.35-.35.567-.683.748-1.15.137-.353.3-.884.344-1.857.056-1.237.068-1.589.068-4.744s-.012-3.507-.068-4.744c-.045-.973-.207-1.504-.344-1.857-.181-.467-.398-.8-.748-1.15-.35-.35-.683-.567-1.15-.748-.353-.137-.884-.3-1.857-.344-1.237-.056-1.589-.068-4.744-.068zm0 3.13a4.87 4.87 0 110 9.74 4.87 4.87 0 010-9.74zm0 8.033a3.163 3.163 0 100-6.326 3.163 3.163 0 000 6.326zm6.187-8.246a1.138 1.138 0 11-2.276 0 1.138 1.138 0 012.276 0z"/>
    </svg>
  )
}

export function TikTokIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005.8 20.1a6.34 6.34 0 0010.86-4.43V8.16a8.16 8.16 0 003.32.83V5.94a4.85 4.85 0 01-.39-.25z"/>
    </svg>
  )
}
```

- [ ] **Step 3: Type-check the frontend**

```
cd /Users/kenneth/Documents/Misc/butterbaseCRM/frontend && npx tsc --noEmit
```

Expected: no TS errors from the changed files. Other pre-existing errors (unrelated) are acceptable — do not fix them here.

---

## Task 10: `SocialPostComposer` — media picker + per-channel panels

**Files:**
- Modify: `frontend/src/components/SocialPostComposer.tsx`

**Interfaces:**
- Consumes: `bb.storage.upload(file, filename)` (returns `{ objectId }` per existing `AttachmentsPanel` usage).
- Produces: composer that sends `media: MediaRef[]` to create/edit endpoints; per-channel validity guarded by `canPostTo(channel, media)`; per-channel override panels for IG/TikTok/Twitter/LinkedIn (existing Reddit panel unchanged).

Note: this task is large by necessity — the composer is the single UX surface for four new post types. Break the mental work into steps but do the edits as one coherent pass.

- [ ] **Step 1: Imports + META extension**

At the top of the file, replace the imports for `SocialIcons` and the `META` map:

```tsx
import { XIcon, LinkedInIcon, RedditIcon, InstagramIcon, TikTokIcon } from '@/components/SocialIcons'
import { bb } from '@/lib/butterbase'
import type { MediaRef } from '@/lib/socialApi'
import { X, ImagePlus } from 'lucide-react'

const META: Record<SocialChannel, { name: string; limit: number; icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element }> = {
  twitter: { name: 'Twitter', limit: 280, icon: XIcon },
  linkedin: { name: 'LinkedIn', limit: 3000, icon: LinkedInIcon },
  reddit: { name: 'Reddit', limit: 40000, icon: RedditIcon },
  instagram: { name: 'Instagram', limit: 2200, icon: InstagramIcon },
  tiktok: { name: 'TikTok', limit: 2200, icon: TikTokIcon },
}
```

- [ ] **Step 2: Add media state + helpers**

Below the existing `useState` block, add:

```tsx
const [media, setMedia] = useState<MediaRef[]>([])
const [uploading, setUploading] = useState(false)
const [igPostType, setIgPostType] = useState<'feed'|'reel'|'story'|'carousel'>('feed')
const [ttPostType, setTtPostType] = useState<'video'|'photo'>('video')
const [ttTitle, setTtTitle] = useState('')
const [ttPrivacy, setTtPrivacy] = useState<'PUBLIC_TO_EVERYONE'|'MUTUAL_FOLLOW_FRIENDS'|'SELF_ONLY'>('PUBLIC_TO_EVERYONE')
const [igCaption, setIgCaption] = useState('')
const [ttCaption, setTtCaption] = useState('')
```

Add helpers:

```tsx
function canPostTo(channel: SocialChannel, m: MediaRef[]): { ok: boolean; reason?: string } {
  if (channel === 'twitter') {
    if (m.length === 0) return { ok: true }
    const hasVideo = m.some(x => x.kind === 'video')
    if (hasVideo && m.length !== 1) return { ok: false, reason: 'Twitter: video posts need exactly 1 video' }
    if (!hasVideo && m.length > 4) return { ok: false, reason: 'Twitter: up to 4 images' }
    return { ok: true }
  }
  if (channel === 'linkedin') {
    if (m.length > 1) return { ok: false, reason: 'LinkedIn: max 1 media item' }
    return { ok: true }
  }
  if (channel === 'reddit') return { ok: true }
  if (channel === 'instagram') {
    if (m.length === 0) return { ok: false, reason: 'Instagram requires media' }
    if (m.length > 10) return { ok: false, reason: 'Instagram carousels max 10 items' }
    return { ok: true }
  }
  if (channel === 'tiktok') {
    if (m.length === 0) return { ok: false, reason: 'TikTok requires media' }
    const kinds = new Set(m.map(x => x.kind))
    if (kinds.size > 1) return { ok: false, reason: 'TikTok: cannot mix images and videos' }
    if (m[0].kind === 'video' && m.length > 1) return { ok: false, reason: 'TikTok video: exactly 1 clip' }
    if (m[0].kind === 'image' && m.length > 35) return { ok: false, reason: 'TikTok photo: max 35 images' }
    return { ok: true }
  }
  return { ok: true }
}

async function handleUpload(files: FileList | null) {
  if (!files || files.length === 0) return
  setUploading(true)
  try {
    const uploaded: MediaRef[] = []
    for (const f of Array.from(files)) {
      const kind: 'image' | 'video' = f.type.startsWith('video/') ? 'video' : 'image'
      const res = await bb.storage.upload(f, f.name)
      if (res.error) throw res.error
      uploaded.push({ object_id: res.data!.objectId, kind, mime: f.type, size_bytes: f.size })
    }
    setMedia((cur) => [...cur, ...uploaded])
  } catch (e: any) {
    toast.error(e?.message ?? 'Upload failed')
  } finally {
    setUploading(false)
  }
}

function removeMedia(idx: number) {
  setMedia((cur) => cur.filter((_, i) => i !== idx))
}

function moveMedia(idx: number, dir: -1 | 1) {
  setMedia((cur) => {
    const next = [...cur]
    const j = idx + dir
    if (j < 0 || j >= next.length) return cur
    ;[next[idx], next[j]] = [next[j], next[idx]]
    return next
  })
}
```

- [ ] **Step 3: Seed IG/TikTok state from `initialContent` / `post`**

Inside the existing `useEffect` on `open`, after the existing `setRedditBody(...)` line:

```tsx
    setIgCaption(o.instagram?.caption ?? '')
    setIgPostType((o.instagram?.post_type ?? (post?.media?.length ?? 0) >= 2 ? 'carousel' : 'feed') as any)
    setTtCaption(o.tiktok?.caption ?? '')
    setTtPostType((o.tiktok?.post_type ?? 'video') as any)
    setTtTitle(o.tiktok?.title ?? '')
    setTtPrivacy((o.tiktok?.privacy ?? 'PUBLIC_TO_EVERYONE') as any)
    setMedia((seed as SocialPost | null)?.media ?? [])
```

- [ ] **Step 4: Extend `buildOverrides()`**

Replace the current function:

```tsx
function buildOverrides(): ChannelOverrides {
  const co: ChannelOverrides = {}
  if (twOverride.trim()) co.twitter = { body: twOverride.trim() }
  if (liOverride.trim()) co.linkedin = { body: liOverride.trim() }
  if (selectedChannels.includes('reddit')) {
    co.reddit = {
      title: redditTitle.trim(),
      subreddit: redditSubreddit.trim().replace(/^\/?r\//i, '').replace(/\//g, ''),
      ...(redditFlairId.trim() ? { flair_id: redditFlairId.trim() } : {}),
      ...(redditBody.trim() ? { body: redditBody.trim() } : {}),
    }
  }
  if (selectedChannels.includes('instagram')) {
    co.instagram = {
      ...(igCaption.trim() ? { caption: igCaption.trim() } : {}),
      post_type: igPostType,
    }
  }
  if (selectedChannels.includes('tiktok')) {
    co.tiktok = {
      ...(ttCaption.trim() ? { caption: ttCaption.trim() } : {}),
      ...(ttTitle.trim() ? { title: ttTitle.trim() } : {}),
      post_type: ttPostType,
      privacy: ttPrivacy,
    }
  }
  return co
}
```

- [ ] **Step 5: Pass `media` in all create/edit calls**

Add `media` to every `createSocialPost(...)` and `editSocialPost(...)` call in the file:

```tsx
// createSocialPost calls: inside the payload object
media,

// editSocialPost calls: inside the patch object
media,
```

(Search for `createSocialPost({` and `editSocialPost(post!.id, {` — there are 4 total call sites in this file.)

- [ ] **Step 6: Update channel-toggle rendering**

In the channel toggle block (`{(Object.keys(META) as SocialChannel[]).map((slug) => { ... })}`), replace the `title` prop calculation and the icon slot:

```tsx
const compat = canPostTo(slug, media)
return (
  <button
    key={slug}
    type="button"
    disabled={!isConnected || lockedChannels || !compat.ok}
    title={lockedChannels ? 'Channels are locked for a published post'
      : (!isConnected ? 'Connect in Settings →' : (compat.reason ?? undefined))}
    onClick={() => toggleChannel(slug)}
    className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm transition ${
      isOn ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
           : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
    } ${(!isConnected || lockedChannels || !compat.ok) ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
  >
    {(() => { const I = META[slug].icon; return <I className="h-4 w-4" /> })()}
    <span>{META[slug].name}</span>
  </button>
)
```

- [ ] **Step 7: Add media picker section**

Insert after the "Link (optional)" block, before the Twitter override panel:

```tsx
<div>
  <Label className="eyebrow !text-[10px]">Media</Label>
  <div className="mt-1 space-y-2">
    <div className="flex items-center gap-2">
      <label className="inline-flex items-center gap-1.5 cursor-pointer rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:border-gray-300">
        <ImagePlus className="h-4 w-4" />
        {uploading ? 'Uploading…' : 'Add images / videos'}
        <input
          type="file"
          multiple
          accept="image/*,video/*"
          disabled={uploading || isPublished}
          onChange={(e) => { handleUpload(e.currentTarget.files); e.currentTarget.value = '' }}
          className="hidden"
        />
      </label>
      {media.length > 0 && <span className="text-[11px] text-gray-500">{media.length} item{media.length === 1 ? '' : 's'}</span>}
    </div>
    {media.length > 0 && (
      <div className="flex gap-2 overflow-x-auto">
        {media.map((m, i) => (
          <div key={m.object_id} className="relative shrink-0 rounded border border-gray-200 bg-gray-50 p-1">
            <div className="flex h-16 w-16 items-center justify-center rounded bg-gray-200 text-[10px] text-gray-500 uppercase">
              {m.kind}
            </div>
            <button type="button" onClick={() => removeMedia(i)} className="absolute -right-1 -top-1 rounded-full bg-white p-0.5 text-gray-500 shadow">
              <X className="h-3 w-3" />
            </button>
            {media.length > 1 && (
              <div className="mt-1 flex justify-center gap-1 text-[9px] text-gray-500">
                <button type="button" onClick={() => moveMedia(i, -1)} disabled={i === 0}>◀</button>
                <button type="button" onClick={() => moveMedia(i, 1)} disabled={i === media.length - 1}>▶</button>
              </div>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
</div>
```

- [ ] **Step 8: Instagram override panel**

After the existing LinkedIn panel:

```tsx
{selectedChannels.includes('instagram') && (
  <div className="rounded border border-pink-200 bg-pink-50 p-3 space-y-2">
    <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-pink-900 uppercase tracking-wide">
      <InstagramIcon className="h-3.5 w-3.5" /> Instagram
    </div>
    <div>
      <Label className="text-xs">Post type</Label>
      <div className="mt-1 flex gap-2 text-sm">
        {(['feed','reel','story','carousel'] as const).map(t => (
          <label key={t} className="flex items-center gap-1 cursor-pointer">
            <input type="radio" checked={igPostType === t} onChange={() => setIgPostType(t)} disabled={
              (t === 'reel' && (media[0]?.kind !== 'video')) ||
              (t === 'carousel' && media.length < 2)
            } /> {t}
          </label>
        ))}
      </div>
    </div>
    <div>
      <Label className="text-xs">Caption override (optional)</Label>
      <Textarea value={igCaption} onChange={(e) => setIgCaption(e.target.value)} rows={2} placeholder="Empty = use shared body" className="mt-1 text-sm" />
      <div className={`mt-0.5 text-[10px] ${igCaption.length > 2200 ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>{eff(body, igCaption).length}/2200</div>
    </div>
  </div>
)}
```

- [ ] **Step 9: TikTok override panel**

Below the Instagram panel:

```tsx
{selectedChannels.includes('tiktok') && (
  <div className="rounded border border-neutral-200 bg-neutral-50 p-3 space-y-2">
    <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-neutral-900 uppercase tracking-wide">
      <TikTokIcon className="h-3.5 w-3.5" /> TikTok
    </div>
    <div>
      <Label className="text-xs">Post type</Label>
      <div className="mt-1 flex gap-2 text-sm">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="radio" checked={ttPostType === 'video'} onChange={() => setTtPostType('video')} disabled={media[0]?.kind !== 'video'} /> video
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="radio" checked={ttPostType === 'photo'} onChange={() => setTtPostType('photo')} disabled={media[0]?.kind !== 'image'} /> photo
        </label>
      </div>
    </div>
    <div>
      <Label className="text-xs">Title (optional)</Label>
      <Input value={ttTitle} onChange={(e) => setTtTitle(e.target.value)} className="mt-1 text-sm" />
    </div>
    <div>
      <Label className="text-xs">Privacy</Label>
      <select value={ttPrivacy} onChange={(e) => setTtPrivacy(e.target.value as any)} className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm">
        <option value="PUBLIC_TO_EVERYONE">Public</option>
        <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
        <option value="SELF_ONLY">Only me</option>
      </select>
    </div>
    <div>
      <Label className="text-xs">Caption override (optional)</Label>
      <Textarea value={ttCaption} onChange={(e) => setTtCaption(e.target.value)} rows={2} placeholder="Empty = use shared body" className="mt-1 text-sm" />
      <div className={`mt-0.5 text-[10px] ${ttCaption.length > 2200 ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>{eff(body, ttCaption).length}/2200</div>
    </div>
  </div>
)}
```

- [ ] **Step 10: Type-check + local smoke**

```
cd /Users/kenneth/Documents/Misc/butterbaseCRM/frontend && npx tsc --noEmit
```

Then run the dev server (`npm run dev`) and open the composer; verify:
- Media picker uploads succeed.
- Instagram / TikTok toggles disable when media shape doesn't match.
- Twitter still works with 0 media.

---

## Task 11: `SocialConnectionsPanel` + `SocialSetupWizard`

**Files:**
- Modify: `frontend/src/components/SocialConnectionsPanel.tsx`
- Modify: `frontend/src/components/SocialSetupWizard.tsx`

**Interfaces:**
- Consumes: existing OAuth connect flow (`bb.integrations.connect(slug, { redirectUrl })`).
- Produces: two visible channel rows in Settings → Social; TikTok routes through the same BYO wizard as Twitter/LinkedIn; Instagram routes directly to `connect` (no wizard step).

- [ ] **Step 1: Add two channel entries to `SocialConnectionsPanel`**

Find the `CHANNELS` (or equivalent) constant/array in the panel and add:

```tsx
{ slug: 'instagram', name: 'Instagram', icon: InstagramIcon, byo: false, hint: 'Business or Creator account required' },
{ slug: 'tiktok', name: 'TikTok', icon: TikTokIcon, byo: true, hint: 'Requires a TikTok developer app' },
```

Update the icon import at top of file to include `InstagramIcon`, `TikTokIcon`.

- [ ] **Step 2: In the Connect button handler, short-circuit Instagram**

When the row has `byo: false`, call `bb.integrations.connect('instagram', { redirectUrl })` directly. When `byo: true`, launch `SocialSetupWizard` (existing behavior).

- [ ] **Step 3: Add TikTok step to `SocialSetupWizard`**

Follow the existing pattern for Twitter/LinkedIn/Reddit. TikTok fields: `client_id`, `client_secret`. Scopes are already set in `configure-social-toolkit`; no extra input needed.

- [ ] **Step 4: Smoke both wizards**

Local: open Settings → Social, click Connect on Instagram — expect direct redirect to Composio OAuth. Click Configure app credentials on TikTok — expect the same-shape wizard.

---

## Task 12: `SocialPostDetailPanel`

**Files:**
- Modify: `frontend/src/components/SocialPostDetailPanel.tsx`

**Interfaces:**
- Consumes: `SocialPostSend.channel` including new values; `deleteFromPlatform(send_id)` return shape can now include `note` and `ok: false` with a soft error.
- Produces: renders Instagram + TikTok icons; passive info banner for TikTok delete or IG story delete.

- [ ] **Step 1: Add icon mapping**

Wherever the file maps `channel → icon`, add Instagram and TikTok. Reuse the `META` shape from the composer or inline:

```tsx
const CHANNEL_ICON: Record<SocialChannel, (p: React.SVGProps<SVGSVGElement>) => JSX.Element> = {
  twitter: XIcon, linkedin: LinkedInIcon, reddit: RedditIcon,
  instagram: InstagramIcon, tiktok: TikTokIcon,
}
```

- [ ] **Step 2: Update `handleDeleteFromPlatform` to surface the soft `note`**

Wherever it calls `deleteFromPlatform(send.id)` and toasts:

```tsx
const { data, error } = await deleteFromPlatform(send.id)
if (error) { toast.error(errMsg(error)); return }
if (data?.ok === false && data?.error) {
  toast.info(data.error)   // TikTok unsupported-delete case
} else if (data?.note) {
  toast.info(data.note)    // IG story auto-expiry case
} else {
  toast.success('Removed from platform')
}
qc.invalidateQueries({ queryKey: ['social-post-sends'] })
```

- [ ] **Step 3: Local smoke**

Open a published post detail; confirm the icons render and that clicking Delete-from-platform on a TikTok send shows the info toast, not a red error.

---

## Task 13: End-to-end smoke + rollout

**Files:** none (verification only).

- [ ] **Step 1: Deploy frontend**

```
mcp__butterbase__create_frontend_deployment app_id=app_44zjayftl7b3
# use the returned deployment_id
mcp__butterbase__manage_frontend app_id=app_44zjayftl7b3 action=start_deployment deployment_id=<id>
```

Verify the live URL loads.

- [ ] **Step 2: Instagram connect + feed image post**

1. Settings → Social → Connect Instagram → complete OAuth with a Business/Creator account.
2. New Social Post → upload 1 image → select `instagram` → post type `feed` → Publish.
3. Verify: `social_posts.status → 'sent'`; `external_url` opens the post on Instagram.

- [ ] **Step 3: Instagram Reel**

1. New Social Post → upload 1 video → select `instagram` → post type `reel` → Publish.
2. Verify: `waitForFinished` runs to completion (may take ~30s); final status `sent`.

- [ ] **Step 4: Instagram carousel**

1. Upload 3 images → select `instagram` → post type auto → `carousel` → Publish.
2. Verify all 3 appear as a carousel on IG.

- [ ] **Step 5: TikTok video post (sandbox)**

1. Settings → Social → Configure TikTok credentials (BYO client_id + client_secret from TikTok Developer Portal, sandbox mode).
2. Connect a TikTok account.
3. Upload 1 short (≤60s) video → select `tiktok` → post type `video` → Publish.
4. Verify: `pollTiktokStatus` returns success and the post appears in the TikTok inbox (sandbox) or feed (production).

- [ ] **Step 6: Twitter + LinkedIn media regression**

1. Publish a Twitter post with 2 images → verify tweet shows both.
2. Publish a LinkedIn post with 1 image → verify UGC post has the image.
3. Publish a Twitter and LinkedIn post with 0 media → verify text-only path still works (regression check).

- [ ] **Step 7: Delete-from-platform paths**

1. Delete a published Instagram feed post from the detail panel → verify success toast + IG media disappears.
2. Delete a published Instagram Story send → expect info toast `stories auto-expire in 24h; nothing to delete on Instagram`.
3. Delete a TikTok send → expect info toast `tiktok: platform does not support programmatic delete`.

- [ ] **Step 8: Update memory + docs**

Add or update these memory records:
- Update `[[project-social-functions-need-api-key-env]]` to mention `send-social-post` now also uses the env var inside `presignMedia`.
- Add a new project memory: "IG requires Business account + FB Page link. TikTok requires developer-app review before non-sandbox posting."

---

## Self-Review Notes

- **Spec coverage:** All eight rollout items map to tasks: schema → Task 1; configure → Task 2; create/publish/edit → Tasks 3/4; send + delete → Tasks 5–8; frontend types + composer + connections + detail → Tasks 9–12; rollout smoke → Task 13.
- **Consistency:** Function/tool name spellings verified: `INSTAGRAM_POST_IG_USER_MEDIA`, `INSTAGRAM_PUBLISH_IG_USER_MEDIA`, `INSTAGRAM_GET_MEDIA`, `INSTAGRAM_DELETE_MEDIA`, `TIKTOK_PUBLISH_VIDEO`, `TIKTOK_POST_PHOTO`, `TIKTOK_FETCH_PUBLISH_STATUS`, `TWITTER_MEDIA_UPLOAD`, `LINKEDIN_REGISTER_UPLOAD`. `SocialChannel` union and `MediaRef` shape match backend expectations.
- **Assumptions to verify at runtime:** Composio's exact param names for `TIKTOK_POST_PHOTO` (`photo_urls`) and `INSTAGRAM_POST_IG_USER_MEDIA` carousel (`is_carousel_item`, `children`). If a smoke call rejects a param, consult Composio's docs UI for that action's schema and adjust the sender inline — this is normal for Composio integrations and does not invalidate the plan structure.
